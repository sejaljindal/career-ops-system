#!/usr/bin/env node
// run-daily.mjs — one-command daily India pipeline run.
//
// Orchestrates the mechanical steps end to end:
//   1. Parse --sector / --tier / --max (passed straight through to
//      coverage.mjs's own flags).
//   2. Scan: `node coverage.mjs [flags]` — priority-list batch scan
//      (oldest-scanned-first) + keyword sweep + coverage_india.csv update.
//      All mechanical, already built.
//   3. Evaluate newly-queued postings (OPT-IN, `--eval`, off by default):
//      spawns a headless Claude Code worker (`claude -p "..."`, per
//      AGENTS.md's documented headless-worker pattern) to run the real
//      Blocks A-G evaluation against cv.md/modes/_profile.md. This is the
//      one step that needs actual AI judgment, not scripting — a plain
//      script cannot score a JD against a CV. It also costs real API usage,
//      which is why it's opt-in rather than silently running every day.
//      Without --eval, newly-scanned postings sit queued in
//      data/pipeline.md for you (or an interactive `/career-ops pipeline`
//      run) to evaluate whenever you choose.
//   4. Export: `node export-excel.mjs` — rebuilds pipeline_india.xlsx from
//      whatever is currently scored in reports/.
//   5. Tailor: `node auto-tailor.mjs --select --limit 10` — mechanical
//      SELECT phase only (fetches JD text, writes work-bundles). Actually
//      writing CV.docx/Cover.docx content needs the same judgment step as
//      scoring; see auto-tailor.mjs's own header. This step just prepares
//      the bundles so that judgment pass has something to work from.
//   6. Print + write the daily summary log (terminal + output/daily_log_india.txt).
//
// Usage:
//   node run-daily.mjs [--sector="X"] [--tier=N] [--max=N] [--eval] [--keyword-sweep] [--skip-tailor]
//
// Default scan scope is the priority-list batch only (coverage.mjs
// --priority-only) — pass --keyword-sweep to also run the full ATS
// keyword-first discovery pass (slower, and bulk-appends newly found
// employers to india_targets.csv without a review step).

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import ExcelJS from 'exceljs';
import { scopeCheck } from './experience-gate.mjs';
import { preScoreRole, isExcludedTitle, loadProfile } from './role-score.mjs';

const ROOT = process.cwd();
const COVERAGE_CSV = path.join(ROOT, 'output', 'coverage_india.csv');
const PIPELINE_PATH = path.join(ROOT, 'data', 'pipeline.md');
const XLSX_PATH = path.join(ROOT, 'output', 'pipeline_india.xlsx');
const LOG_PATH = path.join(ROOT, 'output', 'daily_log_india.txt');
const SHEET_NAME = 'Pipeline (India)';
const DEFAULT_MAX = 50;
const TAILOR_LIMIT = 10;

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { max: DEFAULT_MAX };
  for (const a of argv) {
    if (a === '--eval') opts.eval = true;
    else if (a === '--keyword-sweep') opts.keywordSweep = true;
    else if (a === '--skip-tailor') opts.skipTailor = true;
    else if (a.startsWith('--sector=')) opts.sector = a.slice('--sector='.length).replace(/^"|"$/g, '');
    else if (a.startsWith('--tier=')) opts.tier = a.slice('--tier='.length);
    else if (a.startsWith('--max=')) opts.max = parseInt(a.slice('--max='.length), 10) || DEFAULT_MAX;
  }
  return opts;
}

// ── CSV/TSV helpers ──────────────────────────────────────────────────────

