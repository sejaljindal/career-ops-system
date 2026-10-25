#!/usr/bin/env node
/**
 * merge-discovered.mjs — fold careers-discover.mjs results into portals.yml.
 *
 * Idempotent by design: it dedupes against what is already in
 * tracked_companies (by normalised name AND by careers_url host) and rewrites
 * its own managed block each run. Safe to run mid-sweep and again at the end —
 * the second run picks up everything discovered since, without duplicating.
 *
 * Only ATS_FOUND and CAREERS_FOUND are merged. SITE_ONLY means the company
 * website resolved but exposed no careers page, and NO_SITE means no site at
 * all; neither is a route to live roles, so neither gets an entry.
 *
 * Usage:
 *   node merge-discovered.mjs            # merge (rewrites the managed block)
 *   node merge-discovered.mjs --dry-run  # show what would change
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import * as yaml from 'js-yaml';
import { detectPlatform } from './uk-ats.mjs';

const STATE = 'data/careers-discovery.json';
const PORTALS = 'portals.yml';
const BEGIN = '  # >>> BEGIN auto-discovered careers pages (merge-discovered.mjs) >>>';
const END = '  # <<< END auto-discovered careers pages <<<';

const LEGAL = /\b(uk branch|uk|u k|limited|ltd|llp|plc|lp|incorporated|inc|company|holdings|international|group|technologies|technology|services|trading)\b/g;

const normName = (n) => String(n || '').toLowerCase()
  .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ')
  .replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();

const host = (u) => { try { return new URL(u).host.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

const yq = (s) => (/^[\w][\w .,&/()'+-]*$/.test(s) && !s.endsWith(' ') ? s : JSON.stringify(s));

function main() {
  const dry = process.argv.includes('--dry-run');
  if (!existsSync(STATE)) { console.error(`no ${STATE} — run careers-discover.mjs first`); process.exit(1); }

  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  const discovered = Object.values(state.done)
    .filter((r) => (r.outcome === 'ATS_FOUND' || r.outcome === 'CAREERS_FOUND') && r.careers_url);

  let text = readFileSync(PORTALS, 'utf8');

  // Strip our previous managed block so this run fully replaces it.
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b !== -1 && e !== -1) text = text.slice(0, b) + text.slice(e + END.length + 1);

  // Dedupe against everything else already present.
  const doc = yaml.load(text);
  const takenNames = new Set();
  const takenHosts = new Set();
  for (const c of doc.tracked_companies || []) {
    if (!c || !c.name) continue;
    takenNames.add(normName(c.name));
    const h = host(c.careers_url || '');
    if (h) takenHosts.add(h);
  }

  const fresh = [];
  const skipped = { dupeName: 0, dupeHost: 0 };
  const seenHere = new Set();
  for (const r of discovered) {
    const k = normName(r.name);
    const h = host(r.careers_url);
    if (takenNames.has(k)) { skipped.dupeName++; continue; }
    if (h && takenHosts.has(h)) { skipped.dupeHost++; continue; }
    if (seenHere.has(k)) continue;
    seenHere.add(k);
    if (h) takenHosts.add(h);
    fresh.push(r);
  }

  fresh.sort((a, b2) => (a.sector || '').localeCompare(b2.sector || '') || a.name.localeCompare(b2.name));

  const atsCount = fresh.filter((r) => r.ats).length;
  const lines = [BEGIN,
    '  #',
    `  # ${fresh.length} employers resolved from the gov.uk register by probing`,
    '  # name-derived domains for a careers page (careers-discover.mjs).',
    `  # ${atsCount} of them expose a real ATS board and carry an "ats:" note.`,
    '  #',
    '  # This block is REGENERATED on every merge-discovered.mjs run — edit the',
    '  # discovery state, not these lines. Entries here were NOT on any curated',
    '  # list, so they carry no curated +0.3 bonus.',
    '  #'];

  for (const r of fresh) {
    lines.push('');
    lines.push(`  - name: ${yq(r.name)}`);
    lines.push(`    careers_url: ${r.careers_url}`);
    const p = detectPlatform(r.careers_url);
    if (p && p.jobsUrl) {
      const api = p.jobsUrl(r.careers_url);
      if (api) lines.push(`    api: ${api}`);
    }
    lines.push('    enabled: true');
    const bits = ['register-only (no curated list)'];
    if (r.ats) bits.push(`ats: ${r.ats}`);
    if (r.sector) bits.push(r.sector);
    if (r.tier !== undefined && r.tier !== '') bits.push(`tier ${r.tier}`);
    lines.push(`    notes: "${bits.join(' | ').replace(/"/g, "'")}"`);
  }
  lines.push('');
  lines.push(END);

  const block = lines.join('\n');

  // Insert at the end of tracked_companies (immediately before job_boards:).
  const arr = text.split('\n');
  const idx = arr.findIndex((l) => l.startsWith('job_boards:'));
  if (idx === -1) { console.error('could not locate job_boards: — aborting rather than guess'); process.exit(1); }
  let j = idx;
  while (j > 0 && arr[j - 1].trim() === '') j--;
  const out = arr.slice(0, j).join('\n') + '\n' + block + '\n\n' + arr.slice(j).join('\n');

  console.log(`discovered (reachable) : ${discovered.length}`);
  console.log(`  skipped, name already present : ${skipped.dupeName}`);
  console.log(`  skipped, host already present : ${skipped.dupeHost}`);
  console.log(`merged into portals.yml         : ${fresh.length}  (${atsCount} with a detected ATS)`);

  if (dry) { console.log('\n--dry-run: nothing written'); return; }

  writeFileSync(PORTALS, out, 'utf8');
  const after = yaml.load(readFileSync(PORTALS, 'utf8'));
  console.log(`tracked_companies: ${(doc.tracked_companies || []).length} -> ${(after.tracked_companies || []).length}`);
}

if (isMainModule(import.meta.url)) main();
