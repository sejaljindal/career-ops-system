#!/usr/bin/env node
// outreach.mjs — hiring-manager/recruiter/peer discovery + outreach drafting
// for pipeline_india.xlsx rows.
//
// NOTE ON THE NAME: this was originally shipped as contacts.mjs, but that name
// already belongs to the vCard phonebook exporter (data/contacts.tsv ->
// output/contacts.vcf, with its own test suite and an AGENTS.md entry).
// Overwriting it clobbered working, tested code — renamed here to fix that.
//
// HONESTY NOTE ON ARCHITECTURE: "web search for the likely hiring manager"
// requires an actual web search and judgment about who's actually likely —
// this script has neither. Same two-phase pattern as auto-tailor.mjs:
//
//   SELECT phase (`--select`, mechanical):
//     Reads pipeline_india.xlsx, picks the target row(s) (--row N for one
//     specific row, or --limit N for the top-N scoring rows that don't yet
//     have a Contact Name), and writes one "contact-bundle" JSON per row to
//     output/contact-bundles/{row}.json with the company/role, three ready-
//     to-run LinkedIn search-string suggestions (hiring manager / recruiter
//     / peer), and cv.md's proof points for grounding any drafted message.
//
//   WRITE phase (`--write <results.json>`, mechanical):
//     Takes a results JSON — produced by actually running the searches and
//     judging the likely contacts, and (optionally) drafting outreach copy
//     grounded in cv.md — and writes it back:
//       - The single best-identified contact (Hiring Manager > Recruiter >
//         Peer, in that priority order — the sheet has one Contact Name/
//         Title/Link triplet, not three) goes into those columns.
//       - The other identified/unfound contacts are appended to Notes as a
//         compact addendum (never overwriting existing Notes content).
//       - Any role with no name found gets its LinkedIn search string
//         recorded instead of a blank — never silently drop it.
//       - Drafted messages (short <300 chars, longer version) are written to
//         output/contacts/{row}-outreach.md, one file per row (the sheet has
//         no column for message drafts; adding one wasn't asked for, so this
//         stays a file rather than a silent schema change).
//
// Usage:
//   node outreach.mjs --select --row 5
//   node outreach.mjs --select --limit 10
//   node outreach.mjs --write output/contact-bundles/5.results.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

const ROOT = process.cwd();
const XLSX_PATH = path.join(ROOT, 'output', 'pipeline_india.xlsx');
const CV_MD_PATH = path.join(ROOT, 'cv.md');
const BUNDLES_DIR = path.join(ROOT, 'output', 'contact-bundles');
const OUTREACH_DIR = path.join(ROOT, 'output', 'contacts');
const SHEET_NAME = 'Pipeline (India)';
const SCORE_FLOOR = 4.0;
const MESSAGE_SHORT_MAX = 300;

// ── xlsx I/O ─────────────────────────────────────────────────────────────

async function loadWorkbook() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  return wb;
}

function headerIndex(ws) {
  const idx = {};
  ws.getRow(1).eachCell((cell, col) => { idx[cell.value] = col; });
  return idx;
}

function rowToObject(ws, idx, rowNum) {
  const r = ws.getRow(rowNum);
  const obj = { _rowNum: rowNum };
  for (const [name, col] of Object.entries(idx)) obj[name] = r.getCell(col).value;
  return obj;
}

// ── cv.md proof points (Cross-cutting Advantage / superpowers block) so a
// drafted message has grounded, non-invented material to reference. ───────

function loadProofPoints() {
  if (!existsSync(CV_MD_PATH)) return [];
  const cvMd = readFileSync(CV_MD_PATH, 'utf8');
  const bolded = [...cvMd.matchAll(/\*\*([^*]{10,120})\*\*/g)].map(m => m[1].trim());
  return [...new Set(bolded)].slice(0, 8);
}

// ── LinkedIn search-string suggestions — mechanical, always producible,
// used both as the SELECT-phase starting point and as the guaranteed
// fallback in the WRITE phase when no name was actually found. ───────────

