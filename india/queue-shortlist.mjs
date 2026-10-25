#!/usr/bin/env node
/**
 * queue-shortlist.mjs — turn the raw scan queue into a send list, today.
 *
 * Written 2026-09-10 to unblock a specific dead end. `npm run india-wide` finds
 * hundreds of postings and writes them to data/pipeline.md's `## Pending`
 * section. But nothing reaches output/pipeline_india.xlsx — and therefore
 * nothing reaches ready-to-send.mjs or auto-tailor.mjs — until each posting has
 * been through the LLM evaluation step. So the sheet showed 4 actionable roles
 * while 1,542 sat in the queue untouched.
 *
 * That gap is not a bug in either piece; the two were built at different times
 * for different jobs. This bridges them WITHOUT spending a single token:
 *
 *   1. read every `## Pending` row
 *   2. pre-score it with role-score.mjs — the deterministic role-match / CTC /
 *      location scorer, plus the seniority gate and the excluded-title list
 *   3. drop anything gated or excluded
 *   4. check the survivors are still live (free — ATS API, then a 404 check)
 *   5. print a ranked list you can apply to right now
 *
 * WHAT THIS IS NOT: it is not the full evaluation. The pre-score cannot read a
 * JD, so it knows nothing about CV gaps, culture or red flags — see the header
 * of role-score.mjs, which is explicit that it is a triage tier and not a
 * replacement for the holistic 1-5 score. Treat the output as "worth ten
 * minutes and a base CV", not as "verified strong match".
 *
 * Usage:
 *   node queue-shortlist.mjs                 # 20 live roles, best first
 *   node queue-shortlist.mjs --need=30
 *   node queue-shortlist.mjs --min=3.0       # pre-score floor (default 3.0)
 *   node queue-shortlist.mjs --max-checks=80 # look deeper if many have expired
 *   node queue-shortlist.mjs --no-liveness   # skip the check, just rank
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { preScoreRole, loadProfile } from './role-score.mjs';
import { isStillLive } from './liveness-gate.mjs';

const ROOT = process.cwd();
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');

const arg = (name, def) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};

/**
 * Parse one `## Pending` line.
 *
 * Format, pipe-delimited and written by scan.mjs / paste-jobs.mjs:
 *   - [ ] <url> | <company> | <role> | <location> | posted: <date> | trust: ...
 *
 * Fields after the third are optional and vary by source, so everything is
 * read positionally for the first four and by prefix for the rest.
 */
function parseRow(line) {
  const m = line.match(/^- \[ \] (.+)$/);
  if (!m) return null;
  const parts = m[1].split('|').map((s) => s.trim());
  const [url, company, role, location] = parts;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const posted = (parts.find((p) => p.startsWith('posted:')) || '').replace('posted:', '').trim();
  const source = (parts.find((p) => p.startsWith('source:')) || '').replace('source:', '').trim();
  return { url, company: company || '', role: role || '', location: location || '', posted, source };
}

function daysOld(posted) {
  if (!posted) return null;
  const t = Date.parse(posted);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

async function main() {
  const need = Number(arg('need', 20)) || 20;
  const minScore = Number(arg('min', 3.0)) || 3.0;
  const maxChecks = Number(arg('max-checks', 60)) || 60;
  const noLiveness = process.argv.includes('--no-liveness');

  if (!existsSync(PIPELINE)) {
    console.error(`No ${path.relative(ROOT, PIPELINE)} — run the scan first.`);
    process.exit(1);
  }

  const text = readFileSync(PIPELINE, 'utf8');
  const pendingStart = text.indexOf('## Pending');
  const pendingEnd = text.indexOf('\n## ', pendingStart + 1);
  const pending = text.slice(pendingStart, pendingEnd === -1 ? undefined : pendingEnd);

  const profile = loadProfile();
  const rows = [];
  let gated = 0, excluded = 0, belowFloor = 0;

  for (const line of pending.split('\n')) {
    const r = parseRow(line);
    if (!r) continue;
    const v = preScoreRole({ title: r.role, company: r.company, location: r.location }, profile);
    if (v.tier.startsWith('EXCLUDED')) { excluded++; continue; }
    if (!v.gatePass) { gated++; continue; }
    if (v.preScore < minScore) { belowFloor++; continue; }
    rows.push({ ...r, score: v.preScore, tier: v.tier, matched: v.role.matchedOn, agency: v.agency, age: daysOld(r.posted) });
  }

  // Best score first; among equals, freshest first — a posting from today is
  // far likelier to still be open than one from three weeks ago, and that is
  // the single biggest predictor of whether an application can even land.
  rows.sort((a, b) => (b.score - a.score) || ((a.age ?? 999) - (b.age ?? 999)));

  console.log('='.repeat(78));
  console.log(`  QUEUE SHORTLIST — ${rows.length} candidate(s) above ${minScore}, hunting ${need} live`);
  console.log(`  from ${path.relative(ROOT, PIPELINE)}  ·  gated ${gated} · excluded ${excluded} · below floor ${belowFloor}`);
  console.log('='.repeat(78));

  const live = [];
  let checked = 0;
  for (const r of rows) {
    if (live.length >= need || checked >= maxChecks) break;
    if (noLiveness) { live.push(r); continue; }
    checked++;
    process.stdout.write(`  ${String(r.score).padStart(4)}  ${r.company.slice(0, 26).padEnd(28)} `);
    const v = await isStillLive(r.url);
    console.log(v.result === 'expired' ? `EXPIRED` : 'live');
    if (v.result !== 'expired') live.push(r);
  }

  console.log('\n' + '='.repeat(78));
  console.log(`  ${live.length} LIVE — apply to these`);
  console.log('='.repeat(78));

  const lines = [];
  live.forEach((r, i) => {
    const head = `${i + 1}. [${r.score}] ${r.company} — ${r.role}`;
    const meta = `   ${r.location || 'location not stated'}${r.age != null ? `  ·  ${r.age}d old` : ''}${r.agency ? '  ·  AGENCY-POSTED' : ''}`;
    console.log(`\n${head}`);
    console.log(meta);
    console.log(`   ${r.url}`);
    lines.push(`${head}\n${meta}\n   ${r.url}`);
  });

  const outFile = path.join(ROOT, 'local', `queue-shortlist-${new Date().toISOString().slice(0, 10)}.txt`);
  try {
    writeFileSync(outFile, lines.join('\n\n') + '\n', 'utf8');
    console.log(`\n  saved to ${path.relative(ROOT, outFile)}`);
  } catch { /* local/ may not exist — the console output is the deliverable */ }

  console.log('\n' + '-'.repeat(78));
  console.log('  These have NO tailored CV — apply with the base CV. The pre-score is');
  console.log('  triage (title, CTC, location), not a read of the job description.');
  console.log('-'.repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });
