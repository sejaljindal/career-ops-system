#!/usr/bin/env node
/**
 * uk-coverage.mjs — THE UK sponsor pipeline. One command, one pass.
 *
 *   tag  -> score -> classify coverage -> emit
 *
 * It reads the gov.uk sponsor register (sponsor_targets.csv) plus the curated
 * sponsor lists already merged into portals.yml, and for every employer decides
 * how — if at all — we can actually see its roles.
 *
 * Outputs (all at repo root):
 *   coverage.csv             one row per employer + coverage class
 *   sponsor_targets.tagged.csv   the register plus 2 new columns
 *   sponsor_targets.tagged.xlsx  same, as a real .xlsx
 *
 * Usage:
 *   node uk-coverage.mjs                      # default: --mode=curated
 *   node uk-coverage.mjs --mode=register-only # register employers on no curated list
 *   node uk-coverage.mjs --mode=all
 *   node uk-coverage.mjs --list=University    # Council|University|Tech|AI|Startup|Vetted150
 *   node uk-coverage.mjs --tier=0
 *   node uk-coverage.mjs --max=300
 *   node uk-coverage.mjs --probe              # live-probe DIRECT_API endpoints
 *
 * Flags compose: --mode=register-only --tier=0 --max=300
 */

import { readFileSync, writeFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import { deflateRawSync, crc32 } from 'zlib';
import * as yaml from 'js-yaml';

import { classifyCoverage, detectPlatform, probeEndpoint, UK_ATS, AGGREGATORS } from './uk-ats.mjs';

const REGISTER = 'sponsor_targets.csv';
const PORTALS = 'portals.yml';

// Curated-list bonus. Being on a curated list is evidence the employer ACTUALLY
// sponsors (someone saw them do it), not merely that they hold a licence.
const CURATED_BONUS = 0.3;

// Maps the internal source ids used when the curated lists were merged into
// portals.yml onto the user-facing list names.
const LIST_LABEL = {
  '87-tech': 'Tech',
  '77-ai': 'AI',
  '100-startups': 'Startup',
  'startups-sheet': 'Startup',
  'startups-grad': 'Startup',
  '150-uk': 'Vetted150',
  councils: 'Council',
  universities: 'University',
};
const ALL_LISTS = ['Council', 'University', 'Tech', 'AI', 'Startup', 'Vetted150'];

// ── CSV ──────────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

// ── name normalisation (must match the portals merge) ────────────────

const LEGAL = /\b(uk branch|uk|u k|limited|ltd|llp|plc|lp|incorporated|inc|company|holdings|international|group|technologies|technology|services|trading)\b/g;

export function normName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── load ─────────────────────────────────────────────────────────────

/** Curated employers, read back out of portals.yml (single source of truth). */
export function loadCurated(portalsPath = PORTALS) {
  const doc = yaml.load(readFileSync(portalsPath, 'utf8'));
  const map = new Map();
  for (const c of doc.tracked_companies || []) {
    if (!c || !c.name) continue;
    const notes = String(c.notes || '');
    const lists = new Set();

    // Primary list comes from the section the entry was written under; the
    // "* also on: a, b" marker carries the rest.
    const also = notes.match(/\*\s*also on:\s*([^|]+)/i);
    if (also) {
      for (const raw of also[1].split(',')) {
        const key = raw.trim().replace(/\s*\(.*\)$/, '');
        if (LIST_LABEL[key]) lists.add(LIST_LABEL[key]);
      }
    }
    if (c._list) lists.add(c._list);
    map.set(normName(c.name), {
      name: c.name,
      careers_url: c.careers_url || '',
      notes,
      lists,
      sector: (notes.match(/\|\s*([^|/]+)\s*\//) || [])[1]?.trim() || '',
    });
  }
  return map;
}

/**
 * The curated section headers in portals.yml carry the primary list for every
 * entry beneath them, so re-read the raw text to recover it.
 */
export function loadCuratedPrimaryLists(portalsPath = PORTALS) {
  const text = readFileSync(portalsPath, 'utf8');
  const out = new Map();
  let current = '';
  for (const line of text.split(/\r?\n/)) {
    // The auto-discovered block (merge-discovered.mjs) sits AFTER the curated
    // sections and has no section header of its own. Without this reset, every
    // entry in it inherits the last curated heading — which silently mislabels
    // register-only employers as "University" and hands them the +0.3 curated
    // bonus they have not earned.
    if (line.includes('BEGIN auto-discovered careers pages')) { current = ''; continue; }
    if (line.includes('END auto-discovered careers pages')) { current = ''; continue; }
    const header = line.match(/^\s*#\s*--\s*(.+?)\s*—\s*\d+\s*companies\s*--/);
    if (header) {
      const h = header[1].toLowerCase();
      if (h.includes('council')) current = 'Council';
      else if (h.includes('universit')) current = 'University';
      else if (h.startsWith('tech')) current = 'Tech';
      else if (h.startsWith('ai')) current = 'AI';
      else if (h.includes('startup')) current = 'Startup';
      else if (h.includes('graduate-programme')) current = 'Vetted150';
      else current = '';
      continue;
    }
    const nm = line.match(/^\s{2}- name:\s*(.+?)\s*$/);
    if (nm && current) {
      let v = nm[1].trim();
      if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { /* keep raw */ } }
      out.set(normName(v), current);
    }
  }
  return out;
}

export function loadRegister(path = REGISTER) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine).filter((r) => r.length >= header.length - 1);
  return { header, rows };
}

// ── the pipeline ─────────────────────────────────────────────────────

export function buildRecords({ portalsPath = PORTALS, registerPath = REGISTER } = {}) {
  const curated = loadCurated(portalsPath);
  const primary = loadCuratedPrimaryLists(portalsPath);
  for (const [k, list] of primary) {
    if (curated.has(k)) curated.get(k).lists.add(list);
  }

  const { header, rows } = loadRegister(registerPath);
  const iName = header.indexOf('Organisation');
  const iCity = header.indexOf('City');
  const iSector = header.indexOf('Sector');
  const iCityP = header.indexOf('City Priority');
  const iTier = header.indexOf('Tier');
  const iRating = header.indexOf('Rating');

  const records = [];
  const seen = new Set();

  for (const r of rows) {
    const name = (r[iName] || '').trim();
    if (!name) continue;
    const key = normName(name);
    seen.add(key);
    const c = curated.get(key);
    const lists = c ? [...c.lists].filter(Boolean).sort() : [];
    records.push({
      name,
      key,
      city: (r[iCity] || '').trim(),
      sector: (r[iSector] || '').trim(),
      cityPriority: (r[iCityP] || '').trim(),
      tier: (r[iTier] || '').trim(),
      rating: (r[iRating] || '').trim(),
      careers_url: c?.careers_url || '',
      sourceLists: lists,
      registerVerified: true,
      raw: r,
    });
  }

  // Curated employers NOT on the register — licence not confirmed.
  for (const [key, c] of curated) {
    if (seen.has(key)) continue;
    const lists = [...c.lists].filter(Boolean).sort();
    if (!lists.length) continue;
    records.push({
      name: c.name,
      key,
      city: '',
      sector: c.sector || '',
      cityPriority: '',
      tier: '',
      rating: '',
      careers_url: c.careers_url,
      sourceLists: lists,
      registerVerified: false,
      raw: null,
    });
  }

  for (const rec of records) {
    const cls = classifyCoverage({ careersUrl: rec.careers_url, name: rec.name, sector: rec.sector });
    Object.assign(rec, cls);
    rec.entityType = classifyEntity({ name: rec.name, careers_url: rec.careers_url, sector: rec.sector });
    rec.scoreBonus = rec.sourceLists.length ? CURATED_BONUS : 0;
    rec.warning = rec.registerVerified ? '' : 'licence not confirmed - check before applying';
  }
  return records;
}

// ── entity typing ────────────────────────────────────────────────────
//
// The curated "universities" source is really a list of sponsor-licence holders
// with "University" somewhere in the name. That sweeps in three different kinds
// of employer, and conflating them makes --list=University useless:
//
//   HE    a genuine higher-education institution
//   NHS   an NHS body that merely has "University" in its trust name
//         (Manchester University NHS Foundation Trust) — still a real target,
//         reachable via Health Jobs UK, but not a university
//   OTHER incidental "University"-named entities: Cambridge University Boat
//         Club, CUA Hotel (University Arms), University Campus of Football
//         Business. Noise for this search.

const NHS_RE = /\bNHS\b|foundation trust|\bhospitals?\b|healthcare|health board|ambulance|clinical commissioning|integrated care/i;
// Checked BEFORE the HE test so a university-branded commercial arm or club
// does not get counted as an institution.
const NON_INSTITUTION_RE = /\b(boat club|rowing|hotel|arms\b|football|rugby|cricket|sports? club|students?[' ]?s? union|catering|bar\b|restaurant|press\b|publishing|innovation factory|enterprises?\b|trading (company|ltd|limited)|conference|venues?\b|accommodation|nursery|childcare)\b/i;
const HE_RE = /\b(universit|college|institute|conservatoire|school of|polytechnic|academy of|business school)\b/i;

/** Classify an employer as HE / NHS / OTHER. `.ac.uk` is the strongest HE signal. */
export function classifyEntity({ name = '', careers_url = '', sector = '' } = {}) {
  const n = String(name);
  const isAcUk = /\.ac\.uk(\/|$|")/i.test(String(careers_url));

  if (NHS_RE.test(n)) return 'NHS';
  if (NON_INSTITUTION_RE.test(n)) return 'OTHER';
  if (isAcUk) return 'HE';
  if (HE_RE.test(n)) return 'HE';
  if (/nhs|health/i.test(sector)) return 'NHS';
  if (/educat|universit/i.test(sector)) return 'HE';
  return 'OTHER';
}

// ── filtering / modes ────────────────────────────────────────────────

export function applyMode(records, { mode = 'curated', list = '', tier = '', max = 0, offset = 0, entity = '' } = {}) {
  let out = records;
  if (mode === 'curated') out = out.filter((r) => r.sourceLists.length > 0);
  else if (mode === 'register-only') out = out.filter((r) => r.registerVerified && r.sourceLists.length === 0);
  else if (mode !== 'all') throw new Error(`unknown --mode=${mode} (use curated|register-only|all)`);

  if (list) {
    // Several lists may be given: --list=AI,Startup,Tech matches ANY of them.
    const asked = String(list).split(',').map((s) => s.trim()).filter(Boolean);
    const want = asked.map((a) => {
      const hit = ALL_LISTS.find((l) => l.toLowerCase() === a.toLowerCase());
      if (!hit) throw new Error(`unknown --list=${a} (use ${ALL_LISTS.join('|')})`);
      return hit;
    });
    out = out.filter((r) => r.sourceLists.some((l) => want.includes(l)));
  }
  if (tier !== '' && tier !== undefined && tier !== null) {
    out = out.filter((r) => r.tier === String(tier));
  }
  // --list=University defaults to genuine HE institutions. NHS trusts and
  // incidental "University"-named entities are still reachable, just not what
  // "University" means — ask for them explicitly with --entity=NHS/OTHER/all.
  const entityWanted = entity || (String(list).trim().toLowerCase() === 'university' ? 'HE' : '');
  if (entityWanted && entityWanted.toLowerCase() !== 'all') {
    const want = String(entityWanted).toUpperCase();
    out = out.filter((r) => r.entityType === want);
  }
  const total = out.length;
  const start = Number(offset) || 0;
  const batch = max ? out.slice(start, start + Number(max)) : out.slice(start);
  return { batch, total, start };
}

// ── minimal .xlsx writer (no dependencies) ───────────────────────────

function xlsxEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sheetXml(rows) {
  const body = rows
    .map((row, ri) => {
      const cells = row
        .map((v, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xlsxEscape(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function colName(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/** Build a valid .xlsx (zip) from a row matrix, using only zlib. */
export function writeXlsx(path, rows) {
  const files = [
    ['[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sponsors" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheetXml(rows)],
  ];

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...chunks, centralBuf, end]));
}

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { mode: 'curated', list: '', tier: '', max: 0, offset: 0, probe: false, entity: '' };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'mode') o.mode = v;
    else if (k === 'list') o.list = v;
    else if (k === 'tier') o.tier = v;
    else if (k === 'max') o.max = Number(v);
    else if (k === 'offset') o.offset = Number(v);
    else if (k === 'entity') o.entity = v;
    else if (k === 'probe') o.probe = true;
    else if (k === 'help') o.help = true;
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].replace(/^#!.*\n/, ''));
    return;
  }

  const records = buildRecords();
  const { batch, total, start } = applyMode(records, opts);

  // ── run header (printed at the start of EVERY run) ──
  const universe = records.length;
  const curatedCount = records.filter((r) => r.sourceLists.length).length;
  console.log('='.repeat(78));
  console.log('  career-ops — UK sponsor coverage pipeline');
  console.log('='.repeat(78));
  const shownEntity = opts.entity || (String(opts.list).toLowerCase() === 'university' ? 'HE (default for --list=University)' : '');
  console.log(`  mode          : ${opts.mode}${opts.list ? `  --list=${opts.list}` : ''}${opts.tier !== '' ? `  --tier=${opts.tier}` : ''}${shownEntity ? `  --entity=${shownEntity}` : ''}`);
  console.log(`  batch size    : ${batch.length}${opts.max ? ` (--max=${opts.max})` : ' (no cap)'}`);
  console.log(`  progress      : ${start + batch.length} / ${total} in this mode  ·  ${universe} employers total`);
  console.log(`  universe      : ${universe} = ${records.filter((r) => r.registerVerified).length} register + ${records.filter((r) => !r.registerVerified).length} curated-only`);
  console.log(`  curated-listed: ${curatedCount} (each scored +${CURATED_BONUS})`);
  console.log('='.repeat(78));
  console.log();

  if (opts.probe) {
    const targets = batch.filter((r) => r.coverage === 'DIRECT_API' && r.endpoint);
    console.log(`probing ${targets.length} DIRECT_API endpoints...`);
    let i = 0;
    for (const r of targets) {
      const res = await probeEndpoint(r.endpoint);
      r.probeStatus = res.ok ? `ok:${res.count}` : `fail:${res.status}`;
      if (++i % 25 === 0) console.log(`  ...${i}/${targets.length}`);
    }
    console.log();
  }

  // ── coverage.csv ──
  const covHeader = ['Organisation', 'City', 'Sector', 'Tier', 'City Priority', 'Source Lists',
    'Register Verified', 'Entity Type', 'Coverage', 'Platform', 'Route', 'Endpoint', 'Score Bonus', 'Warning'];
  const covRows = [covHeader, ...batch.map((r) => [
    r.name, r.city, r.sector, r.tier, r.cityPriority,
    r.sourceLists.join('; '), r.registerVerified ? 'YES' : 'NO', r.entityType,
    r.coverage, r.platform, r.route, r.endpoint,
    r.scoreBonus ? `+${r.scoreBonus}` : '', r.warning,
  ])];
  writeFileSync('coverage.csv', toCsv(covRows), 'utf8');

  // ── tagged register (all register rows, both new columns) ──
  const { header, rows } = loadRegister();
  const byKey = new Map(records.map((r) => [r.key, r]));
  const tagHeader = [...header, 'Source Lists', 'Register Verified'];
  const tagRows = [tagHeader, ...rows.map((raw) => {
    const rec = byKey.get(normName(raw[header.indexOf('Organisation')] || ''));
    return [...raw, rec ? rec.sourceLists.join('; ') : '', 'YES'];
  })];
  // Curated-only employers are appended so the file is the full universe.
  for (const r of records.filter((x) => !x.registerVerified)) {
    const row = new Array(header.length).fill('');
    row[header.indexOf('Organisation')] = r.name;
    row[header.indexOf('City')] = r.city;
    row[header.indexOf('Sector')] = r.sector;
    tagRows.push([...row, r.sourceLists.join('; '), 'NO']);
  }
  writeFileSync('sponsor_targets.tagged.csv', toCsv(tagRows), 'utf8');
  writeXlsx('sponsor_targets.tagged.xlsx', tagRows);

  // ── summary ──
  const tally = (arr, k) => arr.reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {});
  const cov = tally(batch, 'coverage');
  console.log('COVERAGE IN THIS BATCH');
  for (const k of ['DIRECT_API', 'AGGREGATOR_ONLY', 'UNREACHABLE']) {
    console.log(`  ${String(cov[k] || 0).padStart(6)}  ${k}`);
  }
  const covAll = tally(records, 'coverage');
  console.log('\nCOVERAGE ACROSS THE FULL UNIVERSE');
  for (const k of ['DIRECT_API', 'AGGREGATOR_ONLY', 'UNREACHABLE']) {
    const n = covAll[k] || 0;
    console.log(`  ${String(n).padStart(6)}  ${k}  (${((n / records.length) * 100).toFixed(1)}%)`);
  }
  const entTally = tally(records, 'entityType');
  console.log('');
  console.log('BY ENTITY TYPE (full universe)');
  for (const k of ['HE', 'NHS', 'OTHER']) console.log(`  ${String(entTally[k] || 0).padStart(6)}  ${k}`);
  const listTally = {};
  for (const r of records) for (const l of r.sourceLists) listTally[l] = (listTally[l] || 0) + 1;
  console.log('\nBY CURATED LIST');
  for (const l of ALL_LISTS) console.log(`  ${String(listTally[l] || 0).padStart(6)}  ${l}`);
  console.log(`\n  ${records.filter((r) => !r.registerVerified).length} employers flagged "licence not confirmed - check before applying"`);
  console.log('\nwrote coverage.csv, sponsor_targets.tagged.csv, sponsor_targets.tagged.xlsx');
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
