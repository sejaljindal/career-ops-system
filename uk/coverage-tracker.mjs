#!/usr/bin/env node
/**
 * coverage-tracker.mjs — per-employer scan coverage. Replaces batch ranges.
 *
 * WHY BATCH RANGES LEAK. "Scan rows 300-600 tonight" assumes the run finishes.
 * When it dies at row 412 the range still advances, and rows 412-600 are never
 * looked at again — a silent permanent hole. This tracks state per EMPLOYER, so
 * the only thing that can move an employer forward in time is that employer
 * actually being scanned.
 *
 * GAP-PROOF GUARANTEES
 *   1. A timestamp is written the instant an employer is scanned, never batched
 *      at the end of a run. Kill the process mid-batch and everything already
 *      scanned counts; everything not reached keeps its old timestamp.
 *   2. Every write goes to an append-only journal FIRST (one line, O(1), fsync-
 *      ordered by the OS). output/coverage.csv is a materialised view. On load
 *      the journal is replayed over the CSV, so a crash between the two loses
 *      nothing.
 *   3. The queue is derived, never stored. There is no cursor to corrupt.
 *
 * QUEUE ORDER — oldest-first, never-scanned at the very top:
 *      sort by (consecutive failures asc, last scanned asc, never = epoch 0)
 *   An employer only leaves the front once it is scanned SUCCESSFULLY.
 *   Failures are retried but deprioritised; after MAX_FAILURES consecutive
 *   failures the employer is marked broken and skipped until you clear it.
 *
 * RE-SCAN: a successful scan buys RESCAN_DAYS of quiet. --force ignores it.
 *
 * Commands:
 *   node coverage-tracker.mjs init                  seed/refresh the roster
 *   node coverage-tracker.mjs next --max=300        next batch (respects filters)
 *   node coverage-tracker.mjs record "<org>" --status=success --postings=7 --ats=greenhouse
 *   node coverage-tracker.mjs stats                 the coverage report (npm run coverage)
 *   node coverage-tracker.mjs reset-broken          clear broken flags
 *
 * Filters compose on `next` and `stats`: --mode=curated|register-only|all
 *                                        --list=University --tier=0 --entity=HE
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';

const OUT_DIR = 'output';
const CSV = `${OUT_DIR}/coverage.csv`;
const JOURNAL = `${OUT_DIR}/coverage-journal.tsv`;

export const RESCAN_DAYS = 14;
export const MAX_FAILURES = 3;
const DAY = 86400000;

// Columns 1-9 are the agreed schema. The last three are bookkeeping the stated
// behaviour requires: consecutive-failure counting for the broken rule, and a
// cumulative total so "employers that never produce postings" can be answered
// across all scans rather than only the most recent one.
const COLUMNS = [
  'Organisation', 'Source Lists', 'Tier', 'City Priority', 'Last Scanned',
  'Last Status', 'Times Scanned', 'Postings Found Last Time', 'ATS Type',
  'Consecutive Failures', 'Total Postings', 'Broken', 'Entity Type',
  // Merged in from uk-coverage.mjs's reachability classification (init()) so
  // run-daily.mjs, npm run coverage and the Excel export all read ONE file
  // instead of a second, disconnected coverage.csv at the repo root.
  'Register Verified', 'Coverage', 'Warning',
];

// ── csv ──────────────────────────────────────────────────────────────

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
const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function rowToRec(r, h) {
  const g = (n) => r[h.indexOf(n)] ?? '';
  return {
    org: g('Organisation'),
    lists: g('Source Lists'),
    tier: g('Tier'),
    cityPriority: g('City Priority'),
    lastScanned: g('Last Scanned'),
    lastStatus: g('Last Status') || 'never',
    timesScanned: Number(g('Times Scanned') || 0),
    postingsLast: Number(g('Postings Found Last Time') || 0),
    ats: g('ATS Type'),
    failures: Number(g('Consecutive Failures') || 0),
    totalPostings: Number(g('Total Postings') || 0),
    broken: String(g('Broken')).toLowerCase() === 'true',
    // Persisted so --entity survives a reload; without it the filter silently
    // matched nothing because entityType only existed in memory during init().
    entityType: g('Entity Type'),
    // Reachability classification, merged in from uk-coverage.mjs by init().
    registerVerified: g('Register Verified'),
    coverage: g('Coverage'),
    warning: g('Warning'),
  };
}
const recToRow = (r) => [r.org, r.lists, r.tier, r.cityPriority, r.lastScanned, r.lastStatus,
  r.timesScanned, r.postingsLast, r.ats, r.failures, r.totalPostings, r.broken ? 'true' : '',
  r.entityType || '', r.registerVerified || '', r.coverage || '', r.warning || ''];

// ── load / save ──────────────────────────────────────────────────────

export function load() {
  mkdirSync(OUT_DIR, { recursive: true });
  const map = new Map();
  if (existsSync(CSV)) {
    const lines = readFileSync(CSV, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length) {
      const h = parseCsvLine(lines[0]);
      for (const l of lines.slice(1)) {
        const rec = rowToRec(parseCsvLine(l), h);
        if (rec.org) map.set(rec.org, rec);
      }
    }
  }
  // Replay the journal over the view. This is what makes a crash between the
  // journal append and the CSV rewrite a non-event.
  if (existsSync(JOURNAL)) {
    let replayed = 0;
    for (const line of readFileSync(JOURNAL, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [org, ts, status, postings, ats] = line.split('\t');
      const rec = map.get(org);
      if (!rec) continue;
      if (rec.lastScanned === ts && rec.lastStatus === status) continue; // already materialised
      applyScan(rec, { ts, status, postings: Number(postings || 0), ats });
      replayed++;
    }
    if (replayed) process.env.COVERAGE_REPLAYED = String(replayed);
  }
  return map;
}

function applyScan(rec, { ts, status, postings, ats }) {
  rec.lastScanned = ts;
  rec.lastStatus = status;
  rec.timesScanned += 1;
  if (ats) rec.ats = ats;
  if (status === 'success') {
    rec.postingsLast = postings;
    rec.totalPostings += postings;
    rec.failures = 0;
  } else {
    rec.failures += 1;
    if (rec.failures >= MAX_FAILURES) rec.broken = true;
  }
}

/** Atomic rewrite of the materialised view. */
export function save(map) {
  mkdirSync(OUT_DIR, { recursive: true });
  const rows = [COLUMNS.join(','), ...[...map.values()].map((r) => recToRow(r).map(cell).join(','))];
  const tmp = `${CSV}.tmp`;
  writeFileSync(tmp, rows.join('\r\n') + '\r\n', 'utf8');
  renameSync(tmp, CSV);
}

