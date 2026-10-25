#!/usr/bin/env node
/**
 * group-dedupe.mjs — Stage 1 of UNREACHABLE resolution: free corporate-group
 * inheritance. No network calls, no guessing.
 *
 * WHY THIS IS SAFE WHERE DOMAIN-GUESSING WASN'T. careers-discover.mjs guesses
 * a domain from a legal name and has already produced at least one wrong
 * match in this file ("Atkins Walters and Webster Limited" ->
 * thesimplygoodfoodscompany.gcs-web.com/careers). This script never guesses a
 * URL — it only copies a careers_url that a human already vetted into the
 * CURATED half of portals.yml, and only when a subsidiary's legal name
 * contains a token distinctive enough to belong to exactly one curated
 * parent (length >= 5, not a stopword, not a generic/place word, and not
 * shared by two different curated parents).
 *
 * SOURCE OF TRUTH FOR "ALREADY KNOWN": the curated block of tracked_companies
 * in portals.yml (entries WITHOUT the "register-only (no curated list)" note
 * — see CLAUDE.md: "Employers on a curated sponsor list (~658) — the
 * highest-signal set"). Register-appended entries are read but never used as
 * a source, even if they happen to carry a careers_url, because those can be
 * careers-discover.mjs guesses, not vetted facts.
 *
 * Usage:
 *   node group-dedupe.mjs               # report only, writes group-dedupe-matches.csv
 *   node group-dedupe.mjs --apply       # also updates portals.yml + coverage.csv
 *                                       # (backs up both first)
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import * as yaml from 'js-yaml';
import { patchPortalsYmlText } from './portals-text-patch.mjs';

const LEADING_JUNK = new Set(['the', 'a', 'an', 'university', 'college', 'trust', 'foundation', 'nhs', 'council',
  'borough', 'royal', 'national', 'international', 'global', 'saint', 'st']);

/**
 * A hand-vetted whitelist of coined/acronym brand tokens — words that are NOT
 * ordinary English vocabulary and NOT common surnames, so a name-collision is
 * implausible. This replaces an earlier attempt to derive tokens automatically
 * from "any word that leads a curated company's name": that produced false
 * positives on every generic adjective and surname that happens to lead SOME
 * curated name (Delta, Alpha, Smart, Direct, Cloud, Evolution, James, Miller —
 * all rejected on inspection, only one of fifteen candidates was a real
 * subsidiary). A frequency or position heuristic cannot tell a coined brand
 * from an ordinary word; only a human can, so this list is deliberately short
 * and grows only when someone checks a new token by hand.
 *
 * Extend this list freely — the loop below only uses tokens that actually
 * exist as a curated tracked_companies name in portals.yml, so an unmatched
 * addition is a silent no-op, never a bad match.
 */
const BRAND_WHITELIST = ['aecom', 'arcadis', 'capgemini', 'atkinsrealis', 'atkinsréalis', 'kpmg', 'pwc',
  'deloitte', 'accenture', 'wsp', 'arup', 'mace', 'wipro', 'infosys', 'sopra', 'atos', 'eviden', 'fujitsu',
  'thales', 'serco', 'mitie', 'sodexo', 'cgi', 'ntt', 'dxc', 'capco', 'mckinsey', 'jacobs', 'aecon',
  'grantthornton', 'rsm', 'bdo', 'mazars', 'cognizant', 'infineon', 'siemens', 'bosch', 'unilever',
  'sanofi', 'novartis', 'astrazeneca', 'glaxosmithkline', 'gsk', 'roche', 'pfizer'];

/** First meaningful word of a name — brand names conventionally lead. */
function firstBrandToken(name) {
  const words = String(name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (LEADING_JUNK.has(w)) continue;
    return BRAND_WHITELIST.includes(w) ? w : null;
  }
  return null;
}

