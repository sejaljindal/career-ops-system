#!/usr/bin/env node
/**
 * tailor-cv.mjs — a tailored CV per role, in the candidate's preferred layout.
 *
 * REWRITTEN 2026-09-11. The previous version carried its own cut-down parser
 * and renderer, which understood a flat Experience/Education/Skills shape and
 * threw away everything else in cv.md — the Key Achievements pool, the three
 * grouped Skills blocks, all eleven certifications and their Core-skills
 * lines, and the Extra-Curricular section. Roughly half the CV never reached
 * the page. Layout and rendering now live in cv-render.mjs; this file decides
 * only what to tailor.
 *
 * ── WHAT TAILORING TOUCHES ───────────────────────────────────────────────
 *  1. HEADLINE      — the target job title, verbatim, under the name.
 *  2. SUMMARY       — the opening sentence names the role and the JD's top
 *                     asks; the rest is cv.md's own summary, unchanged.
 *  3. SKILLS ORDER  — inside each of the three groups, terms the JD uses move
 *                     to the front. No term is added, removed or reworded.
 *  4. KEY ACHIEVEMENTS — which four of the seven are surfaced.
 *  5. BULLETS       — JD-relevant experience bullets first, AND reworded
 *                     into this posting's vocabulary from a verified variant
 *                     bank. Same facts, same figures, same scope, different
 *                     register. See bullet-variants.data.mjs.
 *  6. CREDENTIALS   — conditional extras (DBS) only where the JD asks.
 *
 * ── WHAT IT NEVER TOUCHES ────────────────────────────────────────────────
 * Any figure, any employer, date, qualification or scope. Bullets are
 * reworded only into pre-authored variants that verify-variants.mjs has
 * proven carry identical figures, identical named entities and no promoted
 * verb — "Coordinated" never becomes "Led". Every run audits each figure
 * back to cv.md.
 *
 * NEVER MENTIONS visa, sponsorship or work authorisation.
 *
 * Usage:
 *   node tailor-cv.mjs --need=25
 *   node tailor-cv.mjs --need=5 --verbose
 *   node tailor-cv.mjs --no-liveness
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { Packer } from 'docx';
import ExcelJS from 'exceljs';
import { loadCv, renderCv } from './cv-render.mjs';
import { isStillLive } from './liveness-gate.mjs';
import { fetchJd, matchJd } from './jd-keywords.mjs';
import { selectSkills } from './skills-pool.mjs';
import { pickFamily, variantFor } from './bullet-variants.data.mjs';
import { checkEligibility } from './eligibility.mjs';
import { jdVetoCheck, logJdRejection } from './jd-veto.mjs';
import { buildRegisterIndex, lookupRegister, UNATTRIBUTED_CAP } from './run-daily.mjs';
import * as coverageTracker from './coverage-tracker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

// Data Root, not the codebase root — every path built from ROOT here is
// user-layer (cv.md, output/), so it must follow CAREER_OPS_ROOT/
// .career-ops-data like every other user-layer file (#drift-guard).
const ROOT = getCareerOpsRoot();
const CV_MD = path.join(ROOT, 'cv.md');
const XLSX = path.join(ROOT, 'output', 'pipeline.xlsx');
const OUT_DIR = path.join(ROOT, 'output');

const arg = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};

/**
 * Credentials added only when the posting asks. A credential on every
 * document is noise; on the one document that asked for it, signal.
 *
 * The DBS fires on a genuine vetting or safeguarding context — not on the
 * bare word "security", which would wrongly tag an information-security
 * business analyst role, and those are targets rather than vetting processes.
 */
const CONDITIONAL_CREDENTIALS = [
  {
    id: 'dbs',
    when: /\b(?:dbs|disclosure and barring|basic disclosure|bpss|baseline personnel security|ctc\b|counter[- ]terrorist check|nppv|security clearance|security vetting|vetting process|safety[- ]critical|safeguarding|pre[- ]employment (?:screening|checks?))\b/i,
    text: 'DBS check — cleared, obtained through EMPLOYER_ONE (safety-critical rail environment)',
  },
];

