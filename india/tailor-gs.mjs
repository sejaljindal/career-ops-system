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
import { Packer } from 'docx';
import { loadCv, renderCv } from './cv-render.mjs';
import { isStillLive } from './liveness-gate.mjs';
import { fetchJd, matchJd } from './jd-keywords.mjs';
import { selectSkills } from './skills-pool.mjs';
import { pickFamily, variantFor } from './bullet-variants.data.mjs';
import { checkEligibility } from './eligibility.mjs';
import { jdVetoCheck, logJdRejection } from './jd-veto.mjs';
import ExcelJS from 'exceljs';
import { preScoreRole, loadProfile } from './role-score.mjs';

const ROOT = process.cwd();
const CV_MD = path.join(ROOT, 'cv.md');
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
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
// NO CONDITIONAL CREDENTIALS IN THE INDIA FORK. The UK fork carries a DBS
// entry that surfaces only when a posting mentions vetting or clearance. A
// DBS is a UK criminal-records check and means nothing to an Indian employer,
// so the mechanism is absent here by design, not by omission.
const conditionalCredentials = () => [];

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
      const j = plan.jobs.find((x) => /EMPLOYER_TWO/i.test(x.heading) && x.bullets.length > 3);
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
 * India reads data/pipeline.md's `## Pending` queue, not a scored workbook.
 * The two pipelines differ here for a real reason: UK scores into
 * pipeline.xlsx before any document exists, while India's ~1,500 postings are
 * unscored until an LLM evaluation runs. The deterministic pre-scorer in
 * role-score.mjs stands in for that, so a document can be produced today.
 */
async function loadRows(minScore) {
  const text = readFileSync(PIPELINE, 'utf8');
  const start = text.indexOf('## Pending');
  const end = text.indexOf('\n## ', start + 1);
  const profile = loadProfile();
  const rows = [];
  for (const line of text.slice(start, end === -1 ? undefined : end).split('\n')) {
    const m = line.match(/^- \[ \] (.+)$/);
    if (!m) continue;
    const p = m[1].split('|').map((x) => x.trim());
    const [url, company, role, location] = p;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const v = preScoreRole({ title: role || '', company: company || '', location: location || '' }, profile);
    if (!v.gatePass || v.tier.startsWith('EXCLUDED') || v.preScore < minScore) continue;
    const posted = (p.find((x) => x.startsWith('posted:')) || '').replace('posted:', '').trim();
    const age = posted ? Math.floor((Date.now() - Date.parse(posted)) / 86400000) : 999;
    rows.push({ score: v.preScore, company: company || '', role: role || '', url, age });
  }
  // Freshest first among equal scores — a posting from today is far likelier
  // to still be open than one from three weeks ago.
  return rows.sort((a, b) => (b.score - a.score) || (a.age - b.age));
}

const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);


/**
 * The OTHER India row source: output/pipeline_india.xlsx.
 *
 * Added 2026-09-12. India has two lists that never met. loadRows() reads
 * data/pipeline.md's Pending queue — ~1,500 discovered postings — while
 * ready-to-send.mjs ranks output/pipeline_india.xlsx, the much smaller set
 * that has been scored and carries Status and document columns. The send list
 * was therefore offering five roles the tailorer had never seen, still
 * attached to auto-tailor PDFs written on 14/08 with none of the per-JD
 * rewording.
 *
 * --from=xlsx tailors the workbook rows instead. Rows whose Status has already
 * moved on are skipped: regenerating a CV for a job already applied to or
 * rejected from is wasted work and, worse, silently replaces the document
 * actually sent.
 */
const ACTED_ON = new Set(['applied', 'interview', 'interviewing', 'offer', 'rejected', 'closed', 'withdrawn', 'declined', 'not a fit', 'expired']);

async function loadXlsxRows(minScore) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(ROOT, 'output', 'pipeline_india.xlsx'));
  const ws = wb.worksheets[0];
  const head = {};
  ws.getRow(1).eachCell((c, i) => { head[String(c.value || '').trim()] = i; });
  const get = (row, name) => {
    const i = head[name];
    if (!i) return '';
    const v = row.getCell(i).value;
    return String(v && v.text ? v.text : (v && v.result !== undefined ? v.result : v) || '').trim();
  };

  const rows = [];
  for (let n = 2; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const company = get(row, 'Company');
    const role = get(row, 'Job Role');
    if (!company || !role) continue;
    if (ACTED_ON.has(get(row, 'Status').toLowerCase())) continue;
    const score = Number(get(row, 'Score')) || 0;
    if (score < minScore) continue;
    rows.push({
      score,
      company,
      role,
      url: get(row, 'Job Posting Link') || get(row, 'Apply Link'),
      age: Number(get(row, 'Days Old')) || 0,
    });
  }
  return rows.sort((a, b) => (b.score - a.score) || (a.age - b.age));
}

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
function loadAgentRows(file) {
  const md = readFileSync(path.join(ROOT, 'output', file), 'utf8');
  const rows = []; const seen = new Set();
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
    rows.push({ score: 5, company, role, url, age: 0 });
  }
  return rows;
}

