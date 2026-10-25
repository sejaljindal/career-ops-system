#!/usr/bin/env node
/**
 * pay-bands.mjs — turn published UK pay structures into actual figures.
 *
 * THE PROBLEM THIS SOLVES. UK public-sector adverts print a band, not a salary:
 * "Band 6", "HEO", "Grade 7", "SCP 28". Without a lookup every one of those
 * resolves to UNKNOWN, and an UNKNOWN salary disables the Skilled Worker floor
 * test — the most important filter in this pipeline. A whole sector of genuinely
 * eligible roles becomes invisible.
 *
 * THE RULE THROUGHOUT: where a band maps to a range, take the BOTTOM. Visa
 * eligibility is decided by what is guaranteed on day one, not by the top of a
 * scale reached after years of increments. Resolving "Band 6" to its top point
 * would manufacture eligibility that does not exist — the expensive kind of wrong.
 *
 * Every derived figure is returned with `source: 'BAND_LOOKUP'` so it can never
 * be mistaken for an advertised salary, plus the `confidence` of the structure
 * it came from.
 *
 * Usage:
 *   node pay-bands.mjs "Band 6 role in inner London, £pro rata"
 *   node pay-bands.mjs --self-test
 */

import { readFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import * as yaml from 'js-yaml';

const TABLE = new URL('./templates/uk-pay-bands.yml', import.meta.url);

let cached = null;
export function loadBands(override) {
  if (override) return override;
  if (!cached) cached = yaml.load(readFileSync(TABLE, 'utf8'));
  return cached;
}

/**
 * An advertised figure, if there is one.
 *
 * Ranges take the LOWER bound. Hourly/daily rates are rejected rather than
 * annualised — "£18.50 per hour" is not an annual salary and guessing an FTE
 * multiplier would invent a number the advert never made.
 */
export function advertisedSalary(text) {
  const t = String(text || '').replace(/,/g, '');

  // Reject rates that are not annual before anything else.
  if (/£\s?\d+(\.\d+)?\s*(per\s+hour|ph\b|an hour|hourly|per\s+day|a day|daily|per\s+week|weekly)/i.test(t)) {
    return null;
  }

  const range = t.match(/£\s?(\d{2,3})(k\b|\d{3})\s*(?:-|–|—|to)\s*£?\s?(\d{2,3})(k\b|\d{3})/i);
  if (range) {
    const lo = range[2].toLowerCase() === 'k' ? Number(range[1]) * 1000 : Number(range[1] + range[2]);
    if (lo >= 15000 && lo <= 250000) return lo;
  }
  const single = t.match(/£\s?(\d{2,3})(k\b|\d{3})(?!\d)/i);
  if (single) {
    const v = single[2].toLowerCase() === 'k' ? Number(single[1]) * 1000 : Number(single[1] + single[2]);
    if (v >= 15000 && v <= 250000) return v;
  }
  return null;
}

const londonZone = (text) => {
  const t = String(text).toLowerCase();
  if (/\b(inner london|central london|city of london|westminster|camden|islington|southwark|lambeth|tower hamlets)\b/.test(t)) return 'inner_london';
  if (/\b(outer london|greater london|croydon|barnet|ealing|bromley|harrow|hounslow|enfield)\b/.test(t)) return 'outer_london';
  if (/\blondon\b/.test(t)) return 'inner_london';
  if (/\b(fringe|hertfordshire|essex|surrey|kent|berkshire|buckinghamshire)\b/.test(t)) return 'fringe';
  return null;
};

/** NHS Agenda for Change, including High Cost Area Supplement. */
function nhsAfc(text, bands) {
  const m = String(text).match(/\bband\s*([2-9](?:[a-d])?)\b/i);
  if (!m) return null;
  const key = m[1].toLowerCase();
  const base = bands.bands[key];
  if (!base) return null;

  let salary = base;
  const parts = [`NHS AfC Band ${key} entry point £${base.toLocaleString()}`];
  const zone = londonZone(text);
  if (zone && bands.hcas[zone]) {
    const h = bands.hcas[zone];
    const sup = Math.min(Math.max(base * h.pct, h.min), h.max);
    salary = base + Math.round(sup);
    parts.push(`+ ${zone.replace('_', ' ')} HCAS £${Math.round(sup).toLocaleString()}`);
  }
  return { salary, confidence: bands.confidence, basis: parts.join(' ') };
}

function civilService(text, cs) {
  const t = String(text);
  // Longest label first so "Grade 7" is not shadowed by a bare "EO" match.
  const order = ['Grade 6', 'Grade 7', 'SEO', 'HEO', 'EO', 'AO'];
  for (const g of order) {
    const re = new RegExp(`\\b${g.replace(' ', '\\s*')}\\b`, 'i');
    if (!re.test(t)) continue;
    const row = cs.grades[g];
    if (!row) continue;
    const isLondon = /\blondon\b/i.test(t);
    const salary = isLondon ? row.london : row.national;
    return {
      salary,
      confidence: row.confidence || cs.confidence,
      basis: `Civil Service ${g} ${isLondon ? 'London' : 'national'} band minimum £${salary.toLocaleString()}`,
    };
  }
  return null;
}

function universityGrade(text, uni) {
  // Only trust "Grade N" in an unmistakably HE context — "Grade 7" also means
  // something entirely different in the Civil Service.
  if (!/\b(universit|academic|faculty|ucea|spine point|research fellow|lectur)/i.test(text)) return null;
  const m = String(text).match(/\bgrade\s*([5-9])\b/i);
  if (!m) return null;
  const salary = uni.grades[`Grade ${m[1]}`];
  if (!salary) return null;
  return { salary, confidence: uni.confidence, basis: `University Grade ${m[1]} (indicative) £${salary.toLocaleString()}` };
}

function njcScp(text, njc) {
  const m = String(text).match(/\b(?:scp|spinal column point|scale point)\s*(\d{1,2})\b/i);
  if (!m) return null;
  const want = Number(m[1]);
  const points = Object.keys(njc.scp).map(Number).sort((a, b) => a - b);
  // Nearest defined point at or below the one quoted — never round up.
  const use = [...points].reverse().find((p) => p <= want) ?? points[0];
  const salary = njc.scp[use];
  return {
    salary,
    confidence: njc.confidence,
    basis: `NJC SCP ${want}${use !== want ? ` (nearest defined point ${use})` : ''} £${salary.toLocaleString()}`,
  };
}

/**
 * Resolve a salary from text.
 *
 * Order matters: an advertised figure always beats a derived one.
 * Returns { salary, source, confidence, basis } or { salary: null, ... }.
 */
export function resolveSalary(text, { bands = loadBands() } = {}) {
  const adv = advertisedSalary(text);
  if (adv !== null) {
    const proRata = /\b(pro\s*rata|part[- ]time|fte|full[- ]time equivalent)\b/i.test(text);
    return {
      salary: adv,
      source: 'ADVERTISED',
      confidence: 'high',
      basis: `advertised £${adv.toLocaleString()}${proRata ? ' (stated pro rata / FTE — confirm actual hours)' : ''}`,
      proRata,
    };
  }

  const s = bands.structures;
  // Order matters. "Grade 7" means one thing in the Civil Service and something
  // else entirely at a university, so the university check — which only fires in
  // an unmistakably HE context — must run FIRST or it is permanently shadowed.
  for (const fn of [
    () => nhsAfc(text, s.nhs_afc),
    () => universityGrade(text, s.university),
    () => civilService(text, s.civil_service),
    () => njcScp(text, s.local_government_njc),
  ]) {
    const hit = fn();
    if (hit) {
      return {
        salary: hit.salary,
        source: 'BAND_LOOKUP',
        confidence: hit.confidence,
        basis: hit.basis,
        proRata: /\b(pro\s*rata|part[- ]time|fte)\b/i.test(text),
      };
    }
  }
  return { salary: null, source: 'UNKNOWN', confidence: null, basis: '' };
}

/**
 * What to ask a recruiter when nothing could be resolved. Naming the going rate
 * and the floor turns "salary unknown" into a specific, answerable question.
 */
export function unknownSalaryNote(socCode, rates) {
  const e = rates?.eligible?.[socCode];
  if (!e) return 'Salary not stated — ask the recruiter for the band and the SOC code.';
  return `Salary not stated — ask for at least £${e.new_entrant_floor.toLocaleString()} `
    + `(new-entrant floor for SOC ${socCode}); going rate £${e.going_rate.toLocaleString()}, `
    + `experienced floor £${e.experienced_floor.toLocaleString()}.`;
}

// ── self-test ────────────────────────────────────────────────────────

function selfTest() {
  const cases = [
    ['Band 6 Specialist Nurse, Leeds', 39959, 'BAND_LOOKUP'],
    ['Band 6 Analyst, Inner London', 47951, 'BAND_LOOKUP'],
    ['Band 5 post, Manchester', 32073, 'BAND_LOOKUP'],
    ['Band 8a Programme Lead', 57528, 'BAND_LOOKUP'],
    ['HEO Business Analyst, London', 38500, 'BAND_LOOKUP'],
    ['HEO Business Analyst, Manchester', 34000, 'BAND_LOOKUP'],
    ['Grade 7 Policy Adviser, London', 61000, 'BAND_LOOKUP'],
    ['SCP 28 local authority role', 40476, 'BAND_LOOKUP'],
    ['University of Leeds, Grade 7 research post', 40500, 'BAND_LOOKUP'],
    ['£38,000 - £42,000 per annum', 38000, 'ADVERTISED'],
    ['£45,000 p.a. pro rata', 45000, 'ADVERTISED'],
    ['£18.50 per hour', null, 'UNKNOWN'],
    ['Competitive salary', null, 'UNKNOWN'],
    ['Band 6 role paying £41,000', 41000, 'ADVERTISED'],
  ];
  let pass = 0, fail = 0;
  for (const [text, want, wantSrc] of cases) {
    const r = resolveSalary(text);
    const ok = r.salary === want && r.source === wantSrc;
    if (ok) pass++; else { fail++; console.error(`FAIL: ${text}\n  got ${r.salary} (${r.source}) want ${want} (${wantSrc})`); }
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(r.salary ?? 'null').padStart(7)}  ${r.source.padEnd(12)} ${r.basis || text}`);
  }
  console.log(`\npay-bands: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--self-test')) selfTest();
  else {
    const text = process.argv.slice(2).join(' ');
    if (!text) { console.error('usage: node pay-bands.mjs "<text>"  |  --self-test'); process.exit(1); }
    console.log(JSON.stringify(resolveSalary(text), null, 2));
  }
}
