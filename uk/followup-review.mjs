#!/usr/bin/env node
/**
 * followup-review.mjs — Wed/Sat cadence check. Reads output/pipeline.xlsx,
 * writes output/followups.md. NO scanning, NO scoring, NO JD fetches, NO new
 * evaluations — tracker reading only, so it stays cheap enough to run every
 * few days without eating into scan-night budget.
 *
 * Usage: node followup-review.mjs
 */

import { existsSync, writeFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import ExcelJS from 'exceljs';

import { daysUntilDeadline, loadRates } from './soc-engine.mjs';
import { localDate } from './run-daily.mjs';

const XLSX = 'output/pipeline.xlsx';
const OUT = 'output/followups.md';
const DAY = 86400000;

function parseDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function loadRows() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.getWorksheet('Pipeline');
  const header = [];
  ws.getRow(1).eachCell((c, i) => { header[i - 1] = String(c.value ?? ''); });
  const col = (n) => header.indexOf(n) + 1;
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const cellText = (name) => {
      const v = row.getCell(col(name)).value;
      return v && typeof v === 'object' && 'text' in v ? v.text : (v ?? '');
    };
    const company = cellText('Company');
    const role = cellText('Job Role');
    if (!company && !role) return;
    rows.push({
      company, role,
      status: String(cellText('Status') || '').trim(),
      appliedOn: cellText('Applied On'),
      salaryVerdict: cellText('Salary Verdict'),
      link: cellText('Apply Link'),
    });
  });
  return rows;
}

export function buildReport(rows, { now = new Date() } = {}) {
  const applied = rows.filter((r) => /^applied$/i.test(r.status));
  const withDate = applied.map((r) => ({ ...r, appliedDate: parseDate(r.appliedOn) }));

  const due7 = [], due14 = [], noDate = [];
  for (const r of withDate) {
    if (!r.appliedDate) { noDate.push(r); continue; }
    const days = Math.floor((now - r.appliedDate) / DAY);
    if (days >= 14) due14.push({ ...r, days });
    else if (days >= 7) due7.push({ ...r, days });
  }
  due7.sort((a, b) => b.days - a.days);
  due14.sort((a, b) => b.days - a.days);

  const unappliedNEO = rows.filter((r) => r.salaryVerdict === 'NEW_ENTRANT_ONLY' && !r.status);

  const weekStart = (n) => new Date(now - n * DAY);
  const thisWeek = withDate.filter((r) => r.appliedDate && r.appliedDate >= weekStart(7) && r.appliedDate <= now);
  const lastWeek = withDate.filter((r) => r.appliedDate && r.appliedDate >= weekStart(14) && r.appliedDate < weekStart(7));

  return { due7, due14, noDate, unappliedNEO, thisWeek, lastWeek, appliedTotal: applied.length };
}

function render(report, { now = new Date() } = {}) {
  const rates = loadRates();
  const days = daysUntilDeadline();
  const M = [];
  M.push(`# Follow-up review — ${localDate(now)}`);
  M.push('');
  M.push(`**Days until new-entrant deadline (${rates._meta.new_entrant_deadline}):** ${days}`);
  M.push(`**Total applied, awaiting response:** ${report.appliedTotal}`);
  M.push('');

  M.push('## Due a chase — 14+ days, no response');
  if (report.due14.length) {
    M.push('| Company | Role | Days | Link |');
    M.push('|---|---|---|---|');
    for (const r of report.due14) M.push(`| ${r.company} | ${r.role} | ${r.days} | ${r.link} |`);
  } else M.push('_None._');
  M.push('');

  M.push('## Due a chase — 7-13 days, no response');
  if (report.due7.length) {
    M.push('| Company | Role | Days | Link |');
    M.push('|---|---|---|---|');
    for (const r of report.due7) M.push(`| ${r.company} | ${r.role} | ${r.days} | ${r.link} |`);
  } else M.push('_None._');
  M.push('');

  if (report.noDate.length) {
    M.push('## Applied, but no Applied On date recorded (cannot age these)');
    for (const r of report.noDate) M.push(`- ${r.company} — ${r.role}`);
    M.push('');
  }

  M.push('## NEW_ENTRANT_ONLY roles still sitting unapplied');
  if (report.unappliedNEO.length) {
    M.push(`⚠️ ${report.unappliedNEO.length} role(s) — the new-entrant floor only holds until **${rates._meta.new_entrant_deadline}** (${days} days).`);
    M.push('| Company | Role | Link |');
    M.push('|---|---|---|');
    for (const r of report.unappliedNEO) M.push(`| ${r.company} | ${r.role} | ${r.link} |`);
  } else M.push('_None._');
  M.push('');

  M.push('## This week vs last week');
  M.push(`- Applied this week (last 7 days): ${report.thisWeek.length}`);
  M.push(`- Applied the week before (8-14 days ago): ${report.lastWeek.length}`);
  M.push('');
  M.push('_Tracker read only — no scan, no scoring, no JD fetches this run._');

  return M.join('\n') + '\n';
}

async function main() {
  if (!existsSync(XLSX)) { console.error(`missing ${XLSX} — run a scan first`); process.exit(1); }
  const rows = await loadRows();
  const report = buildReport(rows);
  const md = render(report);
  writeFileSync(OUT, md, 'utf8');
  console.log(`due 14+: ${report.due14.length}   due 7-13: ${report.due7.length}   NEW_ENTRANT_ONLY unapplied: ${report.unappliedNEO.length}`);
  console.log(`this week: ${report.thisWeek.length}   last week: ${report.lastWeek.length}`);
  console.log(`wrote ${OUT}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
