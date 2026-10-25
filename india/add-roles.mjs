#!/usr/bin/env node
/**
 * add-roles.mjs — paste roles you found yourself; the gate decides. INDIA.
 *
 * WHY
 *
 * Everything the pipeline offers comes from a board scan or an agent scan.
 * When the candidate finds a role herself — a LinkedIn post, a company page, a
 * referral — there was nowhere to put it. It got tailored by hand or forgotten.
 *
 * HOW TO USE IT
 *
 *   1. Open  local\my-roles.txt
 *   2. Paste one role per line, in either form:
 *
 *        https://db.wd3.myworkdayjobs.com/.../Business-Management-Analyst_R123
 *        Deutsche Bank | Business Management Analyst | https://db.wd3...
 *
 *      Lines starting with # are ignored.
 *
 *   3. Run:  node add-roles.mjs
 *
 * Each role goes through eligibility.mjs — the India gate, which contains no
 * visa, sponsorship or work-authorisation logic of any kind and checks Indian
 * qualifications (CA/ICAI, CS/ICSI, CMA/ICMAI, CFA).
 *
 * Nothing is special-cased because you found it. Roles that PASS are appended
 * to output/AGENT-SCAN-MANUAL-<date>.md, which tailor-cv.mjs and
 * ready-to-send.mjs already read — so a passing role gets a tailored CV and
 * reaches the send list with nothing else wired up.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { checkEligibility } from './eligibility.mjs';
import { fetchJd } from './jd-keywords.mjs';

const ROOT = process.cwd();
const INPUT = path.join(ROOT, 'local', 'my-roles.txt');
const OUT = path.join(ROOT, 'output');

const today = new Date().toISOString().slice(0, 10);
const REPORT = path.join(OUT, `AGENT-SCAN-MANUAL-${today}.md`);

if (!existsSync(INPUT)) {
  writeFileSync(INPUT, `# Paste roles you found, one per line.
#
#   https://employer.com/jobs/123
#   Company | Role title | https://employer.com/jobs/123
#
# The second form is better: the gate can judge the title even if the page
# cannot be fetched. Lines starting with # are ignored.
#
# Then run:  node add-roles.mjs
`);
  console.log(`Created ${path.relative(ROOT, INPUT)} — paste your roles into it, then run this again.`);
  process.exit(0);
}

/** Pull <title> from a page when the line gives no company or role. */
async function titleOf(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    const m = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
    if (!m) return '';
    return m[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').trim();
  } catch { return ''; }
}

const lines = readFileSync(INPUT, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

if (!lines.length) {
  console.log(`Nothing in ${path.relative(ROOT, INPUT)} yet.`);
  process.exit(0);
}

console.log(`\n${lines.length} role(s) to check.\n`);

const passed = []; const failed = []; const unreadable = [];

for (const line of lines) {
  let company = '', role = '', url = '';

  if (line.includes('|')) {
    const parts = line.split('|').map((p) => p.trim());
    url = parts.find((p) => /^https?:\/\//.test(p)) || '';
    const rest = parts.filter((p) => p !== url);
    company = rest[0] || '';
    role = rest[1] || '';
  } else {
    url = line;
  }

  if (!/^https?:\/\//.test(url)) {
    unreadable.push({ line, why: 'no URL on this line' });
    continue;
  }

  if (!role) {
    const t = await titleOf(url);
    if (!t) {
      unreadable.push({ line, why: 'page would not load — add "Company | Role |" in front of the URL' });
      continue;
    }
    const split = t.split(/\s+[-–—|]\s+|\s+\bat\b\s+/);
    role = (split[0] || t).trim();
    if (!company) company = (split[1] || new URL(url).hostname.replace(/^www\./, '').split('.')[0]).trim();
  }
  if (!company) company = new URL(url).hostname.replace(/^www\./, '').split('.')[0];

  const jd = await fetchJd(url).catch(() => ({ text: '' }));
  const e = checkEligibility(role, jd?.text || '');

  if (e.ok) {
    passed.push({ company, role, url, e });
    console.log(`  PASS  [T${e.tier}] ${company} — ${role}${e.stretch ? `   ⚠ ${e.reason}` : ''}`);
  } else {
    failed.push({ company, role, url, e });
    console.log(`  BLOCK       ${company} — ${role}\n              ${e.reason}`);
  }
}

if (unreadable.length) {
  console.log('\nCould not read these lines:');
  for (const u of unreadable) console.log(`  - ${u.line}\n      ${u.why}`);
}

if (!passed.length) {
  console.log(`\nNothing passed the gate. ${failed.length} blocked.`);
  console.log('If a block looks wrong, tell Claude — the gate being wrong is worth');
  console.log('fixing once for every future role rather than overriding here.\n');
  process.exit(0);
}

if (!existsSync(REPORT)) {
  writeFileSync(REPORT, `# ROLES ADDED BY HAND — ${today}\n\n`
    + `Pasted into local/my-roles.txt and passed through the same eligibility\n`
    + `gate as every automated scan.\n\n`
    + `| Company | Role | Location | Age | Band | Link |\n|---|---|---|---|---|---|\n`);
}

const existing = readFileSync(REPORT, 'utf8');
let added = 0;
for (const p of passed) {
  if (existing.includes(p.url)) continue;
  appendFileSync(REPORT, `| ${p.company} | ${p.role} | — | — | — | ${p.url} |\n`);
  added++;
}

console.log(`\n${passed.length} passed, ${failed.length} blocked.`);
console.log(`${added} new row(s) written to output/${path.basename(REPORT)}\n`);
console.log('Next:');
console.log(`  node tailor-cv.mjs --from-agents=${path.basename(REPORT)} --need=50 --no-liveness --skip-existing`);
console.log('  node ready-to-send.mjs --need=25 --max-checks=70\n');
