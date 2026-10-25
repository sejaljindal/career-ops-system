#!/usr/bin/env node
// coverage.mjs — per-employer coverage tracking for the India job search.
//
// Tracks scan status for every employer in india_targets.csv (Discovery
// Route = PRIORITY_LIST) plus every employer the keyword sweep
// (scan-ats-full.mjs) has surfaced that wasn't on the original list
// (Discovery Route = KEYWORD_SWEEP). Gap-proof: each employer's result is
// written to output/coverage_india.csv immediately after it is scanned, so
// an interrupted run still counts everything completed so far.
//
// Usage:
//   node coverage.mjs                       # keyword sweep + next 50 priority employers, oldest-scanned-first
//   node coverage.mjs --keyword-only         # keyword sweep only, no priority-list scanning
//   node coverage.mjs --priority-only        # priority-list batch only, no keyword sweep/auto-discovery —
//                                             # use this for routine/automated runs (e.g. run-daily.mjs);
//                                             # the keyword sweep bulk-appends newly discovered employers to
//                                             # india_targets.csv with no review step, so trigger it deliberately
//   node coverage.mjs --sector="Consulting / Advisory"   # scope the priority batch to one sector
//   node coverage.mjs --tier=0               # scope the priority batch to one tier
//   node coverage.mjs --max=20                # batch size (default 50)
//   node coverage.mjs --report                # print progress, no scanning
//   node coverage.mjs --init                  # (re)seed output/coverage_india.csv from india_targets.csv, no scanning

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();
const TARGETS_CSV = path.join(ROOT, 'india_targets.csv');
const COVERAGE_CSV = path.join(ROOT, 'output', 'coverage_india.csv');
const STREAK_STATE = path.join(ROOT, 'data', 'coverage-streaks.json');
const SCAN_HISTORY_TSV = path.join(ROOT, 'data', 'scan-history.tsv');
const PORTALS_YML = path.join(ROOT, 'portals.yml');

const COLUMNS = [
  'Organisation', 'Sector', 'Tier', 'Discovery Route', 'Last Scanned',
  'Last Status', 'Times Scanned', 'Postings Found Last Time', 'Platform',
];

const COOLDOWN_DAYS = 14;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_BATCH = 50;

// ── Minimal quote-aware CSV I/O (no external dependency) ───────────────────

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

function csvField(v) {
  v = String(v ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function readCsv(filePath, columns) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    for (const c of columns) if (!(c in row)) row[c] = '';
    return row;
  });
}

// Atomic write (temp file + rename) so a crash mid-write can't corrupt the
// coverage file — same discipline scan-ats-full.mjs uses for its checkpoint.
function writeCsvAtomic(filePath, columns, rows) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map(c => csvField(row[c])).join(','));
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
  renameSync(tmp, filePath);
}

function appendTargetsCsvRow(org, sector, tier, cities) {
  const line = `${org},${sector},${tier},"${cities}"`;
  const current = readFileSync(TARGETS_CSV, 'utf8');
  const sep = current.endsWith('\n') ? '' : '\n';
  writeFileSync(TARGETS_CSV, current + sep + line + '\n', 'utf8');
}

// ── Streak state (consecutive-failure tracking; not part of the public CSV
// schema, so it lives in its own small state file under data/) ────────────

function loadStreaks() {
  if (!existsSync(STREAK_STATE)) return {};
  try { return JSON.parse(readFileSync(STREAK_STATE, 'utf8')); } catch { return {}; }
}

function saveStreaks(streaks) {
  mkdirSync(path.dirname(STREAK_STATE), { recursive: true });
  const tmp = `${STREAK_STATE}.tmp`;
  writeFileSync(tmp, JSON.stringify(streaks, null, 1), 'utf8');
  renameSync(tmp, STREAK_STATE);
}

// ── Init / load coverage file ───────────────────────────────────────────

