#!/usr/bin/env node
/**
 * experience-gate.mjs — hard gate on seniority/experience fit. INDIA PIPELINE.
 *
 * Written 2026-09-04 to close a real asymmetry: the UK pipeline has this gate
 * as deterministic CODE that runs identically every time, while India had the
 * same rule only as prompt text in modes/_profile.md — meaning it fired only
 * if whichever agent ran the scoring step happened to read and apply it.
 *
 * This is an INDEPENDENT India implementation, not a copy of the UK file. It
 * contains NO visa, SOC-code, sponsorship or salary-floor logic of any kind —
 * none of that applies to this candidate, who has full right to work in India.
 * The seniority signals below are calibrated to Indian corporate grades
 * (AVP/DGM/AGM/Associate Director), which the UK version does not contain.
 *
 * BASELINE: ~2 years of relevant experience (EMPLOYER_ONE PMO, Major Projects
 * & Programmes, 19 months) plus a short internship that does NOT count toward
 * seniority. EXPERIENCE_YEARS below is the one number this is calibrated to.
 *
 * TWO INDEPENDENT CHECKS — either one alone is enough to FAIL:
 *
 *   1. NUMERIC — the stated years-of-experience requirement.
 *      - A range ("3-6 years"): use ONLY the lower bound. A high upper bound
 *        is never on its own a reason to fail.
 *      - A single figure ("3 years", "minimum 3 years", "3+ years"): use it.
 *      - PASS if the figure is <= NUMERIC_PASS_CEILING (3).
 *      - No years stated at all -> the numeric check cannot fail on an
 *        absence. It passes, and the scope check still applies independently.
 *
 *   2. SCOPE — would the ACTUAL duties be beyond someone at this level,
 *      regardless of the number stated? This is the half that matters most.
 *      A posting saying "3+ years" while actually hiring an AVP, a Senior
 *      Manager or a Head of Function still FAILS. Signals: P&L/budget
 *      ownership, sole strategic authority, people management, and
 *      title-implied seniority.
 *
 * NEVER PASSES WITHOUT A REAL JD. Title-only text cannot be checked honestly,
 * so jdFetched:false always returns UNVERIFIED, never PASS. The caller must
 * not let an UNVERIFIED role reach the apply threshold unexamined. This
 * matters more in India than in the UK right now, because every current
 * top-scoring role is on Workday and no JD text has ever been fetched.
 *
 * These are heuristic regexes, not a certified taxonomy. Treat FAIL as
 * "flag for a human glance", not as infallible.
 */

import { pathToFileURL } from 'url';

export const EXPERIENCE_YEARS = 2;           // actual relevant experience
export const NUMERIC_PASS_CEILING = 3;       // stated requirement may be at most this

