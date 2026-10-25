#!/usr/bin/env node
/**
 * ats-scan.mjs — read an employer's OWN job board via its ATS API.
 *
 * WHY THIS EXISTS. by-employer search on Reed/NHS Jobs attributes 0% of results
 * correctly: those boards keyword-MATCH rather than filter, so searching
 * "Essex County Council" returns 35 postings from 35 other employers. Measured,
 * not assumed — 0 of 325 across a 15-employer sample.
 *
 * An ATS API is different in kind, not degree: `boards-api.greenhouse.io/.../
 * sopra-steria/jobs` returns Sopra Steria's postings and nobody else's.
 * Attribution is structural, so it is 100% by construction.
 *
 * This is therefore the ONLY honest by-employer route. Everything else must go
 * through title-first discovery plus a register cross-reference.
 *
 * Usage:
 *   node ats-scan.mjs --list            # employers with a reachable board
 *   node ats-scan.mjs "Sopra Steria"
 */

import { readFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import * as yaml from 'js-yaml';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CORPORATE_STOPWORDS = new Set(['ltd', 'limited', 'llp', 'plc', 'lp', 'uk', 'group', 'holdings',
  'services', 'company', 'international', 'the', 'and', 'of']);

export const sig = (name) => String(name || '').toLowerCase()
  .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
  .filter((w) => w.length > 2 && !CORPORATE_STOPWORDS.has(w))
  .sort().join(' ');

/** Vendor + slug from any supported ATS URL. */
export function parseBoard(url) {
  const u = String(url || '');
  let m;
  // The API form must be matched FIRST. boards-api.greenhouse.io/v1/boards/<slug>/jobs
  // otherwise yields "v1" as the slug, and every board 404s.
  if ((m = u.match(/boards-api\.greenhouse\.io\/v\d+\/boards\/([^/?#]+)/i))) return { vendor: 'greenhouse', slug: m[1] };
  if ((m = u.match(/greenhouse\.io\/embed\/job_board\?for=([^/?#&]+)/i))) return { vendor: 'greenhouse', slug: m[1] };
  if ((m = u.match(/(?:job-boards|boards)\.greenhouse\.io\/([^/?#]+)/i))) return { vendor: 'greenhouse', slug: m[1] };
  if ((m = u.match(/api\.lever\.co\/v\d+\/postings\/([^/?#]+)/i))) return { vendor: 'lever', slug: m[1] };
  if ((m = u.match(/lever\.co\/([^/?#]+)/i))) return { vendor: 'lever', slug: m[1] };
  if ((m = u.match(/ashbyhq\.com\/([^/?#]+)/i))) return { vendor: 'ashby', slug: m[1] };
  return null;
}

/** Index every employer in portals.yml that has a machine-readable board. */
export function boardIndex(portalsPath = 'portals.yml') {
  const doc = yaml.load(readFileSync(portalsPath, 'utf8'));
  const idx = new Map();
  for (const c of doc.tracked_companies || []) {
    if (!c || !c.name) continue;
    const board = parseBoard(c.api || '') || parseBoard(c.careers_url || '');
    if (!board) continue;
    const k = sig(c.name);
    if (k && !idx.has(k)) idx.set(k, { name: c.name, ...board });
  }
  return idx;
}

/**
 * Fetch one employer's postings. Every row returned belongs to that employer by
 * construction, so `attributed` is true without needing a name check.
 */
export async function fetchBoard({ vendor, slug }, { timeoutMs = 20000 } = {}) {
  const opts = { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) };
  try {
    if (vendor === 'greenhouse') {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, opts);
      if (!r.ok) return { ok: false, status: r.status, rows: [] };
      const j = await r.json();
      return {
        ok: true,
        status: 200,
        rows: (j.jobs || []).map((x) => ({
          title: x.title || '', url: x.absolute_url || '', location: x.location?.name || '',
        })),
      };
    }
    if (vendor === 'lever') {
      const r = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, opts);
      if (!r.ok) return { ok: false, status: r.status, rows: [] };
      const j = await r.json();
      return {
        ok: true,
        status: 200,
        rows: (Array.isArray(j) ? j : []).map((x) => ({
          title: x.text || '', url: x.hostedUrl || '', location: x.categories?.location || '',
        })),
      };
    }
    if (vendor === 'ashby') {
      const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, opts);
      if (!r.ok) return { ok: false, status: r.status, rows: [] };
      const j = await r.json();
      return {
        ok: true,
        status: 200,
        rows: (j.jobs || []).map((x) => ({
          title: x.title || '', url: x.jobUrl || x.applyUrl || '', location: x.location || '',
        })),
      };
    }
  } catch (e) {
    return { ok: false, status: 'ERR', rows: [], error: String(e.message || e).slice(0, 60) };
  }
  return { ok: false, status: 'unsupported', rows: [] };
}

/** Scan one employer by name. Returns rows already attributed to them. */
export async function scanEmployerViaAts(name, idx = boardIndex()) {
  const board = idx.get(sig(name));
  if (!board) return { ok: false, reason: 'no ATS board on file', rows: [], attributed: true };
  const res = await fetchBoard(board);
  return {
    ok: res.ok,
    reason: res.ok ? '' : `board ${res.status}`,
    vendor: board.vendor,
    slug: board.slug,
    attributed: true,                 // structural: the board IS this employer's
    rows: res.rows.filter((r) => r.title && r.url).map((r) => ({ ...r, company: name })),
  };
}

if (isMainModule(import.meta.url)) {
  const idx = boardIndex();
  if (process.argv.includes('--list')) {
    console.log(`${idx.size} employers with a machine-readable ATS board`);
    const byVendor = {};
    for (const b of idx.values()) byVendor[b.vendor] = (byVendor[b.vendor] || 0) + 1;
    console.log(JSON.stringify(byVendor, null, 2));
  } else {
    const name = process.argv.slice(2).join(' ');
    if (!name) { console.error('usage: node ats-scan.mjs "<employer>"  |  --list'); process.exit(1); }
    console.log(JSON.stringify(await scanEmployerViaAts(name, idx), null, 2));
  }
}
