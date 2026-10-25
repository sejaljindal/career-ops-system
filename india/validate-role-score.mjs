#!/usr/bin/env node
/**
 * validate-role-score.mjs — checks role-score.mjs's deterministic pre-score
 * against the reports already given a real 1-5 score by the LLM eval worker.
 *
 * WHAT THIS DOES NOT CLAIM: role-score.mjs's preScore and modes/_shared.md's
 * "Global" score measure different things by design — the Global score is a
 * holistic LLM judgment folding in CV-gap analysis, culture and red flags,
 * none of which a deterministic role/CTC/location formula can compute. This
 * script therefore checks DIRECTIONAL AGREEMENT (does the pre-score's tier
 * point the same way as the LLM's score bucket?), not exact decimal match.
 * A report where the two clearly disagree (e.g. LLM says "recommend
 * against" but the pre-score says "prioritize") is the actionable signal —
 * it means either the pre-score's word-overlap matching missed something,
 * or the LLM caught a CV-gap/culture problem the pre-score structurally
 * cannot see. Both are worth a human glance, not silent trust either way.
 *
 * Usage: node validate-role-score.mjs [--verbose]
 */

import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { preScoreRole, loadProfile } from './role-score.mjs';

const ROOT = process.cwd();
const REPORTS_DIR = path.join(ROOT, 'reports');
const verbose = process.argv.includes('--verbose');

function llmBucket(score) {
  if (score >= 4.5) return 'Strong (recommend applying immediately)';
  if (score >= 4.0) return 'Good (worth applying)';
  if (score >= 3.5) return 'Decent (apply only if specific reason)';
  return 'Below 3.5 (recommend against)';
}

// Coarse buckets used only for the agreement check — "does the deterministic
// pre-score land in the same rough neighbourhood as the LLM's verdict", not
// an exact-tier match.
function agreementBucket(preScoreOrTier, isLlm) {
  if (isLlm) {
    if (preScoreOrTier >= 4.0) return 'positive';
    if (preScoreOrTier >= 3.5) return 'mixed';
    return 'negative';
  }
  if (preScoreOrTier >= 3.3) return 'positive';
  if (preScoreOrTier >= 2.0) return 'mixed';
  return 'negative';
}

function parseReport(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const scoreMatch = content.match(/\*\*Score:\*\*\s*(\d(?:\.\d)?)\/5/);
  if (!scoreMatch) return null; // gated / dead / unreachable / N/A — nothing to compare
  const score = parseFloat(scoreMatch[1]);

  const ymlMatch = content.match(/```yaml\n([\s\S]*?)\n```/);
  let ms = {};
  if (ymlMatch) {
    try { ms = yaml.load(ymlMatch[1]) || {}; } catch { ms = {}; }
  }
  const titleMatch = content.match(/^# Evaluation:\s*(.+?)\s*—\s*(.+)$/m);
  const company = ms.company || titleMatch?.[1] || '';
  const role = ms.role || titleMatch?.[2] || '';
  const location = ms.location || '';
  const advertisedComp = ms.advertised_comp ?? null;
  const remote = String(ms.remote || '').toLowerCase().includes('remote');

  return { file: path.basename(filePath), score, company, role, location, advertisedComp, remote };
}

function main() {
  const profile = loadProfile();
  const files = readdirSync(REPORTS_DIR).filter(f => /^\d+-.*\.md$/.test(f)).sort();
  const rows = files.map(f => parseReport(path.join(REPORTS_DIR, f))).filter(Boolean);

  console.log(`Comparing ${rows.length} LLM-scored reports against role-score.mjs's deterministic pre-score.\n`);
  console.log('report | company | role | LLM score | LLM bucket | preScore | pre-tier | agree?');
  console.log('---|---|---|---|---|---|---|---');

  let agree = 0;
  const disagreements = [];
  const named = [];

  for (const r of rows) {
    const pre = preScoreRole({ title: r.role, location: r.location, remote: r.remote, advertisedComp: r.advertisedComp, company: r.company }, profile);
    const llmB = agreementBucket(r.score, true);
    const preB = agreementBucket(pre.preScore, false);
    const agrees = llmB === preB || (llmB === 'mixed' || preB === 'mixed');
    if (agrees) agree++; else disagreements.push({ ...r, pre });

    const line = `${r.file} | ${r.company} | ${r.role} | ${r.score} | ${llmBucket(r.score)} | ${pre.preScore} | ${pre.tier} | ${agrees ? 'yes' : 'NO'}`;
    console.log(line);
    if (/barclays/i.test(r.company) || /sanofi/i.test(r.company)) named.push({ ...r, pre });
  }

  console.log(`\nAgreement (directional, positive/mixed/negative buckets): ${agree}/${rows.length} (${((agree / rows.length) * 100).toFixed(0)}%)`);

  console.log('\n-- Named validation targets (Barclays, Sanofi) --');
  for (const r of named) {
    console.log(`${r.file}: LLM ${r.score}/5 (${llmBucket(r.score)}) vs preScore ${r.pre.preScore} (${r.pre.tier}) — role match: ${r.pre.role.tier} on "${r.pre.role.matchedOn}"`);
  }

  if (disagreements.length && verbose) {
    console.log('\n-- Disagreements (worth a human glance) --');
    for (const d of disagreements) {
      console.log(`${d.file}: LLM ${d.score}/5 vs preScore ${d.pre.preScore} [${d.pre.tier}] — role=${d.pre.role.score}(${d.pre.role.tier}) ctc=${d.pre.ctc.score}(${d.pre.ctc.band}) loc=${d.pre.loc.score}(${d.pre.loc.band})`);
    }
  } else if (disagreements.length) {
    console.log(`\n${disagreements.length} disagreement(s) — rerun with --verbose to see them.`);
  }
}

main();