// ── title-implied seniority (checked against the TITLE only) ──────────────
// VERIFIED against config/profile.yml before shipping: none of the India
// target titles (target_roles.primary, tier_1_core, tier_2_programme_
// infrastructure, tier_3_adjacent, india_grade_equivalents) contain any of
// these, so this cannot exclude a role actually being targeted.
//
// India-specific grades included deliberately:
//   avp / svp / evp  — Assistant/Senior/Executive Vice President. "AVP" is the
//     grade that prompted this file: a Barclays posting titled "Senior Analyst"
//     scored 4.5 while its JD body described AVP-level team leadership.
//   dgm / agm / general manager — Deputy/Assistant General Manager, standard
//     Indian corporate grades sitting well above analyst level.
//   "senior manager" — matched as a PHRASE so that "Program Manager", which IS
//     a target title in india_grade_equivalents, is not caught.
//   "associate director" — matched as a phrase so "Associate Consultant" and
//     "Strategy & Operations Associate" are not caught.
export const TITLE_SENIORITY_RE = new RegExp(
  '\\b(director|head\\s+of|vice\\s+president|avp|svp|evp|vp|principal|chief|'
  + 'executive\\s+director|senior\\s+manager|sr\\.?\\s*manager|'
  + 'general\\s+manager|dgm|agm)\\b'
  // "Partner" ONLY in the equity/consultancy-grade sense. Measured against
  // the live pending queue 2026-09-04: of 7 titles containing "partner",
  // ZERO were that grade — they were "Senior Analyst, Finance Business
  // Partner", "Sales Partner Compliance Operations - Sr. Risk Analyst",
  // "Program Manager, Provider Partnerships" and similar. A bare \bpartner\b
  // had a 100% false-positive rate on real data, worse than the "employment"
  // marker rejected earlier for 40%. "Business Partner" and "Finance
  // Business Partner" are ordinary mid-level roles and squarely on target.
  // So: match only a standalone grade — the whole title, or leading/trailing
  // "Partner" delimited by comma/dash, or an explicit Managing/Equity/Senior
  // Partner. Never "<something> Partner" as a compound, never "Partnership".
  + '|^\\s*partners?\\s*$'
  + '|^\\s*partner\\s*[,\\-–—]'
  + '|[,\\-–—]\\s*partner\\s*$'
  + '|\\b(managing|equity|senior|founding)\\s+partner\\b'
  + '|\\bassociate\\s+director\\b'
  // A title that STARTS with a bare "Manager" is the consultancy Manager grade
  // (PwC/Deloitte "Manager, X Practice" = 7+ years). Anchored to the start on
  // purpose: "Program Manager" and "Programme Management Officer" are real
  // target grades in config/profile.yml and must NOT be caught.
  + '|^\\s*manager\\b',
  'i',
);

// ── context exemptions: the title REFERENCES a grade, it is not THAT grade ──
// Added 2026-09-07. TITLE_SENIORITY_RE answers "does a senior-grade word appear
// in this title", which is not the same question as "is this title that grade".
// Real postings that were being wrongly failed:
//
//   "Business Analyst supporting the Senior Manager"   -> an analyst
//   "Strategy Analyst, Office of the Chief Executive"  -> a staff analyst
//   "Chief of Staff"                                   -> at a startup, an IC
//                                                         coordination role, and
//                                                         squarely a target shape
//   "Programme Analyst reporting to the Director"      -> an analyst
//
// Each exemption is deliberately narrow. The default remains FAIL: a token is
// only forgiven when the surrounding words make it grammatically SOMEONE
// ELSE'S grade. "Senior Manager, Business Planning" has nothing before the
// token and is still failed, which is correct — that IS the grade.

// Words that make what follows a person the candidate works WITH or FOR,
// not the candidate's own grade. Anchored to the end of the preceding text so
// the attachment word must sit immediately before the seniority token (an
// optional article between them).
const ATTACHMENT_BEFORE_RE =
  /\b(?:to|for|with|under|supporting|support|supports|assisting|assist|assists|reporting|reports|alongside|serving|serves|partnering|liaising|liaison)\s+(?:the\s+|a\s+|an\s+|our\s+)?(?:[a-z]+\s+)?$/i;