function searchStrings(company, role) {
  const base = `"${company}" India`;
  return {
    hiringManager: `site:linkedin.com/in ${base} ("Hiring Manager" OR "${role.split(/[-,(]/)[0].trim()}" OR "Team Lead" OR "Manager") -jobs`,
    recruiter: `site:linkedin.com/in ${base} (Recruiter OR "Talent Acquisition" OR "HR")`,
    peer: `site:linkedin.com/in ${base} ("${role.split(/[-,(]/)[0].trim()}" OR "Business Analyst" OR "Consultant" OR "Analyst")`,
  };
}

// ── SELECT phase ─────────────────────────────────────────────────────────

async function runSelect({ row, limit }) {
  if (!existsSync(XLSX_PATH)) { console.error(`${XLSX_PATH} not found — run export-excel.mjs first.`); process.exit(1); }

  const wb = await loadWorkbook();
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) { console.error(`Sheet "${SHEET_NAME}" not found.`); process.exit(1); }
  const idx = headerIndex(ws);
  const proofPoints = loadProofPoints();

  let targets = [];
  if (row) {
    const obj = rowToObject(ws, idx, row);
    if (!obj.Company) { console.error(`Row ${row} not found or empty.`); process.exit(1); }
    targets = [obj];
  } else {
    for (let i = 2; i <= ws.rowCount; i++) {
      const obj = rowToObject(ws, idx, i);
      const score = Number(obj.Score);
      if (!Number.isFinite(score) || score < SCORE_FLOOR) continue;
      if (obj['Contact Name']) continue; // already has a contact — skip, don't re-search
      targets.push(obj);
    }
    targets.sort((a, b) => Number(b.Score) - Number(a.Score));
    if (limit) targets = targets.slice(0, limit);
  }

  console.log(`${targets.length} row(s) selected${row ? ` (row ${row})` : limit ? ` (--limit ${limit})` : ''}.`);
  mkdirSync(BUNDLES_DIR, { recursive: true });

  for (const t of targets) {
    const bundle = {
      row: t._rowNum,
      company: t.Company,
      role: t['Job Role'],
      location: t.Location,
      applyLink: t['Apply Link'],
      searchStrings: searchStrings(t.Company, t['Job Role'] || ''),
      proofPoints,
      instructions: {
        priority: 'Search for, in order: (1) hiring manager likely to own this role, (2) a recruiter/TA person at this company, (3) one peer currently in a similar role there. Use the LinkedIn search strings as a starting point, not a strict query.',
        noNameFound: 'If a name genuinely cannot be found for a category, leave that field null in the results — the write phase will record the search string instead of inventing a name.',
        messageRules: 'Draft a LinkedIn connection note under 300 characters AND a longer follow-up message. Ground both in the proof points provided — never invent facts about the candidate. Do NOT use "I hope this finds you well" or equivalent filler. Be direct.',
      },
    };
    writeFileSync(path.join(BUNDLES_DIR, `${t._rowNum}.json`), JSON.stringify(bundle, null, 2), 'utf8');
    console.log(`  Row ${t._rowNum}: ${t.Company} — ${t['Job Role']}`);
  }

  console.log(`\n${targets.length} bundle(s) written to ${BUNDLES_DIR}/{row}.json`);
  console.log('Next: run the actual searches, judge the likely contacts, draft messages, write a results JSON (see schema in the file header), then run:');
  console.log('  node outreach.mjs --write <results.json>');
}

// ── WRITE phase ──────────────────────────────────────────────────────────

function pickPrimary(results) {
  return results.hiringManager || results.recruiter || results.peer || null;
}

function formatUnfoundNote(category, bundle) {
  const ss = bundle?.searchStrings?.[category];
  return `${category}: not found — search "${ss || '(no search string available)'}"`;
}