function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function readCoverageSnapshot() {
  if (!existsSync(COVERAGE_CSV)) return null;
  const lines = readFileSync(COVERAGE_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = lines.slice(1).map(l => parseCsvLine(l));
  const total = rows.length;
  const neverScanned = rows.filter(r => (r[idx['Last Status']] || 'never') === 'never').length;
  const scanned = total - neverScanned;
  return { total, scanned, neverScanned };
}

function countPendingRows() {
  if (!existsSync(PIPELINE_PATH)) return 0;
  const content = readFileSync(PIPELINE_PATH, 'utf8');
  return (content.match(/^- \[ \]/gm) || []).length;
}

// Tallies what happened to postings moved into ## Processed since `since`
// (an ISO date string) — used to report "passed gate / deleted and why"
// after an --eval run. Best-effort text classification of the same
// gate-reason phrasing the evaluation workers write (see eval-worker
// conventions established earlier this session).
function tallyProcessedSince(sinceDateIso) {
  if (!existsSync(PIPELINE_PATH)) return { scored: 0, gated: 0, dead: 0, unreachable: 0 };
  const content = readFileSync(PIPELINE_PATH, 'utf8');
  const processedIdx = content.indexOf('## Processed');
  const section = processedIdx >= 0 ? content.slice(processedIdx) : '';
  const lines = section.split(/\r?\n/).filter(l => l.startsWith('- [x]'));
  let scored = 0, gated = 0, dead = 0, unreachable = 0;
  for (const line of lines) {
    if (!line.includes(sinceDateIso)) continue; // crude same-day filter; good enough for a daily digest
    if (/\d\.\d\/5/.test(line)) scored++;
    else if (/gated at Step 1/i.test(line)) gated++;
    else if (/posting expired/i.test(line)) dead++;
    else if (/content inaccessible/i.test(line)) unreachable++;
  }
  return { scored, gated, dead, unreachable };
}

// ── Spawn helpers ────────────────────────────────────────────────────────

// On win32 with shell:true, spawnSync joins args into one command-line
// string WITHOUT quoting them — an arg containing spaces (the --eval prompt
// below is a full sentence) gets split into separate tokens by cmd.exe, so
// `claude -p` only ever received the prompt's first word ("Run"), and the
// headless worker replied asking what "Run" meant instead of evaluating
// anything. Found 2026-09-05: --eval had never actually scored a posting on
// Windows because of this. Quote any arg containing whitespace ourselves.
function winQuoteArg(arg) {
  const s = String(arg);
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  // shell:true only for the `claude` CLI (a .cmd shim on Windows) — plain
  // `node` invocations need no shell, and shell:true with unescaped args is
  // an injection risk Node itself warns about, so it's scoped narrowly.
  const needsShell = process.platform === 'win32' && cmd === 'claude';
  const finalArgs = needsShell ? args.map(winQuoteArg) : args;
  const res = spawnSync(cmd, finalArgs, { stdio: 'inherit', cwd: ROOT, shell: needsShell, ...opts });
  if (res.status !== 0) {
    console.error(`Warning: "${cmd} ${args.join(' ')}" exited with code ${res.status}. Continuing — the daily log will reflect whatever state exists.`);
  }
  return res.status === 0;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ── Step 2.5: deterministic seniority pre-gate ──────────────────────────
//
// Added 2026-09-04. WHY THIS EXISTS, and why it is here rather than inside
// the eval worker:
//
// India's architecture differs from UK's. UK's run-daily.mjs scores
// in-process and calls experienceGate() directly at its scoring loop. India
// does NOT score in-process at all — it spawns a headless `claude -p` worker
// which applies the Step 1 hard gate by READING modes/_profile.md. That gate
// therefore only fires if the worker actually reads and applies the file.
// It demonstrably did not: "Associate Director", "Senior Manager, Business
// Planning & Analysis" and "Lending Lead Analyst – Vice President" all
// reached the sheet scored and un-gated.
//
// This pass closes that hole deterministically. It runs the SAME
// scopeCheck() the UK pipeline uses, on the title only, before the worker is
// spawned — so a Director/VP/Senior Manager requisition can never reach the
// scoring step regardless of what any agent does or doesn't read.
//
// It also saves real money: every pending row sent to the worker costs API
// usage. Gating them here means they are never paid for.
//
// TITLE-ONLY on purpose. data/pipeline.md holds no JD body, so the numeric
// half of the gate (the "3-6 years" check) cannot run here — it stays with
// the worker, which does fetch the JD. This pass is the floor, not the
// whole gate.
//
// Writes the same "gated at Step 1 (modes/_profile.md Hard Gate)" phrasing
// the worker uses, so tallyProcessedSince() counts these correctly and the
// daily log stays honest about why a posting was dropped.
function preGateBySeniority() {
  if (!existsSync(PIPELINE_PATH)) return { gated: 0, examples: [] };
  const original = readFileSync(PIPELINE_PATH, 'utf8');

  // Safety copy before any mutation of a data file.
  try { writeFileSync(`${PIPELINE_PATH}.bak`, original, 'utf8'); } catch { /* non-fatal */ }

  const lines = original.split(/\r?\n/);
  const kept = [];
  const newlyGated = [];
  const today = todayIso();

  for (const line of lines) {
    if (!line.startsWith('- [ ]')) { kept.push(line); continue; }
    // - [ ] URL | Company | Title | Location | posted: YYYY-MM-DD
    const parts = line.slice('- [ ]'.length).split('|').map(s => s.trim());
    const [url, company, title] = [parts[0] || '', parts[1] || '', parts[2] || ''];
    if (!title) { kept.push(line); continue; }

    const scope = scopeCheck(title, '');
    if (scope.pass) { kept.push(line); continue; }

    newlyGated.push(
      `- [x] #-- | ${url} | ${company} | ${title} — gated at Step 1 `
      + `(modes/_profile.md Hard Gate): ${scope.reason}. Deterministic `
      + `title-only seniority pre-gate (experience-gate.mjs scopeCheck), `
      + `applied ${today} before evaluation; not scored, no report generated, `
      + `no API usage spent. The JD body was not read, so the numeric `
      + `years-of-experience half of the gate did not run on this row.`,
    );
  }

  if (!newlyGated.length) return { gated: 0, examples: [] };

  // Append to the ## Processed section, creating it if absent.
  let out = kept.join('\n');
  if (out.includes('## Processed')) {
    out = out.replace('## Processed', `## Processed\n\n${newlyGated.join('\n')}`);
  } else {
    out = `${out}\n\n## Processed\n\n${newlyGated.join('\n')}\n`;
  }
  writeFileSync(PIPELINE_PATH, out, 'utf8');

  return {
    gated: newlyGated.length,
    examples: newlyGated.slice(0, 5).map((l) => {
      const m = l.match(/\| ([^|]+) \| ([^—]+)—/);
      return m ? `${m[1].trim()} — ${m[2].trim()}` : '';
    }).filter(Boolean),
  };
}

// ── Step 2.6: excluded-titles pre-gate + role/CTC/location pre-score ────
//
// Added 2026-09-07. Two distinct things, both in-process (role-score.mjs),
// both running before the paid --eval step:
//
// 1. A HARD gate on config/profile.yml's excluded_titles (Graduate, Intern,
//    Management Trainee, campus schemes, ...). This is NOT covered by the
//    seniority pre-gate above — scopeCheck() only looks for TOO-SENIOR
//    signals (Director/VP/Senior Manager), so a graduate scheme sailed
//    through it untouched and reached the paid eval step. Mirrors
//    preGateBySeniority()'s exact mechanics (safety copy, same
//    ## Processed phrasing convention) so tallyProcessedSince() and the
//    daily log stay consistent.
//
// 2. A SOFT pre-score (role-match + CTC-band + location-band, via
//    role-score.mjs) attached to every surviving pending row for
//    prioritization only — it never removes a row. Role-title matching is
//    heuristic (word-overlap against a curated but non-exhaustive target
//    list); a low pre-score is a signal to look first at the top of the
//    list, not proof a role is a bad fit. Only the excluded_titles list
//    above is trusted enough to gate on outright.
function preFilterExcludedTitles() {
  if (!existsSync(PIPELINE_PATH)) return { gated: 0, examples: [] };
  const original = readFileSync(PIPELINE_PATH, 'utf8');
  try { writeFileSync(`${PIPELINE_PATH}.bak`, original, 'utf8'); } catch { /* non-fatal */ }

  const lines = original.split(/\r?\n/);
  const kept = [];
  const newlyGated = [];
  const today = todayIso();
  const profile = loadProfile();

  for (const line of lines) {
    if (!line.startsWith('- [ ]')) { kept.push(line); continue; }
    const parts = line.slice('- [ ]'.length).split('|').map(s => s.trim());
    const [url, company, title] = [parts[0] || '', parts[1] || '', parts[2] || ''];
    if (!title || !isExcludedTitle(title, profile)) { kept.push(line); continue; }

    newlyGated.push(
      `- [x] #-- | ${url} | ${company} | ${title} — gated at Step 1 `
      + `(config/profile.yml excluded_titles): title matches the excluded-titles `
      + `list. Deterministic title-only pre-gate (role-score.mjs isExcludedTitle), `
      + `applied ${today} before evaluation; not scored, no report generated, `
      + `no API usage spent.`,
    );
  }

  if (!newlyGated.length) return { gated: 0, examples: [] };

  let out = kept.join('\n');
  if (out.includes('## Processed')) {
    out = out.replace('## Processed', `## Processed\n\n${newlyGated.join('\n')}`);
  } else {
    out = `${out}\n\n## Processed\n\n${newlyGated.join('\n')}\n`;
  }
  writeFileSync(PIPELINE_PATH, out, 'utf8');

  return {
    gated: newlyGated.length,
    examples: newlyGated.slice(0, 5).map((l) => {
      const m = l.match(/\| ([^|]+) \| ([^—]+)—/);
      return m ? `${m[1].trim()} — ${m[2].trim()}` : '';
    }).filter(Boolean),
  };
}

/**
 * Reads current pending rows and attaches a role/CTC/location pre-score to
 * each — sorted highest first. Advertised comp is essentially never present
 * in data/pipeline.md (no JD body has been fetched yet), so the CTC term of
 * every pre-score here is the neutral "unknown" band by construction; role
 * match and location are the two terms doing real work at this stage.
 */
function preScorePendingRows() {
  if (!existsSync(PIPELINE_PATH)) return [];
  const content = readFileSync(PIPELINE_PATH, 'utf8');
  const profile = loadProfile();
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('- [ ]')) continue;
    const parts = line.slice('- [ ]'.length).split('|').map(s => s.trim());
    const [url, company, title, location] = [parts[0] || '', parts[1] || '', parts[2] || '', parts[3] || ''];
    if (!title) continue;
    const remote = /\bremote\b/i.test(location) || /\bremote\b/i.test(title);
    const result = preScoreRole({ title, location, remote, company }, profile);
    rows.push({ url, company, title, location, ...result });
  }
  return rows.sort((a, b) => b.preScore - a.preScore);
}

