#!/usr/bin/env node
/**
 * ready-to-send.mjs — the "what can I actually send right now" list.
 *
 * Written 2026-09-10 to answer one question that kept costing real
 * opportunities: of everything scored and drafted, which roles are STILL OPEN
 * and ALREADY HAVE DOCUMENTS? Nothing else on a given day matters.
 *
 * The failure it exists to prevent: Sopra Steria scored 5.0, had a CV and a
 * cover letter written, sat in output/ for days, and had already 404'd by the
 * time anyone looked. Fourteen of that run's top twenty went the same way.
 * The pipeline was never short of candidates — it was short of a way to see
 * which candidates were real this morning.
 *
 * Reads output/pipeline.xlsx (UK) or output/pipeline_india.xlsx (India) —
 * whichever exists — and for each unapplied row scoring >= the floor:
 *   1. checks the posting is still live (free; ATS API, then a plain 404 check)
 *   2. reports whether the CV and cover letter already exist ON DISK
 *   3. prints, ranked, only the ones you could send in the next ten minutes
 *
 * Zero LLM calls. No browser. Nothing is written — it only reads and reports.
 *
 * Usage:
 *   node ready-to-send.mjs                 # find 5 live roles I can send
 *   node ready-to-send.mjs --need=3        # stop once 3 live ones are found
 *   node ready-to-send.mjs --min=4.0       # score floor (default 4.0)
 *   node ready-to-send.mjs --all           # include rows with no documents yet
 *   node ready-to-send.mjs --max-checks=80 # look deeper when most have expired
 *   node ready-to-send.mjs --full-list     # write output/all-live-roles-full-list.md
 *                                           # (ALL live eligible rows, not just `need`
 *                                           # of them, and regardless of documents)
 */

import { existsSync, statSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { isStillLive } from './liveness-gate.mjs';
import { checkEligibility } from './eligibility.mjs';
import { ukBridgeFor } from './role-score.mjs';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'output');

const arg = (name, def) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};

/** Cell values come back as strings, or as {text, hyperlink} for real links. */
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.hyperlink ?? v.result ?? '').trim();
  return String(v).trim();
}

/**
 * Statuses that mean the row is finished with — anything else is still
 * actionable. See the bugfix note at the filter below for why this cannot be
 * "any non-empty Status".
 */
const ACTED_ON = new Set([
  'applied', 'interview', 'interviewing', 'offer', 'rejected', 'closed',
  'withdrawn', 'declined', 'not a fit', 'expired',
]);

/**
 * Resolve a CV/Cover cell to a real file on disk, or '' if it is not there.
 *
 * The two repos store this differently and BOTH have to work: UK writes a bare
 * filename ("Harper-May-Ltd_Finance-Analyst_CV.docx") that is relative to
 * output/, India writes a repo-relative path ("output/024-cv-....pdf"). Joining
 * output/ onto the India form produced output/output/... and reported every
 * India document as missing.
 */
function docPath(value) {
  if (!value) return '';
  const raw = String(value).replace(/\\/g, '/').trim();
  const candidates = raw.startsWith('output/')
    ? [path.join(ROOT, raw), path.join(OUT, path.basename(raw))]
    : [path.join(OUT, raw), path.join(ROOT, raw)];
  return candidates.find(existsSync) || '';
}
/**
 * The freshly tailored .docx for this row, if one exists.
 *
 * Added 2026-09-12 after the India send list was found pointing at PDFs dated
 * 14/08 — a month old, written by the older auto-tailor path, and therefore
 * carrying none of the per-JD rewording. Two document producers write into
 * output/: auto-tailor.mjs records its PDF in the pipeline's "CV File" column,
 * while tailor-cv.mjs writes Company_Role_CV.docx and records nothing. The
 * send list read the column, so it served the stale document every time.
 *
 * Rather than have tailor-cv.mjs write back into a spreadsheet that may be
 * open in Excel — the same EACCES that already cost a whole run once — the
 * send list reconstructs the filename with the identical slug rule and
 * prefers it when it is NEWER than whatever the column points at. Older or
 * absent, the recorded document still wins, so nothing regresses.
 */
