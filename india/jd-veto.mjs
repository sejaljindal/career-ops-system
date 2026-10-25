#!/usr/bin/env node
/**
 * jd-veto.mjs — content-level JD rejections, on top of the title gates that
 * already exist in eligibility.mjs::checkEligibility.
 *
 * WHY THIS EXISTS. Every gate in this repo before 2026-09-25 decided fit from
 * the TITLE (plus, in eligibility.mjs, a narrow slice of the JD body: an
 * accountancy qualification). None of them read the JD body for the other
 * ways a title-matching role turns out to be wrong: a "PMO Analyst" JD
 * demanding 5+ years, a "Business Analyst" role that is 90% SQL/DAX
 * development, an "Associate Consultant" that needs a CA/CFA, a graduate
 * scheme that excludes anyone who didn't graduate in 2026. A matching title
 * is necessary, not sufficient.
 *
 * OVERLAP IS DELIBERATE. eligibility.mjs already vetoes on required years of
 * experience and on accountancy qualification, but only for the ONE call
 * site that passes it real JD text (tailor-cv.mjs's main() loop, after JD
 * fetch). auto-tailor.mjs's select phase has no equivalent at all. Rather
 * than route every caller through eligibility.mjs (a title-first gate with
 * its own return shape and priority-tier concerns that don't belong here),
 * this module gives every caller the SAME content-level checks, called the
 * same way, regardless of which CV-generating path it is. Where the checks
 * overlap with eligibility.mjs, that is defense in depth, not redundancy to
 * be designed away.
 *
 * PORTED FROM THE UK REPO 2026-09-25. This is the India pipeline: no visa
 * logic, no SOC codes, no sponsorship (see CLAUDE.md). Three UK-only
 * categories were removed rather than ported:
 *   - sub-threshold salary (ran inferSOC()/salaryVerdict() against UK SOC
 *     codes — meaningless for India roles)
 *   - no-sponsorship phrasing (the candidate is Indian; India roles need no
 *     sponsorship)
 *   - UK security/national clearance (SC/DV/BPSS clearance, "British/Irish
 *     citizens only", "UK nationals only") — every phrase in that category
 *     is UK-specific vetting vocabulary with zero India application, and the
 *     "CTC" abbreviation it matched (Counter Terrorism Check, UK) collides
 *     with "CTC" as in Cost To Company, the single most common compensation
 *     term in Indian job postings. Left in, it would be dead weight at best
 *     and a false-positive risk at worst.
 * Two India-specific categories replace them (9 and 10 below).
 *
 * @param {string} jdText - the job description body. An empty/missing JD is
 *   treated as no evidence to veto on, not as a rejection — the same
 *   "absence of evidence is not evidence of misfit" rule the rest of the
 *   pipeline already applies when a JD couldn't be fetched.
 * @param {object} profile - reserved for future per-user overrides (a held
 *   qualification, an additional language). Unused today; every rule below
 *   is a fixed fact about this specific candidate, matching how
 *   eligibility.mjs already hardcodes her profile rather than reading it
 *   from config/profile.yml.
 * @param {object} [options]
 * @param {string} [options.title] - the job title. Required for the YoE
 *   graduate-exemption, the title-vs-body mismatch category, and the
 *   over-level-title category; all are skipped (not rejected) when omitted.
 * @param {string} [options.company] - the employer name, for the Big-4/MBB
 *   exception on category 9 below.
 * @returns {{fit: boolean, reason: string|null, evidence: string|null}}
 */

import { existsSync, statSync, renameSync, appendFileSync, mkdirSync } from 'fs';
import path from 'path';

/** First 200 chars of context around a regex match, for the evidence field. */
function snippet(text, match) {
  if (!match) return null;
  const i = match.index ?? text.indexOf(match[0]);
  const start = Math.max(0, i - 40);
  const raw = text.slice(start, start + 200).replace(/\s+/g, ' ').trim();
  return raw.slice(0, 200);
}

const no = (reason, evidence) => ({ fit: false, reason, evidence: evidence ? evidence.slice(0, 200) : null });

