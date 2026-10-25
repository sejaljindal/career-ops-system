#!/usr/bin/env node
/**
 * export-excel.mjs — build output/pipeline.xlsx, the working spreadsheet.
 *
 * This file is EDITED BY HAND between runs (Status, Applied On, Notes, CV File,
 * contact details). So the export is append-and-merge, never regenerate:
 *
 *   - dedupe on Company + Job Role (normalised)
 *   - a row whose Status is filled in is FROZEN — kept byte-for-byte, never
 *     refreshed, never reordered out of existence. Once you have acted on a
 *     role, the machine does not get to touch that row again — and it is
 *     NEVER excluded by the hard-gate filter below either, since a role you
 *     already applied to must not vanish from your own tracker.
 *   - rows with an empty Status are refreshed from the latest data
 *   - genuinely new rows are appended, but ONLY if they pass every hard gate
 *
 * HARD-GATE FILTER (incoming rows only, never applied to frozen rows):
 * a role only enters the sheet if SOC eligibility, the salary floor, AND the
 * experience/seniority gate (experience-gate.mjs) all confirm PASS. A role
 * whose experience requirement was never checked against a real JD
 * (experienceStatus: 'UNVERIFIED') has not "passed" anything — it is held
 * back, not shown, until run-daily.mjs's JD-enrichment pass confirms it one
 * way or the other. This mirrors run-daily.mjs exactly: it already deletes
 * SOC/salary/experience FAILs before writing data/daily-hits.json, so this
 * filter is mostly a second confirmation — except for SOC-ineligible roles,
 * which run-daily deliberately KEEPS (ranked bottom, score 0) for visibility
 * in the log. Those still fail "Eligible?" here and are correctly held out of
 * the apply-ready spreadsheet.
 *
 * Sheets: Pipeline · Deadline · Coverage
 *
 * Usage:
 *   node export-excel.mjs                       # from data/daily-hits.json (run-daily.mjs's gated output)
 *   node export-excel.mjs --from=path.json      # any hits array — falls back to on-the-fly SOC/salary inference
 *                                                  for legacy shapes that lack run-daily's precomputed fields
 *   node export-excel.mjs --dry-run
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import ExcelJS from 'exceljs';

import { inferSOC, scoreLanguage, salaryVerdict, classifyRemote, daysUntilDeadline, loadRates } from './soc-engine.mjs';

const OUT = 'output/pipeline.xlsx';
// run-daily.mjs's fully-gated output is the primary source — every row in it
// has already been through the SOC/salary/experience hard gates. The older
// aggregator-hits.json (raw, title-only, ungated) is kept only as a fallback
// for standalone use of this script outside the run-daily.mjs pipeline.
const HITS = existsSync('data/daily-hits.json') ? 'data/daily-hits.json' : 'data/aggregator-hits.json';
const COVERAGE_CANDIDATES = ['output/coverage.csv', 'coverage.csv'];

// Exact column order, as specified. Do not reorder — people build muscle memory
// around column positions and a silent reshuffle corrupts their filters.
export const COLUMNS = [
  'Rank', 'Score', 'Posted', 'Days Old', 'Company', 'Source Lists', 'Register Verified',
  'Job Role', 'Location', 'Salary', 'SOC Code', 'SOC Title', 'Going Rate', 'New Entrant Floor',
  'Salary Verdict', 'Experience Gate Result', 'SOC Risk', 'Eligible?', 'Remote Type',
  'Language Verdict', 'Edge Flag',
  'Apply Link', 'CV File', 'Cover Letter', 'Contact Name', 'Contact Title', 'Contact Link',
  'Status', 'Applied On', 'Notes', 'First Seen',
  // Outreach is currently invisible: outreach.mjs writes a draft, and nothing
  // ever records whether it was sent or answered. Two dated columns make that
  // channel measurable without a second system to maintain — you fill them in,
  // and the Weekly sheet counts them.
  'Outreach Sent', 'Outreach Reply',
  // Most recent activity of ANY kind, distinct from Applied On. This is what
  // answers "what has gone cold".
  'Last Update',
];

// New-row highlight — distinct from every VERDICT_FILL hue below (green/amber/grey/red).
const NEW_ROW_FILL = 'FFD9E8FB'; // light blue

// Columns the human owns. Never overwritten on a row that has a Status.
const USER_COLUMNS = new Set(['CV File', 'Cover Letter', 'Contact Name', 'Contact Title',
  'Contact Link', 'Status', 'Applied On', 'Notes', 'Outreach Sent', 'Outreach Reply']);

/**
 * Last Update = the most recent DATED HUMAN ACTIVITY on the row.
 *
 * Deliberately NOT touched by machine refreshes. If a nightly re-score counted
 * as activity, every row would look warm forever and the column could never
 * answer the question it exists for. A row goes cold when YOU stop acting on
 * it, so only the dated user fields move it; First Seen is the floor, so a row
 * never acted on ages from the day it arrived.
 */
