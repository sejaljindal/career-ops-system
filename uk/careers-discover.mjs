#!/usr/bin/env node
/**
 * careers-discover.mjs — per-employer careers-page discovery for the register
 * employers that no ATS sweep and no aggregator route can currently see.
 *
 * The gap this closes: 7,295 of 9,331 employers are UNREACHABLE — known only as
 * a line in the gov.uk sponsor register, with no careers page on file and no
 * detected ATS. This resolves them the only way left that needs no API key:
 *
 *   1. derive candidate domains from the employer's legal name
 *   2. probe each candidate over HTTPS (fast fail on DNS)
 *   3. on a live homepage, look for a careers/jobs/vacancies link
 *   4. sniff the page for an ATS fingerprint (Greenhouse/Ashby/Lever/Workday/…)
 *
 * Step 4 is the valuable one: a homepage that links to a Greenhouse board
 * promotes the employer straight from UNREACHABLE to DIRECT_API.
 *
 * Long-running and resumable. Progress is checkpointed every CHECKPOINT_EVERY
 * employers to data/careers-discovery.json; re-running resumes from there, so an
 * interrupted sweep never restarts from zero.
 *
 * Politeness: bounded concurrency, short timeouts, one request per host at a
 * time, and no retry storms. These are ordinary public homepages.
 *
 * Usage:
 *   node careers-discover.mjs --max=200            # pilot, measure hit rate
 *   node careers-discover.mjs                      # full sweep (resumes)
 *   node careers-discover.mjs --reset              # discard checkpoint
 *   node careers-discover.mjs --report             # summarise what's found
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import { detectPlatform } from './uk-ats.mjs';

const STATE = 'data/careers-discovery.json';
const CHECKPOINT_EVERY = 100;
const CONCURRENCY = 12;
const TIMEOUT_MS = 7000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CAREERS_PATHS = ['/careers', '/jobs', '/vacancies', '/careers/', '/about/careers', '/work-for-us', '/join-us', '/recruitment'];
const CAREERS_RE = /(careers?|jobs|vacanc|work[-_ ]?(for|with)[-_ ]?us|join[-_ ]?us|recruit)/i;

const LEGAL = /\b(uk branch|uk|u k|limited|ltd|llp|plc|lp|incorporated|inc|the|and|of|company|co|group|holdings|international|services|trading|partners|partnership|associates)\b/gi;

/** Candidate hostnames for an employer, most likely first. */
export function candidateDomains(name, sector = '') {
  const cleaned = String(name)
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^A-Za-z0-9& ]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const words = cleaned.split(' ').filter((w) => w.length > 1);
  if (!words.length) return [];

  const stems = new Set();
  stems.add(words.join(''));
  if (words.length > 1) stems.add(words.slice(0, 2).join(''));
  stems.add(words[0]);
  if (words.length > 1) stems.add(words.join('-'));

  const s = String(sector).toLowerCase();
  let tlds = ['co.uk', 'com'];
  if (/universit|educat|college/.test(s)) tlds = ['ac.uk', 'co.uk', 'com'];
  else if (/nhs|health/.test(s)) tlds = ['nhs.uk', 'co.uk', 'com'];
  else if (/local government|council|public/.test(s)) tlds = ['gov.uk', 'co.uk', 'com'];
  else if (/charit|non-profit|nonprofit/.test(s)) tlds = ['org.uk', 'org', 'co.uk'];

  const out = [];
  for (const stem of stems) {
    if (stem.length < 3 || stem.length > 40) continue;
    for (const tld of tlds) out.push(`${stem}.${tld}`);
  }
  return [...new Set(out)].slice(0, 6);
}

async function get(url, { timeout = TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(timeout),
    });
    const body = res.ok ? await res.text() : '';
    return { ok: res.ok, status: res.status, url: res.url, body };
  } catch (e) {
    return { ok: false, status: 'ERR', url, body: '', error: String(e.message || e).slice(0, 40) };
  }
}

/** Find an ATS fingerprint anywhere in a page's links. */
export function sniffAts(html, baseUrl) {
  const urls = [...String(html).matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
  for (const u of urls) {
    const abs = u.startsWith('http') ? u : '';
    if (!abs) continue;
    const p = detectPlatform(abs);
    if (p) return { platform: p.id, url: abs, reach: p.reach };
  }
  return null;
}

/** Find the most likely careers link on a homepage. */
export function findCareersLink(html, origin) {
  const cands = [];
  for (const m of String(html).matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!CAREERS_RE.test(href) && !CAREERS_RE.test(text)) continue;
    let abs;
    try { abs = new URL(href, origin).href; } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    // Prefer links whose PATH says careers, over ones that merely mention it.
    const score = (CAREERS_RE.test(new URL(abs).pathname) ? 2 : 0) + (CAREERS_RE.test(text) ? 1 : 0);
    cands.push({ abs, score });
  }
  cands.sort((a, b) => b.score - a.score);
  return cands.length ? cands[0].abs : null;
}

