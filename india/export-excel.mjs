#!/usr/bin/env node
// export-excel.mjs — builds output/pipeline_india.xlsx from every evaluation
// report that passed the hard gates (location, CTC floor, experience/
// seniority). Sorted Days Old ascending, then Score descending.
//
// Incremental / append-only: if output/pipeline_india.xlsx already exists,
// any row whose Status cell is already filled in is NEVER overwritten or
// recomputed — it's carried forward exactly as-is (the user may have hand-
// edited Status/Applied On/Notes/Contact fields directly in Excel). New rows
// are appended and deduplicated against existing ones on Company + Job Role.
//
// Data sources, joined by report number / URL:
//   reports/{num}-{slug}-{date}.md      — header fields + Machine Summary YAML
//   batch/tracker-additions/{num}-*.tsv — Status, Notes (first-write default only)
//   data/scan-history.tsv               — Location, Posted Date
//   data/pipeline.md                    — Source (checks for `source: MANUAL`)
//   output/coverage_india.csv           — feeds the Coverage sheet
//
// Sheets: "Pipeline (India)", "Coverage", "By Sector"
//
// Usage: node export-excel.mjs

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import ExcelJS from 'exceljs';
import { scopeCheck } from './experience-gate.mjs';
import {
  CTC_FLOOR_LPA, resolveLpaFloor, classifyCtcStatus, ctcStatusFillColor,
  cityMatches, classifyLocationPriority,
} from './ctc-location.mjs';

const ROOT = process.cwd();
const REPORTS_DIR = path.join(ROOT, 'reports');
const TRACKER_DIR = path.join(ROOT, 'batch', 'tracker-additions');
const SCAN_HISTORY_TSV = path.join(ROOT, 'data', 'scan-history.tsv');
const PIPELINE_PATH = path.join(ROOT, 'data', 'pipeline.md');
const TARGETS_CSV = path.join(ROOT, 'india_targets.csv');
const PROFILE_YML = path.join(ROOT, 'config', 'profile.yml');
const COVERAGE_CSV = path.join(ROOT, 'output', 'coverage_india.csv');
const OUT_PATH = path.join(ROOT, 'output', 'pipeline_india.xlsx');

const SHEET_NAME = 'Pipeline (India)';

const HEADERS = [
  'Rank', 'Score', 'Posted', 'Days Old', 'Company', 'Sector', 'Job Role',
  'Location', 'Location Priority', 'CTC', 'CTC Status', 'Experience Gate Result',
  'Remote Type', 'Language Verdict', 'Edge Flag', 'Source', 'Apply Link',
  'Job Posting Link', 'CV File', 'Cover Letter', 'Contact Name', 'Contact Title',
  'Contact Link', 'Status', 'Applied On', 'Notes',
];

// ── data/scan-history.tsv lookup: URL → { location, postedAt } ─────────────

function loadScanHistory() {
  const map = new Map();
  if (!existsSync(SCAN_HISTORY_TSV)) return map;
  const lines = readFileSync(SCAN_HISTORY_TSV, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = lines[0].split('\t');
  const urlIdx = header.indexOf('url');
  const locIdx = header.indexOf('location');
  const postedIdx = header.indexOf('posted_at');
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const url = cols[urlIdx];
    if (!url) continue;
    map.set(url, { location: cols[locIdx] || '', postedAt: cols[postedIdx] || '' });
  }
  return map;
}

// ── data/pipeline.md: report number → source tag ───────────────────────────

function loadSourceTags() {
  const map = new Map();
  if (!existsSync(PIPELINE_PATH)) return map;
  const content = readFileSync(PIPELINE_PATH, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^- \[x\] #(\d+)\b.*$/);
    if (!m) continue;
    map.set(m[1].padStart(3, '0'), /source:\s*MANUAL\b/i.test(line) ? 'Manual' : 'Automated ATS');
  }
  return map;
}

// ── batch/tracker-additions/{num}-*.tsv: report number → { status, notes } ─