async function runWrite(resultsPath) {
  if (!existsSync(resultsPath)) { console.error(`${resultsPath} not found.`); process.exit(1); }
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const bundlePath = path.join(BUNDLES_DIR, `${results.row}.json`);
  const bundle = existsSync(bundlePath) ? JSON.parse(readFileSync(bundlePath, 'utf8')) : null;

  const wb = await loadWorkbook();
  const ws = wb.getWorksheet(SHEET_NAME);
  const idx = headerIndex(ws);
  const rowObj = rowToObject(ws, idx, results.row);
  if (!rowObj.Company) { console.error(`Row ${results.row} not found or empty.`); process.exit(1); }

  const primary = pickPrimary(results);
  if (primary) {
    ws.getRow(results.row).getCell(idx['Contact Name']).value = primary.name || '';
    ws.getRow(results.row).getCell(idx['Contact Title']).value = primary.title || '';
    ws.getRow(results.row).getCell(idx['Contact Link']).value = primary.link || '';
  }

  // Compact addendum for the categories not used as primary, or unfound —
  // appended to Notes, never overwriting what's already there.
  const addendumParts = [];
  for (const category of ['hiringManager', 'recruiter', 'peer']) {
    const c = results[category];
    if (c && c !== primary) addendumParts.push(`${category}: ${c.name}${c.title ? ` (${c.title})` : ''}${c.link ? ` — ${c.link}` : ''}`);
    else if (!c) addendumParts.push(formatUnfoundNote(category, bundle));
  }
  if (addendumParts.length) {
    const notesCell = ws.getRow(results.row).getCell(idx['Notes']);
    const existing = notesCell.value ? String(notesCell.value) : '';
    const addendum = `Contacts — ${addendumParts.join('; ')}`;
    notesCell.value = existing ? `${existing} | ${addendum}` : addendum;
  }

  await wb.xlsx.writeFile(XLSX_PATH);

  // Outreach message file
  mkdirSync(OUTREACH_DIR, { recursive: true });
  const outreachPath = path.join(OUTREACH_DIR, `${results.row}-outreach.md`);
  const lines = [`# Outreach — Row ${results.row}: ${rowObj.Company} — ${rowObj['Job Role']}`, ''];
  for (const category of ['hiringManager', 'recruiter', 'peer']) {
    const c = results[category];
    lines.push(`## ${category}`);
    if (!c) {
      lines.push(`Not found. Search: \`${bundle?.searchStrings?.[category] || 'n/a'}\``, '');
      continue;
    }
    lines.push(`**${c.name}** — ${c.title || 'title unknown'} — ${c.link || 'no link'}`, '');
    if (c.messageShort) {
      const len = c.messageShort.length;
      const flag = len > MESSAGE_SHORT_MAX ? ` ⚠️ ${len} chars — OVER the ${MESSAGE_SHORT_MAX}-char limit, trim before sending` : ` (${len} chars)`;
      lines.push(`**Connection note${flag}:**`, c.messageShort, '');
    }
    if (c.messageLong) {
      lines.push('**Longer message:**', c.messageLong, '');
    }
  }
  writeFileSync(outreachPath, lines.join('\n'), 'utf8');

  console.log(`Row ${results.row} (${rowObj.Company} — ${rowObj['Job Role']}) updated.`);
  console.log(`  Primary contact written to Contact Name/Title/Link: ${primary ? primary.name : '(none found — search strings recorded in Notes)'}`);
  console.log(`  Outreach drafts: ${outreachPath}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--select') opts.select = true;
    else if (argv[i] === '--write') opts.write = argv[++i];
    else if (argv[i] === '--row') opts.row = parseInt(argv[++i], 10);
    else if (argv[i] === '--limit') opts.limit = parseInt(argv[++i], 10);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.write) return runWrite(opts.write);
  if (!opts.row && !opts.limit) {
    console.error('Usage: node outreach.mjs --select --row N  |  node outreach.mjs --select --limit N  |  node outreach.mjs --write <results.json>');
    process.exit(1);
  }
  return runSelect(opts);
}

main().catch(err => {
  console.error('outreach.mjs failed:', err.message);
  process.exit(1);
});