const ACTIVITY_COLUMNS = ['Applied On', 'Outreach Sent', 'Outreach Reply'];

export function computeLastUpdate(row) {
  const dates = [];
  for (const c of [...ACTIVITY_COLUMNS, 'First Seen']) {
    const v = row[c];
    if (!v) continue;
    const d = v instanceof Date ? v : new Date(String(v));
    if (!Number.isNaN(d.getTime())) dates.push(d);
  }
  if (!dates.length) return '';
  return new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString().slice(0, 10);
}

const VERDICT_FILL = {
  PASS_ANY_TIME: 'FFC6EFCE',    // green
  NEW_ENTRANT_ONLY: 'FFFFEB9C', // amber
  UNKNOWN: 'FFD9D9D9',          // grey
  INELIGIBLE: 'FFFFC7CE',       // red
};
const VERDICT_FONT = {
  PASS_ANY_TIME: 'FF006100',
  NEW_ENTRANT_ONLY: 'FF9C6500',
  UNKNOWN: 'FF3F3F3F',
  INELIGIBLE: 'FF9C0006',
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * Dedupe key. Company + Job Role as specified — but when Company is unknown the
 * pair is not distinguishing, and every companyless role with the same title
 * would collapse into one row, silently destroying distinct jobs. In that case
 * fall back to the apply link, which is unique per posting.
 */
const keyOf = (company, role, link = '') =>
  (norm(company) ? `${norm(company)}||${norm(role)}` : `url||${String(link).trim().toLowerCase()}`);

// ── inputs ───────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}

function loadCoverage() {
  for (const p of COVERAGE_CANDIDATES) {
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    if (!lines.length) continue;
    return { path: p, header: parseCsvLine(lines[0]), rows: lines.slice(1).map(parseCsvLine) };
  }
  return null;
}

/** Company/list lookup so the sheet can show provenance per employer. */
function employerIndex(cov) {
  const idx = new Map();
  if (!cov) return idx;
  const iN = cov.header.indexOf('Organisation');
  const iL = cov.header.indexOf('Source Lists');
  const iR = cov.header.indexOf('Register Verified');
  for (const r of cov.rows) {
    const name = r[iN];
    if (!name) continue;
    idx.set(norm(name), {
      lists: iL >= 0 ? r[iL] || '' : '',
      registerVerified: iR >= 0 ? r[iR] || '' : (iL >= 0 ? 'YES' : ''),
    });
  }
  return idx;
}

/**
 * Employer name from a job URL where the aggregator encodes it. Health Jobs UK
 * puts the employing NHS trust in the path, which is the only aggregator that
 * gives employer attribution for free.
 */
export function companyFromUrl(url) {
  const m = String(url).match(/healthjobsuk\.com\/job\/UK\/[^/]+\/[^/]+\/([^/]+)\//);
  if (m) return m[1].replace(/_/g, ' ').trim();
  return '';
}

function loadHits(path) {
  if (!existsSync(path)) return [];
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(rows) ? rows : [];
}

// ── row construction ─────────────────────────────────────────────────

const EDGE_FLAGS = [
  [/capital project|infrastructure|rail|construction|programme/i, '£83.6M portfolio experience'],
  [/bank|financial|finance|invest|insur|asset manage/i, 'YOUR_MSc Finance + commercial analysis'],
  [/consult|advisory/i, '£100K commercial risk identified at EMPLOYER_ONE'],
  [/data|product|software|technology|digital|analytics|bi\b/i, 'SQL, Power BI, 48h to 4h process redesign'],
  [/council|nhs|government|public sector|university/i, 'worked directly with DfT officials'],
  [/stakeholder|governance|pmo|portfolio/i, 'Director, DfT, TOC and principal contractor exposure'],
];

function edgeFlag(text) {
  for (const [re, flag] of EDGE_FLAGS) if (re.test(text)) return flag;
  return '';
}

/** True when `hit` carries run-daily.mjs's precomputed gate/scoring fields. */
const isEnriched = (hit) => Object.prototype.hasOwnProperty.call(hit, 'experienceStatus');

/** SOC occupation title for a code, looked up from soc_rates.json — never re-inferred. */
function socTitleFor(code) {
  if (!code) return '';
  const rates = loadRates();
  return rates.eligible?.[code]?.title || rates.ineligible_below_rqf6?.[code]?.title || '';
}

export function buildRow(hit, empIdx) {
  const title = hit.title || '';
  const url = hit.url || '';
  const company = hit.company || companyFromUrl(url) || '';
  const text = `${title} ${company}`;
  const prov = empIdx.get(norm(company)) || {};
  const posted = hit.posted || '';
  const daysOld = posted ? Math.max(0, Math.floor((Date.now() - Date.parse(posted)) / 86400000)) : '';

  let soc, salVerdict, salFloors, remote, langVerdict, edge, experienceStatus, experienceReason;

  if (isEnriched(hit)) {
    // Trust run-daily.mjs's own determination — it was made against the real
    // fetched JD, which is strictly more accurate than re-inferring from a
    // bare title here. Only the floor figures (going rate / new-entrant floor)
    // are looked up fresh, purely as a numeric lookup keyed on the code
    // run-daily already settled on — not a re-inference of the code itself.
    soc = { code: hit.soc || '', title: socTitleFor(hit.soc), socRisk: Boolean(hit.socRisk), eligible: hit.eligible };
    salVerdict = hit.salaryStatus || 'UNKNOWN';
    salFloors = hit.soc ? salaryVerdict(hit.soc, hit.salary ?? null) : {};
    remote = hit.remote || '';
    langVerdict = hit.language || '';
    edge = hit.edge || '';
    experienceStatus = hit.experienceStatus || 'UNVERIFIED';
    experienceReason = hit.experienceReason || '';
  } else {
    // Legacy shape (raw aggregator hit, title-only) — fall back to on-the-fly
    // inference so the script still works standalone, clearly weaker than the
    // JD-grounded path above since there is no JD text to check against.
    const inferred = inferSOC(title, text);
    soc = inferred;
    const sal = inferred.code ? salaryVerdict(inferred.code, hit.salary ?? null) : { status: 'UNKNOWN' };
    salVerdict = sal.status || 'UNKNOWN';
    salFloors = sal;
    remote = classifyRemote(text);
    langVerdict = scoreLanguage(title).verdict;
    edge = edgeFlag(text);
    experienceStatus = 'UNVERIFIED';
    experienceReason = 'legacy input — no JD fetched, experience gate not run';
  }

  return {
    Rank: '',
    Score: hit.score ?? '',
    Posted: posted,
    'Days Old': daysOld,
    Company: company,
    'Source Lists': prov.lists || hit.sourceLists || '',
    'Register Verified': prov.registerVerified || (hit.registerVerified ? 'YES' : ''),
    'Job Role': title,
    Location: hit.location || '',
    Salary: hit.salary || '',
    'SOC Code': soc.code || '',
    'SOC Title': soc.title || '',
    'Going Rate': salFloors.goingRate ?? '',
    'New Entrant Floor': salFloors.newEntrantFloor ?? '',
    'Salary Verdict': salVerdict || 'UNKNOWN',
    'Experience Gate Result': experienceReason ? `${experienceStatus} — ${experienceReason}` : experienceStatus,
    'SOC Risk': soc.socRisk ? 'YES' : '',
    'Eligible?': soc.eligible === null || soc.eligible === undefined ? '' : (soc.eligible ? 'YES' : 'NO'),
    'Remote Type': remote,
    'Language Verdict': langVerdict,
    'Edge Flag': edge,
    'Apply Link': url,
    'CV File': '', 'Cover Letter': '', 'Contact Name': '', 'Contact Title': '',
    'Contact Link': '', Status: '', 'Applied On': '', Notes: '',
    // Set only when this row is genuinely new (see merge()) — never refreshed
    // once set, so it survives every later run regardless of score/rank churn.
    'First Seen': '',
    'Outreach Sent': '', 'Outreach Reply': '', 'Last Update': '',
    // internal, not a sheet column — read by passesHardGates() below, stripped before write
    __eligible: soc.eligible,
    __experienceStatus: experienceStatus,
    __salaryVerdict: salVerdict,
  };
}

/**
 * Only a row that confirms PASS on every hard gate belongs in the apply-ready
 * sheet: SOC eligibility, the salary floor, and the experience/seniority
 * gate. `eligible === undefined` (no SOC pattern matched at all — genuinely
 * unknown, not "ineligible") is let through rather than penalised for an
 * absence of information; explicit `false` is not.
 */
export function passesHardGates(row) {
  if (row.__eligible === false) return false;
  if (row.__salaryVerdict === 'FAIL') return false;
  if (row.__experienceStatus !== 'PASS') return false;
  return true;
}

// ── existing workbook ────────────────────────────────────────────────

async function readExisting() {
  if (!existsSync(OUT)) return { rows: [], frozen: 0 };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(OUT);
  const ws = wb.getWorksheet('Pipeline');
  if (!ws) return { rows: [], frozen: 0 };

  const header = [];
  ws.getRow(1).eachCell((c, i) => { header[i - 1] = String(c.value ?? ''); });

  const rows = [];
  let frozen = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const obj = {};
    header.forEach((h, i) => {
      const v = row.getCell(i + 1).value;
      obj[h] = v && typeof v === 'object' && 'text' in v ? v.text : (v ?? '');
    });
    if (!obj.Company && !obj['Job Role']) return;
    obj.__locked = String(obj.Status ?? '').trim() !== '';
    if (obj.__locked) frozen++;
    rows.push(obj);
  });
  return { rows, frozen };
}