// ── Step 3: opt-in headless evaluation ──────────────────────────────────

// Found 2026-09-05: this call previously carried NO --allowedTools at all,
// so the headless worker hit an unattended approval wall the moment it
// tried to run reserve-report-num.mjs (or any other tool), and silently did
// nothing. This scoped allowlist mirrors run-overnight-india.bat's
// Bash(npm run %NPMSCRIPT%) pattern: every Bash entry names one specific
// script the pipeline mode (modes/pipeline.md -> auto-pipeline.md -> oferta.md
// Block G -> pdf.md -> tracker.md) actually shells out to, verified by
// reading those mode files. Deliberately NOT --dangerously-skip-permissions
// or --permission-mode bypassPermissions: a blanket bypass would also grant
// browser/form-submit capability, which AGENTS.md's Ethical Use section
// forbids running unattended ("NEVER submit an application without the user
// reviewing it first"). No git, no Playwright (headless mode has none per
// AGENTS.md's own documented "unconfirmed (batch mode)" exception).
const EVAL_ALLOWED_TOOLS = [
  'Bash(node check-liveness.mjs*)',
  'Bash(node reserve-report-num.mjs*)',
  'Bash(node cv-sync-check.mjs*)',
  'Bash(node jd-skill-gap.mjs*)',
  'Bash(node cv-templates.mjs*)',
  'Bash(node build-cv-html.mjs*)',
  'Bash(node verify-cv-facts.mjs*)',
  'Bash(node generate-pdf.mjs*)',
  'Bash(node find.mjs*)',
  'Bash(node merge-tracker.mjs*)',
  'Bash(node set-status.mjs*)',
  'Bash(node verify-pipeline.mjs*)',
  'Bash(npm run jd:similarity*)',
  'WebFetch',
  'WebSearch',
  'Read',
  'Edit',
  'Write',
].join(',');