/**
 * Record one employer's scan. Durable BEFORE it returns: the journal line is
 * appended first, so an immediate crash still leaves the fact on disk.
 */
export function record(org, { status = 'success', postings = 0, ats = '' } = {}, map = null) {
  const ts = new Date().toISOString();
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(JOURNAL, [org, ts, status, postings, ats].join('\t') + '\n', 'utf8');
  if (map) {
    const rec = map.get(org);
    if (rec) applyScan(rec, { ts, status, postings, ats });
  }
  return ts;
}

/** Fold the journal into the CSV and truncate it. */
export function compact() {
  const map = load();
  save(map);
  if (existsSync(JOURNAL)) writeFileSync(JOURNAL, '', 'utf8');
  return map;
}

// ── seeding ──────────────────────────────────────────────────────────

export async function init() {
  const { buildRecords, applyMode } = await import('./uk-coverage.mjs');
  const all = buildRecords();
  const map = load();
  let added = 0, updated = 0;
  for (const r of all) {
    const lists = r.sourceLists.join('; ');
    const registerVerified = r.registerVerified ? 'YES' : 'NO';
    const existing = map.get(r.name);
    if (existing) {
      // Refresh descriptive fields, never scan state.
      if (existing.lists !== lists || existing.tier !== r.tier) updated++;
      existing.lists = lists;
      existing.tier = r.tier;
      existing.cityPriority = r.cityPriority;
      if (!existing.ats && r.platform) existing.ats = r.platform;
      existing.entityType = r.entityType;
      existing.registerVerified = registerVerified;
      existing.coverage = r.coverage || '';
      existing.warning = r.warning || '';
    } else {
      map.set(r.name, {
        org: r.name, lists, tier: r.tier, cityPriority: r.cityPriority,
        lastScanned: '', lastStatus: 'never', timesScanned: 0, postingsLast: 0,
        ats: r.platform || '', failures: 0, totalPostings: 0, broken: false,
        entityType: r.entityType,
        registerVerified, coverage: r.coverage || '', warning: r.warning || '',
      });
      added++;
    }
  }
  save(map);
  return { total: map.size, added, updated };
}

