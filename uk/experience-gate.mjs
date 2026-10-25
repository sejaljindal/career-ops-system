#!/usr/bin/env node
/**
 * experience-gate.mjs — hard gate on seniority/experience fit.
 *
 * SEPARATE FROM, AND APPLIED AFTER, the SOC/salary/visa gates in
 * run-daily.mjs's hardGate(). Never modifies those. This gate exists because a
 * role can pass SOC eligibility and clear the salary floor while still being a
 * role the candidate would be screened out of at CV stage (years) or interview
 * stage (depth) — and skills-keyword matching does not correct for that.
 *
 * BASELINE: ~2 years of relevant experience (EMPLOYER_ONE PMO, Major Projects &
 * Programmes) plus a short internship that does not count toward seniority.
 * See EXPERIENCE_YEARS below — the one number this whole module is calibrated
 * against.
 *
 * TWO INDEPENDENT CHECKS, either one alone is enough to FAIL:
 *
 *   1. NUMERIC — the stated years-of-experience requirement.
 *      - A range ("3-6 years"): use ONLY the lower bound. The upper bound is
 *        never a reason to fail, no matter how high it goes.
 *      - A single figure ("3 years", "minimum 3 years", "3+ years"): use that
 *        figure directly.
 *      - PASS if the resulting number is <= EXPERIENCE_YEARS + 1 (i.e. <= 3).
 *        FAIL if clearly above it (4+).
 *      - No years stated at all -> the numeric check cannot fail on an absence;
 *        it passes, and the scope check below still applies independently.
 *
 *   2. SCOPE — would the ACTUAL duties be beyond someone at this level,
 *      regardless of what number is stated? Judged the way a recruiter would,
 *      from four signal families: P&L/budget ownership, sole strategic
 *      authority, direct people management, and title-implied seniority
 *      (Director / Head of / VP / Principal / Lead / Chief / Executive) or
 *      expert-level/deep-specialist domain depth. A "3-6 years" posting
 *      written for a Head of Department still FAILS on scope even though the
 *      numeric check alone would pass.
 *
 * NEVER PASSES WITHOUT A REAL JD. Title-only or listing-page text cannot be
 * checked honestly, so `jdFetched: false` always returns UNVERIFIED, never
 * PASS. The caller is responsible for not letting an UNVERIFIED role reach the
 * apply threshold (see run-daily.mjs EXPERIENCE_UNVERIFIED_CAP).
 *
 * These signal lists are heuristic regexes, not a certified taxonomy — they
 * are exported so they can be read, tested and tuned. False positives are
 * possible on unusually worded JDs; treat FAIL as "flag for a human glance",
 * not as infallible.
 */

import { isMainModule } from './lib/is-main-module.mjs';

export const EXPERIENCE_YEARS = 2;          // your actual relevant experience
export const NUMERIC_PASS_CEILING = 3;       // stated requirement may be at most this