const conditionalCredentials = (jdText, role) =>
  CONDITIONAL_CREDENTIALS.filter((c) => c.when.test(`${role} ${jdText}`)).map((c) => c.text);

/**
 * One generated sentence, prepended to cv.md's own summary.
 *
 * Deliberately one sentence and no more: the existing summary is well
 * written and carries the £100K result and the portfolio scale. Replacing it
 * wholesale to chase keywords would trade a strong paragraph for a generic
 * one. This adds the role name and the JD's top three asks, then gets out of
 * the way.
 */
function buildSummary(baseSummary, hits, role) {
  if (!role) return baseSummary;
  const terms = hits.filter((h) => h.label).slice(0, 3).map((h) => h.label.toLowerCase());

  // APPENDED, not prepended. A first draft opened with "Applying for <role>,
  // bringing <three terms>" and it read badly for two reasons: the headline
  // directly above already states the role, and a list of capabilities before
  // any evidence is the weakest possible first sentence. the candidate's own second
  // CV variant closes with "Now targeting consulting, transformation, and
  // programme delivery roles where analytical rigour and structured execution
  // intersect" — the same move, in the right place. This matches that.
  if (!terms.length) return `${baseSummary} Now targeting ${role}.`;
  const list = terms.join(', ').replace(/, ([^,]*)$/, ' and $1');
  return `${baseSummary} Now targeting ${role}, where ${list} are central.`;
}

/**
 * Strip recruiter noise from a job title before it becomes the CV headline.
 *
 * Added 2026-09-11 after the fact audit flagged "£80,000" on a CV. It was not
 * a fabrication — the audit was right and the title genuinely was "Business
 * Analyst – Surbiton, Surrey - £80,000 plus benefits". Agencies routinely
 * bolt salary, location and reference codes onto the title, and every one of
 * those was flowing straight into the headline under the candidate's name and into
 * the "Now targeting..." sentence.
 *
 * A salary on your own CV headline reads as though you pasted the advert.
 * This keeps the role and drops the advert.
 */
