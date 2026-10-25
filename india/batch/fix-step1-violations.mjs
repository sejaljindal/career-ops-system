import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const violations = JSON.parse(readFileSync('batch/step1-violations.json', 'utf8'));
const evalList = readFileSync('batch/evaluated-list.tsv', 'utf8').split('\n').filter(Boolean);
const linkByNum = {};
for (const l of evalList) {
  const [num, score, company, role, link] = l.split('\t');
  const m = link.match(/\((.*?)\)/);
  linkByNum[num] = { path: m[1].replace(/^\.\.\//, ''), score, company, role };
}

for (const v of violations) {
  const info = linkByNum[v.num];
  if (!info) { console.log('NO LINK FOR', v.num); continue; }
  let text = readFileSync(info.path, 'utf8');

  // Insert a correction notice right after the header block (before the first '---')
  const correctionNote = `\n## CORRECTION (2026-10-12)\n\nThis report originally carried a score of ${info.score}, but it should never have been scored at all: the JD states an experience floor of ${v.floor}+ years (see the Seniority row below), which fails Step 1 Check 1 in \`modes/_profile.md\` ("floor above 3 → FAIL... stop before Block B, no report, no score"). The original Block A-F content below is left intact for reference, but it was produced in violation of that gate and should not be used to judge this role's fit. **Corrected status: SKIP, no valid score.**\n`;

  const splitIdx = text.indexOf('\n---\n');
  if (splitIdx !== -1) {
    text = text.slice(0, splitIdx) + correctionNote + text.slice(splitIdx);
  } else {
    text += correctionNote;
  }
  // Also patch the header Score: line so a casual grep doesn't pick up the stale score
  text = text.replace(/^\*\*Score:\*\* .*/m, `**Score:** N/A — CORRECTED, see correction notice (was ${info.score}, invalid: Step 1 floor >3yrs)`);

  writeFileSync(info.path, text);
  console.log('patched report', v.num, info.path);

  try {
    execSync(`node set-status.mjs --report ${v.num} SKIP --note "CORRECTED 2026-10-12: Step 1 hard gate floor=${v.floor}yrs >3, score was invalid and removed"`, { stdio: 'inherit' });
  } catch (e) {
    console.log('set-status failed for', v.num, e.message);
  }
}