// ── merge ────────────────────────────────────────────────────────────

// Set once, on first appearance, then carried forward untouched — neither a
// USER_COLUMN (the human never types it) nor a machine-refreshed one.
const FIRST_SEEN = 'First Seen';

export function merge(existing, incoming, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const byKey = new Map();
  for (const r of existing) byKey.set(keyOf(r.Company, r['Job Role'], r['Apply Link']), r);

  let appended = 0, refreshed = 0, skippedLocked = 0;
  for (const inc of incoming) {
    const k = keyOf(inc.Company, inc['Job Role'], inc['Apply Link']);
    const prev = byKey.get(k);
    if (!prev) {
      inc[FIRST_SEEN] = today;
      inc.__newThisRun = true;   // this run's highlight, cleared automatically next run (fresh sheet)
      byKey.set(k, inc);
      appended++;
      continue;
    }
    if (prev.__locked) { skippedLocked++; continue; }   // acted on — hands off
    // Refresh machine-owned columns, preserve anything the user typed.
    const merged = { ...prev };
    for (const c of COLUMNS) if (!USER_COLUMNS.has(c) && c !== FIRST_SEEN) merged[c] = inc[c];
    // Never move once set. Backfill legacy rows that predate this column.
    merged[FIRST_SEEN] = prev[FIRST_SEEN] || today;
    byKey.set(k, merged);
    refreshed++;
  }
  return { rows: [...byKey.values()], appended, refreshed, skippedLocked };
}