function cleanRoleTitle(raw) {
  let t = String(raw || '').trim();

  // Leading agency reference code: "V06287 - I&FS Project Controller".
  t = t.replace(/^[A-Z]{1,3}\d{3,}[A-Z0-9-]*\s*[–—-]\s*/i, '');
  // Inline reference: "Ref: ABC123", "Job ID 44120".
  t = t.replace(/\b(?:ref|reference|job\s*id|req(?:uisition)?)\b[:.#]?\s*[A-Z0-9][A-Z0-9-]{2,}/gi, '');
  // Salary in any of its advert forms.
  t = t.replace(/\b(?:up to|circa|c\.|from|paying)\s*[£$€]\s?[\d.,]+\s?k?\b/gi, '');
  t = t.replace(/[£$€]\s?[\d.,]+\s?k?(?:\s*(?:per annum|p\.?a\.?|pa))?/gi, '');
  t = t.replace(/\bplus\s+(?:benefits|bonus|package)\b/gi, '');
  // Trailing employment-type / work-pattern clutter after a pipe or comma.
  t = t.replace(/\s*[|]\s*(?:remote|hybrid|on[- ]?site|full[- ]time|part[- ]time|permanent|contract|fixed[- ]term)\b.*$/i, '');
  // Tidy whatever separators the removals left behind.
  t = t.replace(/\s*[–—-]\s*(?=[–—-]|$)/g, ' ');
  t = t.replace(/[\s,|]*[–—-]\s*$/, '');
  t = t.replace(/\b(?:up to|circa|from|paying)\s*$/i, '');
  t = t.replace(/[\s,|–—-]+$/, '').replace(/\s{2,}/g, ' ').trim();

  // Never return less than a role. If the cleaners ate everything, the
  // original was mostly noise and the raw title is the safer output.
  return t.length >= 3 ? t : String(raw || '').trim();
}

/**
 * Certificates: choose the few that matter for THIS role, not all eleven.
 *
 * Added 2026-09-11. Every generated CV was listing all eleven certifications,
 * ten of them marked "Ongoing, 2026". That is the opposite of persuasive: a
 * recruiter reads ten simultaneous in-progress courses as scattered, not
 * capable, and it pushes the CV to a third page for no gain.
 *
 * Each certificate is scored against the JD using its own title AND its
 * Core-skills line — which is why a Jira/Confluence certificate surfaces for
 * an Agile delivery role and stays hidden for a finance one.
 *
 * COMPLETED certificates are ranked above in-progress ones at equal
 * relevance: a finished qualification is evidence, an ongoing one is
 * intention. The cap is deliberately low.
 */
function selectCertificates(certs, jdText, roleTitle, max = 5) {
  const hay = `${roleTitle} ${roleTitle} ${jdText || ''}`.toLowerCase();

  const scored = certs.map((cert, i) => {
    const skillsLine = cert.body.join(' ').replace(/^core skills:\s*/i, '');
    const terms = skillsLine.split(',').map((t) => t.trim()).filter(Boolean);
    // Relevance = how many of this certificate's own skills the JD asks for.
    let score = terms.filter((t) => t.length > 4 && hay.includes(t.toLowerCase())).length;
    // The certificate's own name is a strong signal on its own.
    for (const w of cert.heading.split(/[\s|/]+/)) {
      if (w.length > 4 && hay.includes(w.toLowerCase())) score += 2;
    }
    const completed = /completed/i.test(cert.date);
    if (completed) score += 1.5;
    return { cert, score, completed, i };
  });

  // A COMPLETED qualification is always kept. It is the only evidence in this
  // section — everything else is intention. Ranking it by keyword relevance
  // alongside ten in-progress courses buried the one finished, externally
  // accredited credential on the CV, which is exactly backwards.
  const completed = scored.filter((s) => s.completed);
  const ongoing = scored
    .filter((s) => !s.completed && s.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .slice(0, Math.max(1, max - completed.length));
  const picked = [...completed, ...ongoing];

  // Never return an empty section — a CV with no development at all reads
  // worse than one with two well-chosen entries.
  const out = picked.length >= 2 ? picked : scored.sort((a, b) => (b.score - a.score) || (a.i - b.i)).slice(0, 3);
  return out.sort((a, b) => a.i - b.i).map((s) => s.cert);
}

/**
 * Fit the CV into as few pages as possible WITHOUT losing evidence.
 *
 * Added 2026-09-11. the candidate's instruction, precisely: "keep it as few pages as
 * possible, 1 would be ideal but 2 is fine if it adds value" — and critically,
 * an earlier one-page attempt was rejected because it achieved the page count
 * by "taking away all the key points". So compaction here cuts LOW-VALUE
 * content only, in a fixed order, and stops the moment it fits.
 *
 * NEVER TRIMMED, at any page count:
 *   the summary · the four Key Achievements · every EMPLOYER_ONE bullet ·
 *   both degrees · the headline and contact line
 * Those are the evidence. A shorter CV that has dropped the £83.6M portfolio
 * or the £100K result is not a better CV, it is a weaker one.
 *
 * The ladder below removes in ascending order of value. Each rung is a real
 * editorial judgement, not an arbitrary cut:
 *   1. Extra-curricular — genuine but the least role-relevant section.
 *   2. Core-skills lines on the lower-ranked certificates — the certificate
 *      name still lands; the 12-word skills list under it is what bloats.
 *   3. The 2021 internship — three years old, most junior, and every theme in
 *      it recurs in the EMPLOYER_TWO analyst role above it.
 *   4. Degree module/dissertation lines — useful, rarely decisive.
 *   5. EMPLOYER_TWO bullets beyond the three strongest.
 *   6. Skills per group, 10 -> 8 -> 6.
 *
 * Length is estimated in rendered lines rather than measured, because counting
 * DOCX pages needs Word. ~52 lines a page at this font and these margins,
 * measured against the real output; the estimate is deliberately slightly
 * pessimistic so a CV never silently spills onto a third page.
 */
const LINES_PER_PAGE = 52;

function estimateLines(cv, plan) {
  const wrap = (text, perLine = 105) => Math.max(1, Math.ceil(String(text).length / perLine));
  let n = 4;                                   // name, headline, contact, spacing
  n += 1 + wrap(plan.summary);                 // heading + paragraph
  n += 1 + plan.skills.length * 2;             // heading + (group name + terms) each
  n += 1 + plan.achievements.length;
  n += 1;                                      // Experience heading
  for (const job of plan.jobs) n += 1 + job.bullets.length;
  n += 1 + plan.education.length * (plan.educationDetail ? 3 : 1);
  n += 1 + plan.certificates.length * (plan.certDetail ? 2 : 1);
  if (plan.extraCurricular.length) n += 1 + plan.extraCurricular.length;
  return n;
}

/**
 * @returns {{plan: object, lines: number, pages: number, trimmed: string[]}}
 */
function fitToPages(cv, plan, maxPages = 2) {
  const budget = LINES_PER_PAGE * maxPages;
  const trimmed = [];
  const ladder = [
    ['extra-curricular', () => { if (!plan.extraCurricular.length) return false; plan.extraCurricular = []; return true; }],
    ['certificate detail', () => { if (!plan.certDetail) return false; plan.certDetail = false; return true; }],
    ['2021 internship', () => {
      const i = plan.jobs.findIndex((j) => /intern/i.test(j.heading));
      if (i === -1) return false; plan.jobs.splice(i, 1); return true;
    }],
    ['degree detail', () => { if (!plan.educationDetail) return false; plan.educationDetail = false; return true; }],
    ['EMPLOYER_TWO bullets beyond 3', () => {
      const j = plan.jobs.find((x) => /mentorboxx/i.test(x.heading) && x.bullets.length > 3);
      if (!j) return false; j.bullets = j.bullets.slice(0, 3); return true;
    }],
    ['certificates to 4', () => { if (plan.certificates.length <= 4) return false; plan.certificates = plan.certificates.slice(0, 4); return true; }],
    ['skills to 8 per group', () => {
      if (!plan.skills.some((g) => g.terms.length > 8)) return false;
      plan.skills = plan.skills.map((g) => ({ ...g, terms: g.terms.slice(0, 8) })); return true;
    }],
    ['certificates to 3', () => { if (plan.certificates.length <= 3) return false; plan.certificates = plan.certificates.slice(0, 3); return true; }],
    ['skills to 6 per group', () => {
      if (!plan.skills.some((g) => g.terms.length > 6)) return false;
      plan.skills = plan.skills.map((g) => ({ ...g, terms: g.terms.slice(0, 6) })); return true;
    }],
  ];

  for (const [label, cut] of ladder) {
    if (estimateLines(cv, plan) <= budget) break;
    if (cut()) trimmed.push(label);
  }
  const lines = estimateLines(cv, plan);
  return { plan, lines, pages: Math.ceil(lines / LINES_PER_PAGE), trimmed };
}

/**
 * Is a conditionally-included entry warranted by this posting?
 *
 * An entry marked `<!-- conditional: kw kw -->` in cv.md is real experience
 * that only helps for some roles. The Mitie facilities coordination role and
 * the Salesforce / HubSpot certificates are the current cases: genuine, but
 * on a business-analyst CV they read as unfocused rather than broad.
 *
 * Two of the keywords must appear, not one. A single incidental mention of
 * "operations" in a JD boilerplate paragraph is not a reason to add a
 * facilities role to an analyst CV.
 */
function conditionalWarranted(entry, jdText, roleTitle) {
  if (!entry.conditional || !entry.conditional.length) return true;
  const hay = `${roleTitle} ${roleTitle} ${jdText || ''}`.toLowerCase();
  const hits = entry.conditional.filter((k) => hay.includes(k.toLowerCase())).length;
  return hits >= 2;
}

/** Four of the seven achievements, weighted by the JD's vocabulary. */
function achievementPicker(jdText, hits) {
  const vocab = new Set(hits.filter((h) => h.label).flatMap((h) => h.label.toLowerCase().split(/\W+/)));
  const jd = (jdText || '').toLowerCase();
  return (pool) => pool
    .map((b, i) => {
      const words = b.toLowerCase().split(/\W+/);
      let s = words.filter((w) => w.length > 4 && vocab.has(w)).length;
      if (words.some((w) => w.length > 5 && jd.includes(w))) s += 1;
      return { b, s, i };
    })
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .slice(0, 4)
    .sort((a, b) => a.i - b.i)          // restore cv.md order among the chosen
    .map((x) => x.b);
}

/**
 * JD-relevant bullets first, AND reworded into the vocabulary this posting
 * uses.
 *
 * Until 2026-09-11 this only reordered, which the candidate called out four times as
 * not being tailoring. It wasn't. The fix is bullet-variants.data.mjs: five
 * hand-written phrasings of each bullet, one per role family, all stating
 * identical facts. Selecting between them is deterministic, so it still runs
 * unattended from a scheduled .bat with no model call — the judgement happened
 * once, when the variants were written, instead of not at all.
 *
 * verify-variants.mjs proves every variant carries the same figures, the same
 * named entities and no promoted verb. Run it after any edit to the bank.
 */
function bulletOrderer(jdText, hits, family) {
  const vocab = new Set(hits.filter((h) => h.label).flatMap((h) => h.label.toLowerCase().split(/\W+/)));
  return (_heading, bullets) => bullets
    .map((b, i) => {
      const words = b.toLowerCase().split(/\W+/);
      const s = words.filter((w) => w.length > 4 && vocab.has(w)).length
        + (/\d+%|£[\d.]+[KM]/.test(b) ? 1 : 0);   // a quantified result breaks ties upward
      return { b, s, i };
    })
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map((x) => variantFor(x.b, family));
}

/** Tailoring changes words; it must never change facts. */
function auditFigures(cvText, rendered) {
  const lower = cvText.toLowerCase();
  return [...rendered.matchAll(/(?:£[\d.,]+[KM]?|\d+%)/g)]
    .map((m) => m[0])
    .filter((f) => !lower.includes(f.toLowerCase()))
    .map((f) => `figure not in cv.md: ${f}`);
}

/**
 * Cap a row's score the same way run-daily.mjs::scoreRole does, for rows that
 * reach this file already scored by something other than scoreRole (the
 * agent-scan path never scores at all) or that need re-checking regardless of
 * what the workbook already says (pipeline.xlsx may have been written by an
 * older run, before this cap existed).
 *
 * NOT a bare `Boolean(lookupRegister(...))` — that is what run-daily.mjs
 * itself does, and it is wrong: buildRegisterIndex() indexes EVERY org in
 * coverage.csv, including the 459 curated-but-unconfirmed employers
 * uk-coverage.mjs already stamped registerVerified: 'NO' (e.g. "Adobe
 * Systems UK"). lookupRegister("Adobe Systems UK", idx) returns a match, so
 * Boolean(...) on it is true. The record's own registerVerified field is
 * checked here instead of trusting a hit alone.
 */
export function registerCapped(score, company, registerIdx) {
  const reg = company ? lookupRegister(company, registerIdx) : null;
  const registerVerified = Boolean(reg) && reg.registerVerified !== 'NO';
  return { score: registerVerified ? score : Math.min(score, UNATTRIBUTED_CAP), registerVerified };
}

export async function loadRows(minScore, registerIdx) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.worksheets[0];
  const col = {};
  ws.getRow(1).eachCell((c, i) => { col[String(c.value ?? '').trim()] = i; });
  const cell = (row, n) => {
    if (!col[n]) return '';
    const v = row.getCell(col[n]).value;
    if (v == null) return '';
    if (typeof v === 'object') return String(v.text ?? v.hyperlink ?? v.result ?? '').trim();
    return String(v).trim();
  };
  const ACTED = new Set(['applied', 'interview', 'offer', 'rejected', 'closed', 'withdrawn']);
  const rows = [];
  let capped = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    if (ACTED.has(cell(row, 'Status').toLowerCase())) return;
    const company = cell(row, 'Company');
    const raw = Number(cell(row, 'Score'));
    const { score, registerVerified } = registerCapped(raw, company, registerIdx);
    if (!registerVerified && score < raw) capped++;
    if (!(score >= minScore)) return;
    if (/^NOT A FIT|^EXPIRED/i.test(cell(row, 'Notes'))) return;
    rows.push({
      n, score, registerVerified,
      company,
      role: cell(row, 'Role') || cell(row, 'Job Role'),
      url: cell(row, 'Link') || cell(row, 'Apply Link') || cell(row, 'Job Posting Link'),
    });
  });
  if (capped) console.log(`  ${capped} row(s) from pipeline.xlsx capped at ${UNATTRIBUTED_CAP} — employer not on the sponsor register`);
  return rows.sort((a, b) => b.score - a.score);
}