function loadTargets() {
  const lines = readFileSync(TARGETS_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.slice(1).map(l => {
    const c = parseCsvLine(l);
    return { org: c[0], sector: c[1], tier: c[2], cities: c[3] };
  });
}

function blankRow(org, sector, tier, route) {
  return {
    'Organisation': org, 'Sector': sector, 'Tier': tier,
    'Discovery Route': route, 'Last Scanned': '', 'Last Status': 'never',
    'Times Scanned': '0', 'Postings Found Last Time': '', 'Platform': '',
  };
}

function ensureCoverageFile({ forceInit = false } = {}) {
  if (existsSync(COVERAGE_CSV) && !forceInit) return readCsv(COVERAGE_CSV, COLUMNS);
  const targets = loadTargets();
  const rows = targets.map(t => blankRow(t.org, t.sector, t.tier, 'PRIORITY_LIST'));
  writeCsvAtomic(COVERAGE_CSV, COLUMNS, rows);
  console.log(`Initialized ${COVERAGE_CSV} with ${rows.length} employers from india_targets.csv`);
  return rows;
}

// ── Platform resolution ─────────────────────────────────────────────────

function normalizeName(s) {
  return s
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\b(India|Bharat|GCC|GBS|Limited|Ltd|Group|International|Corporation|Inc)\b/gi, ' ')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function slugify(s) {
  return s
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\b(India|Bharat|GCC|GBS)\b/gi, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

let trackedCompaniesCache = null;
function loadTrackedCompanies() {
  if (trackedCompaniesCache) return trackedCompaniesCache;
  const yml = readFileSync(PORTALS_YML, 'utf8');
  const start = yml.indexOf('tracked_companies:');
  const end = yml.indexOf('# ── Search queries');
  const section = yml.slice(start, end > 0 ? end : undefined);
  const entries = [];
  const blocks = section.split(/\n  - name: /).slice(1);
  for (const b of blocks) {
    const name = b.split('\n')[0].trim();
    const urlM = b.match(/careers_url:\s*(\S+)/);
    const providerM = b.match(/provider:\s*(\S+)/);
    entries.push({ name, careers_url: urlM ? urlM[1] : null, provider: providerM ? providerM[1] : inferProviderFromUrl(urlM ? urlM[1] : '') });
  }
  trackedCompaniesCache = entries;
  return entries;
}

function inferProviderFromUrl(url) {
  if (!url) return null;
  if (/greenhouse\.io/.test(url)) return 'greenhouse';
  if (/lever\.co/.test(url)) return 'lever';
  if (/ashbyhq\.com/.test(url)) return 'ashby';
  if (/myworkdayjobs\.com/.test(url)) return 'workday';
  if (/icims\.com/.test(url)) return 'icims';
  return null;
}

let atsDatasetCache = null;
async function loadAtsDatasets() {
  if (atsDatasetCache) return atsDatasetCache;
  const base = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';
  const [wd, icims] = await Promise.all([
    fetch(`${base}/workday_companies.json`).then(r => r.json()).catch(() => []),
    fetch(`${base}/icims_companies.json`).then(r => r.json()).catch(() => []),
  ]);
  atsDatasetCache = { wd, icims };
  return atsDatasetCache;
}

// Resolve an employer to a platform + careers_url. Checks portals.yml
// tracked_companies first (cheap, already-verified), then falls back to a
// live probe (gh/ashby/lever slug guess, workday/icims dataset name match).
// Returns null if nothing resolves — caller records that as a failure.
async function resolveEmployer(org) {
  const target = normalizeName(org);
  for (const t of loadTrackedCompanies()) {
    if (normalizeName(t.name) === target && t.careers_url) {
      return { platform: t.provider, careers_url: t.careers_url };
    }
  }

  const slug = slugify(org);
  if (slug) {
    const ghUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    try {
      const r = await fetch(ghUrl, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return { platform: 'greenhouse', careers_url: `https://job-boards.greenhouse.io/${slug}`, api: ghUrl };
    } catch { /* fall through */ }

    const leverUrl = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    try {
      const r = await fetch(leverUrl, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return { platform: 'lever', careers_url: `https://jobs.lever.co/${slug}` };
    } catch { /* fall through */ }
  }

  const { wd, icims } = await loadAtsDatasets();
  const wdMatch = wd.find(x => normalizeName(String(x).split('|')[0]) === target);
  if (wdMatch) {
    const [tenant, inst, site] = String(wdMatch).split('|');
    return { platform: 'workday', careers_url: `https://${tenant}.${inst}.myworkdayjobs.com/${site}`, tenant, inst, site };
  }
  const icimsMatch = icims.find(x => normalizeName(String(x)) === target);
  if (icimsMatch) {
    return { platform: 'icims', careers_url: `https://careers-${icimsMatch}.icims.com/jobs/search?ss=1&in_iframe=1` };
  }

  return null;
}

// ── Per-platform posting fetch (best-effort count; not a full scan.mjs
// provider integration — this is a lightweight coverage signal) ──────────

async function fetchPostingCount(resolved) {
  try {
    if (resolved.platform === 'greenhouse') {
      const api = resolved.api || resolved.careers_url.replace('job-boards.greenhouse.io', 'boards-api.greenhouse.io/v1/boards') + '/jobs';
      const r = await fetch(api, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j.jobs) ? j.jobs.length : null;
    }
    if (resolved.platform === 'lever') {
      const slug = resolved.careers_url.split('/').pop();
      const r = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j) ? j.length : null;
    }
    if (resolved.platform === 'workday' && resolved.tenant) {
      const url = `https://${resolved.tenant}.${resolved.inst}.myworkdayjobs.com/wday/cxs/${resolved.tenant}/${resolved.site}/jobs`;
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 20, offset: 0, searchText: '' }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return typeof j.total === 'number' ? j.total : null;
    }
    if (resolved.platform === 'icims') {
      const r = await fetch(resolved.careers_url, { signal: AbortSignal.timeout(10000), redirect: 'manual' });
      // iCIMS has no simple public JSON list API; a 200 confirms the board is
      // live but not an exact count — record reachability, not a number.
      return r.status === 200 ? -1 : null; // -1 = "reachable, count unknown"
    }
  } catch {
    return null;
  }
  return null;
}

// ── Batch selection ─────────────────────────────────────────────────────

function selectBatch(rows, { sector, tier, max }) {
  const now = Date.now();
  const eligible = rows.filter(r => {
    if (r['Last Status'] === 'broken') return false;
    if (sector && r.Sector !== sector) return false;
    if (tier !== undefined && String(r.Tier) !== String(tier)) return false;
    if (r['Last Status'] === 'success' && r['Last Scanned']) {
      const days = (now - Date.parse(r['Last Scanned'])) / 86_400_000;
      if (days < COOLDOWN_DAYS) return false;
    }
    return true;
  });
  eligible.sort((a, b) => {
    const ta = a['Last Scanned'] ? Date.parse(a['Last Scanned']) : -Infinity;
    const tb = b['Last Scanned'] ? Date.parse(b['Last Scanned']) : -Infinity;
    return ta - tb; // oldest (or never-scanned, -Infinity) first
  });
  return eligible.slice(0, max);
}

// ── Scan one employer, persist immediately ──────────────────────────────

async function scanOne(row, rows, streaks) {
  const org = row.Organisation;
  let status, postings = '', platform = row.Platform || '';

  const resolved = await resolveEmployer(org);
  if (!resolved) {
    status = 'no_board';
  } else {
    platform = resolved.platform;
    const count = await fetchPostingCount(resolved);
    if (count === null) {
      status = 'fetch_error';
    } else {
      status = 'success';
      postings = count === -1 ? 'n/a' : String(count);
    }
  }

  if (status === 'success') {
    streaks[org] = 0;
  } else {
    streaks[org] = (streaks[org] || 0) + 1;
    if (streaks[org] >= MAX_CONSECUTIVE_FAILURES) status = 'broken';
  }

  row['Last Scanned'] = new Date().toISOString();
  row['Last Status'] = status;
  row['Times Scanned'] = String((parseInt(row['Times Scanned'], 10) || 0) + 1);
  row['Postings Found Last Time'] = postings;
  row['Platform'] = platform;

  // Gap-proof: persist after EVERY employer, not at the end of the batch.
  writeCsvAtomic(COVERAGE_CSV, COLUMNS, rows);
  saveStreaks(streaks);

  return status;
}

// ── Keyword-sweep new-employer detection ────────────────────────────────
// Cross-references company names in data/scan-history.tsv (written by both
// scan.mjs and scan-ats-full.mjs) against the coverage file's Organisation
// column. Anything not already tracked gets appended to BOTH
// india_targets.csv (so it becomes a permanent part of the priority list —
// "the list grows itself") and output/coverage_india.csv (Discovery Route =
// KEYWORD_SWEEP).

// A location string counts as India-relevant only with an explicit named
// India place — "India" itself or a named city/state. Deliberately does NOT
// accept bare "Remote": on these boards "Remote" defaults to US-remote far
// more often than not, so treating it as a pass let through ~250 clearly
// non-India companies (Coca-Cola, OpenAI, Pfizer, Best Western...) in a live
// test — bare "Remote" carries no real evidence either way here (unlike an
// individual job's full location_filter + country_eligibility_filter, this
// function only has the raw scan-history.tsv location string to go on, and
// that string alone can't distinguish "Remote (India ok)" from "Remote (US
// only)"). Blank/unrecognized locations do NOT pass either, unlike the
// softer "don't penalize missing data" rule used for scoring an individual
// job match — growing the permanent priority list needs positive evidence,
// not just the absence of a red flag.
const INDIA_LOCATION_SIGNAL = /\bindia\b|delhi|\bncr\b|gurugram|gurgaon|noida|hyderabad|\bpune\b|bengaluru|bangalore|\bmumbai\b|\bchennai\b|kolkata|ahmedabad/i;

function detectNewEmployers(rows) {
  if (!existsSync(SCAN_HISTORY_TSV)) return { newCount: 0, names: [] };
  const lines = readFileSync(SCAN_HISTORY_TSV, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { newCount: 0, names: [] };

  const header = lines[0].split('\t');
  const companyIdx = header.indexOf('company');
  const statusIdx = header.indexOf('status');
  const locationIdx = header.indexOf('location');
  if (companyIdx === -1) return { newCount: 0, names: [] }; // schema changed — don't guess

  // Substring-containment match, not exact equality — the CSV and
  // scan-history often carry name variants of the same real employer
  // ("Accenture" vs "Accenture Strategy & Consulting", "PwC India" vs
  // "PwC — Global Experienced Careers"). Exact match alone re-adds the same
  // company under a slightly different string every run.
  const knownNorms = rows.map(r => normalizeName(r.Organisation)).filter(Boolean);
  const isKnown = norm => knownNorms.some(k => k === norm || k.includes(norm) || norm.includes(k));

  const seen = new Set();
  const added = [];
  let rejectedNoIndiaSignal = 0;
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const company = cols[companyIdx];
    if (!company) continue;
    // Only count rows the scanner actually kept (added/matched a filter) —
    // 'skipped'/'duplicate'/'filtered' rows are not real discoveries.
    if (statusIdx !== -1 && cols[statusIdx] && !/^(added|matched)$/i.test(cols[statusIdx])) continue;
    const norm = normalizeName(company);
    if (!norm || isKnown(norm) || seen.has(norm)) continue;
    if (locationIdx !== -1 && !INDIA_LOCATION_SIGNAL.test(cols[locationIdx] || '')) { rejectedNoIndiaSignal++; continue; }
    seen.add(norm);
    knownNorms.push(norm);
    added.push(company);
    appendTargetsCsvRow(company, 'Discovered (keyword sweep)', '', '');
    rows.push(blankRow(company, 'Discovered (keyword sweep)', '', 'KEYWORD_SWEEP'));
  }
  if (added.length) writeCsvAtomic(COVERAGE_CSV, COLUMNS, rows);
  if (rejectedNoIndiaSignal) console.log(`  (${rejectedNoIndiaSignal} keyword-matched compan${rejectedNoIndiaSignal === 1 ? 'y' : 'ies'} skipped — no India location signal on the matched posting)`);
  return { newCount: added.length, names: added };
}

// ── Report ───────────────────────────────────────────────────────────────

function printReport(rows) {
  const total = rows.length;
  const byStatus = {};
  for (const r of rows) byStatus[r['Last Status'] || 'never'] = (byStatus[r['Last Status'] || 'never'] || 0) + 1;
  const scanned = total - (byStatus['never'] || 0);

  console.log('═'.repeat(60));
  console.log('  India Coverage Report');
  console.log('═'.repeat(60));
  console.log(`  Total employers tracked:  ${total}`);
  console.log(`  Ever scanned:             ${scanned} (${((scanned / total) * 100).toFixed(1)}%)`);
  console.log(`  Never scanned:            ${byStatus['never'] || 0}`);
  console.log(`  Success:                  ${byStatus['success'] || 0}`);
  console.log(`  No board found:           ${byStatus['no_board'] || 0}`);
  console.log(`  Fetch error:              ${byStatus['fetch_error'] || 0}`);
  console.log(`  Broken (3+ failures):     ${byStatus['broken'] || 0}`);
  console.log();

  console.log('  By sector:');
  const bySector = {};
  for (const r of rows) {
    const s = r.Sector || '(unclassified)';
    bySector[s] = bySector[s] || { total: 0, scanned: 0, success: 0 };
    bySector[s].total++;
    if (r['Last Status'] !== 'never') bySector[s].scanned++;
    if (r['Last Status'] === 'success') bySector[s].success++;
  }
  const sectorNames = Object.keys(bySector).sort((a, b) => bySector[b].total - bySector[a].total);
  for (const s of sectorNames) {
    const d = bySector[s];
    console.log(`    ${s.padEnd(40)} ${String(d.scanned).padStart(3)}/${String(d.total).padEnd(3)} scanned, ${d.success} live boards found`);
  }
  console.log();

  const discovered = rows.filter(r => r['Discovery Route'] === 'KEYWORD_SWEEP');
  console.log(`  Employers discovered by keyword sweep, not on the original list: ${discovered.length}`);
  if (discovered.length) {
    console.log(`    ${discovered.slice(0, 15).map(r => r.Organisation).join(', ')}${discovered.length > 15 ? ', …' : ''}`);
  }
  console.log('═'.repeat(60));
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { max: DEFAULT_BATCH };
  for (const a of argv) {
    if (a === '--keyword-only') opts.keywordOnly = true;
    else if (a === '--priority-only') opts.priorityOnly = true;
    else if (a === '--report') opts.report = true;
    else if (a === '--init') opts.init = true;
    else if (a === '--detect-new') opts.detectNew = true;
    else if (a.startsWith('--sector=')) opts.sector = a.slice('--sector='.length).replace(/^"|"$/g, '');
    else if (a.startsWith('--tier=')) opts.tier = a.slice('--tier='.length);
    else if (a.startsWith('--max=')) opts.max = parseInt(a.slice('--max='.length), 10) || DEFAULT_BATCH;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.init) {
    ensureCoverageFile({ forceInit: true });
    return;
  }

  let rows = ensureCoverageFile();

  if (opts.report) {
    printReport(rows);
    return;
  }

  if (opts.detectNew) {
    const { newCount, names } = detectNewEmployers(rows);
    console.log(`${newCount} new employer(s) added to india_targets.csv: ${names.join(', ') || '(none)'}`);
    return;
  }

  if (opts.keywordOnly) {
    console.log('Running keyword sweep (scan-ats-full.mjs)...');
    spawnSync('node', ['scan-ats-full.mjs', '--since', '30', '--resume'], { stdio: 'inherit', cwd: ROOT });
    const { newCount, names } = detectNewEmployers(rows);
    console.log(`\nKeyword sweep done. ${newCount} new employer(s) added to india_targets.csv: ${names.slice(0, 20).join(', ')}`);
    return;
  }

  const noFilters = !opts.sector && opts.tier === undefined;
  if (noFilters && !opts.priorityOnly) {
    console.log('Running keyword sweep (scan-ats-full.mjs)...');
    spawnSync('node', ['scan-ats-full.mjs', '--since', '30', '--resume'], { stdio: 'inherit', cwd: ROOT });
    rows = readCsv(COVERAGE_CSV, COLUMNS);
    const { newCount } = detectNewEmployers(rows);
    if (newCount) console.log(`${newCount} new employer(s) discovered and added to india_targets.csv.`);
    rows = readCsv(COVERAGE_CSV, COLUMNS);
  }

  const streaks = loadStreaks();
  const batch = selectBatch(rows, { sector: opts.sector, tier: opts.tier, max: opts.max });
  console.log(`\nScanning ${batch.length} priority-list employer(s) (oldest-scanned-first)...`);

  const tally = {};
  for (const row of batch) {
    const status = await scanOne(row, rows, streaks);
    tally[status] = (tally[status] || 0) + 1;
    console.log(`  ${status.padEnd(12)} ${row.Organisation}`);
  }

  console.log('\nBatch complete:', JSON.stringify(tally));
  printReport(rows);
}

main().catch(err => {
  console.error('coverage.mjs failed:', err.message);
  process.exit(1);
});
