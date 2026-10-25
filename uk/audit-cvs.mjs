#!/usr/bin/env node
/**
 * audit-cvs.mjs — run the eligibility gate over every CV already on disk.
 *
 * WHY
 *
 * The gate in eligibility.mjs stops BAD roles getting a CV from now on. It does
 * nothing about the ones already written. On 2026-09-12 there were 190 tailored
 * CVs in the UK output folder, produced over weeks by a selection path that
 * applied none of the candidate's constraints. Among them: a Threat Intelligence
 * Analyst, an "SC Cleared Business Analyst — Central Government", an NHS Band 5
 * Lead, a Senior Commercial Manager, an Operational Excellence Manager (Lean
 * Manufacturing), a Mandarin-speaking Management Reporting Analyst, and several
 * Project Accountant roles.
 *
 * A folder where most files are unusable is worse than an empty one, because
 * every morning it costs her the time to work out which is which. That was my
 * doing and this undoes it.
 *
 * The role title is recovered from the filename, which is Company_Role_CV.docx
 * with every run of non-alphanumeric characters collapsed to a hyphen. Turning
 * the hyphens back into spaces is lossy, but it is lossy in a way that does not
 * matter here: every pattern in eligibility.mjs matches on words, and the words
 * survive.
 *
 * NOTHING IS DELETED. --move relocates failures to output/_disqualified/, so
 * any judgement of mine you disagree with is one drag away from being undone.
 *
 * Usage:
 *   node audit-cvs.mjs                 report only, changes nothing
 *   node audit-cvs.mjs --move          move failures to output/_disqualified/
 *   node audit-cvs.mjs --move --covers also move the matching _Cover.docx
 */

import { readdirSync, mkdirSync, renameSync, existsSync } from 'fs';
import path from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { checkEligibility } from './eligibility.mjs';

// Data Root, not the codebase root — output/ is user-layer, so it must
// follow CAREER_OPS_ROOT/.career-ops-data (#drift-guard).
const ROOT = getCareerOpsRoot();
const OUT = path.join(ROOT, 'output');
const QUARANTINE = path.join(OUT, '_disqualified');

const doMove = process.argv.includes('--move');
const doCovers = process.argv.includes('--covers');

/** "Lane-Clark-and-Peacock-LLP_FP-and-A-Manager_CV.docx" -> "FP and A Manager" */
function roleFromFilename(file) {
  const stem = file.replace(/_CV\.docx$/i, '');
  const i = stem.indexOf('_');
  if (i === -1) return stem.replace(/-/g, ' ');
  return stem.slice(i + 1).replace(/-/g, ' ');
}

function companyFromFilename(file) {
  const stem = file.replace(/_CV\.docx$/i, '');
  const i = stem.indexOf('_');
  return (i === -1 ? stem : stem.slice(0, i)).replace(/-/g, ' ');
}

/**
 * Two things in output/ are not tailored CVs and must not be audited:
 *
 *   ~$Something_CV.docx   Word's lock file for a document you have open. The
 *                         first run reported "~$rward Role — Business Analyst"
 *                         as a keeper, which is a lock file, not a CV.
 *   FirstName-LastName_CV.docx  the untailored base CV. It has no role in its name,
 *                         so the auditor read the company as the role and
 *                         reported "Your Name — Your Name" as
 *                         disqualified.
 */
const files = readdirSync(OUT)
  .filter((f) => /_CV\.docx$/i.test(f))
  .filter((f) => !f.startsWith('~$'))
  .filter((f) => !/^FirstName_LastName_CV\.docx$/i.test(f));

const keep = []; const cut = [];
for (const f of files) {
  const role = roleFromFilename(f);
  const company = companyFromFilename(f);
  // No JD text available here — only the title. That is enough: every role
  // that should never have been tailored was identifiable from its title.
  const e = checkEligibility(role, '', company);
  (e.ok ? keep : cut).push({ f, company, role, e });
}

// ── report ───────────────────────────────────────────────────────────────

console.log(`\n${files.length} tailored CV(s) in output/\n`);

const byReason = new Map();
for (const c of cut) {
  if (!byReason.has(c.e.reason)) byReason.set(c.e.reason, []);
  byReason.get(c.e.reason).push(c);
}

console.log('='.repeat(74));
console.log(`  DISQUALIFIED — ${cut.length}`);
console.log('='.repeat(74));
for (const [reason, list] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  ${reason}  (${list.length})`);
  for (const c of list) console.log(`    ${c.company} — ${c.role}`);
}

const tiers = new Map();
for (const k of keep) {
  if (!tiers.has(k.e.tier)) tiers.set(k.e.tier, []);
  tiers.get(k.e.tier).push(k);
}
const TIER_NAME = {
  1: 'PROJECT MANAGEMENT / PMO / PROJECT CONTROLS',
  2: 'STRATEGY',
  3: 'TRANSFORMATION / MANAGEMENT CONSULTING',
  4: 'BUSINESS ANALYST (business/management only)',
};

console.log(`\n${'='.repeat(74)}`);
console.log(`  KEEP — ${keep.length}, in her priority order`);
console.log('='.repeat(74));
for (const n of [1, 2, 3, 4]) {
  const list = tiers.get(n) || [];
  if (!list.length) continue;
  console.log(`\n  TIER ${n} — ${TIER_NAME[n]}  (${list.length})`);
  for (const k of list.sort((a, b) => Number(a.e.stretch) - Number(b.e.stretch))) {
    console.log(`    ${k.e.stretch ? '~' : ' '} ${k.company} — ${k.role}${k.e.stretch ? `   [${k.e.reason}]` : ''}`);
  }
}

console.log(`\n  ~ marks a stretch: a senior-grade title or a stated 5+ years.`);

// ── move ─────────────────────────────────────────────────────────────────

if (!doMove) {
  console.log(`\n${cut.length} of ${files.length} would be moved out.`);
  console.log('Re-run with --move to relocate them to output/_disqualified/');
  console.log('(a move, not a delete — drag anything back if you disagree).');
  console.log('Add --covers to move the matching cover letters too.\n');
} else {
  mkdirSync(QUARANTINE, { recursive: true });
  let moved = 0, locked = 0;
  for (const c of cut) {
    const targets = [c.f];
    if (doCovers) targets.push(c.f.replace(/_CV\.docx$/i, '_Cover.docx'));
    for (const t of targets) {
      const from = path.join(OUT, t);
      if (!existsSync(from)) continue;
      try { renameSync(from, path.join(QUARANTINE, t)); moved++; } catch (err) {
        // Word holds an exclusive handle on an open document.
        if (err?.code === 'EACCES' || err?.code === 'EBUSY' || err?.code === 'EPERM') { locked++; continue; }
        throw err;
      }
    }
  }
  console.log(`\n${moved} file(s) moved to output/_disqualified/${locked ? ` · ${locked} locked (open in Word)` : ''}`);
  console.log(`output/ now holds ${keep.length} CV(s), all gate-passed.\n`);
}