const safeSlug = (s) => String(s || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function tailoredDoc(company, role, recorded) {
  const p = path.join(OUT, `${safeSlug(company)}_${safeSlug(role)}_CV.docx`);
  if (!existsSync(p)) return '';
  if (recorded && existsSync(recorded)) {
    try {
      if (statSync(p).mtimeMs <= statSync(recorded).mtimeMs) return '';
    } catch { /* unreadable timestamp — prefer the tailored file */ }
  }
  return p;
}


const TIER_LABELS = {
  1: 'Tier 1 — Project management / PMO / project controls',
  2: 'Tier 2 — Strategy and operations',
  3: 'Tier 3 — Transformation / management consulting',
  4: 'Tier 4 — Business analyst (business/management only)',
  5: 'Tier 5 — Graduate / trainee scheme',
};

/**
 * output/all-live-roles-full-list.md — every eligible row that is currently
 * live, grouped by priority tier, whether or not a CV/cover exists yet.
 *
 * Added 2026-09-25 for the India pipeline (Task B). There is no UK
 * equivalent to port from — UK's own "LIVE-LIST-*.md" files were hand-written
 * one-offs from a past session, not script output — so this is a fresh
 * build, not a port. UK-bridge markers are kept (not dropped as a UK-only
 * concept): a candidate's UK experience is a real signal at GCCs, Big-4
 * India, and global tech India sites, so it stays visible here too.
 *
 * Unlike the `need`-hunting loop below, this walks every eligible row (no
 * `top` cap, no document-existence filter) so the file is a complete
 * snapshot, not a shortlist.
 */
async function generateFullList(eligible, candidatesPath, maxChecks) {
  const rows = eligible.filter((r) => !/^NOT A FIT|^EXPIRED/i.test(r.notes));

  const live = [];
  let checked = 0;
  for (const r of rows) {
    if (checked >= maxChecks) break;
    checked++;
    const v = r.link ? await isStillLive(r.link) : { result: 'unknown' };
    if (v.result !== 'expired') live.push(r);
  }

  live.sort((a, b) => (a.tier - b.tier) || (Number(a.stretch) - Number(b.stretch)) || (b.score - a.score));

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    '# All Live Roles — Full List',
    '',
    `Generated: ${now} · Source: ${path.basename(candidatesPath)} · Total live: ${live.length}`,
    '',
  ];

  for (const tierNum of [1, 2, 3, 4, 5]) {
    const tierRows = live.filter((r) => r.tier === tierNum);
    if (!tierRows.length) continue;
    lines.push(`## ${TIER_LABELS[tierNum]} (${tierRows.length})`, '');
    lines.push('| Company | Role | Score | Apply Link | CV | Cover | Notes |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of tierRows) {
      const recorded = docPath(r.cv);
      const cvOk = tailoredDoc(r.company, r.role, recorded) || recorded;
      const covOk = docPath(r.cover);
      const cv = cvOk ? path.basename(cvOk) : 'none yet';
      const cover = covOk ? path.basename(covOk) : 'none yet';
      const bridge = r.ukBridge ? `🇬🇧 UK bridge: ${r.ukBridge}` : '';
      const stretch = r.stretch ? `STRETCH: ${r.tierNote}` : '';
      const notes = [bridge, stretch].filter(Boolean).join(' · ');
      lines.push(`| ${r.company} | ${r.role} | ${r.score} | ${r.link} | ${cv} | ${cover} | ${notes} |`);
    }
    lines.push('');
  }

  const outPath = path.join(OUT, 'all-live-roles-full-list.md');
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`Wrote ${live.length} live row(s) to ${path.relative(ROOT, outPath)} (checked ${checked}, ${rows.length - checked > 0 ? `${rows.length - checked} skipped by --max-checks` : 'all eligible rows checked'}).`);
}

