#!/usr/bin/env node
/**
 * prefilter-scope.mjs — free, no-network pre-filter ahead of web-search
 * discovery. Stage 2 on Tier 0 showed the register's "Major Target" tagging
 * is noisy: roughly half of every batch was a single pharmacy, corner shop,
 * care home, or sole trader with no realistic careers page, burning a search
 * for nothing. This filters those out by pattern BEFORE spending any search
 * budget — conservative on purpose: anything ambiguous stays IN the batch
 * (a missed real employer costs one wasted search later; a wrongly-excluded
 * one is silently lost forever), so this only removes strong-signal noise.
 *
 * Usage:
 *   node prefilter-scope.mjs --tier=1     # report + write tier{N}-plausible.json / tier{N}-skipped.csv
 */
import { readFileSync, writeFileSync } from 'fs';

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

// Trading-as / sole-trader pattern: "R S Bains T/A Bains Pharmacy", "Jasvinder
// Singh Bains T/A Bains Store", "Mr Ratnam Anantharupan TA Royal Food and Wine".
const TRADING_AS_RE = /\bT\/?A\b/i;
// A personal-name-shaped name with no company suffix at all: "Lynn Macbain",
// "j m mcgill" — 2-3 short word tokens, no Ltd/LLP/PLC/etc, no digits.
const PERSONAL_NAME_RE = /^[A-Za-z.]+(\s+[A-Za-z.]+){1,2}$/;
const COMPANY_SUFFIX_RE = /\b(ltd|limited|llp|plc|llc|lp|inc|incorporated|group|holdings|partners|partnership|associates|company|co\b|corp|corporation)\b/i;

// Sector-keyword signal: a single-site local business, regardless of what
// "Sector" the register happened to tag it. Deliberately narrow — general
// words like "services", "consulting", "solutions" are NOT here because they
// also describe real mid-size employers.
const SMALL_BIZ_RE = /\b(pharmacy|pharmacist|chemist|care home|care ltd|care limited|carehome|nursing home|rest home|residential home|supermarket|convenience store|newsagent|off.?licen[cs]e|food and wine|corner shop|fencing|brickwork|bricklay|builder|building services|restaurant|cafe|caf[eé]|takeaway|hairdress|barber|salon|nail bar|tanning|beauty|taxi|minicab|dry clean|launderette|garage|mot centre|car wash|stud farm|kennels?|cattery|guest ?house|bed and breakfast|b&b|dental practice|gp practice|health centre|medical practice|veterinary)\b/i;

// Small-contractor trade naming convention: "[word] Construction Ltd/Limited/
// Services Ltd", "[word] Renovation(s) Ltd", "[word] Roofing/Scaffolding/
// Plumbing/Electrical Contractors Ltd". These are manual-trade subcontractors,
// not knowledge-work employers — checked against known construction MAJORS
// (Balfour Beatty, Laing O'Rourke, Wates, Skanska, Kier, Morgan Sindall, ISG,
// Galliford Try, Bam, McLaren) before adding this: none of them match this
// shape in the register, so this cut has no observed false-negative risk.
const TRADE_RE = /\b(construction|renovation|roofing|scaffold(ing)?|plumbing|electrical contractors?|groundwork|demolition|joinery|carpentry|plastering|tiling|landscaping|paving|guttering|decorating)\b/i;

function classify(name) {
  const n = String(name).trim();
  if (TRADING_AS_RE.test(n)) return { skip: true, reason: 'trading-as / sole trader' };
  if (SMALL_BIZ_RE.test(n)) return { skip: true, reason: 'small-business keyword' };
  if (TRADE_RE.test(n)) return { skip: true, reason: 'manual-trade contractor' };
  if (PERSONAL_NAME_RE.test(n) && !COMPANY_SUFFIX_RE.test(n)) return { skip: true, reason: 'looks like a personal name, no company suffix' };
  return { skip: false, reason: '' };
}

function main() {
  const args = process.argv.slice(2);
  const tier = (args.find((a) => a.startsWith('--tier=')) || '').split('=')[1];
  if (tier === undefined) { console.error('usage: node prefilter-scope.mjs --tier=N'); process.exit(1); }

  const lines = readFileSync('coverage.csv', 'utf8').split(/\r?\n/).filter(Boolean);
  const h = parseCsvLine(lines[0]);
  const iN = h.indexOf('Organisation'), iT = h.indexOf('Tier'), iC = h.indexOf('Coverage'),
    iCity = h.indexOf('City'), iS = h.indexOf('Sector');
  const rows = lines.slice(1).map(parseCsvLine)
    .filter((r) => r[iC] === 'UNREACHABLE' && r[iT] === String(tier))
    .map((r) => ({ name: r[iN], city: r[iCity], sector: r[iS] }));

  const plausible = [];
  const skipped = [];
  for (const r of rows) {
    const c = classify(r.name);
    if (c.skip) skipped.push({ ...r, reason: c.reason });
    else plausible.push(r);
  }

  writeFileSync(`tier${tier}-plausible.json`, JSON.stringify(plausible), 'utf8');
  const csv = ['Organisation,City,Sector,SkipReason',
    ...skipped.map((r) => [r.name, r.city, r.sector, r.reason].map(cell).join(','))].join('\n');
  writeFileSync(`tier${tier}-skipped.csv`, csv, 'utf8');

  const byReason = {};
  for (const r of skipped) byReason[r.reason] = (byReason[r.reason] || 0) + 1;

  console.log('='.repeat(78));
  console.log(`  pre-filter — Tier ${tier} UNREACHABLE`);
  console.log('='.repeat(78));
  console.log(`  total UNREACHABLE       : ${rows.length}`);
  console.log(`  skipped (no web search) : ${skipped.length}  (${((skipped.length / rows.length) * 100).toFixed(1)}%)`);
  for (const [reason, n] of Object.entries(byReason)) console.log(`    ${String(n).padStart(5)}  ${reason}`);
  console.log(`  plausible (to search)   : ${plausible.length}  (${((plausible.length / rows.length) * 100).toFixed(1)}%)`);
  console.log(`\n  wrote tier${tier}-plausible.json (${plausible.length}), tier${tier}-skipped.csv (${skipped.length})`);
}

main();