// "Director's Office", "Vice President's Office" — a staff/support function,
// named after the principal it serves.
const OFFICE_AFTER_RE = /^(?:['’]s|s)?\s*office\b/i;

// "Office of the Chief Executive", "Office of the Director".
// One optional intervening word so a two-token grade is fully covered:
// in "Office of the Chief Executive" the token that matches may be
// "executive", whose preceding text is "...Office of the Chief ".
const OFFICE_BEFORE_RE = /\boffice\s+of\s+(?:the\s+)?(?:[a-z]+\s+)?$/i;

// "Chief of Staff" is not a chief. It is the single most common startup title
// for exactly the strategy/ops/analysis work this candidate does, and gating it
// on the word "chief" is a pure false negative.
const CHIEF_OF_STAFF_AFTER_RE = /^\s*of\s+staff\b/i;

/**
 * True when a matched seniority token is a REFERENCE to someone else's grade
 * rather than the grade of the advertised role.
 *
 * @param {string} title - The normalised title.
 * @param {number} index - Start index of the match within `title`.
 * @param {string} matched - The matched token text.
 * @returns {boolean}
 */
export function isSeniorityReference(title, index, matched) {
  const before = title.slice(0, index);
  const after = title.slice(index + matched.length);

  if (ATTACHMENT_BEFORE_RE.test(before)) return true;
  if (OFFICE_BEFORE_RE.test(before)) return true;
  if (OFFICE_AFTER_RE.test(after)) return true;
  if (/^chief$/i.test(matched.trim()) && CHIEF_OF_STAFF_AFTER_RE.test(after)) return true;

  return false;
}

/**
 * Every seniority token in a title, with position — so each can be judged in
 * context independently. A title is only cleared when EVERY match is a mere
 * reference; one genuine grade token is still a FAIL.
 *
 * @param {string} title - Already normalised.
 * @returns {Array<{text: string, index: number}>}
 */
function seniorityMatches(title) {
  const re = new RegExp(TITLE_SENIORITY_RE.source, 'gi');
  const out = [];
  for (const m of title.matchAll(re)) {
    out.push({ text: m[0], index: m.index });
  }
  return out;
}

/**
 * Normalise a title before seniority matching.
 *
 * Added 2026-09-04 after a real miss. PwC posts titles as
 * "IN_Senior Manager_ Capital Projects_ CPI_ Advisory_ Kolkata". JavaScript's
 * \b treats "_" as a WORD character, so "_Senior" has no word boundary before
 * "Senior" and the pattern never fired — a Senior Manager requisition needing
 * 7+ years sailed through the gate. Underscores and slashes become spaces so
 * the boundaries behave the way a reader would expect.
 */
export function normaliseTitle(title) {
  return String(title || '').replace(/[_/|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── scope/depth signals (checked against the JD BODY) ─────────────────────
// Kept to phrasing that reliably signals leadership/expert scope rather than
// ordinary senior-analyst language ("end to end", "strategic thinking"), which
// would over-trigger on perfectly appropriate mid-level JDs.
export const SCOPE_SIGNALS = [
  [/\bown(s|ing)?\s+(the\s+)?p\s?&\s?l\b/i, 'owns the P&L'],
  [/\bfull\s+p\s?&\s?l\s+responsibility\b/i, 'full P&L responsibility'],
  [/\bprofit\s+(and|&)\s+loss\s+(ownership|accountability)\b/i, 'P&L ownership'],
  [/\bset(s|ting)?\s+(the\s+)?(overall\s+)?strategy\b/i, 'sets the overall strategy'],
  [/\bdefine(s|d)?\s+(the\s+)?strategic\s+direction\b/i, 'defines strategic direction'],
  [/\bsole\s+decision[- ]?maker\b/i, 'sole decision-maker'],
  [/\bfully\s+accountable\s+for\b/i, 'fully accountable for (organisation-level outcome)'],
  [/\bmanag(e|es|ing)\s+(a\s+)?team\s+of\s+\d+/i, 'directly manages a team'],
  // NARROWED 2026-09-04. The original was a bare /\bdirect reports\b/, which
  // failed any JD merely CONTAINING the phrase — including "this role has no
  // direct reports", which is a POSITIVE signal for this candidate. Now it
  // requires the candidate to actually be given reports: a count, or an
  // explicit "you will have / responsible for / manage" lead-in.
  [/\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+direct\s+reports\b/i, 'has a stated number of direct reports'],
  [/\b(you\s+will\s+have|responsible\s+for|manag(e|es|ing))\s+(\d+\s+)?direct\s+reports\b/i, 'is given direct reports'],
  // NARROWED for the same reason: "support line management with reporting"
  // describes an analyst SUPPORTING managers, which is exactly this
  // candidate's level, and was being failed. Now requires the responsibility
  // to be the candidate's own.
  [/\b(line\s+manag(e|ement|ing)\s+(responsibility|duties|of)|responsib(le|ility)\s+for\s+line\s+manag)/i, 'holds line-management responsibility'],
  [/\bpeople\s+manag(er|ement)\s+responsibilit/i, 'people-management responsibility'],
  [/\bmentor(ing)?\s+and\s+manag(e|ing)\s+(a\s+)?team\b/i, 'mentors and manages a team'],
  // Body-level GRADE statements. Added 2026-09-04 from real evidence: once the
  // ATS-API JD fetch started working, both Barclays postings (rows 19 and 5,
  // scored 4.5 and 4.4, titled merely "Senior Analyst" and "Business Analyst")
  // turned out to contain the line "Assistant Vice President Expectations".
  // The grade is stated in the BODY, never in the title — so a title-only
  // check can never see it. This is the single highest-value scope signal
  // found so far: it caught the top-ranked India role, for which a CV and
  // cover letter had already been generated.
  [/\bassistant\s+vice\s+president\s+expectations?\b/i, 'JD states Assistant Vice President grade expectations'],
  [/\b(vice\s+president|director|managing\s+director)\s+expectations?\b/i, 'JD states VP/Director grade expectations'],
  [/\bexpert[- ]level\b/i, 'expert-level requirement'],
  [/\bsubject\s+matter\s+expert\b/i, 'subject matter expert requirement'],
  [/\bdeep\s+(specialist|domain|technical)\s+(knowledge|expertise)\b/i, 'deep specialist/domain expertise'],
  [/\bmulti[- ]million(\s*(dollar|\$|rupee|inr))?\s+budget\b/i, 'multi-million budget ownership'],
  [/\bown(s|ed)?\s+(a\s+)?budget\s+of\s+(₹|rs\.?|inr|\$)?\s?\d/i, 'owns a stated budget'],
  [/\b(\d+\s*)?crore\s+(budget|p&l|portfolio)\b/i, 'crore-scale budget/P&L ownership'],
  [/\bnegotiat(e|es|ing)\s+(multi[- ]million|large[- ]scale)\s+contracts\b/i, 'negotiates large-scale contracts independently'],
];

// Phrasings where "N years" describes the COMPANY, not the candidate:
// "established for 35 years", "backed by more than 25 years of experience".
const COMPANY_HISTORY_RE = /\b(?:established|trading|operating|founded|running|in\s+business|serving|delivering|providing|backed\s+by|celebrating|proud\s+to\s+have\s+been)\b[^.]{0,40}?\b\d{1,2}\+?\s*years?\b|\b(?:over|more\s+than|nearly|almost)\s+\d{1,2}\s*years?\b[^.]{0,30}?\b(?:in\s+business|of\s+trading|experience\s+as\s+a\s+(?:company|business|firm)|history|heritage|legacy)\b/gi;

// Figures that are an AGE or a LOOK-BACK WINDOW, not an experience requirement.
const AGE_OR_WINDOW_RE = /\b\d{1,2}\+?\s*years?\s*(?:old|of\s+age)\b|\b(?:in|over|during|within)\s+the\s+(?:past|last|previous)\s+\d{1,2}\s*years?\b/gi;

/**
 * Extract the years-of-experience requirement.
 * Ranges use the lower bound. Where several distinct mentions appear, the
 * MAXIMUM of their lower bounds is used — the real bar a JD sets is its
 * highest explicit ask, not its lowest.
 * Returns the number, or null if no years-of-experience phrase is found.
 */
export function extractYearsRequirement(text) {
  const t = String(text || '')
    .replace(COMPANY_HISTORY_RE, (m) => ' '.repeat(m.length))
    .replace(AGE_OR_WINDOW_RE, (m) => ' '.repeat(m.length));
  const lowerBounds = [];

  for (const m of t.matchAll(/(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\+?\s*years?\b/gi)) {
    lowerBounds.push(Number(m[1]));
  }
  const rangeSpans = [...t.matchAll(/\d{1,2}\s*(?:-|–|—|to)\s*\d{1,2}\+?\s*years?\b/gi)]
    .map((m) => [m.index, m.index + m[0].length]);
  const insideRange = (idx) => rangeSpans.some(([a, b]) => idx >= a && idx < b);
  for (const m of t.matchAll(/(?:minimum\s+(?:of\s+)?|at\s+least\s+|min\.?\s+)?(\d{1,2})\s*\+?\s*years?'?\b/gi)) {
    if (!insideRange(m.index)) lowerBounds.push(Number(m[1]));
  }

  if (!lowerBounds.length) return null;
  return Math.max(...lowerBounds);
}

/** The numeric half of the gate. */
export function numericCheck(years) {
  if (years === null || years === undefined) {
    return { pass: true, reason: 'no explicit years-of-experience requirement stated' };
  }
  if (years <= NUMERIC_PASS_CEILING) {
    return { pass: true, reason: `stated requirement (${years}y lower bound) is within reach` };
  }
  return { pass: false, reason: `stated requirement (${years}y lower bound) exceeds the ${NUMERIC_PASS_CEILING}y ceiling` };
}

/**
 * Is a matched scope signal NEGATED by the words just before it?
 *
 * Added 2026-09-04 after a real defect: "This role has no direct reports" and
 * "carries no line management responsibility" were both being FAILED, when
 * both are positive signals for this candidate — they describe an individual
 * contributor role, which is exactly what she wants. A scope signal only
 * counts when the JD is ASSERTING the responsibility, not denying it.
 *
 * Window is deliberately short (48 chars) so a negation earlier in an
 * unrelated sentence cannot cancel a genuine signal later.
 */
const NEGATOR_RE = /\b(no|not|never|without|excluding|free\s+of|zero)\b[^.]{0,48}$/i;

export function isNegated(text, matchIndex) {
  const before = String(text || '').slice(Math.max(0, matchIndex - 48), matchIndex);
  return NEGATOR_RE.test(before);
}

/** The scope half. Title checked separately from JD body. */
export function scopeCheck(title, jdText) {
  const t = normaliseTitle(title);
  // Judge every seniority token in context. A title fails on the first token
  // that is genuinely the advertised grade; tokens that merely name someone
  // the role supports, or a function named after a principal, are skipped.
  for (const { text, index } of seniorityMatches(t)) {
    if (isSeniorityReference(t, index, text)) continue;
    return { pass: false, reason: `title-implied seniority ("${text}")` };
  }
  const body = String(jdText || '');
  for (const [re, reason] of SCOPE_SIGNALS) {
    const m = body.match(re);
    if (!m) continue;
    if (isNegated(body, m.index)) continue;   // "no direct reports" is a PASS signal
    return { pass: false, reason };
  }
  return { pass: true, reason: 'no scope/depth signal beyond this level' };
}

/**
 * The gate. Scope failing OVERRIDES a numeric pass — a role stated as
 * "3+ years" but written for an AVP or Head of Function is still a FAIL.
 */
export function experienceGate({ title, jdText, jdFetched }) {
  if (!jdFetched) {
    return { status: 'UNVERIFIED', reason: 'no JD fetched — experience requirement not checked' };
  }
  const years = extractYearsRequirement(jdText);
  const numeric = numericCheck(years);
  const scope = scopeCheck(title, jdText);

  if (!scope.pass) return { status: 'FAIL', reason: `scope: ${scope.reason}`, years, check: 'scope' };
  if (!numeric.pass) return { status: 'FAIL', reason: `numeric: ${numeric.reason}`, years, check: 'numeric' };
  return { status: 'PASS', reason: `${numeric.reason}; ${scope.reason}`, years, check: 'both' };
}

// ── self-test ─────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (label, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL: ${label}`); } };

  // numeric extraction
  ok('single figure', extractYearsRequirement('Minimum 3 years experience') === 3);
  ok('plus figure', extractYearsRequirement('3+ years of experience') === 3);
  ok('range uses lower bound', extractYearsRequirement('3-6 years of experience') === 3);
  ok('range with "to"', extractYearsRequirement('2 to 8 years experience') === 2);
  ok('multiple mentions take max lower bound',
    extractYearsRequirement('3+ years in analysis and 5+ years in stakeholder management') === 5);
  ok('no figure returns null', extractYearsRequirement('You will analyse data.') === null);
  ok('company history ignored',
    extractYearsRequirement('A firm backed by more than 35 years of industry experience.') === null);
  ok('age/window ignored',
    extractYearsRequirement('Resided in the country within the past 10 years.') === null);

  // numeric check
  ok('3y passes', numericCheck(3).pass === true);
  ok('4y fails', numericCheck(4).pass === false);
  ok('null passes', numericCheck(null).pass === true);
  ok('range lower bound 3 passes', numericCheck(extractYearsRequirement('3-10 years')).pass === true);

  // scope — India grades must FAIL
  ok('AVP title fails', scopeCheck('AVP - Business Analysis', 'Analyse data.').pass === false);
  ok('VP title fails', scopeCheck('VP Strategy', 'Analyse data.').pass === false);
  ok('Senior Manager fails', scopeCheck('Senior Manager, Business Planning & Analysis', 'x').pass === false);
  ok('Director fails', scopeCheck('Director of Strategy', 'x').pass === false);
  ok('Head of fails', scopeCheck('Head of PMO', 'x').pass === false);
  ok('DGM fails', scopeCheck('DGM Projects', 'x').pass === false);
  ok('Associate Director fails', scopeCheck('Associate Director, Advisory', 'x').pass === false);
  ok('Principal fails', scopeCheck('Principal Consultant', 'x').pass === false);

  // scope — real target titles must PASS
  ok('Business Analyst passes', scopeCheck('Business Analyst', 'Analyse data and report.').pass === true);
  ok('Senior Analyst passes', scopeCheck('Senior Analyst - Business Analytics', 'Analyse data.').pass === true);
  ok('Senior Consultant passes', scopeCheck('Senior Consultant', 'Analyse data.').pass === true);
  ok('Associate Consultant passes', scopeCheck('Associate Consultant', 'Analyse data.').pass === true);
  ok('Program Manager passes (target grade)', scopeCheck('Program Manager', 'Analyse data.').pass === true);
  ok('PMO Analyst passes', scopeCheck('PMO Analyst', 'Analyse data.').pass === true);
  ok('Strategy & Operations Associate passes',
    scopeCheck('Strategy & Operations Associate', 'Analyse data.').pass === true);

  // ── CONTEXT-AWARE seniority (2026-09-07) ──
  // A grade token that belongs to SOMEONE ELSE must not fail the role.
  ok('"supporting the Senior Manager" passes (analyst supporting a manager)',
    scopeCheck('Business Analyst supporting the Senior Manager', 'x').pass === true);
  ok('"reporting to the Director" passes',
    scopeCheck('Programme Analyst reporting to the Director', 'x').pass === true);
  ok('"reports to VP" passes',
    scopeCheck('Business Analyst, reports to VP Operations', 'x').pass === true);
  ok('"to the Director" in parentheses passes',
    scopeCheck('Business Analyst (reporting to Senior Manager)', 'x').pass === true);
  ok('"Office of the Chief Executive" passes',
    scopeCheck('Strategy Analyst, Office of the Chief Executive', 'x').pass === true);
  ok('"Director\'s Office" passes',
    scopeCheck("Business Analyst, Director's Office", 'x').pass === true);
  ok('"Chief of Staff" passes (startup IC/ops role, not a chief)',
    scopeCheck('Chief of Staff', 'x').pass === true);
  ok('"Chief of Staff to the Founder" passes',
    scopeCheck('Chief of Staff to the Founder', 'x').pass === true);
  ok('"Founder\'s Office" passes (no grade token at all)',
    scopeCheck("Strategy & Operations - Founder's Office", 'x').pass === true);
  ok('"Assistant Manager" passes (Indian mid grade, not the consultancy Manager)',
    scopeCheck('Assistant Manager - Business Excellence', 'x').pass === true);
  ok('"Deputy Manager" passes',
    scopeCheck('Deputy Manager, Project Controls', 'x').pass === true);

  // ── and the exemption must NOT become a loophole ──
  ok('bare "Senior Manager, X" STILL fails (it is the grade)',
    scopeCheck('Senior Manager, Business Planning & Analysis', 'x').pass === false);
  ok('"Senior Manager for Analytics" STILL fails (attachment word is AFTER)',
    scopeCheck('Senior Manager for Analytics', 'x').pass === false);
  ok('"Director of Strategy" STILL fails',
    scopeCheck('Director of Strategy', 'x').pass === false);
  ok('"Chief Data Officer" STILL fails (chief, but not chief of staff)',
    scopeCheck('Chief Data Officer', 'x').pass === false);
  ok('"AVP - Business Analysis" STILL fails',
    scopeCheck('AVP - Business Analysis', 'x').pass === false);
  ok('"Head of PMO" STILL fails',
    scopeCheck('Head of PMO', 'x').pass === false);
  // One exempt token must not clear a second, genuine one.
  ok('exempt token does not rescue a real grade elsewhere in the title',
    scopeCheck('Senior Manager supporting the Director', 'x').pass === false);
  ok('"Manager, X Practice" STILL fails (consultancy Manager grade)',
    scopeCheck('Manager, Infra Transformation Practice', 'x').pass === false);

  // scope — body signals
  ok('P&L ownership fails', scopeCheck('Business Analyst', 'You will own the P&L.').pass === false);
  ok('direct reports fails', scopeCheck('Business Analyst', 'You will have 4 direct reports.').pass === false);

  // NEGATION — an individual-contributor role must NOT be failed. These are
  // positive signals for this candidate and were being rejected before
  // 2026-09-04.
  ok('"no direct reports" passes',
    scopeCheck('Business Analyst', 'This role has no direct reports.').pass === true);
  ok('"not have direct reports" passes',
    scopeCheck('Business Analyst', 'You will not have direct reports; individual contributor role.').pass === true);
  ok('"no line management responsibility" passes',
    scopeCheck('Business Analyst', 'The position carries no line management responsibility.').pass === true);
  ok('"without direct reports" passes',
    scopeCheck('Business Analyst', 'An individual contributor position without direct reports.').pass === true);
  ok('"no people management" passes',
    scopeCheck('Business Analyst', 'Individual contributor role with no people management.').pass === true);

  // SUPPORTING managers is this candidate's actual level and must PASS.
  ok('"support line management" passes',
    scopeCheck('Business Analyst', 'You will support line management with reporting.').pass === true);
  ok('"reporting to line management" passes',
    scopeCheck('Business Analyst', 'Reporting to line management on programme risk.').pass === true);

  // But a genuine negation must not cancel a LATER genuine signal.
  ok('negation does not cancel a later real signal',
    scopeCheck('Business Analyst',
      'No prior experience required. You will own the P&L for the division.').pass === false);
  ok('team of N fails', scopeCheck('Business Analyst', 'Managing a team of 6 analysts.').pass === false);
  ok('crore budget fails', scopeCheck('Business Analyst', 'Own a 50 crore budget.').pass === false);
  ok('ordinary analyst body passes',
    scopeCheck('Business Analyst', 'Produce dashboards and support stakeholders.').pass === true);

  // the headline rule: scope overrides a numeric pass
  const g = experienceGate({
    title: 'Business Analyst',
    jdText: '3-6 years of experience. You will own the P&L for the division.',
    jdFetched: true,
  });
  ok('scope overrides numeric pass', g.status === 'FAIL' && g.check === 'scope');

  const g2 = experienceGate({ title: 'Business Analyst', jdText: '3 years experience.', jdFetched: true });
  ok('clean pass', g2.status === 'PASS');

  const g3 = experienceGate({ title: 'Business Analyst', jdText: '', jdFetched: false });
  ok('no JD -> UNVERIFIED not PASS', g3.status === 'UNVERIFIED');

  const g4 = experienceGate({ title: 'Senior Analyst', jdText: '3+ years. Mentoring and managing a team.', jdFetched: true });
  ok('AVP-style body on analyst title fails', g4.status === 'FAIL');

  console.log(`${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) selfTest();