// ── title-implied seniority (checked against the TITLE only) ──────────
// Confirmed against config/profile.yml target_roles.primary before shipping:
// none of the 51 target titles contain any of these words, so this cannot
// exclude a role you are actually targeting.
// "partner" = equity/salaried partner at a consultancy or professional-services
// firm, ~15+ years. "band 8/9" = the NHS Agenda for Change grades that sit at
// deputy-director level and above (band 8a is already ~£56k senior-manager
// territory; band 9 is executive). Both were added after real postings passed
// this gate: "Partner - Strategy Consulting/Commercial Due Diligence" and
// "Band 9 Director of Digital Strategy". Re-verified against all 72 entries in
// config/profile.yml (target_roles.primary + practice_names): none contain
// "partner", "band" or "architect", so none of these can exclude a role you
// are actually targeting.
// NARROWED 2026-09-04: "partner" moved out of the bare alternation.
// Measured on the India pipeline's live 1,350-row pending queue, of 7 real
// titles containing "partner", ZERO were the equity/consultancy grade — they
// were "Senior Analyst, Finance Business Partner", "Sales Partner Compliance
// Operations - Sr. Risk Analyst", "Program Manager, Provider Partnerships"
// and similar. A bare \bpartner\b had a 100% false-positive rate on real
// data, worse than the "employment" agency marker rejected for 40%.
// "Business Partner" / "Finance Business Partner" / "HR Business Partner"
// are ordinary mid-level roles squarely on target for this candidate, and
// the UK gate was silently dropping every one of them.
//
// Now matched only as a standalone grade: the whole title, a leading or
// trailing "Partner" delimited by comma/dash, or an explicit
// Managing/Equity/Senior/Founding Partner. Never "<something> Partner" as a
// compound, never "Partnership". The real posting that prompted adding
// "partner" originally — "Partner - Strategy Consulting/Commercial Due
// Diligence" — still fails, via the leading-delimited form.
export const TITLE_SENIORITY_RE = new RegExp(
  '\\b(director|head of|vice president|\\bvp\\b|principal|chief|executive|lead|band\\s*[89])\\b'
  + '|^\\s*partners?\\s*$'
  + '|^\\s*partner\\s*[,\\-–—]'
  + '|[,\\-–—]\\s*partner\\s*$'
  + '|\\b(managing|equity|senior|founding)\\s+partner\\b'
  // Added 2026-09-07 — a gap found while porting the context-exemption work
  // from the India pipeline, which had these and the UK did not. A UK
  // consultancy "Manager" or "Senior Manager" grade is a 7+ year hire, same
  // as in India; without these, "Manager, Infrastructure Advisory" and
  // "Senior Manager, Business Planning" passed the gate untouched.
  //
  // Both are anchored exactly as the India file anchors them:
  //   "senior manager" as a PHRASE, so "Programme Manager" is not caught;
  //   bare "manager" only at the START of the title, so "Project Manager",
  //   "Programme Manager" and "Programme Management Officer" — all real
  //   target grades — are not caught.
  + '|\\bsenior\\s+manager\\b'
  + '|\\bsr\\.?\\s*manager\\b'
  + '|\\bassociate\\s+director\\b'
  + '|^\\s*manager\\b',
  'i',
);

// ── scope/depth signals (checked against the JD BODY) ──────────────────
// Each entry: [regex, human-readable reason]. Kept to phrasing that reliably
// signals executive/expert scope rather than generic senior-analyst language
// ("end to end", "strategic thinking") that would over-trigger on ordinary
// mid-level JDs.
export const SCOPE_SIGNALS = [
  [/\bown(s|ing)?\s+(the\s+)?p\s?&\s?l\b/i, 'owns the P&L'],
  [/\bfull\s+p\s?&\s?l\s+responsibility\b/i, 'full P&L responsibility'],
  [/\bset(s|ting)?\s+(the\s+)?(overall\s+)?strategy\b/i, 'sets the overall strategy'],
  [/\bdefine(s|d)?\s+(the\s+)?strategic\s+direction\b/i, 'defines strategic direction'],
  [/\bsole\s+decision[- ]?maker\b/i, 'sole decision-maker'],
  [/\bfully\s+accountable\s+for\b/i, 'fully accountable for (organisation-level outcome)'],
  [/\bmanag(e|es|ing)\s+(a\s+)?team\s+of\s+\d+/i, 'directly manages a team'],
  // NARROWED 2026-09-04, after the India port of this file surfaced the bug.
  // The original was a bare /\bdirect reports\b/, which failed any JD merely
  // CONTAINING the phrase — including "this role has no direct reports",
  // which is a POSITIVE signal for this candidate, and "support line
  // management with reporting", which describes her actual level. Both were
  // being dropped. See also isNegated() below: the two fixes are separate and
  // both are needed.
  [/\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+direct\s+reports\b/i, 'has a stated number of direct reports'],
  [/\b(you\s+will\s+have|responsible\s+for|manag(e|es|ing))\s+(\d+\s+)?direct\s+reports\b/i, 'is given direct reports'],
  [/\b(line\s+manag(e|ement|ing)\s+(responsibility|duties|of)|responsib(le|ility)\s+for\s+line\s+manag)/i, 'holds line-management responsibility'],
  [/\bexpert[- ]level\b/i, 'expert-level requirement'],
  [/\bsubject\s+matter\s+expert\b/i, 'subject matter expert requirement'],
  [/\bdeep\s+(specialist|domain|technical)\s+(knowledge|expertise)\b/i, 'deep specialist/domain expertise'],
  [/\bworld[- ]class\s+expertise\b/i, 'world-class expertise requirement'],
  [/\bmulti[- ]million(\s*(pound|£|dollar|\$))?\s+budget\b/i, 'multi-million budget ownership'],
  [/\bown(s|ed)?\s+(a\s+)?budget\s+of\s+£?\$?\d/i, 'owns a stated budget'],
  [/\bnegotiat(e|es|ing)\s+(multi[- ]million|large[- ]scale)\s+contracts\b/i, 'negotiates large-scale contracts independently'],
];

