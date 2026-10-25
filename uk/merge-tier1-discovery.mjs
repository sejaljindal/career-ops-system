#!/usr/bin/env node
/**
 * merge-tier1-discovery.mjs — fold the Aug-30 Tier 1 sponsor-register
 * web-search discovery (25-entry checkpoint + 20 parallel-window range
 * results, 2573 employers total) into portals.yml and coverage.csv.
 *
 * Modeled on merge-discovered.mjs (same dedupe-by-normalised-name-and-host,
 * same text-level patch of portals.yml rather than a yaml.load()/dump()
 * round-trip, same detectPlatform() reuse) and on apply-stage2-tier0.mjs
 * (same row-rewrite approach for coverage.csv, same backup-before-write).
 * Kept as its own script rather than merged into data/careers-discovery.json
 * because that file is a DIFFERENT discovery stream (careers-discover.mjs's
 * domain-probing, 1558 entries) with its own provenance; conflating the two
 * would make a bad match in one impossible to trace back to its source.
 *
 * CONFLICT RULE: a coverage.csv row whose existing Coverage is anything
 * other than UNREACHABLE/blank already has a route from somewhere else
 * (curated list, prior discovery) — never overwritten, only counted.
 * A portals.yml entry that already exists (by normalised name OR by
 * careers_url host) is likewise left untouched.
 *
 * NOT_FOUND: never added to portals.yml (no route to jobs). Recorded in
 * coverage.csv's Warning column ("tier1 web-search {date}: no careers page
 * found") so nothing re-searches it, but the row is otherwise untouched.
 *
 * Multiple results for the same company (a same-day correction, e.g. Golder
 * Associates -> WSP) are resolved by preferring the LAST non-NOT_FOUND
 * result; only if every result for a name is NOT_FOUND is one of those kept.
 *
 * Usage:
 *   node merge-tier1-discovery.mjs --dry-run
 *   node merge-tier1-discovery.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';
import { detectPlatform } from './uk-ats.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const RANGES_DIR = '.cache/parallel-ranges';
const CHECKPOINT = 'data/tier1-discovery-checkpoint.json';
const PORTALS = 'portals.yml';
const COVERAGE = 'coverage.csv';
const TODAY = new Date().toISOString().slice(0, 10);

// ── same normalisation merge-discovered.mjs uses, so the two scripts agree
// on what counts as "the same company" ─────────────────────────────────────
const LEGAL = /\b(uk branch|uk|u k|limited|ltd|llp|plc|lp|incorporated|inc|company|holdings|international|group|technologies|technology|services|trading)\b/g;
const normName = (n) => String(n || '').toLowerCase()
  .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ')
  .replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
const host = (u) => { try { return new URL(u).host.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

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
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const yq = (s) => (/^[\w][\w .,&/()'+-]*$/.test(s) && !s.endsWith(' ') ? s : JSON.stringify(s));
// Inverse of yq(): a name written plain comes back plain, one written
// JSON.stringify'd (quotes/escapes) comes back parsed.
const unquoteMaybe = (s) => { const t = s.trim(); try { return t.startsWith('"') ? JSON.parse(t) : t; } catch { return t; } };

// ── 1. load every Tier 1 result, keyed by normalised name, picking the
//    right one when a company has more than one result on file ────────────
function loadAllTier1Results() {
  const byNorm = new Map(); // normName -> {result, source}

  const consider = (r, source) => {
    if (!r || !r.name) return;
    const k = normName(r.name);
    const existing = byNorm.get(k);
    if (!existing) { byNorm.set(k, { result: r, source }); return; }
    // Prefer a non-NOT_FOUND result over a NOT_FOUND one (a same-name later
    // entry correcting an earlier weak search — Golder Associates -> WSP is
    // exactly this shape). Between two non-NOT_FOUND results, keep the one
    // seen LAST (later entries are corrections, not the original).
    const existingIsFound = existing.result.outcome !== 'NOT_FOUND';
    const newIsFound = r.outcome !== 'NOT_FOUND';
    if (newIsFound || !existingIsFound) byNorm.set(k, { result: r, source });
  };

  // checkpoint (25 entries, single-window path)
  if (existsSync(CHECKPOINT)) {
    const cp = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
    for (const r of Object.values(cp.done || {})) consider(r, 'checkpoint');
  }

  // ranges 1-13 (1-12 pure Tier 1, 13 mixed Tier 1+2 — filter to tier 1 only
  // using the range's own pool file, which tags each entry's tier)
  for (let i = 1; i <= 13; i++) {
    const poolFile = `${RANGES_DIR}/range-${i}.json`;
    const resFile = `${RANGES_DIR}/range-${i}-results.json`;
    if (!existsSync(poolFile) || !existsSync(resFile)) continue;
    const pool = JSON.parse(readFileSync(poolFile, 'utf8'));
    const tier1Names = new Set(pool.filter((p) => String(p.tier) === '1' || p.tier === undefined).map((p) => normName(p.name)));
    const res = JSON.parse(readFileSync(resFile, 'utf8'));
    for (const r of res) {
      if (!tier1Names.has(normName(r.name))) continue; // range-13's tier-2 entries
      consider(r, `range-${i}`);
    }
  }

  return byNorm;
}

function main() {
  const dry = process.argv.includes('--dry-run');

  const tier1 = loadAllTier1Results();
  console.log(`Tier 1 results loaded (deduplicated by name): ${tier1.size}`);

  // ── portals.yml: which of the found ones are genuinely new? ──────────────
  const portalsText = readFileSync(PORTALS, 'utf8');
  const portalsDoc = yaml.load(portalsText);
  const takenNames = new Set();
  const takenHosts = new Set();
  for (const c of portalsDoc.tracked_companies || []) {
    if (!c || !c.name) continue;
    takenNames.add(normName(c.name));
    const h = host(c.careers_url || '');
    if (h) takenHosts.add(h);
  }

  const toAddToPortals = [];
  let portalsSkippedDupeName = 0, portalsSkippedDupeHost = 0;
  const seenHere = new Set();
  for (const { result: r } of tier1.values()) {
    if (r.outcome === 'NOT_FOUND' || !r.careers_url) continue;
    const k = normName(r.name);
    const h = host(r.careers_url);
    if (takenNames.has(k)) { portalsSkippedDupeName++; continue; }
    if (h && takenHosts.has(h)) { portalsSkippedDupeHost++; continue; }
    if (seenHere.has(k)) continue;
    seenHere.add(k);
    if (h) takenHosts.add(h);
    toAddToPortals.push(r);
  }
  toAddToPortals.sort((a, b) => a.name.localeCompare(b.name));

  // ── coverage.csv: fill in UNREACHABLE/blank rows; never overwrite a row
  //    that already has real coverage from somewhere else ─────────────────
  const covLines = readFileSync(COVERAGE, 'utf8').split(/\r?\n/);
  const ch = parseCsvLine(covLines[0]);
  const iN = ch.indexOf('Organisation'), iCov = ch.indexOf('Coverage'),
    iPlat = ch.indexOf('Platform'), iWarn = ch.indexOf('Warning');
  if ([iN, iCov, iPlat, iWarn].some((i) => i < 0)) {
    console.error('coverage.csv is missing an expected column — aborting rather than guess'); process.exit(1);
  }

  const byNormNameRows = new Map();
  const outRows = [covLines[0]];
  let matchedNoRow = 0;
  const notFoundNames = new Set([...tier1.values()].filter(({ result: r }) => r.outcome === 'NOT_FOUND').map(({ result: r }) => normName(r.name)));
  const foundNames = new Map([...tier1.values()].filter(({ result: r }) => r.outcome !== 'NOT_FOUND' && r.careers_url).map(({ result: r }) => [normName(r.name), r]));

  // BUG FIXED 2026-09-24: unlike the "found" branch below (self-guarding —
  // once Coverage leaves UNREACHABLE, hasRealCoverage is true on every later
  // run and the branch is skipped), this branch never changes Coverage, so a
  // second run had no signal telling it the note was already there and kept
  // appending another copy. Marker text checked verbatim regardless of date,
  // so a re-run on a DIFFERENT day still recognises an existing note instead
  // of adding a second, differently-dated one.
  const NOT_FOUND_MARKER = 'no careers page found — do not re-search';
  let coverageFilled = 0, coverageNotFoundNoted = 0, coverageConflictSkipped = 0, coverageAlreadyNoted = 0;

  for (const line of covLines.slice(1)) {
    if (!line) continue;
    const cells = parseCsvLine(line);
    const name = cells[iN];
    const k = normName(name);
    const hasRealCoverage = cells[iCov] && cells[iCov] !== 'UNREACHABLE';

    if (foundNames.has(k)) {
      const r = foundNames.get(k);
      if (hasRealCoverage) {
        coverageConflictSkipped++;
      } else {
        cells[iCov] = r.ats ? 'DIRECT_API' : 'AGGREGATOR_ONLY';
        if (r.ats) cells[iPlat] = r.ats;
        cells[iWarn] = `${cells[iWarn] || ''} tier1 web-search ${TODAY}: found (${r.confidence} confidence)`.trim();
        coverageFilled++;
      }
    } else if (notFoundNames.has(k)) {
      if (hasRealCoverage) {
        coverageConflictSkipped++;
      } else if ((cells[iWarn] || '').includes(NOT_FOUND_MARKER)) {
        coverageAlreadyNoted++;
      } else {
        cells[iWarn] = `${cells[iWarn] || ''} tier1 web-search ${TODAY}: ${NOT_FOUND_MARKER}`.trim();
        coverageNotFoundNoted++;
      }
    }
    outRows.push(cells.map(cell).join(','));
  }

  // Sanity: every Tier 1 name should have matched a coverage.csv row (all
  // 2573 were confirmed present before this script was written). Anything
  // left over means the row-matching logic missed something — report it
  // rather than silently drop it.
  const matchedKeys = new Set();
  for (const line of covLines.slice(1)) { if (line) matchedKeys.add(normName(parseCsvLine(line)[iN])); }
  for (const k of foundNames.keys()) if (!matchedKeys.has(k)) matchedNoRow++;
  for (const k of notFoundNames) if (!matchedKeys.has(k)) matchedNoRow++;

  // ── report ────────────────────────────────────────────────────────────
  console.log('\n--- portals.yml ---');
  console.log(`new entries to add            : ${toAddToPortals.length}`);
  console.log(`skipped, name already present  : ${portalsSkippedDupeName}`);
  console.log(`skipped, host already present  : ${portalsSkippedDupeHost}`);
  console.log('\n--- coverage.csv ---');
  console.log(`rows filled (UNREACHABLE -> found) : ${coverageFilled}`);
  console.log(`rows noted (NOT_FOUND, do-not-re-search) : ${coverageNotFoundNoted}`);
  console.log(`rows already noted (idempotent skip) : ${coverageAlreadyNoted}`);
  console.log(`rows skipped, conflict (already had real coverage) : ${coverageConflictSkipped}`);
  console.log(`Tier 1 names with no matching coverage.csv row : ${matchedNoRow}`);

  if (dry) { console.log('\n--dry-run: nothing written'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(PORTALS, `portals.before-tier1-merge-${stamp}.yml`);
  copyFileSync(COVERAGE, `coverage.before-tier1-merge-${stamp}.csv`);

  // portals.yml: append a new managed block, same style as merge-discovered.mjs
  const BEGIN = '  # >>> BEGIN tier1 web-search discovery (merge-tier1-discovery.mjs) >>>';
  const END = '  # <<< END tier1 web-search discovery <<<';
  let text = portalsText;
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);

  // BUG FIXED 2026-09-24: takenNames/takenHosts above are built from
  // portalsDoc, which is loaded from the UN-stripped file — so a company this
  // script already added on a prior run is correctly recognised as "already
  // present" and left out of toAddToPortals. That is right for DEDUPE, but
  // this block used to then unconditionally strip the old managed block and
  // rewrite it from toAddToPortals alone — on a run that added 0 NEW entries,
  // that discarded every entry a PRIOR run had legitimately added, because
  // "already present" and "belongs in the regenerated block" were conflated.
  // Fix: parse the existing block's own entries before stripping it, and
  // always carry them forward into the regenerated block — the block
  // accumulates across runs instead of being rebuilt from only this run's delta.
  const carriedForward = [];
  if (b !== -1 && e !== -1) {
    const oldBlock = text.slice(b, e);
    const entryRe = /- name: (.+)\n {4}careers_url: (.+)\n(?: {4}api: .+\n)? {4}enabled: true\n {4}notes: "(.*)"/g;
    let m;
    while ((m = entryRe.exec(oldBlock))) {
      carriedForward.push({
        name: unquoteMaybe(m[1]), careers_url: m[2].trim(),
        ats: (/ats: ([^|"]+)/.exec(m[3]) || [])[1]?.trim() || '',
        confidence: (/confidence: (\w+)/.exec(m[3]) || [])[1] || '',
      });
    }
    text = text.slice(0, b) + text.slice(e + END.length + 1);
  }
  const carriedNames = new Set(carriedForward.map((r) => normName(r.name)));
  const allEntries = [...carriedForward, ...toAddToPortals.filter((r) => !carriedNames.has(normName(r.name)))]
    .sort((a, b2) => a.name.localeCompare(b2.name));

  const atsCount = allEntries.filter((r) => r.ats).length;
  const lines = [BEGIN,
    '  #',
    `  # ${allEntries.length} employers resolved from the gov.uk Tier 1 sponsor-register pool`,
    `  # by targeted WebSearch (2026-08-30 session, merged ${TODAY}${carriedForward.length ? `; ${carriedForward.length} carried forward from a prior merge run` : ''}).`,
    `  # ${atsCount} of them expose a real ATS board and carry an "ats:" note.`,
    '  #',
    '  # This block ACCUMULATES across merge-tier1-discovery.mjs runs — a run',
    '  # that finds 0 new entries leaves prior ones in place.',
    '  #'];
  for (const r of allEntries) {
    lines.push('');
    lines.push(`  - name: ${yq(r.name)}`);
    lines.push(`    careers_url: ${r.careers_url}`);
    const p = detectPlatform(r.careers_url);
    if (p && p.jobsUrl) {
      const api = p.jobsUrl(r.careers_url);
      if (api) lines.push(`    api: ${api}`);
    }
    lines.push('    enabled: true');
    const bits = [`tier1 web-search ${TODAY}`];
    if (r.ats) bits.push(`ats: ${r.ats}`);
    bits.push(`confidence: ${r.confidence}`);
    lines.push(`    notes: "${bits.join(' | ').replace(/"/g, "'")}"`);
  }
  lines.push('');
  lines.push(END);
  const block = lines.join('\n');

  const arr = text.split('\n');
  const idx = arr.findIndex((l) => l.startsWith('job_boards:'));
  if (idx === -1) { console.error('could not locate job_boards: — aborting rather than guess'); process.exit(1); }
  let j = idx;
  while (j > 0 && arr[j - 1].trim() === '') j--;
  const out = arr.slice(0, j).join('\n') + '\n' + block + '\n\n' + arr.slice(j).join('\n');
  writeFileSync(PORTALS, out, 'utf8');

  writeFileSync(COVERAGE, outRows.join('\n'), 'utf8');

  const after = yaml.load(readFileSync(PORTALS, 'utf8'));
  console.log(`\nWROTE portals.yml   : tracked_companies ${(portalsDoc.tracked_companies || []).length} -> ${(after.tracked_companies || []).length}`);
  console.log(`WROTE coverage.csv  : ${coverageFilled} filled, ${coverageNotFoundNoted} noted`);
  console.log(`backups: portals.before-tier1-merge-${stamp}.yml, coverage.before-tier1-merge-${stamp}.csv`);
}

// GUARD ADDED 2026-09-24, after this exact omission caused a real accidental
// run: a bare `import('./merge-tier1-discovery.mjs')` used to sanity-check
// something unrelated ran main() for real, with no --dry-run in argv, writing
// to the live portals.yml/coverage.csv before the intended dry-run ever
// happened. See tailor-cv.mjs for the same fix, same reason.
if (isMainModule(import.meta.url)) main();