/**
 * Does this page actually look like a careers page, rather than merely contain
 * the word somewhere? Checking only the first 4KB — as this used to — tests
 * the <head> of a modern site: meta tags, preload hints and script src
 * attributes, with no visible content yet. angelogordon.com/careers returns
 * 200 and is unmistakably a careers page, and still failed that test.
 */
function looksLikeCareersPage(body) {
  if (!body) return false;
  const head = body.slice(0, 60000);
  const title = (head.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [, ''])[1];
  const h1 = (head.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i) || [, ''])[1];
  if (CAREERS_RE.test(title) || CAREERS_RE.test(h1.replace(/<[^>]+>/g, ''))) return true;
  // Fall back to the body text, not the raw first-4KB of markup.
  const text = head.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return CAREERS_RE.test(text);
}

/** careers.acme.com / jobs.acme.com — never probed before this. */
function subdomainCandidates(domain) {
  const base = domain.replace(/^www\./, '');
  return ['careers', 'jobs', 'recruitment'].map((p) => `${p}.${base}`);
}

async function resolveEmployer(rec) {
  const domains = candidateDomains(rec.name, rec.sector);
  // Remember the first live-but-barren domain instead of RETURNING on it. The
  // old code returned SITE_ONLY from inside this loop, so a parked or unrelated
  // site that happened to sort earlier permanently masked the real parent —
  // "AECOM ENGINEERING TECHNOLOGY SERVICES LTD" stopped at aecomengineering.com
  // and never tried aecom.com, which was in the very same candidate list and
  // resolves correctly for AECOM LIMITED.
  let fallback = null;

  for (const d of domains) {
    const home = await get(`https://${d}`);
    if (!home.ok || !home.body) continue;

    const ats = sniffAts(home.body, home.url);
    if (ats) {
      return { ...rec, domain: d, homepage: home.url, careers_url: ats.url, ats: ats.platform, outcome: 'ATS_FOUND' };
    }
    const careers = findCareersLink(home.body, home.url);
    if (careers) {
      const cp = await get(careers);
      const ats2 = cp.ok ? sniffAts(cp.body, cp.url) : null;
      return {
        ...rec, domain: d, homepage: home.url, careers_url: ats2?.url || careers,
        ats: ats2?.platform || '', outcome: ats2 ? 'ATS_FOUND' : 'CAREERS_FOUND',
      };
    }
    // Conventional paths, now judged on the whole page rather than 4KB of <head>.
    for (const path of CAREERS_PATHS) {
      const r = await get(`https://${d}${path}`);
      if (r.ok && looksLikeCareersPage(r.body)) {
        const ats3 = sniffAts(r.body, r.url);
        return { ...rec, domain: d, homepage: home.url, careers_url: ats3?.url || r.url, ats: ats3?.platform || '', outcome: ats3 ? 'ATS_FOUND' : 'CAREERS_FOUND' };
      }
    }
    // Careers subdomains — plenty of large employers host jobs there and link
    // to it from a JS-rendered nav a plain fetch never sees.
    for (const sd of subdomainCandidates(d)) {
      const r = await get(`https://${sd}`);
      if (r.ok && looksLikeCareersPage(r.body)) {
        const ats4 = sniffAts(r.body, r.url);
        return { ...rec, domain: d, homepage: home.url, careers_url: ats4?.url || r.url, ats: ats4?.platform || '', outcome: ats4 ? 'ATS_FOUND' : 'CAREERS_FOUND' };
      }
    }
    if (!fallback) fallback = { ...rec, domain: d, homepage: home.url, careers_url: '', ats: '', outcome: 'SITE_ONLY' };
    // keep going — a later candidate may be the real company
  }
  return fallback || { ...rec, domain: '', homepage: '', careers_url: '', ats: '', outcome: 'NO_SITE' };
}

// ── coverage.csv input ───────────────────────────────────────────────

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

export function loadUnreachable() {
  const lines = readFileSync('coverage.csv', 'utf8').split(/\r?\n/).filter(Boolean);
  const h = parseCsvLine(lines[0]);
  const iN = h.indexOf('Organisation'), iS = h.indexOf('Sector'), iC = h.indexOf('Coverage'), iT = h.indexOf('Tier'), iCity = h.indexOf('City');
  return lines.slice(1).map(parseCsvLine)
    .filter((r) => r[iC] === 'UNREACHABLE')
    .map((r) => ({ name: r[iN], sector: r[iS], tier: r[iT], city: r[iCity] }));
}

// ── main ─────────────────────────────────────────────────────────────