/**
 * Extract the years-of-experience requirement.
 *
 * Ranges use the lower bound only. When several distinct years-experience
 * mentions appear in one JD (e.g. "3+ years in analysis, 5+ years in
 * stakeholder management"), the MAXIMUM of their lower bounds is used — the
 * real bar a JD sets is its highest explicit ask, not its lowest. This is an
 * interpretation choice where the spec did not address multiple mentions;
 * flagged here rather than applied silently.
 *
 * Returns the number, or null if no years-of-experience phrase is found.
 */
// Phrasings where "N years" describes the COMPANY, not what it wants from a
// candidate: "established for 35 years", "trading for 20 years", "over 40
// years in business". Same class of exclusion as the hours/holiday figures
// this already ignores — a real FDM Group posting was rejected on a phantom
// "35y requirement" that was actually the firm's own age in its boilerplate.
// "backed by" is in the lead-in list because of the real FDM Group posting:
// "a global leader in tech and business talent solutions, backed by more than
// 35 years of industry experience" — the firm's credentials, not the
// candidate's. Note "N years of industry experience" is deliberately NOT
// excluded on its own: a JD can legitimately demand "5 years of industry
// experience" of a candidate. Only the company-subject lead-in makes it safe
// to discard.
const COMPANY_HISTORY_RE = /\b(?:established|trading|operating|founded|running|in\s+business|serving|delivering|providing|backed\s+by|celebrating|proud\s+to\s+have\s+been)\b[^.]{0,40}?\b\d{1,2}\+?\s*years?\b|\b(?:over|more\s+than|nearly|almost)\s+\d{1,2}\s*years?\b[^.]{0,30}?\b(?:in\s+business|of\s+trading|experience\s+as\s+a\s+(?:company|business|firm)|history|heritage)\b/gi;

// Figures in "N years" form that are an AGE or a LOOK-BACK WINDOW, not an
// experience requirement. Found in NHS right-to-work boilerplate carried on
// every jobs.nhs.uk advert: "Adult dependants (over 18 years old)" and
// "resided ... in the past 10 years". Neither says anything about what the
// employer wants from a candidate's career.
const AGE_OR_WINDOW_RE = /\b\d{1,2}\+?\s*years?\s*(?:old|of\s+age)\b|\b(?:in|over|during|within)\s+the\s+(?:past|last|previous)\s+\d{1,2}\s*years?\b/gi;

