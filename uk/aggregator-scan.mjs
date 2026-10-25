#!/usr/bin/env node
/**
 * aggregator-scan.mjs — live role discovery from UK job aggregators.
 *
 * This is the fetching half of the AGGREGATOR_ONLY route: `uk-ats.mjs` decides
 * WHERE an employer's roles can be seen, this reads them.
 *
 * Two strategies, both of which matter:
 *   --by-title     search target titles across the WHOLE board. Surfaces
 *                  employers that are on no list at all. This is the one that
 *                  grows the funnel.
 *   --by-employer  search a specific employer name. Confirms a known target is
 *                  hiring; never discovers anything new.
 *
 * Tiers, ordered by cost. Tier 1 uses plain fetch, Tier 2 launches Chromium.
 *
 *   TIER 1 (no browser, verified by live parse):
 *     nhsjobs  — /candidate/search/results, server-rendered, 10 results/page
 *     reed     — /jobs/<slug>-jobs, server-rendered
 *
 *   TIER 2 (browser required, verified):
 *     findajob     — Next.js App Router, results streamed client-side.
 *                    NOTE: a plain fetch returns 200 and ~166KB, but that is the
 *                    app shell plus i18n strings — ZERO jobs. Do not be fooled
 *                    into classifying it as scrapeable.
 *     civilservice — session-scoped behind an opaque SID param
 *     totaljobs    — HTTP 403 to plain fetch (WAF)
 *     trac         — HTTP 403 to plain fetch (WAF)
 *     jobsgopublic — client-rendered listing
 *
 * Caching: every fetch is cached to .cache/aggregator/ keyed by URL, with a TTL
 * (default 20h) so a nightly run never re-fetches what it already holds.
 *
 * Politeness: Tier 2 runs strictly sequentially in ONE browser context with a
 * delay between navigations. These are public services, several of them
 * taxpayer-funded; do not hammer them.
 *
 * Usage:
 *   node aggregator-scan.mjs --by-title --tier=1
 *   node aggregator-scan.mjs --by-title --sites=nhsjobs,reed --max-titles=5
 *   node aggregator-scan.mjs --by-employer --employers="Barnet Council,YOUR_UNIVERSITY"
 *   node aggregator-scan.mjs --by-employer --max=300            # next 300 off the coverage queue
 *   node aggregator-scan.mjs --by-employer --list=Council --max=50
 *   node aggregator-scan.mjs --by-employer --emp-tier=0 --max=100   # employer Tier 0
 *
 * --by-employer with no --employers pulls the next batch from coverage-tracker
 * (never-scanned first, then oldest) and records each employer's result the
 * instant that employer finishes — so an interrupted run still counts.
 *   node aggregator-scan.mjs --by-title --tier=2 --headful     # watch it work
 *   node aggregator-scan.mjs --stats                            # cache stats only
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
import * as yaml from 'js-yaml';

const CACHE_DIR = join('.cache', 'aggregator');
const DEFAULT_TTL_MS = 20 * 60 * 60 * 1000; // 20h — safe for a nightly cadence
const POLITE_DELAY_MS = 2500;               // between Tier 2 navigations
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// ── cache ────────────────────────────────────────────────────────────

function cachePath(url) {
  return join(CACHE_DIR, createHash('sha1').update(url).digest('hex') + '.json');
}

function cacheGet(url, ttl = DEFAULT_TTL_MS) {
  const p = cachePath(url);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, 'utf8'));
    if (Date.now() - o.at > ttl) return null;
    return o;
  } catch { return null; }
}

function cacheSet(url, body, status) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(url), JSON.stringify({ url, at: Date.now(), status, body }), 'utf8');
}

export function cacheStats() {
  if (!existsSync(CACHE_DIR)) return { files: 0, bytes: 0, fresh: 0 };
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
  let bytes = 0, fresh = 0;
  for (const f of files) {
    const p = join(CACHE_DIR, f);
    bytes += statSync(p).size;
    try {
      if (Date.now() - JSON.parse(readFileSync(p, 'utf8')).at <= DEFAULT_TTL_MS) fresh++;
    } catch { /* ignore corrupt entry */ }
  }
  return { files: files.length, bytes, fresh };
}

// ── TIER 1: plain fetch ──────────────────────────────────────────────