// ── category 1: required YoE > 3 ────────────────────────────────────────
// Same extraction shape as eligibility.mjs's own (undocumented-as-a-function)
// years check: a bare \d{1,2} would match the tail of a req/date number
// ("2017" -> "17"), so the figure must sit near the word "experience".
const GRAD_TITLE = /\b(graduate|entry[- ]level|intern(?:ship)?|junior|associate)\b/i;
const YEARS_RE_A = /\b(\d{1,2})\s*\+?\s*(?:to|-|–)?\s*(?:\d{1,2})?\s*(?:years?|yrs?)[^.;]{0,50}?experien/gi;
const YEARS_RE_B = /experien[^.;]{0,50}?\b(\d{1,2})\s*\+?\s*(?:to|-|–)?\s*(?:\d{1,2})?\s*(?:years?|yrs?)/gi;

function checkYearsOfExperience(jdText, title) {
  if (GRAD_TITLE.test(title || '')) return null;
  const hits = [...jdText.matchAll(YEARS_RE_A), ...jdText.matchAll(YEARS_RE_B)]
    .map((m) => ({ n: Number(m[1]), m }))
    .filter((x) => x.n >= 1 && x.n <= 25);
  if (!hits.length) return null;
  const worst = hits.reduce((a, b) => (b.n > a.n ? b : a));
  if (worst.n > 3) return no(`job description asks for ${worst.n}+ years' experience`, snippet(jdText, worst.m));
  return null;
}

// ── category 2: reverse graduation-year phrasings ───────────────────────
// She graduated 2024. Any cohort restriction naming 2025-2029 excludes her;
// "graduated 2024" or earlier, or no year mentioned at all, does not match.
// "expected graduation 2027" (noun) and "expected to graduate in 2027" (verb)
// are both common real phrasings — the first draft only caught the noun form
// and missed "students expected to graduate in 2027" in the smoke test.
const GRAD_YEAR_RE = /\b(?:graduat(?:ed|ing)\s+(?:in\s+)?20(2[5-9])|class\s+of\s+20(2[5-9])|final[- ]year\s+students?|expected\s+(?:to\s+)?graduat(?:e|ion)(?:\s+(?:date|in))?\s*:?\s*(?:in\s+)?20(2[5-9])|must\s+be\s+graduating\s+in\s+20(2[5-9]))\b/i;

function checkGraduationCohort(jdText) {
  const m = GRAD_YEAR_RE.exec(jdText);
  if (!m) return null;
  return no(`cohort-restricted to a ${m[0].match(/20(2[5-9])/)?.[0] || 'later'} graduation year — excludes a 2024 graduate`, snippet(jdText, m));
}

// ── category 3: required professional license she doesn't hold ─────────
// Proximity-gated to "required/must/essential/mandatory" so a JD that merely
// mentions the license in passing ("you'll work alongside CFA holders")
// doesn't trip this. CA and ICAI added 2026-09-25 (India's own chartered-
// accountant qualification and its issuing body — the UK list had ACA/ACCA
// but no India equivalent).
const LICENSE_TERM_RE = /\b(cfa\b|acca\b|\baca\b|cpa\b|cima\b|frm\b|ifoa\b|chartered\s+actuary|actuarial\s+qualification|mbbs\b|professional\s+engineer(?:ing)?\s+licen[cs]e|\bpe\s+licen[cs]e\b|llb\b|practising\s+certificate|bar\s+qualification|\bca\b|icai\b|chartered\s+accountant)\b/gi;
const REQUIRED_NEARBY_RE = /\b(required|must\s+(?:have|hold|be)|essential|mandatory|is\s+a\s+prerequisite)\b/i;

function checkLicense(jdText) {
  for (const m of jdText.matchAll(LICENSE_TERM_RE)) {
    const around = jdText.slice(Math.max(0, m.index - 60), m.index + 60);
    if (REQUIRED_NEARBY_RE.test(around)) {
      return no(`requires a professional licence she does not hold ("${m[0]}")`, snippet(jdText, m));
    }
  }
  return null;
}