// ── queue ────────────────────────────────────────────────────────────

const scannedMs = (r) => (r.lastScanned ? Date.parse(r.lastScanned) || 0 : 0);

export function eligible(recs, { force = false, now = Date.now() } = {}) {
  return recs.filter((r) => {
    if (r.broken) return false;
    if (force) return true;
    // A SUCCESSFUL scan buys quiet; a failed one does not.
    if (r.lastStatus === 'success' && now - scannedMs(r) < RESCAN_DAYS * DAY) return false;
    return true;
  });
}

/**
 * Never-scanned first, then oldest-first. Failures sink to the back of the
 * queue but are still retried — that is "deprioritise", not "drop".
 */
export function orderQueue(recs) {
  return [...recs].sort((a, b) =>
    a.failures - b.failures ||
    scannedMs(a) - scannedMs(b) ||
    a.org.localeCompare(b.org));
}

export function nextBatch(map, { max = 300, force = false, ...filters } = {}) {
  const recs = filterRecs([...map.values()], filters);
  const queue = orderQueue(eligible(recs, { force }));
  return { batch: queue.slice(0, max), queueLength: queue.length, poolSize: recs.length };
}

function filterRecs(recs, { mode = '', list = '', tier = '', entity = '' } = {}) {
  let out = recs;
  if (mode === 'curated') out = out.filter((r) => r.lists);
  else if (mode === 'register-only') out = out.filter((r) => !r.lists);
  // --list accepts several lists: --list=AI,Startup,Tech matches ANY of them.
  if (list) {
    const want = String(list).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    out = out.filter((r) => r.lists.split(';').map((s) => s.trim().toLowerCase()).some((l) => want.includes(l)));
  }
  if (tier !== '' && tier !== undefined) out = out.filter((r) => String(r.tier) === String(tier));
  if (entity) out = out.filter((r) => String(r.entityType || '').toUpperCase() === String(entity).toUpperCase());
  return out;
}

// ── stats ────────────────────────────────────────────────────────────

const ALL_LISTS = ['Council', 'University', 'Tech', 'AI', 'Startup', 'Vetted150'];