/** Score descending, as specified. Ties broken by Days Old ascending, then company name. */
export function sortRows(rows) {
  const dnum = (v) => (v === '' || v === null || v === undefined ? Number.POSITIVE_INFINITY : Number(v));
  const snum = (v) => (v === '' || v === null || v === undefined ? Number.NEGATIVE_INFINITY : Number(v));
  return [...rows].sort((a, b) =>
    snum(b.Score) - snum(a.Score) ||
    dnum(a['Days Old']) - dnum(b['Days Old']) ||
    String(a.Company).localeCompare(String(b.Company)));
}

// ── write ────────────────────────────────────────────────────────────

async function write(rows, cov, stats) {
  mkdirSync('output', { recursive: true });
  const runId = new Date().toISOString();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'career-ops';
  wb.modified = new Date();

  // ── Pipeline ──
  const ws = wb.addWorksheet('Pipeline', {
    views: [{ state: 'frozen', ySplit: 1 }],   // freeze top row
  });
  ws.columns = COLUMNS.map((h) => ({ header: h, key: h, width: Math.min(Math.max(h.length + 2, 10), 34) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

  rows.forEach((r, i) => {
    const out = {};
    // A row with a Status is reproduced exactly as it was read, Rank included.
    // Renumbering it would be an overwrite, and the rule is absolute.
    for (const c of COLUMNS) {
      out[c] = c === 'Rank' ? (r.__locked ? (r.Rank ?? '') : i + 1) : (r[c] ?? '');
    }
    const row = ws.addRow(out);

    // New-this-run highlight FIRST, so the Salary Verdict cell's own fill
    // (applied next) always wins on that one cell — the two never fight over
    // the same pixel, and the two colour schemes stay visually distinct.
    if (r.__newThisRun) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NEW_ROW_FILL } };
      });
    }

    const v = String(r['Salary Verdict'] || '').trim();
    if (VERDICT_FILL[v]) {
      const cell = row.getCell(COLUMNS.indexOf('Salary Verdict') + 1);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERDICT_FILL[v] } };
      cell.font = { color: { argb: VERDICT_FONT[v] }, bold: true };
    }
    if (String(r.Status ?? '').trim()) {
      row.getCell(COLUMNS.indexOf('Status') + 1).font = { bold: true };
    }
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  // ── Deadline ──
  const rates = loadRates();
  const deadline = rates._meta.new_entrant_deadline;
  const days = daysUntilDeadline();
  const neo = rows.filter((r) => r['Salary Verdict'] === 'NEW_ENTRANT_ONLY').length;

  const d = wb.addWorksheet('Deadline');
  d.columns = [{ header: 'Metric', key: 'm', width: 46 }, { header: 'Value', key: 'v', width: 30 }];
  d.getRow(1).font = { bold: true };
  d.addRow({ m: 'New entrant deadline', v: deadline });
  d.addRow({ m: 'Days remaining', v: days });
  d.addRow({ m: 'Roles flagged NEW_ENTRANT_ONLY', v: neo });
  d.addRow({ m: '', v: '' });
  d.addRow({ m: 'Note', v: rates._meta.new_entrant_deadline_note || '' });
  d.addRow({ m: 'Rule', v: 'New entrant status is assessed on age at the date the visa application is SUBMITTED.' });
  const dc = d.getCell('B2');
  dc.font = { bold: true, color: { argb: days < 90 ? 'FF9C0006' : days < 180 ? 'FF9C6500' : 'FF006100' } };
  d.getCell('B3').font = { bold: true };

  // ── Coverage ──
  const c = wb.addWorksheet('Coverage', { views: [{ state: 'frozen', ySplit: 1 }] });
  if (cov) {
    c.columns = cov.header.map((h) => ({ header: h, key: h, width: Math.min(Math.max(h.length + 2, 12), 40) }));
    c.getRow(1).font = { bold: true };
    for (const r of cov.rows) c.addRow(r);
    c.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cov.header.length } };
  } else {
    c.addRow(['coverage.csv not found — run: node coverage-tracker.mjs init']);
  }
  // Run stamp, parked two columns clear of the table so it never collides
  // with the autoFilter range or the coverage.csv column count changing.
  const stampCol = (cov ? cov.header.length : 1) + 2;
  c.getCell(1, stampCol).value = 'Workbook last written';
  c.getCell(1, stampCol).font = { bold: true };
  c.getCell(2, stampCol).value = runId;

  // ── Weekly ──
  const weekly = buildWeekly(rows);
  const w = wb.addWorksheet('Weekly', { views: [{ state: 'frozen', ySplit: 1 }] });
  w.columns = [
    { header: 'Week commencing', key: 'wk', width: 18 },
    { header: 'Applications sent', key: 'apps', width: 18 },
    { header: 'Outreach sent', key: 'osent', width: 15 },
    { header: 'Outreach conversations', key: 'oconv', width: 22 },
    { header: 'Reply rate', key: 'rate', width: 12 },
    { header: 'Interviews booked', key: 'ivs', width: 18 },
  ];
  w.getRow(1).font = { bold: true };
  w.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  for (const r of weekly) w.addRow(r);
  if (!weekly.length) {
    w.addRow({ wk: '(no dated activity yet)' });
    w.addRow({ wk: 'Fill in Applied On, Outreach Sent and Outreach Reply on the Pipeline sheet' });
    w.addRow({ wk: 'and these counts populate automatically.' });
  }
  // State plainly where each number comes from, so a zero is never ambiguous
  // between "nothing happened" and "nothing was recorded".
  const noteRow = w.rowCount + 2;
  w.getCell(noteRow, 1).value = 'Applications sent = rows with an Applied On date that week.';
  w.getCell(noteRow + 1, 1).value = 'Outreach sent = rows with an Outreach Sent date that week. Outreach conversations = rows with an Outreach Reply date that week.';
  w.getCell(noteRow + 2, 1).value = 'Interviews booked = rows whose Status is Interview, counted in the week of their Last Update.';
  w.getCell(noteRow + 3, 1).value = 'These are recorded, not inferred: a blank column means it was not logged, not that it did not happen.';
  for (let i = 0; i < 4; i++) w.getCell(noteRow + i, 1).font = { italic: true, size: 9 };

  // ── Make every URL cell a REAL, clickable Excel hyperlink ───────────────
  // Added 2026-09-04. Before this, links were written as plain text strings.
  // Excel only auto-linkifies a URL you type and press Enter on — it does NOT
  // linkify text written by a library, so every link in this workbook had to
  // be copy-pasted into a browser rather than clicked. This converts them in
  // place, on every sheet that has such a column. Non-URL values are left
  // untouched, which matters for Contact Link: where no contact is verified it
  // holds a LinkedIn SEARCH URL (never a guessed name — CLAUDE.md
  // non-negotiable #5). Those are real URLs and are linked too; anything that
  // is not a URL is left exactly as-is.
  const LINK_COLUMNS = ['Apply Link', 'Job Posting Link', 'Contact Link'];
  for (const sheet of wb.worksheets) {
    const header = [];
    sheet.getRow(1).eachCell((c, i) => { header[i] = String(c.value || ''); });
    for (const colName of LINK_COLUMNS) {
      const idx = header.findIndex((h) => h === colName);
      if (idx < 1) continue;
      sheet.getColumn(idx).eachCell({ includeEmpty: false }, (cell, rowNumber) => {
        if (rowNumber === 1) return;
        const raw = cell.value;
        const text = typeof raw === 'string' ? raw : (raw && raw.text) || '';
        if (!/^https?:\/\//i.test(String(text).trim())) return;
        const url = String(text).trim();
        cell.value = { text: url, hyperlink: url };
        cell.font = { color: { argb: 'FF0563C1' }, underline: true };
      });
    }
  }

  await wb.xlsx.writeFile(OUT);
  return { deadline, days, neo, coverageRows: cov ? cov.rows.length : 0, weeks: weekly.length };
}