function runHeadlessEval(pendingCountBefore) {
  if (pendingCountBefore === 0) {
    console.log('\nNo new pending postings to evaluate — skipping headless worker.');
    return;
  }
  console.log(`\n--eval passed: spawning a headless Claude Code worker to evaluate ${pendingCountBefore} pending posting(s).`);
  console.log('This makes real API calls (Blocks A-G judgment against cv.md/modes/_profile.md, per posting) — it is not free.');
  const prompt = 'Run the career-ops pipeline mode for data/pipeline.md — evaluate every pending URL through the full Blocks A-G pipeline, applying the Step 1 hard gate from modes/_profile.md. Do not ask for confirmation; process every pending URL in this single run.';
  const ok = run('claude', ['-p', prompt, '--allowedTools', EVAL_ALLOWED_TOOLS]);
  if (!ok) {
    console.error('Headless evaluation did not complete cleanly — check output above. The daily log below reflects whatever state exists now, which may be partial.');
  }
}

// ── Step 7: read the freshly-exported xlsx for the log's stats ─────────

/**
 * Unwrap an ExcelJS cell value to something safe to interpolate into a string.
 *
 * ExcelJS returns a primitive for most cells but an OBJECT for several ordinary
 * shapes, and `${obj}` then renders "[object Object]". Bug found 2026-09-06: the
 * TOP 5 TODAY table printed [object Object] in its link column. Cause: this
 * repo's export-excel.mjs now writes every URL cell as a REAL clickable Excel
 * hyperlink — `{ text, hyperlink }` — instead of a bare string, so the raw cell
 * value stopped being a string the moment that change landed.
 *
 * Unwrapping happens HERE, at the single point where rows are read, rather than
 * at each print site: the same object shape reaches every consumer of these
 * rows, so a per-site guard would have to be remembered every time a new field
 * is printed. Primitives (including the numeric Score) pass through untouched,
 * so numeric comparisons downstream are unaffected.
 */