export function stats(map, { nightly = 300, ...filters } = {}) {
  const now = Date.now();
  const all = [...map.values()];
  const recs = filterRecs(all, filters);

  const never = recs.filter((r) => !r.lastScanned);
  const ever = recs.filter((r) => r.lastScanned);
  const within = (d) => ever.filter((r) => now - scannedMs(r) < d * DAY).length;
  const broken = recs.filter((r) => r.broken);
  const failing = recs.filter((r) => !r.broken && r.failures > 0);

  const q = orderQueue(eligible(recs, { now }));
  const oldest = q.length ? q[0] : null;
  const oldestAgeDays = oldest && oldest.lastScanned
    ? Math.floor((now - scannedMs(oldest)) / DAY) : null;

  const byList = {};
  for (const l of ALL_LISTS) {
    const g = all.filter((r) => r.lists.split(';').map((s) => s.trim()).includes(l));
    byList[l] = { total: g.length, scanned: g.filter((r) => r.lastStatus === 'success').length };
  }

  const produced = recs.filter((r) => r.totalPostings > 0)
    .sort((a, b) => b.totalPostings - a.totalPostings).slice(0, 10);
  const barren = recs.filter((r) => r.lastStatus === 'success' && r.totalPostings === 0)
    .sort((a, b) => b.timesScanned - a.timesScanned).slice(0, 10);

  // Reachability classification, merged in from uk-coverage.mjs by init().
  // Empty/unset means init() has not been (re-)run since this record was
  // added — surfaced as its own bucket rather than silently folded into
  // UNREACHABLE, which would overstate how bad coverage actually is.
  const byCoverage = { DIRECT_API: 0, AGGREGATOR_ONLY: 0, UNREACHABLE: 0, unclassified: 0 };
  for (const r of recs) {
    if (r.coverage === 'DIRECT_API') byCoverage.DIRECT_API++;
    else if (r.coverage === 'AGGREGATOR_ONLY') byCoverage.AGGREGATOR_ONLY++;
    else if (r.coverage === 'UNREACHABLE') byCoverage.UNREACHABLE++;
    else byCoverage.unclassified++;
  }
  const licenceUnconfirmed = recs.filter((r) => r.registerVerified === 'NO').length;

  return {
    total: recs.length, universe: all.length,
    never: never.length, ever: ever.length,
    last7: within(7), last30: within(30),
    broken: broken.length, failing: failing.length,
    queueLength: q.length,
    oldest: oldest ? { org: oldest.org, lastScanned: oldest.lastScanned || 'never', ageDays: oldestAgeDays } : null,
    nightsToFullCycle: q.length ? Math.ceil(q.length / nightly) : 0,
    byList, produced, barren, byCoverage, licenceUnconfirmed,
    byMode: {
      curated: all.filter((r) => r.lists).length,
      'register-only': all.filter((r) => !r.lists).length,
    },
  };
}

function printStats(s, { nightly }) {
  const pct = (n) => (s.total ? `${((n / s.total) * 100).toFixed(1)}%` : '0%');
  console.log('='.repeat(74));
  console.log('  career-ops — scan coverage');
  console.log('='.repeat(74));
  console.log(`  employers (this view) : ${s.total}   of ${s.universe} total`);
  console.log(`  by mode               : curated ${s.byMode.curated} · register-only ${s.byMode['register-only']}`);
  console.log('');
  console.log(`  scanned ever          : ${s.ever}  (${pct(s.ever)})`);
  console.log(`    ...last 7 days      : ${s.last7}`);
  console.log(`    ...last 30 days     : ${s.last30}`);
  console.log(`  never scanned         : ${s.never}  (${pct(s.never)})`);
  console.log('');
  console.log(`  due now (queue)       : ${s.queueLength}`);
  console.log(`  oldest outstanding    : ${s.oldest ? `${s.oldest.org} — ${s.oldest.lastScanned}${s.oldest.ageDays != null ? ` (${s.oldest.ageDays}d ago)` : ''}` : '(queue empty)'}`);
  console.log(`  nights to full cycle  : ${s.nightsToFullCycle}  (at ${nightly}/night)`);
  console.log(`  failing / broken      : ${s.failing} retrying · ${s.broken} broken (>= ${MAX_FAILURES} consecutive failures)`);
  console.log('');
  console.log('  REACHABILITY (from uk-coverage.mjs, merged in by `init`)');
  console.log(`    DIRECT_API      ${String(s.byCoverage.DIRECT_API).padStart(5)}`);
  console.log(`    AGGREGATOR_ONLY ${String(s.byCoverage.AGGREGATOR_ONLY).padStart(5)}`);
  console.log(`    UNREACHABLE     ${String(s.byCoverage.UNREACHABLE).padStart(5)}`);
  if (s.byCoverage.unclassified) console.log(`    unclassified    ${String(s.byCoverage.unclassified).padStart(5)}  (run: node coverage-tracker.mjs init)`);
  console.log(`    licence not confirmed - check before applying : ${s.licenceUnconfirmed}`);
  console.log('');
  console.log('  BY SOURCE LIST');
  for (const [l, v] of Object.entries(s.byList)) {
    if (!v.total) continue;
    console.log(`    ${l.padEnd(12)} ${String(v.scanned).padStart(5)} of ${String(v.total).padEnd(5)} scanned`);
  }
  console.log('');
  console.log('  TOP 10 BY POSTINGS PRODUCED');
  if (!s.produced.length) console.log('    (nothing scanned successfully yet)');
  for (const r of s.produced) console.log(`    ${String(r.totalPostings).padStart(5)}  ${r.org.slice(0, 52)}`);
  console.log('');
  console.log('  10 THAT NEVER PRODUCE (scanned OK, zero postings)');
  if (!s.barren.length) console.log('    (none yet)');
  for (const r of s.barren) console.log(`    ${String(r.timesScanned).padStart(3)}x  ${r.org.slice(0, 52)}`);
  console.log('='.repeat(74));
}

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { cmd: argv[2] || 'stats', max: 300, nightly: 300, force: false };
  for (const a of argv.slice(3)) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) { if (!o.org) o.org = a; continue; }
    const [, k, v] = m;
    if (k === 'force') o.force = true;
    else if (k === 'max' || k === 'nightly' || k === 'postings') o[k] = Number(v);
    else o[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  if (argv[2] === 'record') o.org = argv[3];
  return o;
}