async function fetchCached(url, ttl) {
  const hit = cacheGet(url, ttl);
  if (hit) return { ...hit, cached: true };
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: AbortSignal.timeout(30000) });
  const body = await res.text();
  cacheSet(url, body, res.status);
  return { url, body, status: res.status, cached: false };
}

/** NHS Jobs — server-rendered, verified by live parse. */
function parseNhs(html) {
  const out = [];
  for (const m of html.matchAll(/<a[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = strip(m[2]);
    if (!title || title.length < 3) continue;
    out.push({ title, url: 'https://www.jobs.nhs.uk' + m[1].replace(/&amp;/g, '&') });
  }
  return dedupe(out);
}

/**
 * Reed — parsed per job card so the REAL employer is captured.
 *
 * This matters more than it looks. Reed's `?keywords=` search is a full-text
 * match, NOT an employer filter: searching "Bassetlaw District Council" returns
 * jobs from Walsall Housing Group and MEARS GROUP PLC. Attributing those to the
 * searched employer would put a false company name on a real job — worse than
 * leaving it blank, because it looks authoritative.
 *
 * The posting employer sits in the card's recruiter link (gtmJobListingPostedBy).
 */
function parseReed(html) {
  const out = [];
  for (const card of html.matchAll(/data-page-component="job_card"([\s\S]*?)<\/article>/g)) {
    const c = card[1];
    const link = c.match(/<a[^>]*href="(\/jobs\/[^"?]*\/\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const title = strip(link[2]);
    if (!title || title.length < 3) continue;
    const emp = c.match(/gtmJobListingPostedBy[^>]*>([^<]{2,80})</i)
      || c.match(/class="[^"]*recruiter[^"]*"[^>]*>([^<]{2,80})</i);
    out.push({
      title,
      url: 'https://www.reed.co.uk' + link[1],
      company: emp ? strip(emp[1]) : '',
    });
  }
  return dedupe(out);
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = r.url;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const SITES = {
  nhsjobs: {
    tier: 1,
    label: 'NHS Jobs',
    byTitle: (t) => `https://www.jobs.nhs.uk/candidate/search/results?keyword=${encodeURIComponent(t)}`,
    byEmployer: (e) => `https://www.jobs.nhs.uk/candidate/search/results?keyword=${encodeURIComponent(e)}`,
    parse: parseNhs,
  },
  reed: {
    tier: 1,
    label: 'Reed',
    byTitle: (t) => `https://www.reed.co.uk/jobs/${slugify(t)}-jobs`,
    byEmployer: (e) => `https://www.reed.co.uk/jobs?keywords=${encodeURIComponent(e)}`,
    parse: parseReed,
  },
  // Jobs Go Public — councils. Verified working in Chromium: the listing is
  // client-rendered and the job links live under /job/, NOT /vacancies/.
  jobsgopublic: {
    tier: 2,
    label: 'Jobs Go Public',
    byTitle: (t) => `https://www.jobsgopublic.com/vacancies?keyword=${encodeURIComponent(t)}`,
    byEmployer: (e) => `https://www.jobsgopublic.com/vacancies?keyword=${encodeURIComponent(e)}`,
    waitFor: 'a[href*="/job/"]',
    extract: () => [...document.querySelectorAll('a[href*="/job/"]')]
      .map((a) => ({ title: a.textContent.trim().replace(/\s+/g, ' '), url: a.href }))
      .filter((r) => r.title.length > 3),
  },

  // Health Jobs UK — the PUBLIC face of TRAC. www.trac.jobs is the employer-side
  // admin portal (it links out to healthjobsuk.com); scraping trac.jobs itself
  // returns the product homepage, not vacancies. Verified working: job URLs
  // embed the employing NHS trust, which makes employer attribution free.
  healthjobsuk: {
    tier: 2,
    label: 'Health Jobs UK (TRAC)',
    byTitle: (t) => `https://www.healthjobsuk.com/job_list?JobSearch_q=${encodeURIComponent(t)}`,
    byEmployer: (e) => `https://www.healthjobsuk.com/job_list?JobSearch_q=${encodeURIComponent(e)}`,
    waitFor: 'a[href*="/job/"]',
    extract: () => [...document.querySelectorAll('a[href*="/job/"]')]
      .map((a) => ({ title: a.textContent.trim().replace(/\s+/g, ' '), url: a.href }))
      .filter((r) => r.title.length > 3),
  },
};

/**
 * Sites deliberately NOT scraped, and why. Kept in code so nobody "re-adds"
 * them without knowing what happens.
 *
 *   findajob     — GOV.UK Find a Job is CLOSED. Navigating returns HTTP 503 and
 *                  the body reads "This site is now closed". A plain fetch still
 *                  returns 200 + ~166KB of app shell, which is why it looked
 *                  alive in a naive probe. It is not. Do not route to it.
 *   totaljobs    — HTTP 403 to plain fetch AND to headless Chromium ("Access
 *                  Denied"). Would need a stealth/residential setup; out of scope.
 *   civilservice — serves a "Quick check needed" bot interstitial to headless
 *                  Chromium. Blocked without solving the challenge.
 */
export const BLOCKED = {
  findajob: 'service permanently closed (HTTP 503, "This site is now closed")',
  totaljobs: 'HTTP 403 / Access Denied to headless Chromium',
  civilservice: 'bot interstitial ("Quick check needed") to headless Chromium',
};

// ── target titles ────────────────────────────────────────────────────

export function targetTitles(limit = 0) {
  const cfg = yaml.load(readFileSync('config/profile.yml', 'utf8'));
  const t = cfg?.target_roles?.primary || [];
  return limit ? t.slice(0, limit) : t;
}

// ── per-employer scanning (coverage-tracked) ─────────────────────────

/**
 * Open one browser session reused across every employer. Launching Chromium per
 * employer would dominate the runtime and hammer the sites.
 */
export async function openSession({ headful = false } = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: !headful });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  return { page, close: () => browser.close() };
}

/**
 * Scan every selected site for ONE employer.
 *
 * Success vs failure is deliberately NOT "did we find jobs":
 *   success = at least one site answered, whether or not it had vacancies
 *   failed  = every site errored (network, WAF, timeout)
 *
 * Conflating "no vacancies right now" with "scan failed" would push every
 * quiet employer to 3 consecutive failures and silently mark it broken —
 * exactly the kind of permanent hole this tracking exists to prevent.
 */
export async function scanEmployer(employer, siteIds, { session, ttl } = {}) {
  const rows = [];
  let answered = 0;
  let errored = 0;

  for (const site of siteIds) {
    const cfg = SITES[site];
    const url = cfg.byEmployer(employer);
    try {
      if (cfg.tier === 1) {
        const r = await fetchCached(url, ttl);
        if (r.status !== 200) { errored++; continue; }
        rows.push(...cfg.parse(r.body).map((j) => ({ ...j, site })));
        answered++;
        if (!r.cached) await sleep(600);
      } else {
        const hit = cacheGet(url, ttl);
        if (hit) {
          rows.push(...safeParseCached(hit).map((j) => ({ ...j, site })));
          answered++;
          continue;
        }
        await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await session.page.waitForSelector(cfg.waitFor, { timeout: 12000 }).catch(() => {});
        const found = dedupe(await session.page.evaluate(cfg.extract).catch(() => []));
        cacheSet(url, JSON.stringify(found), 200);
        rows.push(...found.map((j) => ({ ...j, site })));
        answered++;
        await sleep(POLITE_DELAY_MS);
      }
    } catch {
      errored++;
    }
  }
  return { rows: dedupe(rows), status: answered > 0 ? 'success' : 'failed', answered, errored };
}

// ── Tier 2 runner ────────────────────────────────────────────────────

async function runBrowser(tasks, { headful = false, ttl = DEFAULT_TTL_MS } = {}) {
  const results = [];
  const pending = tasks.filter((t) => !cacheGet(t.url, ttl));
  for (const t of tasks) {
    const hit = cacheGet(t.url, ttl);
    if (hit) results.push({ ...t, rows: safeParseCached(hit), cached: true });
  }
  if (!pending.length) return results;

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: !headful });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  try {
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i];
      process.stdout.write(`  [${i + 1}/${pending.length}] ${t.site} :: ${t.term.slice(0, 40)} ... `);
      let rows = [];
      try {
        await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector(SITES[t.site].waitFor, { timeout: 12000 }).catch(() => {});
        rows = await page.evaluate(SITES[t.site].extract).catch(() => []);
        rows = dedupe(rows);
        cacheSet(t.url, JSON.stringify(rows), 200);
        console.log(`${rows.length} jobs`);
      } catch (e) {
        cacheSet(t.url, JSON.stringify([]), 'ERR');
        console.log(`ERR ${String(e.message).slice(0, 40)}`);
      }
      results.push({ ...t, rows, cached: false });
      if (i < pending.length - 1) await sleep(POLITE_DELAY_MS); // be polite
    }
  } finally {
    await browser.close();
  }
  return results;
}

