#!/usr/bin/env node
/**
 * followup-review.mjs — Wed/Sat cadence check. INDIA PIPELINE.
 *
 * Reads output/pipeline_india.xlsx, writes output/followups_india.md.
 * NO scanning, NO scoring, NO JD fetches, NO new evaluations, NO LLM — tracker
 * reading only, so it is cheap enough to run every few days and can never
 * consume Claude usage or hit a limit.
 *
 * WHY THIS EXISTS (built 2026-09-04): the Wed/Sat automation originally called
 * followup-cadence.mjs, which reads data/applications.md + data/follow-ups.md.
 * Neither file exists in this repo, and neither is where application status
 * actually lives — the real data is in the spreadsheet's "Status" and
 * "Applied On" columns. So the follow-up run was pointed at the wrong source
 * and would have kept reporting "no applications" no matter how diligently
 * applications were logged. This reads the source that actually holds the data.
 *
 * HOW TO LOG AN APPLICATION so this can see it: open
 * output/pipeline_india.xlsx, set Status to "Applied", and put the date in
 * "Applied On" (YYYY-MM-DD). That is the whole mechanism — there is no
 * separate tracker file to maintain.
 *
 * CADENCE (calendar days after Applied On):
 *   day  7 — first nudge, if no reply logged
 *   day 14 — second nudge
 *   day 21 — final nudge, then let it go
 * A row whose Status has moved beyond "Applied" (Interview, Offer, Rejected,
 * Closed) is never chased.
 *
 * Usage: node followup-review.mjs
 */

import { existsSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import ExcelJS from 'exceljs';

const XLSX = 'output/pipeline_india.xlsx';
const OUT = 'output/followups_india.md';
const SHEET = 'Pipeline';
const DAY = 86400000;

const NUDGE_DAYS = [7, 14, 21];

/** Statuses that mean the conversation has moved on — never chase these. */
const CLOSED_STATUSES = new Set([
  'interview', 'offer', 'rejected', 'closed', 'withdrawn', 'skip', 'not a fit', 'declined',
]);

/** Local calendar date, never a raw UTC timestamp — same rule as the UK repo. */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole calendar days between two dates, ignoring time-of-day. */
export function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / DAY);
}

/**
 * Which nudge is due for a row applied `days` ago, or null.
 * Returns the highest nudge threshold reached, so a row checked late (say day
 * 16) reports the day-14 nudge rather than silently skipping it.
 */
export function nudgeDue(days) {
  let due = null;
  for (const n of NUDGE_DAYS) if (days >= n) due = n;
  return due;
}

function cellText(row, idx) {
  if (idx < 1) return '';
  const v = row.getCell(idx).value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return String(v.text || v.hyperlink || '').trim();
  return String(v).trim();
}

export async function buildReport(xlsxPath = XLSX) {
  if (!existsSync(xlsxPath)) {
    return { error: `${xlsxPath} not found — run \`npm run export\` first.`, rows: [] };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet(SHEET) || wb.worksheets[0];
  if (!ws) return { error: `no worksheet found in ${xlsxPath}`, rows: [] };

  const header = [];
  ws.getRow(1).eachCell((c, i) => { header[i] = String(c.value || '').trim(); });
  const col = (name) => header.findIndex((h) => h === name);

  const cStatus = col('Status');
  const cApplied = col('Applied On');
  const cCompany = col('Company');
  const cRole = col('Job Role');
  const cLink = col('Apply Link');
  const cContact = col('Contact Name');
  const cContactLink = col('Contact Link');
  const cNotes = col('Notes');

  if (cStatus < 1 || cApplied < 1) {
    return { error: 'Status and/or Applied On column missing from the sheet', rows: [] };
  }

  const today = new Date();
  const due = [];
  const awaiting = [];
  let applied = 0;

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const status = cellText(row, cStatus);
    const statusLc = status.toLowerCase();
    if (CLOSED_STATUSES.has(statusLc)) continue;
    if (statusLc !== 'applied') continue;      // only chase things actually sent

    applied++;
    const appliedOn = parseDate(row.getCell(cApplied).value);
    const entry = {
      row: r,
      company: cellText(row, cCompany),
      role: cellText(row, cRole),
      link: cellText(row, cLink),
      contact: cellText(row, cContact),
      contactLink: cellText(row, cContactLink),
      notes: cellText(row, cNotes),
      appliedOn: appliedOn ? localDate(appliedOn) : null,
    };

    if (!appliedOn) {
      // Status says Applied but no date — cannot compute cadence. Surface it
      // rather than dropping it silently: an unlogged date is a real gap.
      entry.days = null;
      entry.nudge = null;
      awaiting.push(entry);
      continue;
    }
    entry.days = daysBetween(appliedOn, today);
    entry.nudge = nudgeDue(entry.days);
    if (entry.nudge) due.push(entry); else awaiting.push(entry);
  }

  due.sort((a, b) => (b.days || 0) - (a.days || 0));
  awaiting.sort((a, b) => (b.days || 0) - (a.days || 0));
  return { rows: due, awaiting, applied, today: localDate(today) };
}