async function main() {
  const o = parseArgs(process.argv);
  const filters = { mode: o.mode, list: o.list, tier: o.tier, entity: o.entity };

  if (o.cmd === 'init') {
    const r = await init();
    console.log(`roster: ${r.total} employers (${r.added} added, ${r.updated} refreshed) -> ${CSV}`);
    return;
  }

  if (o.cmd === 'next') {
    const map = load();
    const { batch, queueLength, poolSize } = nextBatch(map, { max: o.max, force: o.force, ...filters });
    console.error(`queue ${queueLength} of ${poolSize} eligible${o.force ? ' (--force: cooldown ignored)' : ''}; taking ${batch.length}`);
    for (const r of batch) console.log(r.org);
    return;
  }

  if (o.cmd === 'record') {
    if (!o.org) { console.error('usage: record "<org>" --status=success|failed [--postings=N] [--ats=greenhouse]'); process.exit(1); }
    const map = load();
    if (!map.has(o.org)) { console.error(`unknown employer: ${o.org}`); process.exit(1); }
    const ts = record(o.org, { status: o.status || 'success', postings: o.postings || 0, ats: o.ats || '' }, map);
    save(map);
    const rec = map.get(o.org);
    console.log(`${o.org}: ${rec.lastStatus} at ${ts} (scans ${rec.timesScanned}, failures ${rec.failures}${rec.broken ? ', BROKEN' : ''})`);
    return;
  }

  if (o.cmd === 'reset-broken') {
    const map = load();
    let n = 0;
    for (const r of map.values()) if (r.broken) { r.broken = false; r.failures = 0; n++; }
    save(map);
    console.log(`cleared broken flag on ${n} employers`);
    return;
  }

  if (o.cmd === 'compact') { const m = compact(); console.log(`compacted ${m.size} rows`); return; }

  const map = load();
  if (!map.size) { console.error(`no roster yet — run: node coverage-tracker.mjs init`); process.exit(1); }
  if (process.env.COVERAGE_REPLAYED) console.log(`(replayed ${process.env.COVERAGE_REPLAYED} journal entries)\n`);
  printStats(stats(map, { nightly: o.nightly, ...filters }), { nightly: o.nightly });
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