function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v !== 'object') return v;
  if (typeof v.hyperlink === 'string') return v.hyperlink;   // { text, hyperlink }
  if (typeof v.text === 'string') return v.text;
  if (Array.isArray(v.richText)) return v.richText.map((t) => t && t.text).join('');
  if ('result' in v) return cellValue(v.result);             // formula cell
  if ('error' in v) return '';                               // #REF!, #N/A, ...
  return String(v);
}

async function readXlsxStats() {
  if (!existsSync(XLSX_PATH)) return null;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) return null;
  const idx = {};
  ws.getRow(1).eachCell((cell, col) => { idx[cell.value] = col; });

  const rows = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const obj = {};
    for (const [name, col] of Object.entries(idx)) obj[name] = cellValue(r.getCell(col).value);
    rows.push(obj);
  }

  const scored4plus = rows.filter(r => Number(r.Score) >= 4.0);
  const cvsGenerated = rows.filter(r => r['CV File']).length;
  const ctcAtOrAbove8 = rows.filter(r => /^Meets floor/.test(String(r['CTC Status'] || ''))).length;
  const ctcUnknown = rows.filter(r => /^Unknown/.test(String(r['CTC Status'] || ''))).length;
  const ctcBelowTarget = rows.filter(r => /^Below floor/.test(String(r['CTC Status'] || ''))).length;

  const top5 = [...rows]
    .filter(r => Number.isFinite(Number(r.Score)))
    .sort((a, b) => Number(b.Score) - Number(a.Score))
    .slice(0, 5);

  return { totalRows: rows.length, scored4plus: scored4plus.length, cvsGenerated, ctcAtOrAbove8, ctcUnknown, ctcBelowTarget, top5 };
}

