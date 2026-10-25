#!/usr/bin/env node
/**
 * apply-stage2-tier0.mjs — one-shot apply of the Stage 2 web-search results
 * (stage2-tier0-results.csv) into portals.yml + coverage.csv. Only high/medium
 * confidence hits are applied; low-confidence hits are left UNREACHABLE for a
 * human to check by hand. Backs up both files first.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { patchPortalsYmlText } from './portals-text-patch.mjs';

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

const lines = readFileSync('stage2-tier0-results.csv', 'utf8').split(/\r?\n/).filter(Boolean);
const h = parseCsvLine(lines[0]);
const rows = lines.slice(1).map(parseCsvLine).map((r) => ({
  name: r[h.indexOf('Organisation')], outcome: r[h.indexOf('Outcome')],
  careers_url: r[h.indexOf('CareersURL')], ats: r[h.indexOf('ATS')], confidence: r[h.indexOf('Confidence')],
}));
const applied = rows.filter((r) => r.careers_url && (r.confidence === 'high' || r.confidence === 'medium'));
const byName = new Map(applied.map((r) => [r.name, r]));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
copyFileSync('portals.yml', `portals.before-stage2-tier0-${stamp}.yml`);
copyFileSync('coverage.csv', `coverage.before-stage2-tier0-${stamp}.csv`);

// Text-level patch, not yaml.load()/yaml.dump() — a full round-trip through
// js-yaml silently drops every comment in the file, including the curated-
// list section headers loadCuratedPrimaryLists() depends on. That exact bug
// undercounted curated employers by ~350 for several nights before it was
// caught on 2026-08-31. See portals-text-patch.mjs.
const portalsRaw = readFileSync('portals.yml', 'utf8');
const updates = new Map();
for (const m of applied) {
  updates.set(m.name, {
    careers_url: m.careers_url,
    notesAppend: `web-search verified (${m.confidence} confidence, stage 2)`,
  });
}
const { text: patchedYml, patchedCount: portalsUpdated } = patchPortalsYmlText(portalsRaw, updates);
writeFileSync('portals.yml', patchedYml, 'utf8');

const covLines = readFileSync('coverage.csv', 'utf8').split(/\r?\n/);
const ch = parseCsvLine(covLines[0]);
const iN = ch.indexOf('Organisation'), iC = ch.indexOf('Coverage'), iW = ch.indexOf('Warning'), iP = ch.indexOf('Platform');
let coverageUpdated = 0;
const out = [covLines[0]];
for (const line of covLines.slice(1)) {
  if (!line) continue;
  const cells = parseCsvLine(line);
  const m = byName.get(cells[iN]);
  if (m) {
    cells[iC] = m.ats ? 'DIRECT_API' : 'AGGREGATOR_ONLY';
    if (iP >= 0 && m.ats) cells[iP] = m.ats;
    cells[iW] = `${cells[iW] || ''} stage2 web-search verified (${m.confidence})`.trim();
    coverageUpdated++;
  }
  out.push(cells.map(cell).join(','));
}
writeFileSync('coverage.csv', out.join('\n'), 'utf8');

console.log(`applied ${applied.length} matches (${applied.filter((r) => r.confidence === 'high').length} high, ${applied.filter((r) => r.confidence === 'medium').length} medium confidence)`);
console.log(`portals.yml entries updated : ${portalsUpdated}`);
console.log(`coverage.csv rows updated   : ${coverageUpdated}`);
console.log(`backups: portals.before-stage2-tier0-${stamp}.yml, coverage.before-stage2-tier0-${stamp}.csv`);