async function main() {
  const need = Number(arg('need', 5)) || 5;        // how many LIVE roles you want
  const maxChecks = Number(arg('max-checks', 40)) || 40;
  const top = Number(arg('top', 200)) || 200;      // how deep the ranked list may go
  const minScore = Number(arg('min', 4.0)) || 4.0;
  const includeUndocumented = process.argv.includes('--all');

  // Whichever pipeline this repo is.
  const candidatesPath = [
    path.join(OUT, 'pipeline.xlsx'),
    path.join(OUT, 'pipeline_india.xlsx'),
  ].find(existsSync);
  if (!candidatesPath) {
    console.error('No pipeline workbook found in output/. Run the scan first.');
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(candidatesPath);
  const ws = wb.worksheets[0];

  const col = {};
  ws.getRow(1).eachCell((c, i) => { col[cellText(c.value)] = i; });
  const get = (row, name) => (col[name] ? cellText(row.getCell(col[name]).value) : '');

  // Column names differ slightly between the two repos; accept either.
  const LINK = ['Apply Link', 'Job Posting Link', 'Link'].find((n) => col[n]);
  const ROLE = ['Job Role', 'Role'].find((n) => col[n]);

  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    // BUGFIX 2026-09-10. This was `if (get(row,'Status')) return;`, which
    // assumed the UK convention of leaving Status BLANK until a role is acted
    // on. India does not: export-excel.mjs writes "Evaluated" to every scored
    // row, so the blanket check silently hid the entire India pipeline and the
    // report claimed "0 role(s)" while auto-tailor was finding four.
    //
    // Only a status that means YOU HAVE ALREADY ACTED should remove a row.
    // Anything else — blank, Evaluated, Pending, Queued — is still sendable.
    if (ACTED_ON.has(get(row, 'Status').toLowerCase())) return;
    const score = Number(get(row, 'Score'));
    if (!(score >= minScore)) return;
    const company = get(row, 'Company');
    rows.push({
      n, score,
      company,
      role: ROLE ? get(row, ROLE) : '',
      link: LINK ? get(row, LINK) : '',
      cv: get(row, 'CV File'),
      cover: get(row, 'Cover Letter'),
      salary: get(row, 'Salary Verdict') || get(row, 'CTC') || '',
      register: get(row, 'Register Verified'),
      notes: get(row, 'Notes'),
      ukBridge: ukBridgeFor(company).tag,
    });
  });

  // Agent web-wide scan reports are a row source too. See the UK file's note:
  // roles found by an agent scan have tailored CVs on disk but never enter
  // pipeline_india.xlsx, so this list could not see them.
  for (const report of readdirSync(OUT).filter((f) => /^AGENT-SCAN-.*\.md$/i.test(f))) {
    const md = readFileSync(path.join(OUT, report), 'utf8');
    for (const line of md.split('\n')) {
      if (!line.startsWith('|')) continue;
      const c = line.split('|').map((x) => x.trim());
      const url = c.find((x) => /^https?:\/\//.test(x));
      if (!url || rows.some((r) => r.link === url)) continue;
      const [, company, role] = c;
      if (!company || !role) continue;
      rows.push({
        n: 0, score: 5, company, role, link: url,
        cv: '', cover: '', salary: '', register: '',
        ukBridge: ukBridgeFor(company).tag,
        notes: `via ${report}`,
      });
    }
  }

  // THE GATE, applied before the score decides anything. See eligibility.mjs.
  // Ranking on score alone rewards keyword density, which is how engineering
  // and Manager-grade roles kept reaching the top of this list.
  const rejected = [];
  const eligible = rows.filter((r) => {
    const e = checkEligibility(r.role, '', r.company);
    if (!e.ok) { rejected.push(`${r.company} — ${r.role}  [${e.reason}]`); return false; }
    r.tier = e.tier; r.stretch = e.stretch; r.tierNote = e.reason;
    return true;
  });

  // Her stated priority order beats the score: project management, then
  // strategy, then transformation, and Business Analyst LAST.
  eligible.sort((a, b) => (a.tier - b.tier)
    || (Number(a.stretch) - Number(b.stretch))
    || (b.score - a.score));

  if (process.argv.includes('--full-list')) {
    await generateFullList(eligible, candidatesPath, Number(arg('max-checks', 200)) || 200);
    return;
  }

  const shortlist = eligible
    .filter((r) => includeUndocumented || docPath(r.cv) || tailoredDoc(r.company, r.role, ''))
    .filter((r) => !/^NOT A FIT|^EXPIRED/i.test(r.notes))
    .slice(0, top);

  if (rejected.length) {
    console.log(`\n${rejected.length} row(s) excluded by the eligibility gate:`);
    for (const x of rejected.slice(0, 40)) console.log(`  - ${x}`);
    if (rejected.length > 40) console.log(`  ...and ${rejected.length - 40} more`);
  }

  console.log('='.repeat(74));
  console.log(`  READY TO SEND — hunting for ${need} live role(s), score >= ${minScore}`);
  console.log(`  ${shortlist.length} candidate row(s) with documents`);
  console.log('  ranked by PRIORITY TIER, not score:');
  console.log('    1 project management / PMO   2 strategy');
  console.log('    3 transformation / consulting   4 business analyst (last)');
  console.log(`  source: ${path.basename(candidatesPath)}`);
  console.log('='.repeat(74));

  if (!shortlist.length) {
    console.log('\nNothing scored above the floor has documents yet.');
    console.log('Run:  node auto-tailor.mjs --limit=10      (UK, writes them itself)');
    console.log('  or: node auto-tailor.mjs --select --limit 3   (India, then an agent renders)');
    return;
  }

  // Walk DOWN the ranked list until `need` live roles are found, rather than
  // checking a fixed top-N and reporting whatever survives.
  //
  // Why: on 2026-09-10 the UK top 6 by score were five dead postings and one
  // live one. A fixed window makes a healthy pipeline look empty simply
  // because its highest scores are also its oldest rows. What is wanted is
  // "give me five I can send", not "tell me how the top six did".
  //
  // `checked` is capped so a pipeline where everything has expired still
  // finishes in reasonable time instead of walking thousands of rows.
  const live = [];
  let checked = 0;
  for (const r of shortlist) {
    if (live.length >= need || checked >= maxChecks) break;
    checked++;
    process.stdout.write(`  checking ${r.company.slice(0, 28).padEnd(30)} `);
    const v = await isStillLive(r.link);
    console.log(v.result === 'expired' ? `EXPIRED (${v.reason})` : 'live');
    if (v.result !== 'expired') live.push(r);
  }

  console.log('\n' + '='.repeat(74));
  console.log(`  ${live.length} LIVE and ready. Send these.`);
  console.log('='.repeat(74));

  live.forEach((r, i) => {
    const recorded = docPath(r.cv);
    const cvOk = tailoredDoc(r.company, r.role, recorded) || recorded;
    const covOk = docPath(r.cover);
    console.log(`\n${i + 1}. [TIER ${r.tier}] ${r.company} — ${r.role}`);
    console.log(`   score ${r.score}${r.stretch ? `  ·  STRETCH: ${r.tierNote}` : ''}${r.salary ? `  ·  ${r.salary}` : ''}${r.ukBridge ? `  ·  🇬🇧 UK bridge: ${r.ukBridge}` : ''}`);
    console.log(`   ${r.link}`);
    console.log(`   CV    : ${cvOk ? path.relative(ROOT, cvOk) : (r.cv ? `${r.cv}  (LISTED BUT MISSING ON DISK)` : 'none yet')}`);
    console.log(`   Cover : ${covOk ? path.relative(ROOT, covOk) : (r.cover ? `${r.cover}  (LISTED BUT MISSING ON DISK)` : 'none yet')}`);
  });

  const dead = checked - live.length;
  console.log('\n' + '-'.repeat(74));
  if (dead > 0) {
    console.log(`  ${dead} of the ${checked} checked had already closed. That is the cost of waiting.`);
  }
  if (live.length < need && checked >= maxChecks) {
    console.log(`  Stopped after ${maxChecks} checks. Raise it with --max-checks=80.`);
  }
  console.log('  Open the folder:  explorer output');
  console.log('  Record a send:    node set-status.mjs <row> Applied');
  console.log('-'.repeat(74));
}

main().catch((e) => { console.error(e); process.exit(1); });