async function pool(items, worker, concurrency, onTick) {
  const results = [];
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
      onTick?.(results.filter(Boolean).length);
    }
  }));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const max = Number((args.find((a) => a.startsWith('--max=')) || '').split('=')[1] || 0);
  const reset = args.includes('--reset');
  const reportOnly = args.includes('--report');

  mkdirSync('data', { recursive: true });
  let state = { done: {}, started: null };
  if (!reset && existsSync(STATE)) {
    try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { /* fresh */ }
  }

  // --sector=A,B restricts the sweep to named sectors. The unreachable pool is
  // ~5,800 employers, most of them small private firms that will never
  // advertise this profile's roles; the value is concentrated in a few sectors
  // (Major Target, Consulting / Advisory), so being able to sweep those first
  // is the difference between a useful hour and a wasted night.
  const sectorArg = (args.find((a) => a.startsWith('--sector=')) || '').split('=')[1] || '';
  const wantSectors = sectorArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  let all = loadUnreachable();
  const poolBefore = all.length;
  if (wantSectors.length) {
    all = all.filter((r) => wantSectors.some((w) => String(r.sector || '').toLowerCase().includes(w)));
    console.log(`  sector filter    : ${sectorArg}  ->  ${all.length} of ${poolBefore} unreachable employers`);
  }

  if (reportOnly) {
    const rows = Object.values(state.done);
    summarise(rows, all.length);
    return;
  }

  const todo = all.filter((r) => !state.done[r.name]);
  const batch = max ? todo.slice(0, max) : todo;

  console.log('='.repeat(78));
  console.log('  career-ops — per-employer careers discovery');
  console.log('='.repeat(78));
  console.log(`  unreachable pool : ${all.length}`);
  console.log(`  already resolved : ${Object.keys(state.done).length}`);
  console.log(`  this run         : ${batch.length}${max ? ` (--max=${max})` : ' (full sweep)'}`);
  console.log(`  concurrency      : ${CONCURRENCY}  ·  timeout ${TIMEOUT_MS}ms  ·  checkpoint every ${CHECKPOINT_EVERY}`);
  console.log('='.repeat(78));
  if (!batch.length) { console.log('\nnothing to do — pool exhausted.'); return; }

  const t0 = Date.now();
  let n = 0;
  await pool(batch, async (rec) => {
    const out = await resolveEmployer(rec);
    state.done[rec.name] = out;
    if (++n % CHECKPOINT_EVERY === 0) {
      writeFileSync(STATE, JSON.stringify(state), 'utf8');
      const rate = n / ((Date.now() - t0) / 1000);
      const hits = Object.values(state.done).filter((x) => x.outcome === 'ATS_FOUND' || x.outcome === 'CAREERS_FOUND').length;
      console.log(`  ${n}/${batch.length}  ·  ${rate.toFixed(1)}/s  ·  ${hits} careers pages found so far`);
    }
    return out;
  }, CONCURRENCY);

  writeFileSync(STATE, JSON.stringify(state), 'utf8');
  summarise(Object.values(state.done), all.length, Date.now() - t0);
}

function summarise(rows, poolSize, elapsedMs) {
  const t = {};
  for (const r of rows) t[r.outcome] = (t[r.outcome] || 0) + 1;
  const found = (t.ATS_FOUND || 0) + (t.CAREERS_FOUND || 0);
  console.log('\n' + '='.repeat(78));
  console.log('DISCOVERY RESULTS');
  for (const k of ['ATS_FOUND', 'CAREERS_FOUND', 'SITE_ONLY', 'NO_SITE']) {
    const n = t[k] || 0;
    console.log(`  ${String(n).padStart(6)}  ${k}${rows.length ? `  (${((n / rows.length) * 100).toFixed(1)}%)` : ''}`);
  }
  console.log(`  ${String(rows.length).padStart(6)}  processed of ${poolSize} unreachable`);
  console.log(`\n  newly reachable: ${found} (${rows.length ? ((found / rows.length) * 100).toFixed(1) : 0}% of processed)`);
  if (elapsedMs) console.log(`  elapsed: ${(elapsedMs / 1000).toFixed(0)}s`);

  const ats = {};
  for (const r of rows) if (r.ats) ats[r.ats] = (ats[r.ats] || 0) + 1;
  if (Object.keys(ats).length) console.log('  ATS platforms found:', JSON.stringify(ats));

  const out = rows.filter((r) => r.careers_url);
  const csv = ['Organisation,Sector,Tier,Domain,Careers URL,ATS,Outcome',
    ...out.map((r) => [r.name, r.sector, r.tier, r.domain, r.careers_url, r.ats, r.outcome]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  writeFileSync('careers-discovered.csv', csv, 'utf8');
  console.log(`\nwrote careers-discovered.csv (${out.length} employers with a careers URL)`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