function loadTrackerAdditions() {
  const map = new Map();
  if (!existsSync(TRACKER_DIR)) return map;
  for (const f of readdirSync(TRACKER_DIR)) {
    if (!f.endsWith('.tsv')) continue;
    const numMatch = f.match(/^(\d+)-/);
    if (!numMatch) continue;
    const cols = readFileSync(path.join(TRACKER_DIR, f), 'utf8').trim().split('\t');
    map.set(numMatch[1].padStart(3, '0'), { status: cols[4] || '', notes: cols[8] || '' });
  }
  return map;
}

// ── india_targets.csv: company name → Sector (substring-containment match) ─

function normalizeName(s) {
  return (s || '')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\b(India|Bharat|GCC|GBS|Limited|Ltd|Group|International|Corporation|Inc)\b/gi, ' ')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function loadSectorLookup() {
  const rows = [];
  if (!existsSync(TARGETS_CSV)) return rows;
  const lines = readFileSync(TARGETS_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) {
    const m = line.match(/^([^,]+),([^,]+),([^,]*),/);
    if (!m) continue;
    rows.push({ norm: normalizeName(m[1]), sector: m[2] });
  }
  return rows;
}

function lookupSector(sectorRows, company) {
  const norm = normalizeName(company);
  if (!norm) return '';
  const hit = sectorRows.find(r => r.norm === norm || r.norm.includes(norm) || norm.includes(r.norm));
  return hit ? hit.sector : '';
}

// ── config/profile.yml: location.priority tiers + language.output ─────────

function loadProfileConfig() {
  if (!existsSync(PROFILE_YML)) return { priorityTiers: [], outputLang: 'en' };
  const doc = yaml.load(readFileSync(PROFILE_YML, 'utf8')) || {};
  return {
    priorityTiers: doc.location?.priority || [],
    outputLang: doc.language?.output || 'en',
  };
}

function resolveGenericLocation(location, priorityTiers, reportContent) {
  if (!/^\d+\s+locations?$/i.test((location || '').trim())) return location;
  if (!reportContent) return location;
  const contentLower = reportContent.toLowerCase();
  for (const t of priorityTiers) {
    for (const city of t.locations || []) {
      if (cityMatches(contentLower, city)) return city;
    }
  }
  return location;
}

// ── Remote Type — classify from Block A's "Remote" table row ───────────────

function extractRemoteType(content) {
  const m = content.match(/\|\s*Remote\s*\|\s*([^|]+?)\s*\|/i);
  if (!m) return '';
  const v = m[1].trim();
  if (/^remote\b/i.test(v)) return 'Remote';
  const hasOnsite = /onsite|on-site/i.test(v);
  const hasHybrid = /hybrid/i.test(v);
  if (hasOnsite && hasHybrid) return 'Onsite/Hybrid';
  if (hasHybrid) return 'Hybrid';
  if (hasOnsite) return 'Onsite';
  return 'Unclear';
}

// ── Edge Flag — STEP 4 of modes/_profile.md, computed from Sector/archetype

function computeEdgeFlags(sector, archetype) {
  const s = (sector || '').toLowerCase();
  const a = (archetype || '').toLowerCase();
  const flags = [];
  if (s.includes('consult') || a.includes('consultant')) {
    flags.push('£100K commercial risk identified at EMPLOYER_ONE');
  }
  if (s.includes('infrastructure') || s.includes('capital project') || a.includes('infrastructure') || a.includes('capital project')) {
    flags.push('£83.6M UK portfolio, DfT and principal contractor exposure — rare in the Indian market');
  }
  if (s.includes('financial services')) {
    flags.push('YOUR_MSc Finance');
  }
  if (s.includes('global tech') || a.includes('reporting') || a.includes('bi ')) {
    flags.push('SQL, Power BI, 48h to 4h process redesign');
  }
  if (s.includes('global capability centre') || s.includes('gcc')) {
    flags.push('2 years UK delivery experience');
  }
  return flags.join('; ');
}

// ── Parse one report file ───────────────────────────────────────────────