export function extractYearsRequirement(text) {
  // Blank out company-history spans before any matching, so the digits inside
  // them cannot be read as a requirement by either pattern below. Replacing
  // with spaces (not '') keeps every other match index intact.
  const t = String(text || '')
    .replace(COMPANY_HISTORY_RE, (m) => ' '.repeat(m.length))
    .replace(AGE_OR_WINDOW_RE, (m) => ' '.repeat(m.length));
  const lowerBounds = [];

  // Range: "3-6 years", "2 to 4 years", "0-5 years"
  for (const m of t.matchAll(/(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\+?\s*years?\b/gi)) {
    lowerBounds.push(Number(m[1]));
  }
  // Single figure, with optional qualifier: "3 years", "minimum 3 years",
  // "at least 3 years", "3+ years". Only counted if NOT already inside a range
  // match (avoid double-counting "3" from "3-6 years" as a separate single).
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

/** The scope half of the gate. Title checked separately from JD body. */
// NHS Agenda for Change bands 1-6. Where a title carries one of these, the
// BAND is the authoritative seniority signal and the word "lead" is not:
// the NHS uses "Lead" loosely in junior titles ("Band 5 Lead Data Analysis
// and Information Officer" is an early-career post). Band 7+ is genuinely
// senior, so "lead" still trips there, and "lead" keeps its normal meaning
// on every non-NHS title. Deliberately narrow: ONLY "lead" is softened —
// Director/Head of/Chief/VP/Partner still trip at any band.
const JUNIOR_NHS_BAND_RE = /\bband\s*[1-6]\b/i;

/**
 * Is a matched scope signal NEGATED by the words just before it?
 *
 * Added 2026-09-04 after a real defect: "This role has no direct reports" and
 * "carries no line management responsibility" were both being FAILED, when
 * both are positive signals for this candidate — they describe an individual
 * contributor role, which is what she is targeting. A scope signal only counts
 * when the JD ASSERTS the responsibility, not when it denies it.
 *
 * This ran in production for weeks before being caught, so some share of the
 * "experience gate: scope" deletions in past run logs were false positives.
 *
 * Window is deliberately short (48 chars) so a negation earlier in an
 * unrelated sentence cannot cancel a genuine signal later.
 */
const NEGATOR_RE = /\b(no|not|never|without|excluding|free\s+of|zero)\b[^.]{0,48}$/i;

export function isNegated(text, matchIndex) {
  const before = String(text || '').slice(Math.max(0, matchIndex - 48), matchIndex);
  return NEGATOR_RE.test(before);
}

// ── context exemptions: the title REFERENCES a grade, it is not THAT grade ──
// Added 2026-09-07, ported from the India pipeline. TITLE_SENIORITY_RE answers
// "does a senior-grade word appear in this title", which is not the same
// question as "is this title that grade". Titles wrongly failed before:
//
//   "Business Analyst supporting the Senior Manager"   -> an analyst
//   "Strategy Analyst, Office of the Chief Executive"  -> a staff analyst
//   "Chief of Staff"                                   -> an IC coordination role
//   "Programme Analyst reporting to the Director"      -> an analyst
//
// Each exemption is narrow. The default remains FAIL: a token is only forgiven
// when the surrounding words make it grammatically SOMEONE ELSE'S grade.
const ATTACHMENT_BEFORE_RE =
  /\b(?:to|for|with|under|supporting|support|supports|assisting|assist|assists|reporting|reports|alongside|serving|serves|partnering|liaising|liaison)\s+(?:the\s+|a\s+|an\s+|our\s+)?(?:[a-z]+\s+)?$/i;
const OFFICE_AFTER_RE = /^(?:['’]s|s)?\s*office\b/i;
// One optional intervening word so a two-token grade is fully covered:
// in "Office of the Chief Executive" the token that matches may be
// "executive", whose preceding text is "...Office of the Chief ".
const OFFICE_BEFORE_RE = /\boffice\s+of\s+(?:the\s+)?(?:[a-z]+\s+)?$/i;
const CHIEF_OF_STAFF_AFTER_RE = /^\s*of\s+staff\b/i;

/**
 * True when a matched seniority token names someone else's grade rather than
 * the grade of the advertised role.
 * @param {string} title
 * @param {number} index - Start index of the match within `title`.
 * @param {string} matched
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
 * Every seniority token in a title, with position, so each can be judged in
 * context. A title clears only when EVERY match is a mere reference.
 * @param {string} title
 * @returns {Array<{text: string, index: number}>}
 */
function seniorityMatches(title) {
  const re = new RegExp(TITLE_SENIORITY_RE.source, 'gi');
  return [...title.matchAll(re)].map(m => ({ text: m[0], index: m.index }));
}

export function scopeCheck(title, jdText) {
  const t = String(title || '');
  for (const { text: word, index } of seniorityMatches(t)) {
    if (isSeniorityReference(t, index, word)) continue;
    // Pre-existing NHS carve-out: "Lead" at a junior Agenda for Change band is
    // a task-lead, not a leadership grade.
    if (/^lead$/i.test(word) && JUNIOR_NHS_BAND_RE.test(t)) continue;
    return { pass: false, reason: `title-implied seniority ("${word}")` };
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
 * The gate. Order: numeric first (cheap, explicit), then scope (judgement-
 * based) — but EITHER can fail it independently; scope failing overrides a
 * numeric pass, exactly as specified ("a role stated as 3-6 years but written
 * for a Head of Department is still a FAIL").
 *
 * `jdFetched` must be true and `jdText` must be the real fetched JD body — a
 * title-only or listing-page pass must call this with jdFetched:false, which
 * always returns UNVERIFIED, never PASS.
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

// ── self-test ────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (label, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL: ${label}`); } };

  ok('range takes lower bound only', extractYearsRequirement('3-6 years experience required') === 6 ? false : true);
  ok('extracts range lower bound', extractYearsRequirement('We need 3-6 years experience') === 3);
  ok('extracts single figure', extractYearsRequirement('Minimum 3 years experience') === 3);
  ok('extracts 3+ years', extractYearsRequirement('3+ years experience') === 3);
  ok('extracts 0-5 years as 0', extractYearsRequirement('0-5 years experience') === 0);
  ok('no years mention returns null', extractYearsRequirement('A great role for an analyst') === null);
  ok('takes max of multiple distinct mentions', extractYearsRequirement('3+ years in analysis, 5+ years in stakeholder management') === 5);

  // Figures that are NOT a years-of-experience requirement. The first two
  // always worked; the company-history cases are the FDM Group regression —
  // "established for 35 years" was read as a 35-year requirement.
  ok('ignores weekly hours', extractYearsRequirement('35 hours per week') === null);
  ok('ignores annual leave', extractYearsRequirement('25 days annual leave plus bank holidays') === null);
  ok('ignores "established for N years"', extractYearsRequirement('We have been established for 35 years') === null);
  ok('ignores "trading for N years"', extractYearsRequirement('Trading for 20 years across the UK') === null);
  ok('ignores "operating for N years"', extractYearsRequirement('Operating for 15 years in the sector') === null);
  ok('ignores "founded over N years ago"', extractYearsRequirement('Founded over 30 years ago') === null);
  ok('ignores "over N years in business"', extractYearsRequirement('With over 40 years in business') === null);
  ok('ignores "more than N years of trading"', extractYearsRequirement('More than 12 years of trading') === null);
  // Verbatim from the FDM Group posting that was wrongly rejected.
  ok('ignores "backed by more than N years of industry experience"',
    extractYearsRequirement('a global leader in tech and business talent solutions, backed by more than 35 years of industry experience') === null);
  // The counterpart that must STILL be read as a requirement.
  ok('still catches "N years of industry experience" as a requirement',
    extractYearsRequirement('You will have 5 years of industry experience') === 5);
  // Verbatim from NHS right-to-work boilerplate on every jobs.nhs.uk advert.
  ok('ignores an age in years', extractYearsRequirement('Adult dependants (over 18 years old) are also subject to this') === null);
  ok('ignores "N years of age"', extractYearsRequirement('Applicants must be 18 years of age') === null);
  ok('ignores a residency look-back window',
    extractYearsRequirement('resided continuously or cumulatively for 12 months or more in the past 10 years') === null);
  ok('real requirement survives alongside NHS boilerplate',
    extractYearsRequirement('Adult dependants (over 18 years old) apply. You need 2 years experience.') === 2);
  ok('company history does not mask a real requirement in the same JD',
    extractYearsRequirement('We have been established for 35 years. You will need 2+ years experience.') === 2);

  ok('numeric passes at ceiling', numericCheck(3).pass === true);
  ok('numeric passes below ceiling', numericCheck(2).pass === true);
  ok('numeric passes on no requirement', numericCheck(null).pass === true);
  ok('numeric fails just above ceiling', numericCheck(4).pass === false);
  ok('numeric fails well above ceiling', numericCheck(8).pass === false);

  ok('scope passes ordinary analyst text', scopeCheck('Business Analyst', 'Analyse data and produce reports for stakeholders.').pass === true);
  ok('scope fails on title Director', scopeCheck('Director of Strategy', 'Analyse data.').pass === false);
  ok('scope fails on title Head of', scopeCheck('Head of PMO', 'Analyse data.').pass === false);
  ok('scope fails on P&L ownership', scopeCheck('Business Analyst', 'You will own the P&L for the division.').pass === false);
  ok('scope fails on team management', scopeCheck('Business Analyst', 'Manage a team of 8 analysts.').pass === false);
  ok('scope fails on expert-level', scopeCheck('Business Analyst', 'Expert-level knowledge of SAP required.').pass === false);
  ok('scope passes generic "lead the analysis" phrasing in body (only TITLE triggers lead)',
    scopeCheck('Business Analyst', 'You will lead the analysis of quarterly data.').pass === true);

  // NHS band overrides the word "lead" at junior grades only.
  ok('lead does NOT trip at Band 5', scopeCheck('Band 5 Lead Data Analysis and Information Officer', 'Analyse data.').pass === true);
  ok('lead does NOT trip at Band 6', scopeCheck('Band 6 Lead Information Analyst', 'Analyse data.').pass === true);
  ok('lead STILL trips at Band 7', scopeCheck('Band 7 Lead Business Analyst', 'Analyse data.').pass === false);
  ok('lead STILL trips at Band 8', scopeCheck('Band 8a Lead Analyst', 'Analyse data.').pass === false);
  ok('lead STILL trips with no band at all', scopeCheck('Lead Business Analyst', 'Analyse data.').pass === false);
  ok('Director still trips even at Band 5', scopeCheck('Band 5 Director of Analytics', 'Analyse data.').pass === false);
  ok('Band 9 still trips', scopeCheck('Band 9 Director of Digital Strategy', 'Analyse data.').pass === false);

  // ── the three demonstration cases ──
  const supportOfficer = experienceGate({
    title: 'Project Support Officer',
    jdText: 'Support the PMO team, maintain the project log, arrange governance meetings. 1-3 years experience.',
    jdFetched: true,
  });
  ok('Project Support Officer: numeric passes on its own (gate is not why this role fails — SOC 3543 is)',
    supportOfficer.status === 'PASS');

  const headOfBA = experienceGate({
    title: 'Head of Business Analysis',
    jdText: 'You will own the strategy for the practice and manage a team of 6 analysts. 3-6 years experience.',
    jdFetched: true,
  });
  ok('Head of Business Analysis 3-6y: FAILS on scope despite numeric pass', headOfBA.status === 'FAIL' && headOfBA.check === 'scope');

  const juniorBA = experienceGate({
    title: 'Business Analyst',
    jdText: 'Analyse commercial data, produce reporting for stakeholders, support delivery of the programme. 2+ years experience.',
    jdFetched: true,
  });
  ok('ordinary 2+ years Business Analyst PASSES', juniorBA.status === 'PASS');

  const unverified = experienceGate({ title: 'Business Analyst', jdText: '', jdFetched: false });
  ok('no JD fetched -> UNVERIFIED, never PASS', unverified.status === 'UNVERIFIED');

  console.log(`experience-gate: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--self-test')) selfTest();
  else {
    const title = process.argv[2] || '';
    const jdText = process.argv.slice(3).join(' ');
    console.log(JSON.stringify(experienceGate({ title, jdText, jdFetched: Boolean(jdText) }), null, 2));
  }
}