function render(res) {
  const L = [];
  L.push('# India follow-up review');
  L.push('');
  L.push(`Generated ${res.today || localDate()} from \`${XLSX}\`. Read-only: no scan, no scoring, no LLM.`);
  L.push('');

  if (res.error) {
    L.push(`**Could not run:** ${res.error}`);
    L.push('');
    return L.join('\n');
  }

  L.push(`Applications with Status = "Applied": **${res.applied}**`);
  L.push('');

  if (!res.applied) {
    L.push('## Nothing to follow up — but read this before concluding that');
    L.push('');
    L.push('No row in the sheet has Status set to "Applied". That may genuinely mean');
    L.push('nothing has been sent yet, **or** it may mean applications were sent but');
    L.push('never logged. This report cannot tell those two apart.');
    L.push('');
    L.push('To log one: open `output/pipeline_india.xlsx`, set **Status** to `Applied`,');
    L.push('and put the date in **Applied On** as YYYY-MM-DD.');
    L.push('');
    return L.join('\n');
  }

  if (res.rows.length) {
    L.push(`## Due now (${res.rows.length})`);
    L.push('');
    L.push('| Days | Nudge | Company | Role | Contact | Link |');
    L.push('|---|---|---|---|---|---|');
    for (const e of res.rows) {
      const contact = e.contact || (e.contactLink ? '(search link)' : '—');
      L.push(`| ${e.days} | day ${e.nudge} | ${e.company} | ${e.role} | ${contact} | ${e.link || '—'} |`);
    }
    L.push('');
  } else {
    L.push('## Due now');
    L.push('');
    L.push('Nothing is due. Every logged application is inside its cadence window.');
    L.push('');
  }

  if (res.awaiting && res.awaiting.length) {
    L.push(`## Logged, not yet due (${res.awaiting.length})`);
    L.push('');
    L.push('| Days | Company | Role | Applied on |');
    L.push('|---|---|---|---|');
    for (const e of res.awaiting) {
      L.push(`| ${e.days === null ? '—' : e.days} | ${e.company} | ${e.role} | ${e.appliedOn || '**date missing**'} |`);
    }
    L.push('');
    if (res.awaiting.some((e) => e.appliedOn === null)) {
      L.push('> Rows showing **date missing** have Status = Applied but no Applied On date,');
      L.push('> so no cadence can be calculated for them. Fill the date in to fix.');
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push('Cadence: nudge at day 7, day 14, then day 21 and let it go. Rows whose Status');
  L.push('has moved on (Interview, Offer, Rejected, Closed, Withdrawn) are never chased.');
  L.push('');
  L.push('**Never guess a contact name.** Where no name is verified the Contact Link column');
  L.push('holds a LinkedIn search URL instead — use that to find the real person.');
  return L.join('\n');
}

async function main() {
  const res = await buildReport();
  const md = render(res);
  writeFileSync(OUT, md, 'utf8');
  console.log(md);
  console.log(`\nwrote ${OUT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