// ── category 4: required specific degree she doesn't have ──────────────
const DEGREE_TERM_RE = /\b(computer\s+science|software\s+engineering|electrical\s+engineering|mechanical\s+engineering|civil\s+engineering|(?:an?\s+)?engineering|medicine|medical|\blaw\b|physics|a\s+stem\s+(?:field|degree|subject))\s+degree\b|\bdegree\s+in\s+(computer\s+science|engineering|medicine|law|physics|a\s+stem\s+(?:field|subject))\b|\bllb\s+required\b|\bmd\s+required\b/gi;
const DEGREE_REQUIRED_NEARBY_RE = /\b(required|must\s+(?:have|hold)|essential|mandatory|minimum\s+requirement)\b/i;

function checkDegree(jdText) {
  for (const m of jdText.matchAll(DEGREE_TERM_RE)) {
    const around = jdText.slice(Math.max(0, m.index - 60), m.index + 60);
    if (DEGREE_REQUIRED_NEARBY_RE.test(around) || /\bllb\s+required\b|\bmd\s+required\b/i.test(m[0])) {
      return no(`requires a degree she doesn't have ("${m[0].trim()}")`, snippet(jdText, m));
    }
  }
  return null;
}

// ── category 5: required native-level language other than English ──────
const LANGUAGE_RE = /\b(?:native|c1|c2|fluent)(?:\s+level)?\s+(french|german|mandarin|chinese|arabic|spanish|dutch|italian)\b|\b(french|german|mandarin|chinese|arabic|spanish|dutch|italian)\s+(?:c1|c2|native|fluency|fluent|mother[- ]tongue)\b/gi;

function checkLanguage(jdText) {
  const m = LANGUAGE_RE.exec(jdText);
  if (!m) return null;
  return no(`requires native/fluent ${(m[1] || m[2])} — English only`, snippet(jdText, m));
}