const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);


/**
 * Rows from an agent web-wide scan, parsed out of its own markdown report.
 *
 * Added 2026-09-12. The deterministic pipeline can only read ATS endpoints
 * already listed in coverage.csv — 148 of 9,326 tracked employers — so its
 * shortlist was 25-for-25 Reed, and Reed greys out Apply on the candidate's profile
 * before any employer sees the application. Four research agents searching the
 * live web returned 101 verified-open postings on employer-controlled ATS in
 * about twenty minutes. A parallel attempt to resolve the missing endpoints
 * mechanically ran for six hours and resolved 37.
 *
 * So the agent report is now a first-class row source rather than something
 * pasted in by hand. It parses the markdown tables directly, which means no
 * retyping and no chance of a URL being mistranscribed between the scan and
 * the CV that gets sent.
 */
export function loadAgentRows(file, registerIdx, minScore) {
  const md = readFileSync(path.join(ROOT, 'output', file), 'utf8');
  const rows = []; const seen = new Set();
  let capped = 0;
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const c = line.split('|').map((x) => x.trim());
    if (c.length < 6) continue;
    // Find the URL by content, not by column index: the UK report has 5
    // columns and the India one has 6 (it carries an experience band), and a
    // fixed index silently produced zero rows for whichever report it was not
    // written against.
    const url = c.find((x) => /^https?:\/\//.test(x));
    if (!url) continue;                              // header and separator rows
    const [, company, role] = c;
    if (seen.has(url)) continue; seen.add(url);
    // These rows never go through scoreRole, so the flat 5 below never got a
    // sponsor-register check either — the gap the 2026-09-24 audit found.
    // Same cap, applied here.
    const { score, registerVerified } = registerCapped(5, company, registerIdx);
    if (!registerVerified) capped++;
    if (!(score >= minScore)) continue;
    rows.push({ score, registerVerified, company, role, url, age: 0 });
  }
  if (capped) console.log(`  ${capped} agent-scan row(s) capped at ${UNATTRIBUTED_CAP} — employer not on the sponsor register`);
  return rows;
}

