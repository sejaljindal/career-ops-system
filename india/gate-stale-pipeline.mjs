// One-off: apply the Step 1 freshness hard gate (modes/_profile.md, "Posting older
// than 7 days") to data/pipeline.md before running the full A-G evaluation loop.
// Moves stale dated entries straight to Processed with no report/score claimed.
import { readFileSync, writeFileSync, appendFileSync } from 'fs';

const path = 'data/pipeline.md';
const discardLogPath = 'data/discard.log';
const today = new Date('2026-10-13T00:00:00Z');
const CUTOFF_DAYS = 7;
const nowIso = new Date().toISOString();

const raw = readFileSync(path, 'utf8');
const lines = raw.split('\n');

const pendingHeaderIdx = lines.findIndex(l => l.trim() === '## Pending');
const processedHeaderIdx = lines.findIndex(l => l.trim() === '## Processed');

const before = lines.slice(0, pendingHeaderIdx + 1);
const pendingBlock = lines.slice(pendingHeaderIdx + 1, processedHeaderIdx);
const processedAndAfter = lines.slice(processedHeaderIdx);

const keptPending = [];
const gated = [];
let staleCount = 0, keptCount = 0;

for (const line of pendingBlock) {
  const m = line.match(/^- \[ \] (\S+)(.*)$/);
  if (!m) { keptPending.push(line); continue; } // blank lines / non-entry lines pass through
  const url = m[1];
  const rest = m[2];
  const postedMatch = rest.match(/\|\s*posted:\s*(\d{4}-\d{2}-\d{2})/);
  const cols = rest.split('|').map(s => s.trim()).filter(Boolean);
  const company = cols[0] || '';
  const role = cols[1] || '';

  if (postedMatch) {
    const posted = new Date(postedMatch[1] + 'T00:00:00Z');
    const ageDays = Math.round((today - posted) / 86400000);
    if (ageDays > CUTOFF_DAYS) {
      staleCount++;
      const reason = `Step 1 gate: posting ${ageDays}d old, posted ${postedMatch[1]}, >${CUTOFF_DAYS}-day freshness cutoff`;
      gated.push(`- [x] #-- | ${url} | ${company} | ${role} | skipped (${reason})`);
      appendFileSync(discardLogPath, `${nowIso}\t${url}\t${reason}\n`);
      continue;
    }
  }
  keptCount++;
  keptPending.push(line);
}

const out = [
  ...before,
  '',
  ...keptPending,
  '',
  ...processedAndAfter.slice(0, 1), // '## Processed'
  '',
  ...gated,
  ...processedAndAfter.slice(1),
];

writeFileSync(path, out.join('\n'));
console.log(JSON.stringify({ staleGated: staleCount, keptPending: keptCount }, null, 2));