// ── category 6: title-vs-body mismatch ──────────────────────────────────
// "80%+ of the JD body is technical-implementation content" cannot be
// measured exactly from free text; this is a practical proxy, not a claim of
// precision — split into sentence-ish chunks, count what fraction are
// dominated by build/develop/SQL-DAX/ML/QA-testing language, and reject only
// on a clear majority (>=0.8), so a BA role that merely mentions "SQL" a few
// times among governance/stakeholder duties is not caught by this.
const MISMATCH_TITLE_RE = /\b(business analyst|pmo|consultant)\b/i;
const TECH_IMPL_RE = /\b(write|design|build|develop|maintain|optimi[sz]e|debug|deploy|refactor)\b[^.;\n]{0,40}\b(code|codebase|microservices?|apis?|apps?|applications?|algorithms?|models?|pipelines?|etl|ci\/cd|containers?|kubernetes|terraform)\b|\b(python|java|c\+\+|c#|golang|typescript|javascript|react|node\.?js|spark|hadoop|tensorflow|pytorch|scikit-learn|dbt|airflow|snowflake|databricks)\b|\bsql\b[^.;\n]{0,20}\bquer(?:y|ies)\b|\bdax\b|\bpower\s*query\b|\bmachine\s+learning\s+model|\bml\s+model|\bunit\s+tests?\b|\btest\s+automation\b|\bquality\s+assurance\s+testing\b/i;

function checkTitleBodyMismatch(jdText, title) {
  if (!title || !MISMATCH_TITLE_RE.test(title)) return null;
  const chunks = jdText.split(/(?<=[.!?])\s+|\n+|(?:^|\n)\s*[-•*]\s*/).map((s) => s.trim()).filter((s) => s.length > 15);
  if (chunks.length < 4) return null; // too little content to judge a ratio honestly
  const techChunks = chunks.filter((c) => TECH_IMPL_RE.test(c));
  const ratio = techChunks.length / chunks.length;
  if (ratio >= 0.8) {
    return no(
      `title "${title}" but ${Math.round(ratio * 100)}% of the JD body is software-engineering/data-build/QA content`,
      techChunks[0],
    );
  }
  return null;
}

// ── category 7 (India-specific): Senior title outside Big-4/MBB ─────────
// Mirrors eligibility.mjs's BIG4_MBB_TITLE / BIG4_STRETCH_TITLE pair (same
// firms, same fixed-list-not-regex-derived-from-company reasoning): at
// Deloitte/EY/KPMG/PwC and McKinsey/BCG/Bain specifically, "Senior Analyst /
// Senior Associate / Senior Consultant" is a genuine 2-3 year band. Anywhere
// else that title is a 5+ year band and is a hard over-level reject here —
// this is a JD-content veto, not a stretch flag, so no ambiguity: if the
// title says Senior and the company isn't Big-4/MBB, it's out.
const BIG4_MBB_COMPANY_RE = /\b(deloitte|ey|kpmg|pwc|mckinsey|bcg|bain)\b/i;
const SENIOR_TITLE_RE = /\bsenior\s+(analyst|associate|consultant)\b/i;

function checkSeniorTitleOverLevel(title, company) {
  if (!title || !SENIOR_TITLE_RE.test(title)) return null;
  if (BIG4_MBB_COMPANY_RE.test(String(company || ''))) return null;
  return no(`"${title.match(SENIOR_TITLE_RE)[0]}" at "${company || 'unknown company'}" — Senior Analyst/Associate/Consultant is a 5+ year band outside Big 4/MBB`, title);
}

// ── category 8 (India-specific): internal-only postings ─────────────────
// India job boards (Naukri, LinkedIn) surface internal-mobility postings
// that were never meant to be externally applied to — visible, but
// inaccessible. Reject on the JD's own words, not on the source board.
const INTERNAL_ONLY_RE = /\bfor\s+internal\s+candidates?\s+only\b|\binternal\s+candidates?\s+only\b|\bemployee\s+referral\s+only\b|\binternal\s+mobility\s+only\b|\binternal\s+applicants?\s+only\b|\bcurrent\s+employees?\s+only\b/i;

function checkInternalOnly(jdText) {
  const m = INTERNAL_ONLY_RE.exec(jdText);
  if (!m) return null;
  return no('posting is restricted to internal candidates / referrals', snippet(jdText, m));
}

// ── the gate ──────────────────────────────────────────────────────────────

const CHECKS_NO_TITLE = [checkGraduationCohort, checkLicense, checkDegree, checkLanguage, checkInternalOnly];

export function jdVetoCheck(jdText, profile, options = {}) {
  const text = String(jdText || '');
  const title = options.title || '';
  const company = options.company || '';

  // The over-level-title check reads the title/company pair, not the JD
  // body, so it runs even when jdText is empty — the same "title alone is
  // enough to know" reasoning eligibility.mjs already applies to SENIOR_TITLE.
  const seniorHit = checkSeniorTitleOverLevel(title, company);
  if (seniorHit) return seniorHit;

  if (!text.trim()) return { fit: true, reason: null, evidence: null };

  const yoe = checkYearsOfExperience(text, title);
  if (yoe) return yoe;

  for (const check of CHECKS_NO_TITLE) {
    const hit = check(text);
    if (hit) return hit;
  }

  const mismatch = checkTitleBodyMismatch(text, title);
  if (mismatch) return mismatch;

  return { fit: true, reason: null, evidence: null };
}

// ── rejection log ─────────────────────────────────────────────────────────

const LOG_DIR = 'output';
const LOG_FILE = path.join(LOG_DIR, 'jd-rejections.log');
const ROTATE_BYTES = 5 * 1024 * 1024;

/** Escape the one character that would break the ` | `-delimited line format. */
const logField = (v) => String(v ?? '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ').trim();

/**
 * Append one rejection line: "YYYY-MM-DD | company | role | url | reason | evidence".
 * Rotates output/jd-rejections.log to output/jd-rejections-YYYY-MM-DD.log
 * (today's date) once the live file exceeds 5MB, then starts a fresh one —
 * never overwrites, only appends or rotates-then-appends.
 */
export function logJdRejection({ company, role, url, reason, evidence }) {
  mkdirSync(LOG_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > ROTATE_BYTES) {
    let target = path.join(LOG_DIR, `jd-rejections-${today}.log`);
    let n = 2;
    // Same-day double rotation (a >5MB day, twice): don't clobber the first
    // rotated file, number the next one instead.
    while (existsSync(target)) { target = path.join(LOG_DIR, `jd-rejections-${today}-${n}.log`); n++; }
    renameSync(LOG_FILE, target);
  }

  const line = [today, company, role, url, reason, evidence].map(logField).join(' | ');
  appendFileSync(LOG_FILE, line + '\n', 'utf8');
}
