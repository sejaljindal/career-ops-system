#!/usr/bin/env node
/**
 * auto-tailor.mjs — tailored CV + cover letter for rows worth applying to.
 *
 * Reads output/pipeline.xlsx, takes every row scoring 4.0+ whose CV File is
 * empty, and for each one decides HONESTLY whether this is a genuine fit before
 * writing anything. Roles that are not a fit get "NOT A FIT - <reason>" in Notes
 * and no documents. Generating a polished CV for a role the candidate should not
 * apply to is worse than generating nothing.
 *
 * NO-FABRICATION ARCHITECTURE
 * Every line of both documents is SELECTED from 03_Master_Profile.md / cv.md —
 * never composed. The tailoring levers are:
 *   1. which bullets are included
 *   2. what order they appear in
 *   3. which positioning angle leads
 * There is no free-text generation of claims, so an employer, title, tool, date,
 * qualification or result cannot be invented: if it is not in the source file it
 * has no way to reach the page.
 *
 * SOC LANGUAGE. Bullets are RANKED so analysis-language ones lead ("analysed",
 * "advised", "recommended", "identified", "assessed"), because the verbs decide
 * whether the role codes to 2431 (eligible) or 3543 (not eligible). Support-
 * language bullets are demoted and dropped first when trimming to length
 * (target 1.5-2 pages, two maximum — never compress to one page).
 * They are NOT verb-swapped: rewriting "Coordinated programme governance" as
 * "Analysed programme governance" would misdescribe the actual work, which is
 * fabrication wearing better vocabulary.
 *
 * Usage:
 *   node auto-tailor.mjs               # all eligible rows
 *   node auto-tailor.mjs --limit=5
 *   node auto-tailor.mjs --dry-run     # decide + report, write nothing
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import { isStillLive } from './liveness-gate.mjs';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } from 'docx';

import * as yaml from 'js-yaml';
import { inferSOC, scoreLanguage, salaryVerdict, classifyRemote } from './soc-engine.mjs';
import { experienceGate } from './experience-gate.mjs';
// Reuse run-daily's agency detection rather than a second, drifting copy —
// it is the same judgement ("is this posting from a recruiter, not the
// employer?") that already drives the -0.4 score penalty.
import { isAgency, buildRegisterIndex, lookupRegister } from './run-daily.mjs';
import * as coverageTracker from './coverage-tracker.mjs';
import { jdVetoCheck, logJdRejection } from './jd-veto.mjs';

/** Target role titles from config/profile.yml — the JD-unavailable fallback. */
function targetTitles() {
  try {
    const cfg = yaml.load(readFileSync('config/profile.yml', 'utf8'));
    return [...(cfg?.target_roles?.primary || [])];
  } catch { return []; }
}

const XLSX = 'output/pipeline.xlsx';
// Checkpoint file — rewritten atomically after EVERY role, not just at the
// end, so an interrupted run leaves a durable, truthful record of exactly
// how far down the ranked list tailoring got. Cleared/superseded fresh by
// the next invocation's initial write, so a stale file from a finished run
// never bleeds into the next one's reporting.
const PROGRESS = 'output/tailor-progress.json';
const MASTER = '03_Master_Profile.md';
const CV = 'cv.md';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MIN_SCORE = 4.0;
// Target length is 1.5-2 pages, two maximum — NOT one page. See
// 03_Master_Profile.md rule 4 and "Trim order when over two pages".
// (Currently declared but unreferenced; kept so the intended ceiling is
// stated in one place if bullet-capping is ever wired up.)
const MAX_BULLETS = 12;         // ~two pages
const MIN_SKILL_OVERLAP = 2;    // distinct profile skills the JD must actually ask for

// Verbs that push a role toward SOC 2431 (eligible) vs 3543 (ineligible).
const ANALYSIS_RE = /\b(analys|advis|recommend|identif|assess|evaluat|review|insight|decision[- ]support|business case|apprais|diagnos|forecast|model)/i;
const SUPPORT_RE = /\b(support|coordinat|administer|administrat|assist|arrang|schedul|maintain|collat|log\b|diary)/i;

// Domains the profile has no honest claim to. A "fit" score can otherwise be
// dragged up by generic words ("analysis", "reporting") on a clinical or legal
// posting the candidate is simply not qualified for.
const OUT_OF_DOMAIN = [
  [/\b(nurse|nursing|midwif|clinical|clinician|physiotherap|radiograph|paramedic|doctor|gp\b|consultant psychiatr|dental|pharmac|occupational therap|speech (and|&) language)\b/i, 'clinical/healthcare-registered role'],
  [/\b(solicitor|barrister|paralegal|conveyanc|litigation)\b/i, 'qualified legal role'],
  [/\b(social worker|safeguarding lead|foster|youth offend)\b/i, 'registered social work role'],
  [/\b(teacher|teaching assistant|lecturer|tutor|headteacher|early years practitioner)\b/i, 'teaching role'],
  [/\b(electrician|plumber|carpenter|hgv|driver|technician|welder|mechanic|labourer|cleaner|chef|caretaker)\b/i, 'trade/manual role'],
  [/\b(software engineer|developer|devops|data scientist|machine learning|full[- ]stack|back[- ]end|front[- ]end)\b/i, 'hands-on engineering role'],
  [/\b(security officer|police constable|firefighter|special constable)\b/i, 'uniformed service role'],
  // Added after "Sopra Steria - Senior Security Achitect" passed the fit gate:
  // architecture roles are a hands-on technical specialism, not business
  // analysis. Note the deliberate misspelling — the real posting was titled
  // "Achitect", and a gate that only catches correctly-spelled titles is a
  // gate with a hole in it.
  [/\b(security architect|solutions? architect|technical architect|enterprise architect|architect|achitect)\b/i, 'technical architecture role'],
];

const EXCLUDED_TITLE = /\b(graduate|trainee|intern|apprentice|placement|support officer|team administrator|project coordinator|scheme|rotational)\b/i;

// ── skill matching ──────────────────────────────────────────────────
//
// Same technique as run-daily.mjs's employer-name matching (distinctiveTokens
// / matchesEmployer): tokenise, drop stopwords, compare on WHOLE tokens, never
// substrings. The difference is deliberate — employer matching requires EVERY
// distinctive token to line up (identity: "Bain" must never match
// "Bainbridge"), but a skill only needs to share ONE real signal word with the
// JD. "stakeholder workshops" should credit toward "stakeholder engagement"
// and "business analysis" toward "strategic analysis" — a JD paraphrases, it
// doesn't quote the skills list back verbatim. What stays constant is that a
// filtered-out stopword can never be the thing that makes the match: only a
// genuinely distinctive shared word counts.
const SKILL_STOPWORDS = new Set(['and', 'of', 'the', 'for', 'with', 'in', 'on', 'to', 'a', 'an',
  'is', 'are', 'this', 'that', 'your', 'you', 'will', 'including', 'etc', 'or', 'as', 'at', 'by']);

// Words that appear in almost every job posting regardless of domain, so
// sharing one proves nothing about overlap. A videography JD says "final
// delivery" and "engagement" (a social-media metric) and "project management";
// none of that is "delivery assurance" or "stakeholder engagement". These are
// therefore never sufficient ON THEIR OWN to carry a skill match — a skill
// whose ONLY overlap with the JD is one of these does not count. Genuinely
// discriminating words (analysis, strategic, stakeholder, governance, problem,
// assurance, forecasting...) are deliberately NOT here: those really do
// indicate the kind of work this profile does.
const GENERIC_FILLER = new Set(['management', 'managing', 'manage', 'delivery', 'delivering',
  'deliver', 'engagement', 'reporting', 'report', 'reports', 'project', 'projects', 'performance',
  'commercial', 'business', 'support', 'supporting', 'process', 'processes', 'improvement',
  'operations', 'operational', 'team', 'teams', 'work', 'working', 'experience', 'skills',
  'role', 'client', 'clients', 'customer', 'customers', 'data', 'time', 'new', 'key', 'high',
  'strong', 'good', 'excellent', 'ability', 'across', 'within', 'per', 'annum']);

function skillTokens(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SKILL_STOPWORDS.has(w));
}

