#!/usr/bin/env node
/**
 * direct-shortlist.mjs — roles on the EMPLOYER'S OWN site, never a job board.
 *
 * Written 2026-09-12 after every role on the morning send list turned out to
 * be a Reed posting showing "you don't currently meet this employer's work
 * authorisation requirements" — Reed's own profile filter, which greys out
 * Apply before the employer ever sees the application.
 *
 * Discovery was never the problem: pipeline.xlsx holds 15,913 rows of which
 * 9,912 are not Reed. The ranking was. The scorer reads titles, Reed titles
 * are clean and keyword-dense, and ATS rows often carry a blank company and a
 * noisy title — so Reed took 71 of the 81 rows scoring >= 4 while genuinely
 * relevant Greenhouse/Workday/Lever postings sat below the cut.
 *
 * This bypasses that score entirely and filters on two things that actually
 * matter: is the link an employer-controlled ATS, and does the title match
 * what the candidate does.
 */
import ExcelJS from 'exceljs';
import path from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isStillLive } from './liveness-gate.mjs';

// Data Root, not the codebase root — output/pipeline.xlsx is user-layer, so
// it must follow CAREER_OPS_ROOT/.career-ops-data (#drift-guard).
const ROOT = getCareerOpsRoot();
const arg = (n, d) => (process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];

// Employer-controlled application surfaces. Applying here goes straight to the
// company's ATS, so no aggregator sits in between deciding she is ineligible.
const DIRECT = /greenhouse\.io|lever\.co|myworkdayjobs\.com|ashbyhq\.com|smartrecruiters\.com|workable\.com|teamtailor\.com|recruitee\.com|icims\.com|successfactors|taleo\.net|eightfold\.ai|careers?\./i;
const BOARD  = /reed\.co\.uk|jobsgopublic|indeed\.|totaljobs|cv-library|monster\.|glassdoor|linkedin\.com\/jobs|adzuna/i;

// What she actually does. Deliberately tight: the existing scorer's looseness
// is why "Chair, Advisory Board on the Registration of Homeopathic Products"
// scored 4.0 and a real BA role scored 3.
const WANT = /\b(business analyst|systems analyst|data analyst|insight analyst|commercial analyst|finance analyst|financial analyst|fp&a|pmo|project analyst|programme analyst|program analyst|project manager|programme manager|project coordinator|delivery (?:analyst|manager|lead)|business partner|reporting analyst|planning analyst|operations analyst|strategy (?:analyst|associate|manager)|consultant|change analyst|transformation|product owner)\b/i;

// Clinical, academic and executive roles the title filter would otherwise let
// through on one matching word.
const NOT = /\b(band [1-9]|nurse|midwife|therapist|clinician|consultant (?:psychiatrist|physician|surgeon|radiologist|anaesthetist)|locum|gp\b|dentist|pharmacist|professor|lecturer|phd|chair\b|trustee|non-executive|director of|head of|vp\b|chief|apprentice)\b/i;

const main = async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(ROOT, 'output', 'pipeline.xlsx'));
  const ws = wb.worksheets[0];
  const h = {}; ws.getRow(1).eachCell((c, i) => { h[String(c.value || '').trim()] = i; });
  const get = (r, n) => { const i = h[n]; if (!i) return ''; const v = r.getCell(i).value;
    return String(v && v.text ? v.text : (v && v.result !== undefined ? v.result : v) || '').trim(); };

  const seen = new Set(); const rows = [];
  for (let n = 2; n <= ws.rowCount; n++) {
    const r = ws.getRow(n);
    const url = get(r, 'Job Posting Link') || get(r, 'Apply Link');
    if (!url || BOARD.test(url) || !DIRECT.test(url)) continue;
    const role = get(r, 'Job Role');
    if (!WANT.test(role) || NOT.test(role)) continue;
    const st = get(r, 'Status').toLowerCase();
    if (['applied', 'rejected', 'closed', 'withdrawn', 'expired', 'interview'].includes(st)) continue;
    if (seen.has(url)) continue; seen.add(url);
    rows.push({ url, role, company: get(r, 'Company') || new URL(url).hostname.replace(/^www\./, '').split('.')[0], score: Number(get(r, 'Score')) || 0 });
  }
  rows.sort((a, b) => b.score - a.score);
  console.log(`${rows.length} direct-employer candidate(s) matching target titles.\n`);

  const need = Number(arg('need', 25)); const max = Number(arg('max-checks', 60));
  let live = 0, checked = 0, gone = 0;
  for (const r of rows) {
    if (live >= need || checked >= max) break;
    checked++;
    const v = await isStillLive(r.url);
    if (v.state === 'gone') { gone++; continue; }
    live++;
    console.log(`${live}. ${r.company} — ${r.role}   [score ${r.score}]`);
    console.log(`   ${r.url}\n`);
  }
  console.log(`${live} live · ${gone} of ${checked} checked had closed.`);
};
main();