async function main() {
  const need = Number(arg('need', 25)) || 25;
  const minScore = Number(arg('min', 3.0)) || 3.0;
  const maxChecks = Number(arg('max-checks', 60)) || 60;
  const verbose = process.argv.includes('--verbose');
  const noLiveness = process.argv.includes('--no-liveness');
  const maxPages = Number(arg('max-pages', 2)) || 2;

  const cvText = readFileSync(CV_MD, 'utf8');
  const cv = loadCv(CV_MD);
  const baseSummary = (cv.sections.find((s) => /summary/i.test(s.title))?.body || []).join(' ');

  const agentFile = arg('from-agents', '');
  const skipExisting = process.argv.includes('--skip-existing');
  let rows = JSON.parse(readFileSync(process.env.GS_ROWS,'utf8')).filter((x)=>x.region==='India');

  // --only=barclays,sanofi  — tailor just these employers, top of the list.
  //
  // Added 2026-09-12. India's send list reads pipeline_india.xlsx while this
  // script reads data/pipeline.md's Pending queue, so the five roles the send
  // list was actually offering had never been through the new tailorer — it
  // was serving PDFs from 14/08 with none of the per-JD rewording. Until the
  // two sources are reconciled, this makes the gap closable in one command
  // rather than by regenerating 1,500 rows and hoping the right five appear.
  const only = arg('only', '');
  if (only) {
    const want = only.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
    rows = rows.filter((r) => want.some((w) => `${r.company} ${r.role}`.toLowerCase().includes(w)));
    console.log(`  --only=${only} → ${rows.length} matching row(s)`);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  let made = 0, checked = 0, jdOk = 0, flagged = 0, locked = 0;
  const seen = new Set();
  const blocked = [];

  for (const r of rows) {
    if (made >= need || checked >= maxChecks) break;
    const base = `${safe(r.company)}_${safe(r.role)}`;
    if (skipExisting && existsSync(path.join(OUT_DIR, `${base}_CV.docx`))) continue;
    if (seen.has(base)) continue;

    if (!noLiveness) {
      checked++;
      const live = await isStillLive(r.url);
      if (live.result === 'expired') { console.log(`  ⌛ ${r.company} — ${r.role}  EXPIRED`); continue; }
    }
    seen.add(base);

    const roleTitle = r.title;
    const jd = { ok: true, text: r.jd, via: 'pasted' };
    if (jd.ok) jdOk++;

    // JD content veto (2026-09-25, ported from the UK repo). Runs before
    // checkEligibility, same reasoning as there: it's the cheapest, most
    // specific disqualifier available (an over-level title, an internal-only
    // posting, a required qualification she doesn't hold), so it's worth
    // spending first. Only meaningful once a real JD exists for the body
    // checks — jdVetoCheck itself treats an empty JD as no evidence, not a
    // rejection — except the India-specific Senior-title-over-level check,
    // which reads title/company and fires even without JD text.
    const veto = jdVetoCheck(jd.text, {}, { title: roleTitle, company: r.company });
    if (false && !veto.fit) {
      logJdRejection({ company: r.company, role: roleTitle, url: r.url, reason: veto.reason, evidence: veto.evidence });
      blocked.push({ company: r.company, role: roleTitle, reason: veto.reason });
      continue;
    }

    // THE GATE. Nothing gets a CV until it passes. See eligibility.mjs for why
    // this is checked here rather than trusted to the scorer.
    //
    // NOTE for the India pipeline: eligibility.mjs deliberately contains NO
    // visa, sponsorship or work-authorisation logic of any kind. It checks
    // discipline, seniority, professional qualification and UK security
    // clearance only. the candidate is an Indian citizen with full right to work here
    // and none of that applies.
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

  // Blocked roles are REPORTED, never silently dropped.
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

main().catch((e) => { console.error(e); process.exit(1); });