/** Does this brand token also lead (within the first two words of) a name? */
function matchesBrand(name, token) {
  const words = String(name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
    .filter((w) => !LEADING_JUNK.has(w));
  return words.slice(0, 2).includes(token);
}

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

function loadCoverage() {
  const lines = readFileSync('coverage.csv', 'utf8').split(/\r?\n/).filter(Boolean);
  const h = parseCsvLine(lines[0]);
  const iN = h.indexOf('Organisation'), iT = h.indexOf('Tier'), iC = h.indexOf('Coverage');
  const map = new Map();
  const unreachable = [];
  for (const r of lines.slice(1).map(parseCsvLine)) {
    map.set(r[iN], r[iC]);
    if (r[iC] === 'UNREACHABLE') unreachable.push({ name: r[iN], tier: r[iT] });
  }
  return { coverageByName: map, unreachable };
}

function main() {
  const apply = process.argv.includes('--apply');
  const portalsRaw = readFileSync('portals.yml', 'utf8');
  const doc = yaml.load(portalsRaw);
  const companies = doc.tracked_companies || [];

  const { coverageByName, unreachable } = loadCoverage();
  const registerByName = new Map(companies
    .filter((c) => /register-only \(no curated list\)/.test(c.notes || ''))
    .map((c) => [c.name, c]));

  // A company is a trustworthy SOURCE of a careers_url if it's either in the
  // curated (human-vetted) block, or a register-appended entry whose own
  // Coverage is already DIRECT_API/AGGREGATOR_ONLY — i.e. proven reachable,
  // not an UNREACHABLE guess. UNVERIFIABLE/unclassified register entries with
  // a careers_url are excluded: that careers_url could itself be a bad
  // careers-discover.mjs guess (see the Atkins Walters and Webster case).
  const sourcePool = companies.filter((c) => {
    if (!c.careers_url) return false;
    const isCurated = !/register-only \(no curated list\)/.test(c.notes || '');
    if (isCurated) return true;
    const cov = coverageByName.get(c.name);
    return cov === 'DIRECT_API' || cov === 'AGGREGATOR_ONLY';
  });

  // brand token (leads a source name) -> [{name, careers_url}], plural so
  // ambiguous tokens (two different parents leading with the same word) can
  // be dropped rather than guessed at.
  const tokenIndex = new Map();
  for (const c of sourcePool) {
    const t = firstBrandToken(c.name);
    if (!t) continue;
    if (!tokenIndex.has(t)) tokenIndex.set(t, []);
    tokenIndex.get(t).push({ name: c.name, careers_url: c.careers_url });
  }
  for (const [t, hits] of tokenIndex) {
    const distinct = new Set(hits.map((h) => h.careers_url));
    if (distinct.size > 1) tokenIndex.delete(t);
  }

  const matches = [];
  for (const r of unreachable) {
    const reg = registerByName.get(r.name);
    if (!reg) continue; // curated employer already, not part of the register-only pool
    for (const [t, cand] of tokenIndex) {
      if (matchesBrand(r.name, t)) { matches.push({ name: r.name, tier: r.tier, token: t, parent: cand[0].name, careers_url: cand[0].careers_url }); break; }
    }
  }

  const csv = ['Organisation,Tier,MatchedToken,ParentCompany,CareersURL',
    ...matches.map((m) => [m.name, m.tier, m.token, m.parent, m.careers_url]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  writeFileSync('group-dedupe-matches.csv', csv, 'utf8');

  console.log('='.repeat(78));
  console.log('  Stage 1 — corporate-group dedupe (free, no network)');
  console.log('='.repeat(78));
  console.log(`  known-good source pool (curated + verified-reachable) : ${sourcePool.length}`);
  console.log(`  distinctive tokens usable for matching: ${tokenIndex.size}`);
  console.log(`  UNREACHABLE register-only pool        : ${unreachable.length}`);
  console.log(`  RESOLVED via group inheritance         : ${matches.length}`);
  console.log(`\n  wrote group-dedupe-matches.csv (${matches.length} rows)`);
  if (matches.length) {
    console.log('\n  sample:');
    for (const m of matches.slice(0, 15)) console.log(`    ${m.name}  ->  ${m.parent}  (${m.careers_url})  [token: ${m.token}]`);
  }

  if (!apply) {
    console.log('\n  dry run only — re-run with --apply to write portals.yml + coverage.csv');
    return;
  }
  if (!matches.length) { console.log('\n  nothing to apply.'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync('portals.yml', `portals.before-group-dedupe-${stamp}.yml`);
  copyFileSync('coverage.csv', `coverage.before-group-dedupe-${stamp}.csv`);

  const byName = new Map(matches.map((m) => [m.name, m]));
  // Text-level patch, not yaml.load()/yaml.dump() — a full round-trip through
  // js-yaml silently drops every comment in the file, including the
  // curated-list section headers loadCuratedPrimaryLists() depends on. That
  // exact bug undercounted curated employers by ~350 for several nights
  // before it was caught on 2026-08-31. See portals-text-patch.mjs.
  const updates = new Map();
  for (const m of matches) {
    updates.set(m.name, {
      careers_url: m.careers_url,
      notesAppend: `group-inherited from ${m.parent} via token "${m.token}"`,
    });
  }
  const { text: patchedYml, patchedCount } = patchPortalsYmlText(portalsRaw, updates);
  writeFileSync('portals.yml', patchedYml, 'utf8');
  if (patchedCount !== matches.length) {
    console.log(`  WARNING: expected to patch ${matches.length} entries, actually patched ${patchedCount} — check for a name mismatch before trusting this run.`);
  }

  const lines = readFileSync('coverage.csv', 'utf8').split(/\r?\n/);
  const h = parseCsvLine(lines[0]);
  const iN = h.indexOf('Organisation'), iC = h.indexOf('Coverage'), iW = h.indexOf('Warning');
  const out = [lines[0]];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = parseCsvLine(line);
    const m = byName.get(cells[iN]);
    if (m) {
      cells[iC] = 'AGGREGATOR_ONLY';
      cells[iW] = `${cells[iW] || ''} group-inherited: ${m.parent}`.trim();
    }
    out.push(cells.map((v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(','));
  }
  writeFileSync('coverage.csv', out.join('\n'), 'utf8');
  console.log(`\n  applied: portals.yml + coverage.csv updated (${matches.length} employers), backups written.`);
}

if (isMainModule(import.meta.url)) {
  main();
}