function parseReport(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const num = path.basename(filePath).match(/^(\d+)-/)?.[1];
  if (!num) return null;

  const scoreMatch = content.match(/\*\*Score:\*\*\s*(\d(?:\.\d)?)\/5/);
  if (!scoreMatch) return null; // gated / dead / unreachable — no real score

  const score = parseFloat(scoreMatch[1]);
  const urlMatch = content.match(/\*\*URL:\*\*\s*(\S+)/);
  const pdfMatch = content.match(/\*\*PDF:\*\*\s*(\S+\.pdf)/);
  const titleMatch = content.match(/^# Evaluation:\s*(.+?)\s*—\s*(.+)$/m);

  const ymlMatch = content.match(/```yaml\n([\s\S]*?)\n```/);
  let ms = {};
  if (ymlMatch) {
    try { ms = yaml.load(ymlMatch[1]) || {}; } catch { ms = {}; }
  }

  const company = ms.company || titleMatch?.[1] || '';
  const role = ms.role || titleMatch?.[2] || '';
  const url = ms.url || urlMatch?.[1] || '';
  const advertisedComp = ms.advertised_comp ?? null;
  const archetype = ms.archetype || '';

  // ── Experience Gate Result ────────────────────────────────────────────
  // REWRITTEN 2026-09-04. The previous version could ONLY ever print "PASS":
  //
  //     const gateApplied = parseInt(num, 10) >= 24;
  //     gateResult: gateApplied ? 'PASS (gate applied)' : 'PASS (pre-rubric…)'
  //
  // Both branches were hardcoded to PASS. It was recording *provenance*
  // (did a gate exist when this report was written?) while reading like a
  // *verdict*. The result: "Associate Director", "Senior Manager, Business
  // Planning & Analysis" and "Lending Lead Analyst – Vice President" all sat
  // in the sheet labelled "PASS (gate applied)". They had never been tested.
  //
  // Now it runs the real scopeCheck() from experience-gate.mjs and reports
  // what it actually finds.
  //
  // DELIBERATELY TITLE-ONLY. The report body is not passed as jdText, even
  // though it often quotes the requirement, because the same body also
  // discusses the CANDIDATE's tenure ("candidate has ~2.5 years"). The
  // year-extraction regex would read the "5" out of "2.5 years" as a 5-year
  // requirement and fabricate a FAIL. A conservative title check that is
  // right is worth more than a body scan that is sometimes confidently wrong.
  // The numeric half of the gate belongs where real JD text exists.
  const scope = scopeCheck(role, '');
  const gateResult = scope.pass
    ? 'PASS (title check — JD not read)'
    : `FAIL — ${scope.reason}`;

  return {
    num, score, company, role, url, pdf: pdfMatch?.[1] || '', advertisedComp, archetype,
    remoteType: extractRemoteType(content),
    gateResult,
    content,
  };
}

// ── Dedup key — Company + Job Role, case/whitespace-insensitive ────────────

function rowKey(company, role) {
  return `${(company || '').trim().toLowerCase()}|${(role || '').trim().toLowerCase()}`;
}

// ── Read an existing workbook's Pipeline sheet, if present. Any row whose
// Status is non-empty is protected: carried forward untouched on re-export,
// never recomputed. This is what makes hand-edits (Status, Applied On,
// Notes, Contact fields, or anything else the user corrected in Excel)
// survive a re-run instead of being silently clobbered. ────────────────────

// Old header name → current header name. Lets a protected row read back from
// a file written under a previous column schema without losing data — e.g.
// this session's rename from "Posted Date" to "Posted". Columns dropped
// entirely in the current schema (Experience Gate Result, Job Posting Link)
// have no entry here and are simply not carried forward.
const HEADER_ALIASES = {
  'Posted Date': 'Posted',
  'CTC (if stated)': 'CTC',
  'Cover Letter File': 'Cover Letter',
};

async function loadProtectedRows() {
  const protectedRows = new Map();
  if (!existsSync(OUT_PATH)) return protectedRows;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(OUT_PATH);
    const ws = wb.getWorksheet(SHEET_NAME);
    if (!ws) return protectedRows;
    const headerRow = ws.getRow(1).values.slice(1);
    for (let i = 2; i <= ws.rowCount; i++) {
      const r = ws.getRow(i);
      const obj = {};
      headerRow.forEach((h, idx) => {
        const v = r.getCell(idx + 1).value;
        obj[h] = v;
        if (HEADER_ALIASES[h]) obj[HEADER_ALIASES[h]] = v; // schema-migration compat
      });
      if (obj.Status !== undefined && obj.Status !== null && String(obj.Status).trim() !== '') {
        protectedRows.set(rowKey(obj.Company, obj['Job Role']), obj);
      }
    }
  } catch (err) {
    console.error(`Warning: could not read existing ${OUT_PATH} (${err.message}) — proceeding without row protection.`);
  }
  return protectedRows;
}