function safeParseCached(hit) {
  try {
    const v = JSON.parse(hit.body);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// ── main ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { byTitle: false, byEmployer: false, tier: 0, sites: '', maxTitles: 0, employers: '',
    headful: false, stats: false, ttl: DEFAULT_TTL_MS,
    // coverage-queue controls (used when --by-employer has no explicit list)
    max: 0, force: false, mode: '', list: '', empTier: '', entity: '' };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'by-title') o.byTitle = true;
    else if (k === 'by-employer') o.byEmployer = true;
    else if (k === 'tier') o.tier = Number(v);
    else if (k === 'sites') o.sites = v;
    else if (k === 'max-titles') o.maxTitles = Number(v);
    else if (k === 'employers') o.employers = v;
    else if (k === 'headful') o.headful = true;
    else if (k === 'stats') o.stats = true;
    else if (k === 'ttl-hours') o.ttl = Number(v) * 3600000;
    else if (k === 'max') o.max = Number(v);
    else if (k === 'force') o.force = true;
    else if (k === 'mode') o.mode = v;
    else if (k === 'list') o.list = v;
    else if (k === 'entity') o.entity = v;
    else if (k === 'emp-tier') o.empTier = v;   // employer Tier for the coverage queue
                                                // (--tier stays the SITE tier: 1 or 2)
    else if (k === 'no-track') o.noTrack = true;
  }
  if (!o.byTitle && !o.byEmployer) o.byTitle = true;
  return o;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.stats) {
    const s = cacheStats();
    console.log(`cache: ${s.files} entries (${s.fresh} fresh), ${(s.bytes / 1024).toFixed(0)} KB at ${CACHE_DIR}`);
    return;
  }

  let siteIds = Object.keys(SITES);
  if (opts.sites) siteIds = opts.sites.split(',').map((s) => s.trim()).filter((s) => SITES[s]);
  if (opts.tier) siteIds = siteIds.filter((s) => SITES[s].tier === opts.tier);

  const titles = opts.byTitle ? targetTitles(opts.maxTitles) : [];

  // Employer list: an explicit --employers=... wins; otherwise pull the next
  // batch straight off the coverage queue (never-scanned first, then oldest).
  let employers = [];
  let tracker = null;
  let trackerMap = null;
  let queueInfo = null;
  if (opts.byEmployer) {
    if (opts.employers) {
      employers = opts.employers.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      tracker = await import('./coverage-tracker.mjs');
      trackerMap = tracker.load();
      const map = trackerMap;
      if (!map.size) {
        console.error('no coverage roster — run: node coverage-tracker.mjs init');
        process.exit(1);
      }
      const nb = tracker.nextBatch(map, {
        max: opts.max || 300, force: opts.force,
        mode: opts.mode, list: opts.list, tier: opts.empTier, entity: opts.entity,
      });
      queueInfo = nb;
      employers = nb.batch.map((r) => r.org);
    }
  }

  console.log('='.repeat(78));
  console.log('  career-ops — aggregator scan');
  console.log('='.repeat(78));
  console.log(`  strategy : ${opts.byTitle ? 'by-title' : ''}${opts.byTitle && opts.byEmployer ? ' + ' : ''}${opts.byEmployer ? 'by-employer' : ''}`);
  console.log(`  sites    : ${siteIds.map((s) => `${s}(T${SITES[s].tier})`).join(', ') || '(none)'}`);
  console.log(`  terms    : ${titles.length} titles, ${employers.length} employers`);
  const cs = cacheStats();
  console.log(`  cache    : ${cs.files} entries (${cs.fresh} fresh) — TTL ${(opts.ttl / 3600000).toFixed(0)}h`);
  console.log('='.repeat(78));

  const all = [];

  // ── employer strategy: one employer at a time, coverage recorded per employer ──
  if (employers.length) {
    console.log(`\nBY-EMPLOYER — ${employers.length} employers${queueInfo ? ` (queue depth ${queueInfo.queueLength} of ${queueInfo.poolSize})` : ''}`);
    if (tracker) console.log('  coverage recorded immediately after each employer\n');
    const needsBrowser = siteIds.some((s) => SITES[s].tier === 2);
    const session = needsBrowser ? await openSession({ headful: opts.headful }) : null;
    let ok = 0, failed = 0, found = 0;
    try {
      for (let i = 0; i < employers.length; i++) {
        const emp = employers[i];
        const res = await scanEmployer(emp, siteIds, { session, ttl: opts.ttl });
        all.push({
          site: 'multi', term: emp, mode: 'employer',
          // r.company is the employer the SITE says posted the job. `emp` is only
          // what we searched for — a fallback, never an override.
          rows: res.rows.map((r) => ({ ...r, company: r.company || '', searchedFor: emp })),
        });
        found += res.rows.length;
        if (res.status === 'success') ok++; else failed++;

        // Durable BEFORE moving on — a kill here loses nothing already scanned.
        if (tracker) {
          tracker.record(emp, { status: res.status, postings: res.rows.length, ats: 'aggregator' }, trackerMap);
          tracker.save(trackerMap);
        }
        console.log(`  [${i + 1}/${employers.length}] ${res.status === 'success' ? '✓' : '✗'} ${emp.slice(0, 46).padEnd(48)} ${String(res.rows.length).padStart(3)} jobs  (${res.answered} sites ok, ${res.errored} err)`);
      }
    } finally {
      if (session) await session.close();
    }
    console.log(`\n  employers scanned: ${ok} ok · ${failed} failed · ${found} postings total`);
  }

  // ── title strategy: board-wide discovery, not tied to any one employer ──
  const t1 = [], t2 = [];
  for (const site of siteIds) {
    for (const term of titles) {
      const url = SITES[site].byTitle(term);
      (SITES[site].tier === 1 ? t1 : t2).push({ site, term, url, mode: 'title' });
    }
  }

  if (t1.length) {
    console.log(`\nTIER 1 — plain fetch (${t1.length} requests)`);
    for (const t of t1) {
      const r = await fetchCached(t.url, opts.ttl);
      const rows = r.status === 200 ? SITES[t.site].parse(r.body) : [];
      all.push({ ...t, rows, cached: r.cached });
      console.log(`  ${t.site.padEnd(12)} ${String(rows.length).padStart(3)} jobs  ${r.cached ? '(cached)' : ''}  ${t.term.slice(0, 40)}`);
      if (!r.cached) await sleep(600);
    }
  }

  if (t2.length) {
    console.log(`\nTIER 2 — Playwright, sequential + ${POLITE_DELAY_MS}ms delay (${t2.length} requests)`);
    all.push(...(await runBrowser(t2, { headful: opts.headful, ttl: opts.ttl })));
  }

  // ── results ──
  const bySite = {};
  const employersFound = new Set();
  let total = 0;
  for (const r of all) {
    bySite[r.site] = (bySite[r.site] || 0) + r.rows.length;
    total += r.rows.length;
  }
  const uniq = new Map();
  for (const r of all) for (const j of r.rows) uniq.set(j.url, { ...j, site: r.site, term: r.term });

  console.log('\n' + '='.repeat(78));
  console.log('RESULTS');
  for (const [s, n] of Object.entries(bySite)) {
    console.log(`  ${String(n).padStart(5)}  ${SITES[s]?.label ?? 'by-employer (all sites)'}`);
  }
  console.log(`  ${String(total).padStart(5)}  total rows`);
  console.log(`  ${String(uniq.size).padStart(5)}  unique job URLs`);
  console.log('='.repeat(78));

  mkdirSync('data', { recursive: true });
  const rows = [...uniq.values()];
  writeFileSync('data/aggregator-hits.json', JSON.stringify(rows, null, 2), 'utf8');
  const csv = ['site,term,title,url', ...rows.map((r) => [r.site, r.term, r.title, r.url].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  writeFileSync('data/aggregator-hits.csv', csv, 'utf8');
  console.log('\nwrote data/aggregator-hits.json and data/aggregator-hits.csv');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
