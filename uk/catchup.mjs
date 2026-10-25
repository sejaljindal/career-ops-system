#!/usr/bin/env node
/**
 * catchup.mjs — the 07:00 completion pass that follows a 02:00 scan night.
 *
 * COMPLETION BEFORE DISCOVERY. Its job is to finish what the scan night
 * started, not to start anything new. Order is fixed:
 *
 *   1. tailoring   — CVs and cover letters for roles already scored 4.0+
 *   2. contacts    — outreach targets for pairs that have documents but no contact
 *   3. scanning    — ONLY if 1 and 2 are complete and budget remains
 *
 * If the 02:00 run finished everything, this exits immediately having written
 * nothing. That is the common case and it is not a failure.
 *
 * WHY THIS RESUMES RATHER THAN RESTARTS — the mechanism, not a promise:
 *
 *   Tailoring: auto-tailor.mjs selects candidates with
 *       score >= MIN_SCORE && !cvFile && !/^NOT A FIT/.test(notes)
 *     A role that already produced documents has a non-empty `CV File`, so it
 *     is not re-selected. A role already judged unfit carries a NOT A FIT note,
 *     so it is not re-judged. Only genuinely unprocessed roles remain, and they
 *     are walked in the sheet's existing score-descending order — so the
 *     ranked list continues from where it stopped rather than starting over.
 *
 *   Scanning: coverage-tracker.mjs orderQueue() sorts by
 *       (consecutive failures asc, last-scanned asc, name)
 *     with never-scanned records carrying scannedMs = 0, so they sort first.
 *     An employer scanned at 02:00 has a fresh timestamp and sinks to the back;
 *     one never reached keeps its old timestamp and stays at the front. There
 *     is no cursor, no batch number and nothing to reset — "resume" is just
 *     re-deriving the most-overdue N from current state.
 *
 * Usage:
 *   node catchup.mjs                 # full pass
 *   node catchup.mjs --dry-run       # report what it WOULD do, change nothing
 *   node catchup.mjs --budget=90     # minutes; default 120
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { isMainModule } from './lib/is-main-module.mjs';
import ExcelJS from 'exceljs';

const XLSX = 'output/pipeline.xlsx';
const PROGRESS = 'output/tailor-progress.json';
const BRIEF = 'output/morning_brief.md';
const LOG = 'output/catchup_log.txt';
const MIN_SCORE = 4.0;

const arg = (a, n, d = '') => {
  const m = a.find((x) => x.startsWith(`--${n}=`));
  return m ? m.slice(n.length + 3) : d;
};

/** How the 02:00 run ended, read from the brief it wrote. */
function lastRunStatus() {
  if (!existsSync(BRIEF)) return { status: 'unknown', text: '' };
  const text = readFileSync(BRIEF, 'utf8');
  if (/\*\*Run status:\*\*\s*finished cleanly/i.test(text)) return { status: 'clean', text };
  if (/stopped: usage limit reached/i.test(text)) return { status: 'limit', text };
  if (/stopped: error/i.test(text)) return { status: 'error', text };
  if (/RUN IN PROGRESS/i.test(text)) return { status: 'in-progress', text };
  return { status: 'unknown', text };
}

/** What is genuinely outstanding, read from the sheet rather than assumed. */
async function outstanding() {
  if (!existsSync(XLSX)) return { tailor: 0, contacts: 0, rows: [] };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.getWorksheet('Pipeline');
  const h = [];
  ws.getRow(1).eachCell((c, i) => { h[i - 1] = String(c.value ?? ''); });
  const col = (n) => h.indexOf(n) + 1;

  let tailor = 0, contacts = 0;
  const rows = [];
  ws.eachRow((r, n) => {
    if (n === 1) return;
    if (String(r.getCell(col('Status')).value ?? '').trim()) return;   // acted on — leave alone
    const score = Number(r.getCell(col('Score')).value);
    if (!(score >= MIN_SCORE)) return;
    const cv = String(r.getCell(col('CV File')).value ?? '').trim();
    const notes = String(r.getCell(col('Notes')).value ?? '').trim();
    const contact = String(r.getCell(col('Contact Name')).value ?? '').trim();
    // Same predicate auto-tailor uses — so this count cannot drift from what
    // a tailoring run would actually pick up.
    if (!cv && !/^NOT A FIT/.test(notes)) { tailor++; rows.push({ n, kind: 'tailor' }); }
    else if (cv && !contact) { contacts++; rows.push({ n, kind: 'contact' }); }
  });
  return { tailor, contacts, rows };
}