// ── output/coverage_india.csv → Coverage sheet summary ─────────────────────

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

function loadCoverageSummary() {
  if (!existsSync(COVERAGE_CSV)) return null;
  const lines = readFileSync(COVERAGE_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = lines.slice(1).map(l => parseCsvLine(l));

  const byStatus = {};
  const bySector = {};
  for (const r of rows) {
    const status = r[idx['Last Status']] || 'never';
    byStatus[status] = (byStatus[status] || 0) + 1;
    const sector = r[idx['Sector']] || '(unclassified)';
    bySector[sector] = bySector[sector] || { total: 0, scanned: 0, success: 0 };
    bySector[sector].total++;
    if (status !== 'never') bySector[sector].scanned++;
    if (status === 'success') bySector[sector].success++;
  }
  const total = rows.length;
  const scanned = total - (byStatus['never'] || 0);
  const discovered = rows.filter(r => r[idx['Discovery Route']] === 'KEYWORD_SWEEP').length;

  return { total, scanned, byStatus, bySector, discovered };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(REPORTS_DIR)) {
    console.error('reports/ directory not found.');
    process.exit(1);
  }

  const scanHistory = loadScanHistory();
  const sourceTags = loadSourceTags();
  const trackerAdditions = loadTrackerAdditions();
  const sectorRows = loadSectorLookup();
  const { priorityTiers } = loadProfileConfig();
  const outputLang = loadProfileConfig().outputLang;
  const protectedRows = await loadProtectedRows();

  const reportFiles = readdirSync(REPORTS_DIR).filter(f => /^\d+-.+\.md$/.test(f));
  const freshRows = [];
  let excludedGated = 0;
  let excludedCtc = 0;
  let protectedCount = 0;
  let skippedProtected = 0;

  for (const f of reportFiles) {
    const parsed = parseReport(path.join(REPORTS_DIR, f));
    if (!parsed) { excludedGated++; continue; }

    const key = rowKey(parsed.company, parsed.role);
    if (protectedRows.has(key)) { skippedProtected++; continue; } // protected version wins — don't recompute

    const ctcFloor = resolveLpaFloor(parsed.advertisedComp);
    if (ctcFloor !== null && ctcFloor < CTC_FLOOR_LPA) { excludedCtc++; continue; }

    const hist = scanHistory.get(parsed.url) || {};
    const tracker = trackerAdditions.get(parsed.num) || {};
    const source = sourceTags.get(parsed.num) || 'Automated ATS';

    const postedDate = hist.postedAt || '';
    let daysOld = '';
    if (postedDate && /^\d{4}-\d{2}-\d{2}/.test(postedDate)) {
      const diffMs = Date.now() - new Date(postedDate).getTime();
      daysOld = Math.max(0, Math.round(diffMs / 86_400_000));
    }

    const sector = lookupSector(sectorRows, parsed.company);
    const location = resolveGenericLocation(hist.location || '', priorityTiers, parsed.content);
    const ctcStatus = classifyCtcStatus(parsed.advertisedComp);

    freshRows.push({
      score: parsed.score,
      company: parsed.company,
      sector,
      source,
      role: parsed.role,
      location,
      locationPriority: classifyLocationPriority(priorityTiers, location, parsed.remoteType),
      ctc: parsed.advertisedComp || '',
      ctcStatus,
      postedDate,
      daysOld,
      gateResult: parsed.gateResult,
      remoteType: parsed.remoteType,
      languageVerdict: `Match (${outputLang})`,
      edgeFlag: computeEdgeFlags(sector, parsed.archetype),
      applyLink: parsed.url,
      jobPostingLink: parsed.url,
      cvFile: parsed.pdf,
      coverLetterFile: '',
      contactName: '',
      contactTitle: '',
      contactLink: '',
      status: tracker.status || 'Evaluated',
      appliedOn: '',
      notes: tracker.notes || '',
    });
  }

  // Combine: protected rows carried forward untouched + freshly computed rows.
  const combined = [];
  for (const obj of protectedRows.values()) {
    combined.push({
      score: obj.Score, company: obj.Company, sector: obj.Sector, source: obj.Source,
      role: obj['Job Role'], location: obj.Location, locationPriority: obj['Location Priority'],
      ctc: obj.CTC, ctcStatus: obj['CTC Status'], postedDate: obj.Posted, daysOld: obj['Days Old'],
      gateResult: obj['Experience Gate Result'], remoteType: obj['Remote Type'],
      languageVerdict: obj['Language Verdict'], edgeFlag: obj['Edge Flag'],
      applyLink: obj['Apply Link'], jobPostingLink: obj['Job Posting Link'],
      cvFile: obj['CV File'], coverLetterFile: obj['Cover Letter'],
      contactName: obj['Contact Name'], contactTitle: obj['Contact Title'], contactLink: obj['Contact Link'],
      status: obj.Status, appliedOn: obj['Applied On'], notes: obj.Notes,
    });
    protectedCount++;
  }
  combined.push(...freshRows);

  // Sort: Days Old ascending (blank/unknown sorts last), then Score descending.
  combined.sort((a, b) => {
    const aAge = a.daysOld === '' || a.daysOld === undefined || a.daysOld === null ? Infinity : Number(a.daysOld);
    const bAge = b.daysOld === '' || b.daysOld === undefined || b.daysOld === null ? Infinity : Number(b.daysOld);
    if (aAge !== bAge) return aAge - bAge;
    return (Number(b.score) || 0) - (Number(a.score) || 0);
  });
  combined.forEach((r, i) => { r.rank = i + 1; });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'career-ops export-excel.mjs';
  wb.created = new Date();

  // ── Sheet 1: Pipeline (India) ──────────────────────────────────────────
  const ws = wb.addWorksheet(SHEET_NAME);
  ws.columns = HEADERS.map(h => ({ header: h, key: h, width: Math.max(12, Math.min(40, h.length + 6)) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADERS.length } };

  for (const r of combined) {
    const excelRow = ws.addRow({
      'Rank': r.rank, 'Score': r.score, 'Posted': r.postedDate, 'Days Old': r.daysOld,
      'Company': r.company, 'Sector': r.sector, 'Job Role': r.role, 'Location': r.location,
      'Location Priority': r.locationPriority, 'CTC': r.ctc, 'CTC Status': r.ctcStatus,
      'Experience Gate Result': r.gateResult, 'Remote Type': r.remoteType,
      'Language Verdict': r.languageVerdict, 'Edge Flag': r.edgeFlag,
      'Source': r.source, 'Apply Link': r.applyLink, 'Job Posting Link': r.jobPostingLink,
      'CV File': r.cvFile, 'Cover Letter': r.coverLetterFile, 'Contact Name': r.contactName,
      'Contact Title': r.contactTitle, 'Contact Link': r.contactLink, 'Status': r.status,
      'Applied On': r.appliedOn, 'Notes': r.notes,
    });
    const ctcCell = excelRow.getCell('CTC Status');
    ctcCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ctcStatusFillColor(String(r.ctcStatus || '')) } };
  }

  // ── Make every URL cell a REAL, clickable Excel hyperlink ───────────────
  // Added 2026-09-04. Before this, links were written as plain text strings.
  // Excel only auto-linkifies a URL you type and press Enter on — it does NOT
  // linkify text written by a library, so every link in this sheet had to be
  // copy-pasted into a browser rather than clicked. This converts them in
  // place. Non-URL values (blanks, LinkedIn search strings that are already
  // URLs, "n/a") are left exactly as they are.
  const LINK_COLUMNS = ['Apply Link', 'Job Posting Link', 'Contact Link'];
  for (const colName of LINK_COLUMNS) {
    let col;
    try { col = ws.getColumn(colName); } catch { continue; }
    if (!col) continue;
    col.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber === 1) return;                       // header
      const raw = cell.value;
      const text = typeof raw === 'string' ? raw : (raw && raw.text) || '';
      if (!/^https?:\/\//i.test(text.trim())) return;    // not a URL — leave alone
      cell.value = { text: text.trim(), hyperlink: text.trim() };
      cell.font = { color: { argb: 'FF0563C1' }, underline: true };
    });
  }

  ws.getColumn('Job Role').width = 42;
  ws.getColumn('Notes').width = 50;
  ws.getColumn('Apply Link').width = 45;
  ws.getColumn('Job Posting Link').width = 45;
  ws.getColumn('CV File').width = 38;
  ws.getColumn('Sector').width = 26;
  ws.getColumn('Location Priority').width = 24;
  ws.getColumn('CTC Status').width = 22;
  ws.getColumn('Experience Gate Result').width = 26;
  ws.getColumn('Edge Flag').width = 55;
  ws.getColumn('Remote Type').width = 16;

  // ── Sheet 2: Coverage ───────────────────────────────────────────────────
  const covWs = wb.addWorksheet('Coverage');
  const coverage = loadCoverageSummary();
  covWs.getColumn(1).width = 30;
  covWs.getColumn(2).width = 18;
  if (!coverage) {
    covWs.addRow(['output/coverage_india.csv not found — run `npm run coverage:scan` first.']);
  } else {
    covWs.addRow(['India Coverage Summary']).font = { bold: true, size: 14 };
    covWs.addRow([]);
    covWs.addRow(['Total employers tracked', coverage.total]);
    covWs.addRow(['Ever scanned', `${coverage.scanned} (${((coverage.scanned / coverage.total) * 100).toFixed(1)}%)`]);
    covWs.addRow(['Never scanned', coverage.byStatus['never'] || 0]);
    covWs.addRow(['Success', coverage.byStatus['success'] || 0]);
    covWs.addRow(['No board found', coverage.byStatus['no_board'] || 0]);
    covWs.addRow(['Fetch error', coverage.byStatus['fetch_error'] || 0]);
    covWs.addRow(['Broken (3+ failures)', coverage.byStatus['broken'] || 0]);
    covWs.addRow(['Discovered by keyword sweep (not on original list)', coverage.discovered]);
    covWs.addRow([]);
    const header = covWs.addRow(['Sector', 'Scanned / Total', 'Live boards found']);
    header.font = { bold: true };
    const sectorNames = Object.keys(coverage.bySector).sort((a, b) => coverage.bySector[b].total - coverage.bySector[a].total);
    for (const s of sectorNames) {
      const d = coverage.bySector[s];
      covWs.addRow([s, `${d.scanned}/${d.total}`, d.success]);
    }
  }

  // ── Sheet 3: By Sector — count of live (evaluated, passing) roles per sector
  const bySectorWs = wb.addWorksheet('By Sector');
  bySectorWs.getColumn(1).width = 30;
  bySectorWs.getColumn(2).width = 16;
  const header3 = bySectorWs.addRow(['Sector', 'Live Roles']);
  header3.font = { bold: true };
  const liveBySector = {};
  for (const r of combined) {
    const s = r.sector || '(unclassified)';
    liveBySector[s] = (liveBySector[s] || 0) + 1;
  }
  const sortedSectors = Object.keys(liveBySector).sort((a, b) => liveBySector[b] - liveBySector[a]);
  for (const s of sortedSectors) bySectorWs.addRow([s, liveBySector[s]]);
  bySectorWs.addRow([]);
  const totalRow = bySectorWs.addRow(['Total', combined.length]);
  totalRow.font = { bold: true };

  await wb.xlsx.writeFile(OUT_PATH);
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Rows in sheet: ${combined.length} (${protectedCount} protected/preserved, ${freshRows.length} freshly computed)`);
  console.log(`Skipped recomputing (already protected): ${skippedProtected}`);
  console.log(`Excluded (gated/dead/unreachable — no score): ${excludedGated}`);
  console.log(`Excluded (CTC below ${CTC_FLOOR_LPA} LPA floor): ${excludedCtc}`);
  return combined.length;
}

main().catch(err => {
  console.error('export-excel.mjs failed:', err.message);
  process.exit(1);
});