// ── Log formatting ───────────────────────────────────────────────────────

function formatLog({ date, mode, batchSize, coverageBefore, coverageAfter, pendingBefore, pendingAfter, evalRan, tally, tailorBundles, xlsxStats }) {
  const lines = [];
  lines.push('====== INDIA JOB PIPELINE ======');
  lines.push(`Date: ${date}`);
  lines.push(`Mode: ${mode}`);
  lines.push(`Batch size: ${batchSize}`);
  lines.push('');

  if (coverageAfter) {
    const runsToFullCycle = batchSize > 0 ? Math.ceil(coverageAfter.neverScanned / batchSize) : '?';
    lines.push(`Coverage: ${coverageAfter.scanned} of ${coverageAfter.total} scanned, ${coverageAfter.neverScanned} never, ~${runsToFullCycle} runs to a full cycle`);
  } else {
    lines.push('Coverage: output/coverage_india.csv not found');
  }

  // If --eval ran, postings moved from Pending into Processed during this
  // run, so pendingAfter no longer reflects "new" count directly — use the
  // tally instead. If it didn't run, new postings are simply the growth in
  // the Pending count from this scan.
  const newFromScan = evalRan ? null : Math.max(0, pendingAfter - pendingBefore);

  if (evalRan) {
    lines.push(`New postings: ${tally.scored + tally.gated + tally.dead + tally.unreachable} evaluated this run`);
    lines.push(`Passed gate: ${tally.scored}`);
    lines.push(`Deleted and why: ${tally.gated + tally.dead + tally.unreachable} (${tally.gated} gated at Step 1 [freshness/location/title/experience], ${tally.dead} dead posting, ${tally.unreachable} content inaccessible)`);
  } else {
    lines.push(`New postings: ${newFromScan} queued (not evaluated — run with --eval to score them, or evaluate interactively)`);
    lines.push('Passed gate: n/a (--eval not run)');
    lines.push('Deleted and why: n/a (--eval not run)');
  }
  lines.push('');

  if (xlsxStats) {
    lines.push(`Scoring 4.0+ (cumulative): ${xlsxStats.scored4plus}`);
    lines.push(`CVs generated (cumulative): ${xlsxStats.cvsGenerated}`);
    lines.push('');
    lines.push(`Roles at 8 LPA or above: ${xlsxStats.ctcAtOrAbove8}`);
    lines.push(`CTC unknown: ${xlsxStats.ctcUnknown}`);
    lines.push(`Below target: ${xlsxStats.ctcBelowTarget}`);
    lines.push('');
    lines.push('TOP 5 TODAY:');
    lines.push('rank | company | role | score | CTC | link');
    xlsxStats.top5.forEach((r, i) => {
      lines.push(`${i + 1} | ${r.Company} | ${r['Job Role']} | ${r.Score} | ${r.CTC || '(not stated)'} | ${r['Apply Link']}`);
    });
  } else {
    lines.push('No pipeline_india.xlsx data available for scoring/CTC/top-5 stats.');
  }
  lines.push('');
  lines.push(`Tailor bundles prepared: ${tailorBundles === null ? 'skipped (--skip-tailor)' : tailorBundles}`);
  lines.push('=================================');
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const date = todayIso();
  const mode = [opts.sector && `sector="${opts.sector}"`, opts.tier !== undefined && `tier=${opts.tier}`, `max=${opts.max}`]
    .filter(Boolean).join(', ');

  console.log(`Running India daily pipeline — ${date} (${mode})`);

  const coverageBefore = readCoverageSnapshot();
  if (!coverageBefore) {
    console.error(`${COVERAGE_CSV} not found. Run "node coverage.mjs --init" first.`);
    process.exit(1);
  }

  // Step 2: scan
  const coverageArgs = [];
  if (opts.sector) coverageArgs.push(`--sector=${opts.sector}`);
  if (opts.tier !== undefined) coverageArgs.push(`--tier=${opts.tier}`);
  coverageArgs.push(`--max=${opts.max}`);
  // Default: priority-list batch only. The keyword sweep bulk-appends newly
  // discovered employers to india_targets.csv with no review step — real
  // testing surfaced hundreds of false positives from it in one pass (see
  // coverage.mjs's detectNewEmployers for the fix history), so it only runs
  // here when explicitly requested, not on every routine daily run.
  if (!opts.keywordSweep) coverageArgs.push('--priority-only');
  const pendingBefore = countPendingRows();
  run('node', ['coverage.mjs', ...coverageArgs]);
  // Step 2.5: deterministic seniority pre-gate. Runs on EVERY run, not just
  // --eval runs: it costs nothing, and keeping Director/VP/Senior-Manager
  // requisitions out of the pending queue is worth doing whether or not the
  // paid evaluation step happens today.
  const preGate = preGateBySeniority();
  if (preGate.gated) {
    console.log(`\nSeniority pre-gate: ${preGate.gated} pending posting(s) gated on title before evaluation.`);
    for (const ex of preGate.examples) console.log(`  ${ex}`);
    if (preGate.gated > preGate.examples.length) {
      console.log(`  ...and ${preGate.gated - preGate.examples.length} more (see data/pipeline.md ## Processed).`);
    }
  }

  // Step 2.6: excluded-titles pre-gate (Graduate/Intern/campus schemes —
  // not covered by the seniority gate above) + role/CTC/location pre-score.
  const excludeGate = preFilterExcludedTitles();
  if (excludeGate.gated) {
    console.log(`\nExcluded-titles pre-gate: ${excludeGate.gated} pending posting(s) gated on title before evaluation.`);
    for (const ex of excludeGate.examples) console.log(`  ${ex}`);
    if (excludeGate.gated > excludeGate.examples.length) {
      console.log(`  ...and ${excludeGate.gated - excludeGate.examples.length} more (see data/pipeline.md ## Processed).`);
    }
  }

  const preScored = preScorePendingRows();
  if (preScored.length) {
    console.log(`\nRole/CTC/location pre-score: ${preScored.length} pending posting(s) ranked (highest first):`);
    for (const r of preScored.slice(0, 5)) {
      console.log(`  ${r.preScore.toFixed(1)} [${r.tier}] ${r.company} — ${r.title}`);
    }
    if (preScored.length > 5) console.log(`  ...and ${preScored.length - 5} more.`);
  }

  const pendingAfter = countPendingRows();
  const coverageAfter = readCoverageSnapshot();

  // Step 3: evaluate (opt-in)
  let tally = { scored: 0, gated: 0, dead: 0, unreachable: 0 };
  if (opts.eval) {
    runHeadlessEval(pendingAfter);
    tally = tallyProcessedSince(date);
  }

  // Step 4: export
  run('node', ['export-excel.mjs']);

  // Step 5: tailor (select phase only — see file header)
  let tailorBundles = null;
  if (!opts.skipTailor) {
    run('node', ['auto-tailor.mjs', '--select', '--limit', String(TAILOR_LIMIT)]);
    const bundlesDir = path.join(ROOT, 'output', 'tailor-bundles');
    tailorBundles = existsSync(bundlesDir)
      ? readdirSync(bundlesDir).filter(f => f.endsWith('.json') && !f.includes('.decision.')).length
      : 0;
  }

  // Step 6/7: stats + log
  const xlsxStats = await readXlsxStats();
  const log = formatLog({
    date, mode, batchSize: opts.max, coverageBefore, coverageAfter,
    pendingBefore, pendingAfter, evalRan: !!opts.eval, tally, tailorBundles, xlsxStats,
  });

  console.log('\n' + log);
  writeFileSync(LOG_PATH, log + '\n', 'utf8');
  console.log(`\nLog written to ${LOG_PATH}`);
}

main().catch(err => {
  console.error('run-daily.mjs failed:', err.message);
  process.exit(1);
});