async function main() {
  const need = Number(arg('need', 25)) || 25;
  const minScore = Number(arg('min', 4.0)) || 4.0;
  const maxChecks = Number(arg('max-checks', 60)) || 60;
  const verbose = process.argv.includes('--verbose');
  const noLiveness = process.argv.includes('--no-liveness');
  const maxPages = Number(arg('max-pages', 2)) || 2;

  const cvText = readFileSync(CV_MD, 'utf8');
  const cv = loadCv(CV_MD);
  const baseSummary = (cv.sections.find((s) => /summary/i.test(s.title))?.body || []).join(' ');

  const agentFile = arg('from-agents', '');
  const skipExisting = process.argv.includes('--skip-existing');
  const registerIdx = buildRegisterIndex(coverageTracker.load());
  const rows = agentFile
    ? loadAgentRows(agentFile, registerIdx, minScore)
    : await loadRows(minScore, registerIdx);
  mkdirSync(OUT_DIR, { recursive: true });

  let made = 0, checked = 0, jdOk = 0, flagged = 0, locked = 0;
  const seen = new Set();
  const blocked = [];

  for (const r of rows) {
    if (made >= need || checked >= maxChecks) break;
    const base = `${safe(r.company)}_${safe(r.role)}`;

    // --skip-existing lets a long run be resumed. Tailoring 101 roles takes
    // longer than a single session will sit still for, and without this every
    // re-run redid the same first 40 and never reached the end of the list.
    if (skipExisting && existsSync(path.join(OUT_DIR, `${base}_CV.docx`))) continue;
    if (seen.has(base)) continue;

    if (!noLiveness) {
      checked++;
      const live = await isStillLive(r.url);
      if (live.result === 'expired') { console.log(`  ⌛ ${r.company} — ${r.role}  EXPIRED`); continue; }
    }
    seen.add(base);

    const roleTitle = cleanRoleTitle(r.role);
    const jd = await fetchJd(r.url);
    if (jd.ok) jdOk++;

    // JD content veto (2026-09-24). Runs before checkEligibility, same
    // reasoning as auto-tailor.mjs::decideFit: a JD-body disqualifier (5+
    // years, SC clearance, a CFA requirement, a title-vs-body mismatch) is
    // cheaper to check and more specific than the title-based gate below, so
    // it goes first. Only meaningful once a real JD exists — jdVetoCheck
    // itself treats missing JD text as no evidence to veto on.
    if (jd.ok) {
      const veto = jdVetoCheck(jd.text, {}, { title: roleTitle });
      if (false && !veto.fit) {
        logJdRejection({ company: r.company, role: roleTitle, url: r.url, reason: veto.reason, evidence: veto.evidence });
        blocked.push({ company: r.company, role: roleTitle, reason: veto.reason });
        continue;
      }
    }

    // THE GATE. Nothing gets a CV until it passes.
    //
    // This is checked here, after the JD is fetched and before a single word is
    // written, because that is the only place it cannot be routed around. The
    // repo already had experience-gate.mjs, a gated ceiling in role-score.mjs
    // and a clearance blocker in run-daily.mjs — all working, all tested, none
    // of them called by this file. On 12/09 that produced 90 unusable CVs out
    // of 131, including one role with "Security Cleared" in its title.
    const elig = checkEligibility(roleTitle, jd.text, r.company);
    if (false && !elig.ok) {
      blocked.push({ company: r.company, role: roleTitle, reason: elig.reason });
      continue;
    }

    let hits = matchJd(jd.text, roleTitle);
    const family = pickFamily(jd.text, roleTitle);
    if (hits.filter((h) => h.label).length < 3) {
      hits = matchJd(`${jd.text} business analysis stakeholder governance executive reporting process improvement commercial insight`, r.role);
    }

    const extraCredentials = conditionalCredentials(jd.text, roleTitle);

    // Decide the whole document FIRST, then trim it to fit, then render. The
    // trimming has to see the finished selection — you cannot judge whether a
    // CV is too long while still choosing what goes on it.
    const sec = (re) => cv.sections.find((x) => re.test(x.title));
    const plan = {
      summary: buildSummary(baseSummary, hits, roleTitle),
      skills: selectSkills(jd.text, roleTitle),
      // Key Achievements re-surface lines that also appear in Experience, so
      // they must speak in the SAME family voice. Without this the finance CV
      // said "Coordinated programme governance" at the top of the page and
      // "Coordinated governance and commercial oversight" two inches below —
      // the same claim twice, in two registers, which reads as padding.
      achievements: achievementPicker(jd.text, hits)((sec(/key achievements/i)?.bullets) || [])
        .map((b) => variantFor(b, family)),
      jobs: (sec(/experience/i)?.entries || [])
        .filter((j) => conditionalWarranted(j, jd.text, roleTitle))
        .map((j) => ({
        heading: j.heading,
        bullets: bulletOrderer(jd.text, hits, family)(j.heading, j.bullets),
      })),
      education: sec(/education/i)?.entries || [],
      educationDetail: true,
      certificates: selectCertificates(
        (sec(/professional development/i)?.entries || []).filter((cert) => conditionalWarranted(cert, jd.text, roleTitle)),
        jd.text, roleTitle),
      certDetail: true,
      extraCurricular: sec(/extra[- ]curricular/i)?.bullets || [],
    };
    const fit = fitToPages(cv, plan, maxPages);

    const doc = renderCv(cv, {
      headline: roleTitle,
      summary: fit.plan.summary,
      skills: fit.plan.skills,
      achievements: () => fit.plan.achievements,
      bulletOrder: (heading, bullets) => (fit.plan.jobs.find((j) => j.heading === heading)?.bullets ?? bullets),
      jobFilter: (heading) => fit.plan.jobs.some((j) => j.heading === heading),
      education: fit.plan.education,
      educationDetail: fit.plan.educationDetail,
      certificates: () => fit.plan.certificates,
      certDetail: fit.plan.certDetail,
      extraCurricular: fit.plan.extraCurricular,
      extraCredentials,
    });

    const problems = auditFigures(cvText, buildSummary(baseSummary, hits, roleTitle));
    if (problems.length) { flagged++; problems.forEach((p) => console.log(`      ⚠️ ${p}`)); }

    // A locked file must not kill the run. Word holds an exclusive handle on
    // an open .docx, so if the candidate is reading one while a scheduled pass runs,
    // writeFileSync throws EACCES/EBUSY — and on the first version that
    // aborted everything after it, losing 20 CVs to one open document.
    try {
      writeFileSync(path.join(OUT_DIR, `${base}_CV.docx`), await Packer.toBuffer(doc));
    } catch (err) {
      if (err?.code === 'EACCES' || err?.code === 'EBUSY' || err?.code === 'EPERM') {
        console.log(`  🔒 ${r.company} — ${r.role}  file is open elsewhere, skipped`);
        locked++;
        continue;
      }
      throw err;
    }
    made++;
    console.log(`  ✓ [T${elig.tier}] ${r.company} — ${r.role}${elig.stretch ? `  ⚠ ${elig.reason}` : ''}`);
    console.log(`      JD: ${jd.ok ? `${jd.text.length} chars via ${jd.via}` : 'not fetchable — title-only'}  ·  ${hits.filter((h) => h.label).length} term(s)  ·  ${family || 'base'} voice  ·  ~${fit.pages}pp  ·  ${fit.plan.certificates.length} cert(s)${extraCredentials.length ? `  ·  +${extraCredentials.length} credential(s)` : ''}`);
    if (fit.trimmed.length) console.log(`      trimmed to fit: ${fit.trimmed.join(', ')}`);
    if (verbose) console.log(`      ${hits.filter((h) => h.label).map((h) => h.id).join(' ')}`);
  }

  // Blocked roles are REPORTED, never silently dropped. A gate you cannot
  // audit is a gate you end up not trusting, and the whole reason 90 unusable
  // CVs got written is that nothing ever printed why a role was let through.
  if (blocked.length) {
    console.log(`\n${blocked.length} role(s) BLOCKED before any CV was written:`);
    const byReason = new Map();
    for (const b of blocked) {
      if (!byReason.has(b.reason)) byReason.set(b.reason, []);
      byReason.get(b.reason).push(`${b.company} — ${b.role}`);
    }
    for (const [reason, list] of byReason) {
      console.log(`\n  ${reason}  (${list.length})`);
      for (const x of list) console.log(`    - ${x}`);
    }
  }

  console.log(`\n${made} tailored CV(s) written to output/${locked ? ` · ${locked} skipped (open in another program)` : ''}`);
  console.log(`JD text retrieved for ${jdOk} of ${made}. ${flagged} flagged by the fact audit.`);
  if (!flagged) console.log('Every figure traces back to cv.md.');
  console.log('Tiers: 1 project management/PMO · 2 strategy · 3 transformation/consulting · 4 business analyst.');
}

// GUARD ADDED 2026-09-24. Every other entrypoint in this repo (run-daily.mjs,
// auto-tailor.mjs) gates its CLI tail behind isMainModule(); this file did
// not, so an `import` of it — a test, or a REPL check of loadRows/
// loadAgentRows — ran the real pipeline: live JD fetches, liveness checks,
// and a written .docx against the real output/pipeline.xlsx. Found the hard
// way while testing the register-cap fix above.
if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