/** Monday of the ISO week containing `d`. */
function weekStart(d) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;         // Mon=0 … Sun=6
  x.setDate(x.getDate() - day);
  return x.toISOString().slice(0, 10);
}

const asDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Per-week counts. Every number traces to a column a human filled in — none is
 * inferred from machine state, so the outreach figure reflects what actually
 * happened rather than how many drafts were generated.
 */
export function buildWeekly(rows) {
  const weeks = new Map();
  const bump = (d, key) => {
    if (!d) return;
    const wk = weekStart(d);
    if (!weeks.has(wk)) weeks.set(wk, { wk, apps: 0, osent: 0, oconv: 0, ivs: 0 });
    weeks.get(wk)[key]++;
  };
  for (const r of rows) {
    bump(asDate(r['Applied On']), 'apps');
    bump(asDate(r['Outreach Sent']), 'osent');
    bump(asDate(r['Outreach Reply']), 'oconv');
    if (/^interview$/i.test(String(r.Status ?? '').trim())) {
      bump(asDate(r['Last Update']) || asDate(r['Applied On']), 'ivs');
    }
  }
  return [...weeks.values()]
    .sort((a, b) => b.wk.localeCompare(a.wk))     // newest week first
    .map((x) => ({ ...x, rate: x.osent ? `${Math.round((x.oconv / x.osent) * 100)}%` : '' }));
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const from = (args.find((a) => a.startsWith('--from=')) || `--from=${HITS}`).split('=')[1];
  const dry = args.includes('--dry-run');

  const cov = loadCoverage();
  const empIdx = employerIndex(cov);
  const hits = loadHits(from);
  const built = hits.map((h) => buildRow(h, empIdx));

  // Hard-gate filter applies to INCOMING rows only. A frozen (Status-filled)
  // row is merged in below regardless of gate outcome — see file header.
  const incoming = built.filter(passesHardGates);
  const gateRejected = built.length - incoming.length;

  const { rows: existing, frozen } = await readExisting();
  const m = merge(existing, incoming);
  // Strip the internal __-prefixed gate fields before anything touches the
  // sheet or the merge-preserved existing rows — they are not sheet columns.
  for (const r of m.rows) { delete r.__eligible; delete r.__experienceStatus; delete r.__salaryVerdict; }
  // Recompute on every row each run: a date typed into Applied On / Outreach
  // Sent / Outreach Reply since the last export must move Last Update, and
  // the human never has to maintain it by hand.
  for (const r of m.rows) r['Last Update'] = computeLastUpdate(r);
  const sorted = sortRows(m.rows);

  console.log('='.repeat(70));
  console.log('  career-ops — pipeline export');
  console.log('='.repeat(70));
  console.log(`  source          : ${from} (${hits.length} rows)`);
  console.log(`  held back by hard gates : ${gateRejected} (SOC ineligible / salary FAIL / experience not PASS)`);
  console.log(`  existing sheet  : ${existing.length} rows (${frozen} with Status — frozen, never gate-filtered)`);
  console.log(`  appended        : ${m.appended}`);
  console.log(`  refreshed       : ${m.refreshed}`);
  console.log(`  left untouched  : ${m.skippedLocked}  (Status filled in)`);
  console.log(`  total rows      : ${sorted.length}`);

  if (dry) { console.log('\n--dry-run: nothing written'); return; }

  const info = await write(sorted, cov, m);
  const verdicts = {};
  for (const r of sorted) verdicts[r['Salary Verdict'] || 'UNKNOWN'] = (verdicts[r['Salary Verdict'] || 'UNKNOWN'] || 0) + 1;
  console.log(`\n  salary verdicts : ${JSON.stringify(verdicts)}`);
  console.log(`  deadline        : ${info.deadline} — ${info.days} days, ${info.neo} NEW_ENTRANT_ONLY`);
  console.log(`  coverage sheet  : ${info.coverageRows} rows from ${cov ? cov.path : '(none)'}`);
  console.log(`\nwrote ${OUT}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