function run(label, cmd, args, dry) {
  if (dry) { console.log(`  [dry-run] would run: ${cmd} ${args.join(' ')}`); return { ok: true, out: '' }; }
  console.log(`  -> ${label}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) console.log(`     exited ${r.status}`);
  return { ok: r.status === 0, out };
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const budgetMin = Number(arg(args, 'budget', '120')) || 120;
  const deadline = Date.now() + budgetMin * 60000;
  const L = [];
  const say = (s) => { console.log(s); L.push(s); };

  say('='.repeat(66));
  say(`  catch-up pass — ${new Date().toISOString()}`);
  say('='.repeat(66));

  const last = lastRunStatus();
  const work = await outstanding();
  say(`  last 02:00 run  : ${last.status}`);
  say(`  tailoring due   : ${work.tailor}`);
  say(`  contacts due    : ${work.contacts}`);

  // REMOVED 2026-09-09, on the candidate's instruction: "don't block anything."
  //
  // This used to return early — "nothing outstanding, exit without scanning" —
  // which meant the BEST case (a clean night, all documents written) was the
  // one case that produced no new discovery at all. Combined with the backlog
  // skip below, there was no state in which the catch-up actually scanned.
  //
  // A second pass is cheap: run-daily.mjs makes no LLM call, and postings found
  // in the morning are postings that would otherwise wait a full day. So the
  // pass now always continues to step 3.
  if (last.status === 'clean' && work.tailor === 0 && work.contacts === 0) {
    say('');
    say('  Nothing outstanding — the 02:00 run completed and every scored role has');
    say('  its documents. Continuing to the scan anyway (no LLM cost).');
  }

  if (last.status === 'error') {
    say('');
    say('  ⚠️  The 02:00 run stopped on an ERROR, not a budget limit. Finishing the');
    say('     outstanding documents below, but NOT scanning — a fresh scan would');
    say('     most likely hit the same fault. Check the brief before the next run.');
  }

  // ── 1. tailoring (resumes: see the file header) ──
  if (work.tailor > 0) {
    say('');
    say(`  [1/3] tailoring — ${work.tailor} role(s) outstanding`);
    const r = run('auto-tailor', process.execPath, ['auto-tailor.mjs', '--limit=25'], dry);
    const made = Number((r.out.match(/documents generated\s*:\s*(\d+)/) || [])[1] ?? 0);
    const nf = Number((r.out.match(/marked NOT A FIT\s*:\s*(\d+)/) || [])[1] ?? 0);
    say(`        ${made} pair(s) generated, ${nf} marked NOT A FIT`);
  } else {
    say('');
    say('  [1/3] tailoring — nothing outstanding');
  }

  // ── 2. contacts ──
  const after = await outstanding();
  if (after.contacts > 0) {
    say('');
    say(`  [2/3] contacts — ${after.contacts} pair(s) without a contact`);
    let done = 0;
    for (const row of after.rows.filter((x) => x.kind === 'contact')) {
      if (Date.now() > deadline) { say('        budget reached — stopping contacts here'); break; }
      const r = run(`outreach row ${row.n}`, process.execPath, ['outreach.mjs', String(row.n)], dry);
      if (r.ok) done++;
    }
    say(`        ${done} contact block(s) written`);
  } else {
    say('');
    say('  [2/3] contacts — nothing outstanding');
  }

  // ── 3. scanning, LAST and only if the above is clear ──
  const final = await outstanding();
  const budgetLeft = Date.now() < deadline;
  say('');
  // CHANGED 2026-09-09, on the candidate's instruction: "don't block anything."
  //
  // The original rule was "completion before discovery" — step 3 was skipped
  // whenever ANY tailoring or contact item was outstanding. In practice that
  // blocked discovery indefinitely: 51 rows sat without a contact, so the scan
  // was skipped every single night and the catch-up path never found a role.
  //
  // Backlogs are now reported, never blocking. Both tailoring and contacts are
  // resumable — the next pass picks up exactly where this one stopped — so a
  // backlog costs nothing by being carried, while a skipped scan costs a whole
  // day of postings that expire.
  //
  // The two REAL reasons to skip remain, and neither is a backlog:
  //   - the previous run died on an ERROR (a fresh scan would hit the fault)
  //   - the time budget is genuinely gone
  if (final.tailor > 0 || final.contacts > 0) {
    say(`  note: ${final.tailor} tailoring + ${final.contacts} contact item(s) still`);
    say('        outstanding. Both resume next pass; neither blocks the scan.');
  }
  if (last.status === 'error') {
    say('  [3/3] scanning — SKIPPED. Previous run failed with an error, not a limit.');
  } else if (!budgetLeft) {
    say('  [3/3] scanning — SKIPPED. Time budget exhausted by the steps above.');
  } else {
    const mins = Math.max(1, Math.round((deadline - Date.now()) / 60000));
    say(`  [3/3] scanning — ~${mins} min of budget left.`);
    run('run-daily', process.execPath, ['run-daily.mjs', '--mode=register-only', '--skip-tailor'], dry);
  }

  say('');
  say('='.repeat(66));
  if (!dry) writeFileSync(LOG, L.join('\n') + '\n', 'utf8');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