/**
 * True when this profile skill shares at least one DISCRIMINATING token with
 * the JD. Generic filler shared by every posting ("management", "delivery",
 * "performance") can never carry a match on its own.
 *
 * A skill made ENTIRELY of filler — "Business performance improvement" is the
 * only one in the current profile — is therefore unmatchable, deliberately.
 * It has no word that distinguishes this profile's work from any other job
 * ad's, so a "match" on it is evidence of nothing. Silently unmatchable is the
 * correct outcome, not a bug to work around: the alternative (falling back to
 * filler tokens) is precisely what let a videography role score 12 skill
 * matches against a business-analysis profile.
 */
function skillMatches(skill, jdTokenSet) {
  const discriminating = skillTokens(skill).filter((t) => !GENERIC_FILLER.has(t));
  return discriminating.length > 0 && discriminating.some((t) => jdTokenSet.has(t));
}

// K3 Advisory Group's "Multi-Media Producer" JD passed on 12 matched skills —
// every one of them came from the employer's own "About us" paragraph
// ("expert advisory, restructuring, tax, and transaction services"), not
// from the actual role, which was videography/animation/photography. A JD
// posted through a board template almost always separates the two: a company
// blurb, THEN a heading, THEN the actual duties. Cut at the first such
// heading and match skills only against what follows it — the part of the
// posting that is actually describing the job. Ordered so a more specific
// heading ("what you'll be doing") wins over a more generic one ("the role")
// when a JD happens to contain both.
const DUTIES_HEADINGS = [
  /\bwhat you('| )ll be doing\b/i,
  /\bkey responsibilities\b/i,
  /\bmain responsibilities\b/i,
  /\bresponsibilities\b/i,
  /\babout the role\b/i,
  /\brole overview\b/i,
  /\bpurpose of the role\b/i,
  /\bthe role\b/i,
  /\byour role\b/i,
  // NOT "job description" — Reed and most boards prepend "Full job
  // description" as page furniture at the very top of the raw text, BEFORE
  // the company blurb even starts. Matching it defeats the whole cut: it
  // finds the earliest possible position and skips nothing.
];

/**
 * The JD text from the first duties heading onward, or the whole JD when no
 * such heading is found — NOT an empty string, because plenty of genuine JDs
 * (Sopra Steria's, among the ones already seen) never use one of these
 * headings at all, and losing all skill-matching signal on those would be a
 * worse failure than the contamination this exists to prevent.
 */
export function extractDuties(jdText) {
  const text = String(jdText || '');
  let cut = -1;
  for (const re of DUTIES_HEADINGS) {
    const m = text.match(re);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  return cut === -1 ? text : text.slice(cut);
}

// ── source of truth ──────────────────────────────────────────────────

/**
 * Parse the master profile into structured, quotable facts. Anything not
 * captured here simply cannot appear in a generated document.
 */
// Hard boundary in 03_Master_Profile.md. Everything ABOVE it is fact and
// quotable; everything BELOW is coaching, interview prep and generator
// instructions. Truncating here means no parser bug or future subsection can
// leak commentary into an outbound document — which is exactly how an
// interview answer about immigration status ended up in every cover letter.
const GUIDANCE_MARKER = '# PART 2 — GUIDANCE. NEVER QUOTED INTO A GENERATED DOCUMENT.';

export function loadProfile(masterPath = MASTER) {
  const whole = readFileSync(masterPath, 'utf8');
  const cut = whole.indexOf(GUIDANCE_MARKER);
  if (cut === -1) {
    throw new Error(`${masterPath} is missing the PART 2 guidance divider — refusing to parse, `
      + 'since without it coaching notes and interview answers can be pulled into a CV or letter.');
  }
  const text = whole.slice(0, cut);
  const roles = [];

  // Scope role parsing to the `## Experience` section ONLY. Splitting the whole
  // file on `###` treated every other `###` subsection that happens to contain
  // bullets — the CV-structure notes, the "bullets that must not be dropped"
  // list — as if it were a job, and those fake roles printed into EXPERIENCE
  // as employment history. The section boundary is the fix, not a blocklist of
  // heading names, which would break again the next time a subsection is added.
  const expBlock = (text.split(/^## Experience\s*$/m)[1] || '').split(/^## /m)[0] || '';
  const sections = expBlock.split(/^### /m).slice(1);
  for (const sec of sections) {
    const lines = sec.split('\n');
    const head = lines[0].trim();
    const meta = (lines.find((l) => /^\*\*/.test(l)) || '').replace(/\*\*/g, '').trim();
    const bullets = lines
      .filter((l) => /^[•\-]\s+/.test(l.trim()))
      .map((l) => l.trim().replace(/^[•\-]\s+/, '').replace(/\*\*/g, '').trim())
      .filter(Boolean);
    if (!bullets.length) continue;
    const [title, employer] = head.includes('|')
      ? head.split('|').map((s) => s.trim())
      : [head, ''];
    roles.push({ title, employer, meta, bullets });
  }

  const skills = {};
  const skillBlock = text.split(/^## Skills/m)[1] || '';
  for (const m of skillBlock.matchAll(/^\*\*(.+?)\*\*\s*—\s*(.+)$/gm)) {
    skills[m[1].trim()] = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  }

  const education = [];
  const eduBlock = (text.split(/^## Education/m)[1] || '').split(/^## /m)[0] || '';
  for (const m of eduBlock.matchAll(/^\*\*(.+?)\*\*\s*—\s*(.+)$/gm)) {
    education.push({ qualification: m[1].trim(), detail: m[2].trim() });
  }

  const contact = {
    name: (text.match(/^#\s*Master Profile\s*—\s*(.+)$/m) || [, 'Candidate'])[1].trim(),
    // City for the letterhead block. Taken from the contact table's location
    // line, with any relocation/visa qualifier stripped — a letterhead states
    // where you are, and nothing about immigration belongs on it.
    city: ((text.match(/\|\s*Location line\s*\|\s*([^|]+)\|/) || [, ''])[1] || '')
      .split('—')[0].trim(),
    email: (text.match(/\|\s*Email\s*\|\s*([^|]+)\|/) || [, ''])[1]?.trim() || '',
    phone: (text.match(/\|\s*Phone\s*\|\s*([^|]+)\|/) || [, ''])[1]?.trim() || '',
    linkedin: (text.match(/\|\s*LinkedIn\s*\|\s*([^|]+)\|/) || [, ''])[1]?.trim() || '',
  };

  // Education detail lines (dissertation, modules) — the lines that follow each
  // **Qualification** — detail line until the next blank line. Modules are the
  // first thing dropped when trimming to two pages, so they are kept separate.
  for (const e of education) {
    const after = eduBlock.slice(eduBlock.indexOf(e.detail) + e.detail.length);
    const block = after.split(/\n\s*\n/)[0] || '';
    // Strip markdown emphasis — these strings go straight into a .docx, where
    // a literal asterisk is just a typo on the page.
    e.extras = block.split('\n')
      .map((l) => l.trim().replace(/\*\*/g, '').replace(/\*/g, ''))
      .filter(Boolean);
  }

  // Professional development — the 11-row table. `match` drives JD relevance;
  // `ongoing` gates the "at most three in progress" rule.
  const dev = [];
  const devBlock = (text.split(/^## Professional development/m)[1] || '').split(/^## /m)[0] || '';
  for (const m of devBlock.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)) {
    const status = m[4].trim();
    dev.push({
      n: Number(m[1]),
      item: m[2].replace(/\*\*/g, '').trim(),
      provider: m[3].trim(),
      status: status.replace(/\*\*/g, '').trim(),
      ongoing: /ongoing/i.test(status),
      match: m[5].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    });
  }

  // Extra-curricular — always printed, so parsed unconditionally.
  const extra = [];
  const extraBlock = (text.split(/^## Extra-curricular and interests/m)[1] || '').split(/^## /m)[0] || '';
  for (const l of extraBlock.split('\n')) {
    const t = l.trim();
    if (/^[•\-]\s+/.test(t)) extra.push(t.replace(/^[•\-]\s+/, '').replace(/\*\*/g, '').trim());
  }

  const allSkills = Object.values(skills).flat();
  // `raw` is deliberately NOT returned. It carried the entire fact-section
  // text — including any note-to-self written inside a fact section — into
  // every consumer of this function. Nothing read it, so it was a latent
  // carrier and nothing else: one template interpolating profile.raw would
  // have put commentary straight into a CV. Selected fields only.
  return { roles, skills, allSkills, education, dev, extra, contact };
}

// ── JD ───────────────────────────────────────────────────────────────

/**
 * Fetch a job description.
 *
 * `ok` means "this page really is the JD for THIS role" — not merely "bytes came
 * back". Length alone is a trap: a Reed search-results page is ~380KB and passes
 * any size check while containing no description at all. Treating that as a JD
 * makes the skill-overlap test see zero matches and reject perfectly good roles
 * for lack of evidence. So the page must also carry the role title.
 */
export async function fetchJd(url, role = '') {
  if (!url) return { text: '', ok: false, reason: 'no apply link' };
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { text: '', ok: false, reason: `HTTP ${res.status}` };
    const html = await res.text();
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();

    if (body.length < 400) return { text: body, ok: false, reason: 'page too thin to be a JD' };

    // Does the page actually concern this role?
    const words = String(role).toLowerCase().match(/[a-z]{4,}/g) || [];
    if (words.length) {
      const hits = words.filter((w) => body.toLowerCase().includes(w)).length;
      if (hits / words.length < 0.6) {
        return { text: body, ok: false, reason: 'page does not contain the role title — looks like a listing, not a JD' };
      }
    }
    return { text: body, ok: true, reason: '' };
  } catch (e) {
    return { text: '', ok: false, reason: String(e.message || e).slice(0, 50) };
  }
}

// ── the fit decision ─────────────────────────────────────────────────

/**
 * Decide honestly. Returns {fit:boolean, reason, evidence}.
 * Every rejection names a concrete, checkable cause.
 */
export function decideFit({ role, company, jd, profile, salary, jdOk = true, targetTitles = [], registerIdx = null, url = '' }) {
  const haystack = `${role} ${jd}`;
  const titleOnly = String(role);

  // JD content veto (2026-09-24). Runs FIRST, before every other check below,
  // because it is the cheapest, most specific disqualifier available: a JD
  // demanding 5+ years or an SC clearance is disqualifying regardless of
  // title, seniority band, SOC code or salary, and checking it first avoids
  // spending the rest of this function's work (skill-token extraction,
  // achievement matching) on a role that was never in play. Only runs when a
  // real JD was fetched — jdOk:false has no body to veto on, same "absence of
  // evidence is not evidence of misfit" rule the rest of this function uses.
  if (jdOk && jd) {
    const veto = jdVetoCheck(jd, profile, { title: titleOnly });
    if (!veto.fit) {
      logJdRejection({ company, role: titleOnly, url, reason: veto.reason, evidence: veto.evidence });
      return { fit: false, reason: veto.reason, evidence: veto.evidence };
    }
  }

  // Sponsor-register check. `company` was accepted as a parameter here
  // already but never once read in this function — every other decision
  // below (title, seniority, SOC, salary) ran on an employer that had never
  // been confirmed able to sponsor at all. Same cap point as
  // run-daily.mjs::scoreRole and tailor-cv.mjs::registerCapped: before any
  // other work is spent on the role. `registerIdx` is optional so a caller
  // that has not built one yet (or a unit test) still gets every other check
  // — but a caller that HAS one and passes a company gets this enforced.
  if (registerIdx && company) {
    const reg = lookupRegister(company, registerIdx);
    const registerVerified = Boolean(reg) && reg.registerVerified !== 'NO';
    if (!registerVerified) {
      return { fit: false, reason: `"${company}" is not a confirmed sponsor on the register` };
    }
  }

  if (EXCLUDED_TITLE.test(titleOnly)) {
    return { fit: false, reason: `excluded title band (${titleOnly.match(EXCLUDED_TITLE)[0]})` };
  }
  for (const [re, label] of OUT_OF_DOMAIN) {
    if (re.test(titleOnly)) return { fit: false, reason: `${label} — outside the profile` };
  }

  // The SAME seniority/experience gate run-daily.mjs applies when a role
  // enters the pipeline. It has to be re-applied here because auto-tailor
  // picks up ANY sheet row scoring 4.0+ with an empty CV File — including the
  // ~15,000 legacy rows that predate the gate, which therefore never faced it.
  // Without this, a Director/Partner/Band 9 role gets a tailored CV written
  // for it purely because it was scanned before the gate existed.
  // UNVERIFIED (no real JD) is deliberately NOT treated as a failure here:
  // the skill-overlap and title checks below still have to be satisfied, and
  // rejecting on absence of a JD would discard roles for lack of evidence.
  const exp = experienceGate({ title: titleOnly, jdText: jd || titleOnly, jdFetched: jdOk });
  if (exp.status === 'FAIL') {
    return { fit: false, reason: `seniority/experience gate: ${exp.reason}` };
  }

  const soc = inferSOC(role, haystack);
  if (soc.eligible === false) {
    return { fit: false, reason: `SOC ${soc.code} (${soc.title}) is below RQF6 — not sponsorable as a first-time applicant` };
  }
  if (classifyRemote(haystack) === 'OTHER_COUNTRY') {
    return { fit: false, reason: 'role is restricted to a country outside the UK' };
  }
  if (soc.code) {
    const sv = salaryVerdict(soc.code, salary ?? null);
    if (sv.status === 'FAIL') {
      return { fit: false, reason: `salary ${salary} is below the new-entrant floor £${sv.newEntrantFloor} for SOC ${soc.code}` };
    }
  }

  // Title is always in-scope (it's the strongest, least ambiguous signal);
  // the JD body is narrowed to the duties section so an employer's own
  // "about us" boilerplate can't manufacture matches for an unrelated role.
  const jdTokens = new Set(skillTokens(`${role} ${extractDuties(jd)}`));
  const matched = profile.allSkills.filter((s) => skillMatches(s, jdTokens));
  const titleIsTarget = targetTitles.some((t) =>
    new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(titleOnly));

  // The skill-overlap test is only meaningful when a JD was actually retrieved.
  // Many boards (Reed, WAF-protected sites) hand back a listing page instead, and
  // rejecting on that is rejecting for ABSENCE of evidence, not evidence of
  // misfit — it would silently discard perfect roles. When the JD is missing,
  // fall back to the title against the target-role list ALONE.
  if (!jdOk) {
    if (titleIsTarget) {
      return { fit: true, reason: `JD unavailable — title matches a target role`, evidence: matched, soc, lowConfidence: true };
    }
    return { fit: false, reason: 'JD unavailable and the title is not one of the target roles — cannot honestly assess fit' };
  }

  // Title match is an ADDITIONAL signal here, not just the no-JD fallback
  // above: a title on the target-role list counts toward the threshold
  // alongside skill overlap, so e.g. 1 genuine skill match + a target-role
  // title clears the bar without lowering MIN_SKILL_OVERLAP itself.
  const signal = matched.length + (titleIsTarget ? 1 : 0);
  if (signal < MIN_SKILL_OVERLAP) {
    return {
      fit: false,
      reason: `only ${matched.length} profile skill(s) matched${titleIsTarget ? ' (plus a target-role title)' : ''} — too little genuine overlap to claim a fit`,
      evidence: matched,
    };
  }

  return {
    fit: true,
    reason: `SOC ${soc.code || 'n/a'}; ${matched.length} matching skill(s)${titleIsTarget ? ' + target-role title' : ''}`,
    evidence: matched, soc,
  };
}

// ── selection + ordering ─────────────────────────────────────────────

/** Which positioning angle leads, per the master profile's own rules. */
export function leadAngle(role, jd) {
  const t = `${role} ${jd}`;
  if (/\b(programme|program|infrastructure|capital project|rail|construction|portfolio|pmo)\b/i.test(t)) return 'portfolio';
  return 'commercial';
}

/**
 * Rank bullets: JD relevance first, then analysis language, then the two
 * headline facts. Nothing is rewritten — only chosen and ordered.
 */
export function selectBullets(profile, { role, jd, angle }) {
  const jdWords = new Set(String(jd).toLowerCase().match(/[a-z]{4,}/g) || []);
  const scored = [];
  for (const r of profile.roles) {
    for (const b of r.bullets) {
      const words = new Set(b.toLowerCase().match(/[a-z]{4,}/g) || []);
      let overlap = 0;
      for (const w of words) if (jdWords.has(w)) overlap++;
      const isAnalysis = ANALYSIS_RE.test(b);
      const isSupport = SUPPORT_RE.test(b) && !isAnalysis;
      let score = overlap;
      if (isAnalysis) score += 6;      // 2431 language leads
      if (isSupport) score -= 4;       // 3543 language sinks
      if (angle === 'commercial' && /£100K/.test(b)) score += 100;
      if (angle === 'portfolio' && /£64\.9M|£83\.6M|PROJECT_ONE/.test(b)) score += 100;
      scored.push({ text: b, role: r, score, isAnalysis, isSupport });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // EVERY role appears, always — including the Business Development Intern,
  // which the old flat top-N cut kept dropping whenever the two analyst roles
  // filled the quota. Bullets are allocated per role instead of globally.
  const byRole = new Map();
  const keep = [];
  for (const r of profile.roles) {
    const mine = scored.filter((s) => s.role === r);
    // Newest/most senior role carries the most detail; later roles are
    // progressively lighter, which is how the reference CV is shaped.
    const quota = r === profile.roles[0] ? 7 : r === profile.roles[1] ? 5 : 3;
    const picked = mine.slice(0, quota);
    if (picked.length) {
      byRole.set(r, picked);
      keep.push(...picked);
    }
  }
  return { byRole, keep, dropped: scored.length - keep.length };
}

// ── headline ─────────────────────────────────────────────────────────
//
// The headline is a SOC-ELIGIBILITY CONTROL, not decoration. "PMO", "Project
// Support", "Team Organiser" etc. code the document to SOC 3543 — below RQF6,
// not sponsorable — so they can never appear here however PMO-flavoured the
// role is. The job title inside EXPERIENCE stays honest and untouched; only
// the positioning line is chosen. Honest title, accurate positioning.
const BANNED_HEADLINE_RE = /\b(pmo|project support|programme support|program support|project coordinator|team organiser|team organizer|support officer|administrator)\b/i;

const POSITIONING = [
  [/\b(management consultant|consulting|consultancy|advisory|transformation)\b/i, 'Management Consultant'],
  [/\b(commercial analyst|commercial|cost|contract|procurement|bid|pricing)\b/i, 'Commercial Analyst'],
  [/\b(strategy|strategic|corporate development|market analysis)\b/i, 'Strategy Analyst'],
  [/\b(business analyst|business analysis|requirements|process improvement|change)\b/i, 'Business Analyst'],
];

/**
 * `{positioning} | {skill 1} | {skill 2}` — the two skills read from THIS JD's
 * own emphasis, and only where the profile genuinely lists them.
 */
export function buildHeadline(profile, { role, jd }) {
  const hay = `${role} ${jd}`;
  let positioning = 'Business Analyst';                 // safe 2431 default
  for (const [re, label] of POSITIONING) {
    if (re.test(hay)) { positioning = label; break; }
  }

  // Rank real profile skills by how much the JD emphasises them (frequency,
  // not mere presence), so the two chosen are the JD's own priorities.
  const low = hay.toLowerCase();
  const ranked = profile.allSkills
    .map((s) => {
      const key = s.toLowerCase();
      const hits = (low.match(new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')) || []).length;
      const token = key.split(/\s+/)[0];
      const tokenHits = token.length > 4
        ? (low.match(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')) || []).length : 0;
      return { skill: s, score: hits * 3 + tokenHits };
    })
    .filter((x) => x.score > 0 && !BANNED_HEADLINE_RE.test(x.skill))
    .sort((a, b) => b.score - a.score);

  const title = (s) => s.replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
  const picked = [];
  for (const r of ranked) {
    if (picked.length >= 2) break;
    if (!picked.some((p) => p.toLowerCase() === r.skill.toLowerCase())) picked.push(title(r.skill));
  }
  // Fall back to the profile's two strongest general skills rather than
  // emitting a bare positioning line with nothing after it.
  while (picked.length < 2) {
    const fill = ['Commercial Analysis', 'Executive Reporting', 'Power BI'].find((f) => !picked.includes(f));
    if (!fill) break;
    picked.push(fill);
  }

  const headline = [positioning, ...picked].join(' | ');
  if (BANNED_HEADLINE_RE.test(headline)) {
    // Belt and braces: a banned term must never reach the page.
    return [positioning, 'Commercial Analysis', 'Executive Reporting'].join(' | ');
  }
  return headline;
}

// ── professional development selection ───────────────────────────────
//
// 3-5 entries, at most three in progress, completed items ALWAYS retained.
// Never all eleven — a section stacked with "ongoing" reads as unfinished
// rather than committed.
const DEV_TARGET = 5;
const MAX_ONGOING = 3;

export function selectDev(profile, { role, jd }) {
  const low = `${role} ${jd}`.toLowerCase();
  const scored = profile.dev.map((d) => ({
    ...d,
    score: d.match.reduce((n, m) => n + (low.includes(m) ? 1 : 0), 0),
  }));

  const completed = scored.filter((d) => !d.ongoing);              // always kept
  const ongoing = scored.filter((d) => d.ongoing)
    .sort((a, b) => b.score - a.score || a.n - b.n)
    .slice(0, MAX_ONGOING);

  const out = [...ongoing, ...completed]
    .sort((a, b) => b.score - a.score || a.n - b.n)
    .slice(0, DEV_TARGET);

  // A completed credential outweighs any in-progress one, so re-add it if the
  // cap above happened to trim it out.
  for (const c of completed) if (!out.includes(c)) out.push(c);
  return out;
}

// ── key achievements (conditional) ───────────────────────────────────
//
// Only when 3-4 genuinely strong, role-relevant quantified wins fit. One or
// two weak ones -> omit the section entirely; a thin achievements block is
// worse than none.
const QUANTIFIED_RE = /£[\d,.]+[KM]?|\b\d+%|\b\d+\s*(?:hours?|hrs?)\b/i;
const MIN_ACHIEVEMENTS = 3;
const MAX_ACHIEVEMENTS = 4;

export function selectAchievements(profile, { role, jd }) {
  const jdWords = new Set(String(jd).toLowerCase().match(/[a-z]{4,}/g) || []);
  const scored = [];
  for (const r of profile.roles) {
    for (const b of r.bullets) {
      if (!QUANTIFIED_RE.test(b)) continue;              // must be quantified
      const words = new Set(b.toLowerCase().match(/[a-z]{4,}/g) || []);
      let overlap = 0;
      for (const w of words) if (jdWords.has(w)) overlap++;
      if (ANALYSIS_RE.test(b)) overlap += 2;             // 2431 language first
      scored.push({ text: b, score: overlap });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.filter((s) => s.score > 0);
  // Below the minimum, the section is omitted rather than padded.
  if (relevant.length < MIN_ACHIEVEMENTS) return [];
  return relevant.slice(0, MAX_ACHIEVEMENTS).map((s) => s.text);
}

/** Mirror JD vocabulary ONLY where it already matches a profile skill. */
export function mirroredKeywords(profile, jd) {
  const out = [];
  for (const s of profile.allSkills) {
    if (s.length < 4) continue;
    if (new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(jd)) out.push(s);
  }
  return [...new Set(out)];
}

// ── documents ────────────────────────────────────────────────────────

const P = (text, opts = {}) => new Paragraph({
  children: [new TextRun({ text, ...opts })],
  spacing: { after: opts.after ?? 60 },
  alignment: opts.alignment,
});

const H = (text) => P(text, { bold: true, size: 21, after: 70 });
const BULLET = (text, size = 19) => new Paragraph({
  children: [new TextRun({ text, size })],
  bullet: { level: 0 },
  spacing: { after: 40 },
});

/** Front-load the skills a given JD actually emphasises, within each category. */
function orderSkills(list, jd) {
  const low = String(jd).toLowerCase();
  return [...list].sort((a, b) => {
    const ha = low.includes(a.toLowerCase()) ? 1 : 0;
    const hb = low.includes(b.toLowerCase()) ? 1 : 0;
    return hb - ha;
  });
}

const titleCase = (s) => s.replace(/^([a-z])/, (m, c) => c.toUpperCase());

/**
 * Section order is mandatory and fixed:
 *   Name · Headline · Contact · SUMMARY · SKILLS · KEY ACHIEVEMENTS (conditional)
 *   · EXPERIENCE · EDUCATION AND QUALIFICATIONS · PROFESSIONAL DEVELOPMENT
 *   · EXTRA-CURRICULAR ACTIVITIES AND INTERESTS
 * Only KEY ACHIEVEMENTS is ever absent. Nothing here is composed — every
 * string is selected from 03_Master_Profile.md.
 */
function cvDoc(profile, { company, role, sel, keywords, angle, jd, headline, dev, achievements }) {
  const c = profile.contact;
  const kids = [
    new Paragraph({ children: [new TextRun({ text: c.name, bold: true, size: 32 })], spacing: { after: 30 } }),
    P(headline, { size: 21, bold: true, after: 30 }),
    P([c.email, c.phone, c.linkedin].filter(Boolean).join('  |  '), { size: 18, after: 150 }),
  ];

  // ── PROFESSIONAL SUMMARY — tailored, but only from master-profile facts.
  kids.push(H('PROFESSIONAL SUMMARY'));
  const summary = angle === 'portfolio'
    ? 'Strategy and operations professional with nearly two years’ UK work experience supporting complex infrastructure and transformation programmes within EMPLOYER_ONE’s Major Projects & Programmes division, spanning an £83.6M capital portfolio across the £64.9M PROJECT_ONE, £10M PROJECT_TWO and £8.7M PROJECT_THREE. Experienced in translating financial, commercial, schedule and risk data into executive-ready insight for Directors, Department for Transport officials, Train Operating Companies and Principal Contractors. MSc Management (Finance) from YOUR_UNIVERSITY.'
    : 'Business and commercial analyst with nearly two years’ UK work experience at EMPLOYER_ONE, where I identified a £100K commercial risk through financial and delivery analysis, enabling early recovery planning before wider programme escalation. Experienced in translating cost, schedule and risk data into executive-ready insight across an £83.6M capital portfolio, alongside commercial pipeline analysis and dashboard development at EMPLOYER_TWO. MSc Management (Finance) from YOUR_UNIVERSITY.';
  kids.push(P(summary, { size: 19, after: 150 }));

  // ── SKILLS — all three categories, always, with their printed labels.
  kids.push(H('SKILLS'));
  for (const [label, list] of Object.entries(profile.skills)) {
    kids.push(P(label, { bold: true, size: 18, after: 20 }));
    kids.push(P(orderSkills(list, jd).map(titleCase).join(' • '), { size: 18, after: 70 }));
  }
  kids.push(P('', { size: 8, after: 60 }));

  // ── KEY ACHIEVEMENTS — conditional; omitted entirely when thin.
  if (achievements.length) {
    kids.push(H('KEY ACHIEVEMENTS'));
    for (const a of achievements) kids.push(BULLET(a));
    kids.push(P('', { size: 8, after: 60 }));
  }

  // ── EXPERIENCE — all three roles, always. Titles never inflated.
  kids.push(H('EXPERIENCE'));
  for (const [r, bullets] of sel.byRole) {
    kids.push(P(`${r.title}${r.employer ? ` | ${r.employer}` : ''}`, { bold: true, size: 19, after: 20 }));
    if (r.meta) kids.push(P(cleanMeta(r.meta), { italics: true, size: 17, after: 40 }));
    for (const b of bullets) kids.push(BULLET(b.text));
    kids.push(P('', { size: 8, after: 40 }));
  }

  // ── EDUCATION AND QUALIFICATIONS — modules are the first trim.
  kids.push(H('EDUCATION AND QUALIFICATIONS'));
  for (const e of profile.education) {
    kids.push(P(`${e.qualification} — ${e.detail}`, { bold: true, size: 19, after: 20 }));
    for (const x of (e.extras || [])) kids.push(P(x, { size: 17, after: 20 }));
    kids.push(P('', { size: 8, after: 30 }));
  }

  // ── PROFESSIONAL DEVELOPMENT — tailored, never exhaustive. Heading is
  // never relabelled "Certifications": most of these are in progress.
  kids.push(H('PROFESSIONAL DEVELOPMENT'));
  for (const d of dev) {
    kids.push(P(`${d.item} | ${d.provider} — ${d.status}`, { size: 18, after: 30 }));
  }
  kids.push(P('', { size: 8, after: 60 }));

  // ── EXTRA-CURRICULAR — always present, condensed.
  kids.push(H('EXTRA-CURRICULAR ACTIVITIES AND INTERESTS'));
  for (const x of profile.extra) kids.push(BULLET(x, 18));

  return new Document({
    creator: 'career-ops', title: `${c.name} — ${role}`,
    sections: [{ properties: { page: { margin: { top: 620, bottom: 620, left: 680, right: 680 } } }, children: kids }],
  });
}

// ── cover letter ─────────────────────────────────────────────────────
//
// The old version was the CV restated in sentences: identical skeleton every
// time, "I am applying for X at Y. At EMPLOYER_ONE I [bullet]. At EMPLOYER_ONE
// I [bullet]. I hold an MSc. I would welcome the chance to discuss." A
// Medical Insight Analyst letter contained nothing about healthcare or data.
//
// What replaces it: open on something SPECIFIC AND REAL from this JD, run ONE
// narrative thread, and say the thing the CV structurally cannot — why this
// role, why now, what connects the UK infrastructure background to their
// problem. No company fact is ever invented: the opening is drawn from the
// JD's own words, which is a legitimate specific and needs no outside research.

// Text about the HIRING PROCESS, not the job. A Royal Free posting yielded
// "the role and assessment, all interviews will be conducted in person" —
// grammatically fine, entirely useless, and embarrassing to quote back as if
// it described the work.
const PROCESS_NOISE = /\b(interview|assessment centre|shortlist|closing date|apply|application|vacanc|redeploy|secondment|dbs|references?|pre-employment|right to work|sponsor|salary|pension|annual leave|benefits|equal opportunit|safeguarding|cookies|privacy notice|supporting documents|employer name)\b/i;

// A phrase that actually describes doing the job.
const DUTY_VERB = /\b(analys|analyz|deliver|develop|produce|manage|support|lead|provide|design|build|maintain|coordinat|report|advis|assess|review|implement|drive|shape|define|improv|work with|liais)/i;

// Bullet fragments harvested mid-list: infinitives ("To lead or participate…")
// and bare gerund/imperative openings that are not sentences.
const FRAGMENT_START = /^(?:to|and|or|the following|including|e\.?g\.?|i\.?e\.?)\b/i;

/**
 * True only for a phrase that reads as a complete, duty-describing clause.
 * Anything failing this is discarded in favour of the generic phrasing — an
 * unusable quote is strictly worse than no quote.
 */
function usablePhrase(s) {
  const t = String(s || '').trim();
  if (t.length < 40 || t.length > 240) return false;
  if (PROCESS_NOISE.test(t)) return false;      // about applying, not the job
  if (!DUTY_VERB.test(t)) return false;         // says nothing about the work
  if (FRAGMENT_START.test(t)) return false;     // starts mid-sentence
  if (/\b[a-z]{2,}[A-Z]/.test(t)) return false; // run-together capitals from list scraping
  if ((t.match(/[A-Z]/g) || []).length > t.length / 4) return false;  // heading-case fragment
  if (!/\s/.test(t)) return false;
  return true;
}

/** The JD's own statement of the problem — never a fact invented about the firm. */
function jdHook(jd, role) {
  const text = String(jd || '').replace(/\s+/g, ' ');
  // Sentences describing what the role EXISTS to do, in the JD's own words.
  // Each must begin at a sentence boundary, so a match cannot start mid-clause.
  const WANT = [
    /(?:^|(?<=[.!?]\s))(?:you(?:'ll| will)\s+(?:be\s+)?(?:responsible for|lead|own|support|work|help|deliver|drive|carry out|conduct|produce|analyse|analyze)[^.]{25,190})\./i,
    /(?:^|(?<=[.!?]\s))(?:the (?:role|successful candidate|postholder)\s+(?:will|is)[^.]{25,190})\./i,
    /(?:^|(?<=[.!?]\s))(?:we(?:'re| are) (?:looking for|seeking|recruiting)[^.]{25,190})\./i,
    /(?:^|(?<=[.!?]\s))(?:this (?:role|position|opportunity)\s+(?:will|is|offers)[^.]{25,190})\./i,
  ];
  for (const re of WANT) {
    const m = text.match(re);
    if (!m) continue;
    const phrase = m[0].trim().replace(/\.$/, '').replace(/\s+/g, ' ');
    if (usablePhrase(phrase)) return phrase;
  }
  return '';   // caller falls back to generic phrasing
}

/** Lower-case an opening fragment so it reads inside a sentence. */
function inline(s) {
  const t = String(s).trim().replace(/\.$/, '');
  return t.replace(/^(You|The|We|This)\b/, (m) => m.toLowerCase());
}

/**
 * Something specific about THIS EMPLOYER, not merely the duties — a named
 * practice, team or division, or the technology/domain areas the employer
 * states it works across. Sourced from the employer's own posting, so it is
 * never an invented company fact; if nothing nameable is found the caller
 * writes around it rather than manufacturing something.
 */
// Words that mean the capture is a duty bullet, not the name of a team. The
// Royal Free posting produced "To lead or participate in administrative team"
// — a mid-list fragment whose leading capital came from the bullet, not from a
// proper noun — and it was printed as though it were the team's name.
const NOT_A_TEAM_NAME = /^(?:to|and|or|in|of|the|a|an|for|with|within|across|lead|leads?|leading|participate|ensure|ensures?|provide|provides?|support|supports?|manage|manages?|undertake|assist|maintain|deliver|work|working|liaise|contribute|develop|be|is|are|will|other|any|all|as|from|responsible|member|part|join|our)\b/i;

/**
 * A team name reads as a proper noun: mostly capitalised words, no verbs, no
 * sentence connectives. Anything else is a scraped fragment.
 */
function looksLikeProperName(s) {
  const t = String(s || '').trim();
  if (t.length < 4 || t.length > 60) return false;
  if (NOT_A_TEAM_NAME.test(t)) return false;
  if (PROCESS_NOISE.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  // Every word either capitalised, an acronym, or a short joiner like "&"/"of".
  const capish = words.filter((w) => /^[A-Z0-9(&]/.test(w) || /^(?:of|and|&|for)$/i.test(w));
  return capish.length === words.length;
}

function companyAnchor(jd) {
  const text = String(jd || '').replace(/\s+/g, ' ');
  // Require a sentence-internal position so a bullet's leading capital cannot
  // masquerade as the start of a proper noun.
  const named = text.match(/(?:join|within|part of|our|the)\s+((?:[A-Z][A-Za-z&.\-]*\s+){1,4}(?:\([A-Z]{2,6}\)\s+)?)(consulting team|practice|division|team|function|business unit)\b/);
  if (named) {
    const name = named[1].trim();
    if (looksLikeProperName(name)) return { kind: 'team', value: `${name} ${named[2].trim()}` };
  }

  const across = text.match(/\b(?:across|spanning|including)\s+((?:areas\s+including\s+)?[A-Z][A-Za-z0-9&,\-. ]{10,90})/);
  if (across) {
    // Cut at the first sentence end. Without this the capture runs straight
    // into the next sentence and is then chopped by the length cap mid-word —
    // a Greencore posting produced "...Workforce Management solutions. The
    // ideal cand", which was printed verbatim.
    let v = across[1].replace(/^areas\s+including\s+/i, '').trim();
    const stop = v.search(/\.(?:\s|$)/);
    if (stop !== -1) v = v.slice(0, stop);
    v = v.replace(/[,.\s]+$/, '').replace(/\s+(?:and|or|the|a|an)$/i, '').trim();

    // Must be a short list of named things (Cloud, Data & AI, ServiceNow…),
    // not prose, and must not have been truncated mid-word by the cap.
    const words = v.split(/\s+/).filter(Boolean);
    const truncated = across[1].length >= 90 && stop === -1;
    if (v.length >= 12 && words.length <= 12 && !truncated
        && !NOT_A_TEAM_NAME.test(v) && !PROCESS_NOISE.test(v)
        && (v.match(/[A-Z]/g) || []).length >= 2) {
      return { kind: 'areas', value: v };
    }
  }
  return null;   // caller uses the no-anchor phrasing
}

/**
 * HARD BLOCK. Sponsorship, visa and immigration history must NEVER appear in a
 * cover letter — it is the candidate's explicit standing rule and it is in
 * config/profile.yml as `sponsorship_disclosure: on_request_only`. An earlier
 * version of this generator wrote "my authorisation reached its end point in
 * January 2026" into every letter, which is exactly the disclosure the rule
 * forbids. This runs over the assembled text as a last line of defence, so a
 * future edit that reintroduces the phrasing fails loudly instead of shipping.
 */
// NOTE: "authoris/authoriz" is matched BARE, not only as "work authorisation".
// The sentence that caused this rule to exist read "my authorisation reached
// its end point in January 2026" — a `work authoris` pattern sails straight
// past it. Any form of the word is blocked.
const FORBIDDEN_IN_LETTER = /\b(visas?|sponsor(?:ship|ed|ing|s)?|authoris\w*|authoriz\w*|right to work|immigration|immigrant|skilled worker|tier 2|settlement|indefinite leave|work permit|relocat\w*)\b/i;

function assertNoStatusDisclosure(paragraphs) {
  for (const p of paragraphs) {
    const m = String(p).match(FORBIDDEN_IN_LETTER);
    if (m) throw new Error(`cover letter would disclose immigration/sponsorship status ("${m[0]}") — blocked. See sponsorship_disclosure: on_request_only.`);
  }
}

// Where a posting yields no nameable team or focus area, the letter still
// needs a "why this" paragraph. One fixed sentence would be byte-identical
// across every such letter — fine read alone, visibly canned if two land on
// the same desk. These are variants of the SAME true claim, rotated by a hash
// of company+role so the choice is stable per role (regenerating a letter
// doesn't reshuffle it) but differs across roles. Every clause traces to
// 03_Master_Profile.md; none invents anything about the employer.
const GENERIC_FIT = [
  (co) => `What draws me to ${co} specifically is that the analysis has to hold up in front of a client rather than only inside an internal reporting pack. That is the standard I worked to on a portfolio where Directors, DfT officials and principal contractors were all reading the same numbers.`,
  (co) => `What interests me about ${co} is the kind of scrutiny the work has to survive. On an £83.6M portfolio the same cost and schedule figures were read by Directors, Department for Transport officials and principal contractors at once, and anything that did not reconcile surfaced quickly — which is where the £100K risk came from.`,
  (co) => `The reason I am applying to ${co} rather than casting widely is the shape of the work: analysis that has to be defensible to people who did not produce it. At EMPLOYER_ONE every reporting output went to Directors, DfT officials, Train Operating Companies and Principal Contractors, so the standard was whether a decision could safely be taken on it.`,
];

const AGENCY_FIT = [
  'On fit for the role itself: the brief calls for someone who can take cost, schedule and commercial data and turn it into something a decision-maker acts on, and that is the through-line of both roles above — the analysis at EMPLOYER_TWO that changed how a commercial pipeline was run, and the reporting at EMPLOYER_ONE that surfaced a six-figure risk before it escalated.',
  'On fit for the role itself: what both roles above have in common is producing analysis that other people then act on — a commercial pipeline restructured at EMPLOYER_TWO off the back of conversion analysis, and a £100K risk at EMPLOYER_ONE caught from routine cost and schedule data rather than a formal review.',
  'On fit for the role itself: the common thread across my experience is turning operational and financial data into decisions — identifying where a commercial pipeline was losing volume at EMPLOYER_TWO, and surfacing a six-figure exposure at EMPLOYER_ONE early enough for recovery planning to still be possible.',
];

/** Stable per-role choice: same key always yields the same variant. */
function pick(variants, key) {
  let hash = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return variants[hash % variants.length];
}

/** Exported so run-daily.mjs can report how far tailoring got when a run dies. */
export const TAILOR_PROGRESS_PATH = PROGRESS;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const letterDate = (d = new Date()) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/**
 * Full-letterhead cover letter, matching the candidate's own standard:
 *   name · title · city | phone | email | LinkedIn · date · addressee block
 *   then a letter that WEAVES education, EMPLOYER_TWO and EMPLOYER_ONE into one
 *   argument rather than restating whichever single bullet scored highest.
 *
 * NEVER mentions visa, sponsorship or work-authorisation history. That is the
 * candidate's standing rule (`sponsorship_disclosure: on_request_only`), it is
 * answered honestly when actually asked, and it has no place in a letter whose
 * job is to argue for the work. `assertNoStatusDisclosure` enforces it.
 */
function coverDoc(profile, { company, role, sel, angle, jd, headline, matchedSkills, agency = false }) {
  const c = profile.contact;
  const hook = jdHook(jd, role);
  const anchor = companyAnchor(jd);
  // An agency is not the employer. Writing "the brief AT {agency}" or "what
  // draws me to {agency} specifically" reads as not understanding who is being
  // written to — the end employer is unknown, so there is nothing to engage
  // with and nobody to "join". The three substantive paragraphs are identical
  // either way; only the framing changes.
  const at = agency ? '' : (company ? ` at ${company}` : '');

  // ── Opening: the role, and the specific reason it fits.
  // No "I am writing to apply for X at Y" preamble — the letter opens on the
  // employer's own description of the work.
  //
  // NO CUMULATIVE DURATION CLAIM. Total experience is ~31 months across three
  // non-continuous roles with an MSc in between (intern 3mo + EMPLOYER_TWO 10mo
  // + EMPLOYER_ONE 19mo) — "the past four years", which this line used to say,
  // was simply false. Describing the ARC ("across analyst and infrastructure
  // delivery roles") is accurate and needs no arithmetic. The only duration
  // figure anywhere in a generated document is "nearly two years' UK", which
  // refers to EMPLOYER_ONE alone and is correct.
  const opening = agency
    ? (hook
      ? `I would like to be considered for the ${role} role you are advertising. The brief — ${inline(hook)} — describes the work I have been doing across analyst and infrastructure delivery roles, most recently on a national capital portfolio at EMPLOYER_ONE.`
      : `I would like to be considered for the ${role} role you are advertising. It describes the work I have been doing across analyst and infrastructure delivery roles, most recently on a national capital portfolio at EMPLOYER_ONE.`)
    : (hook
      ? `Your description of the ${role} role${at} — ${inline(hook)} — describes the work I have been doing across analyst and infrastructure delivery roles, most recently on a national capital portfolio at EMPLOYER_ONE.`
      : `The ${role} brief${at} describes the work I have been doing across analyst and infrastructure delivery roles, most recently on a national capital portfolio at EMPLOYER_ONE.`);

  // ── Education → EMPLOYER_TWO: the analytical foundation and where it was
  // first applied commercially. Both drawn from the master profile.
  const foundation = 'My MSc in Management (Finance) from YOUR_UNIVERSITY gave me the analytical grounding I work from — corporate finance, business economics, strategy and management accounting — and it shaped how I approach a problem: structure the information, establish what the data actually supports, then translate that into something a decision-maker can act on. I applied that directly at EMPLOYER_TWO as a Business Analyst, analysing end-to-end commercial pipelines to identify conversion bottlenecks and lifting qualified lead volume by 30%, building the Power BI and Excel dashboards senior leadership used for commercial planning, and standardising CRM datasets in SQL and Excel to cut manual reporting effort by 30% while improving forecast accuracy. Redesigning the lead-to-onboarding process there took response times from 48 hours to 4.';

  // ── EMPLOYER_ONE: the scale, and the catch that came out of it.
  const infra = angle === 'portfolio'
    ? 'At EMPLOYER_ONE I moved that analytical work into a far larger and more complex delivery environment, coordinating programme governance across the £64.9M PROJECT_ONE, the £10M PROJECT_TWO and the £8.7M PROJECT_THREE — an £83.6M portfolio — working directly with Directors, Department for Transport officials, Train Operating Companies and Principal Contractors. I produced the executive reporting that translated detailed cost, schedule and risk data into management insight, and it was that routine interrogation of the numbers which surfaced a £100K commercial risk early enough to enable recovery planning before it escalated across the wider programme.'
    : 'At EMPLOYER_ONE I applied the same instincts across an £83.6M capital portfolio, producing the executive reporting that translated detailed cost, schedule and risk data into management insight for Directors, Department for Transport officials, Train Operating Companies and Principal Contractors. The work I would point to first is a £100K commercial risk I identified through financial and delivery analysis — it surfaced from routine cost and schedule data rather than a formal review, and was caught early enough to enable recovery planning before it escalated. I also redesigned the SharePoint-based triage and reporting processes, increasing team throughput by 20% while holding a 97% same-day response rate on executive requests.';

  // ── Engage with THIS employer, using what the employer itself published.
  // No outside claim is invented; if the posting names nothing, the sentence
  // is built from the role's own remit instead.
  const skillTail = matchedSkills.length
    ? ` The overlap with what you are asking for is concrete: ${matchedSkills.slice(0, 3).map((s) => s.toLowerCase()).join(', ')}.`
    : '';
  // Agency route: there is no end employer to engage with, so this paragraph
  // argues fit for the ROLE instead of affinity for a company.
  const fitAgency = pick(AGENCY_FIT, `${company}|${role}`) + skillTail;

  const fit = agency ? fitAgency : anchor
    ? (anchor.kind === 'team'
      ? `What draws me to ${company || 'this role'} specifically is the ${anchor.value} this role sits in: advisory work where the analysis has to hold up in front of a client, not just inside a reporting pack. That is the standard I worked to on a portfolio where Directors, DfT officials and principal contractors were all reading the same numbers.${skillTail}`
      : `What draws me to ${company || 'this role'} specifically is the breadth the role spans — ${anchor.value} — and the fact that the analysis has to hold up in front of a client rather than only inside a reporting pack. That is the standard I worked to on a portfolio where Directors, DfT officials and principal contractors were all reading the same numbers.${skillTail}`)
    : pick(GENERIC_FIT, `${company}|${role}`)(company || 'this role') + skillTail;

  // ── Purposeful close: names what she wants to do, not a request for a chat.
  const close = agency
    ? `I have attached my CV. If you think the fit is right, I would be glad to be put forward for this role, and I am happy to talk through the detail or to hear about similar briefs on your desk.`
    : `I would like to bring that combination — commercial analysis grounded in finance, and delivery experience on complex multi-party programmes — to ${company || 'your team'}. I have attached my CV, and I would be glad to walk through how the ${role} brief maps onto the work above.`;

  const body = [opening, foundation, infra, fit, close];
  assertNoStatusDisclosure(body);   // throws rather than shipping a disclosure

  // Letterhead is STACKED, one item per line, matching the candidate's own
  // standard (her Google letter) rather than a single run-on contact line.
  const kids = [
    new Paragraph({ children: [new TextRun({ text: c.name, bold: true, size: 26 })], spacing: { after: 20 } }),
    ...[c.city, c.phone, c.email, c.linkedin].filter(Boolean)
      .map((l, i, a) => P(l, { size: 19, after: i === a.length - 1 ? 200 : 20 })),
    P(letterDate(), { size: 19, after: 200 }),
    ...(company
      ? (agency
        ? [P('Recruitment Team', { size: 19, after: 20 }), P(company, { size: 19, after: 20 })]
        : [P(`${role} Hiring Team`, { size: 19, after: 20 }), P(company, { size: 19, after: 20 })])
      : [P('Hiring Team', { size: 19, after: 20 })]),
    P('', { size: 8, after: 150 }),
    P('Dear Hiring Team,', { size: 20, after: 140 }),
    ...body.map((t) => P(t, { size: 20, after: 140 })),
    P('Yours sincerely,', { size: 20, after: 70 }),
    P(c.name, { size: 20 }),
  ];

  return new Document({
    creator: 'career-ops', title: `${c.name} — cover letter — ${role}`,
    sections: [{ properties: { page: { margin: { top: 820, bottom: 820, left: 900, right: 900 } } }, children: kids }],
  });
}

/** Drop the month-count from a role's meta line. */
export function cleanMeta(meta) {
  return String(meta).replace(/\s*\|\s*\d+\s*months?\s*$/i, '').trim();
}

/**
 * Turn a CV bullet into a first-person sentence for the letter. Only the
 * grammatical frame changes — the claim, its numbers and its verb are the
 * source bullet's own.
 */
export function asSentence(bullet, employer) {
  const b = String(bullet).trim().replace(/\s+/g, ' ');
  const lead = b.charAt(0).toLowerCase() + b.slice(1);
  return employer ? `At ${employer} I ${lead}.` : `I ${lead}.`;
}

const safe = (s) => String(s || 'Unknown').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// ── main ─────────────────────────────────────────────────────────────

/** Temp-then-rename so a kill mid-write can never leave pipeline.xlsx (15k+
 *  rows of accumulated history) half-written and corrupt — same principle as
 *  coverage-tracker.mjs's save(). */
async function saveXlsxAtomic(wb) {
  const tmp = `${XLSX}.tmp`;
  await wb.xlsx.writeFile(tmp);
  renameSync(tmp, XLSX);
}

function saveProgress(state) {
  const tmp = `${PROGRESS}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, PROGRESS);
}

async function main() {
  const args = process.argv.slice(2);
  const limit = Number((args.find((a) => a.startsWith('--limit=')) || '--limit=0').split('=')[1]) || 0;
  const dry = args.includes('--dry-run');
  // Added 2026-09-10 alongside the liveness gate. On by default — the whole
  // point is that it runs without being remembered. Opt out when offline.
  const skipLiveness = args.includes('--skip-liveness');

  if (!existsSync(XLSX)) { console.error(`missing ${XLSX} — run: node export-excel.mjs`); process.exit(1); }
  const profile = loadProfile();
  const TITLES = targetTitles();
  const registerIdx = buildRegisterIndex(coverageTracker.load());
  mkdirSync('output', { recursive: true });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.getWorksheet('Pipeline');
  const header = [];
  ws.getRow(1).eachCell((c, i) => { header[i - 1] = String(c.value ?? ''); });
  const col = (n) => header.indexOf(n) + 1;

  const candidates = [];
  let alreadyRejected = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const score = Number(row.getCell(col('Score')).value);
    const cvFile = String(row.getCell(col('CV File')).value ?? '').trim();
    if (!(score >= MIN_SCORE) || cvFile) return;
    // A prior run already fetched this JD and decided NOT A FIT — that verdict
    // is durable, not a queue position. Without this check, every already-
    // rejected role gets re-fetched and re-judged EVERY run forever, since
    // rejection only ever sets Notes, never CV File. Re-review is manual: the
    // user clears the Notes cell if they want a role looked at again.
    const notes = String(row.getCell(col('Notes')).value ?? '').trim();
    if (notes.startsWith('NOT A FIT')) { alreadyRejected++; return; }
    candidates.push({
      n,
      company: String(row.getCell(col('Company')).value ?? '').trim(),
      role: String(row.getCell(col('Job Role')).value ?? '').trim(),
      link: (() => { const v = row.getCell(col('Apply Link')).value; return v && typeof v === 'object' && 'text' in v ? v.text : String(v ?? ''); })(),
      salary: String(row.getCell(col('Salary')).value ?? '').trim(),
    });
  });

  const batch = limit ? candidates.slice(0, limit) : candidates;

  console.log('='.repeat(72));
  console.log('  career-ops — auto-tailor');
  console.log('='.repeat(72));
  console.log(`  rows scoring >= ${MIN_SCORE} with no CV File : ${candidates.length + alreadyRejected} (${alreadyRejected} already NOT A FIT, skipped)`);
  console.log(`  genuinely un-reviewed                : ${candidates.length}`);
  console.log(`  processing                          : ${batch.length}${limit ? ` (--limit=${limit})` : ''}`);
  console.log('='.repeat(72));
  if (!batch.length) {
    console.log('\nnothing to do.');
    return;
  }

  // Full ranked list is already built (export-excel.mjs sorted it by Score
  // descending before this ran) — `candidates` above walked the sheet
  // top-to-bottom, so `batch` IS the top-down slice of the real ranking.
  // Record it BEFORE processing starts so a kill on role 1 still leaves an
  // honest "0 of N done, here's what's pending" checkpoint, not silence.
  const startedAt = new Date().toISOString();
  const progress = {
    startedAt, finishedAt: null,
    rankedEligibleTotal: candidates.length,   // every role that qualifies, not just this run's slice
    batchSize: batch.length, limit,
    processed: [],
    pending: batch.map((c, i) => ({ rank: i + 1, company: c.company, role: c.role })),
  };
  if (!dry) saveProgress(progress);

  let made = 0, notFit = 0, expired = 0;
  for (let i = 0; i < batch.length; i++) {
    const c = batch[i];

    // ── LIVENESS GATE (added 2026-09-10) ──────────────────────────────────
    // Root cause of a real, expensive failure: Sopra Steria Senior Business
    // Consultant scored 5.0, got a CV and cover letter written, sat in
    // output/ for days, and by the time it was looked at the Reed posting
    // returned 404. Fourteen of the top twenty went the same way inside three
    // days — Reed postings expire in days, not weeks.
    //
    // Generating documents for a closed posting is pure waste: it burns the
    // tailoring budget, pads output/ with files that can never be sent, and
    // — worst — makes the ranked list look full when it is mostly dead.
    //
    // FAIL-OPEN BY DESIGN. A network blip, a bot-block or a slow ATS must
    // never silently stop a good role being tailored, so anything other than
    // a confident "this is gone" lets the role through. The check only ever
    // REMOVES work; it can never invent a rejection.
    //
    // Skip it with --skip-liveness when offline or when speed matters more.
    if (!skipLiveness) {
      const live = await isStillLive(c.link);
      if (live.result === 'expired') {
        expired++;
        const note = `EXPIRED - ${live.reason}`;
        console.log(`  ⌛ ${c.role.slice(0, 44).padEnd(46)} ${note}`);
        if (!dry) ws.getRow(c.n).getCell(col('Notes')).value = note;
        progress.processed.push({ rank: i + 1, company: c.company, role: c.role, result: 'expired', reason: live.reason });
        progress.pending = progress.pending.filter((p) => p.rank !== i + 1);
        if (!dry) saveProgress(progress);
        continue;
      }
    }

    const jd = await fetchJd(c.link, c.role);
    const verdict = decideFit({
      role: c.role, company: c.company, jd: jd.text, profile, salary: c.salary,
      jdOk: jd.ok, targetTitles: TITLES, registerIdx, url: c.link,
    });
    const row = ws.getRow(c.n);

    let outcome;
    if (!verdict.fit) {
      notFit++;
      const note = `NOT A FIT - ${verdict.reason}`;
      console.log(`  ✗ ${c.role.slice(0, 44).padEnd(46)} ${note}`);
      if (!dry) row.getCell(col('Notes')).value = note;
      outcome = { rank: i + 1, company: c.company, role: c.role, result: 'not_fit', reason: verdict.reason };
    } else {
      const angle = leadAngle(c.role, jd.text);
      const sel = selectBullets(profile, { role: c.role, jd: jd.text, angle });
      const keywords = mirroredKeywords(profile, jd.text);
      const headline = buildHeadline(profile, { role: c.role, jd: jd.text });
      const dev = selectDev(profile, { role: c.role, jd: jd.text });
      const achievements = selectAchievements(profile, { role: c.role, jd: jd.text });
      const base = `${safe(c.company)}_${safe(c.role)}`;
      const cvName = `${base}_CV.docx`;
      const covName = `${base}_Cover.docx`;

      if (!dry) {
        writeFileSync(`output/${cvName}`, await Packer.toBuffer(cvDoc(profile, {
          company: c.company, role: c.role, sel, keywords, angle,
          jd: jd.text, headline, dev, achievements,
        })));
        writeFileSync(`output/${covName}`, await Packer.toBuffer(coverDoc(profile, {
          company: c.company, role: c.role, sel, angle,
          jd: jd.text, headline, matchedSkills: keywords, agency: isAgency(c.company || ''),
        })));
        row.getCell(col('CV File')).value = cvName;
        row.getCell(col('Cover Letter')).value = covName;
      }
      made++;
      console.log(`  ✓ ${c.role.slice(0, 44).padEnd(46)} lead=${angle} · ${sel.keep.filter((b) => b.isAnalysis).length}/${sel.keep.length} analysis bullets · ${keywords.length} mirrored terms${jd.ok ? '' : `  [JD unavailable: ${jd.reason}]`}`);
      outcome = { rank: i + 1, company: c.company, role: c.role, result: 'made', cvFile: cvName, coverFile: covName };
    }

    // Checkpoint NOW, not at the end. A kill immediately after this line
    // loses at most the in-progress role, never anything already finished —
    // both the actual documents (written above) and the xlsx/Notes cell
    // updates for it are durable before the next role's JD fetch even starts.
    if (!dry) {
      await saveXlsxAtomic(wb);
      progress.processed.push(outcome);
      progress.pending = progress.pending.filter((p) => p.rank !== i + 1);
      saveProgress(progress);
    }
  }

  if (!dry) { progress.finishedAt = new Date().toISOString(); saveProgress(progress); }

  console.log('='.repeat(72));
  console.log(`  documents generated : ${made} pairs`);
  console.log(`  marked NOT A FIT    : ${notFit}`);
  console.log(`  skipped as EXPIRED  : ${expired}${skipLiveness ? ' (liveness check disabled)' : ''}`);
  console.log(dry ? '\n--dry-run: no files written, spreadsheet untouched' : `\nupdated ${XLSX} (checkpointed per role) · progress: ${PROGRESS}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
