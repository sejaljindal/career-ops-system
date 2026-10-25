#!/usr/bin/env node
/**
 * soc-engine.mjs — deterministic UK SOC-code inference and Skilled Worker
 * salary/eligibility logic, driven entirely by soc_rates.json.
 *
 * This is a scoring/advisory layer. It never edits the tracker, never writes a
 * report, and never decides on the user's behalf — it returns structured
 * verdicts for the evaluation modes to fold into Block A.
 *
 * All thresholds, codes, phrases and deadlines live in soc_rates.json. Nothing
 * is hardcoded here, so refreshing that file from GOV.UK updates the engine.
 *
 * Usage:
 *   node soc-engine.mjs "Business Analyst" jd.txt [advertised_salary]
 */

import { readFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';

const RATES_PATH = new URL('./soc_rates.json', import.meta.url);

let cachedRates = null;

/** Load soc_rates.json (cached). Pass an object to inject rates in tests. */
export function loadRates(override) {
  if (override) return override;
  if (!cachedRates) cachedRates = JSON.parse(readFileSync(RATES_PATH, 'utf8'));
  return cachedRates;
}

/**
 * Normalize free text for phrase matching: lowercase, and reduce every run of
 * non-alphanumeric characters to a single space. Padded with spaces so a
 * phrase can be matched with plain `includes` on whole-word boundaries.
 */
function normalize(text) {
  return ` ${String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** Whether `phrase` occurs in already-normalized `haystack` on word boundaries. */
function containsPhrase(haystack, phrase) {
  const needle = normalize(phrase);
  return needle.trim().length > 0 && haystack.includes(needle);
}

/** Longest `covers` phrase from `entry` present in the normalized text, or null. */
function bestCoverMatch(normalizedText, entry) {
  let best = null;
  for (const phrase of entry.covers ?? []) {
    if (!containsPhrase(normalizedText, phrase)) continue;
    if (!best || phrase.length > best.length) best = phrase;
  }
  return best;
}

/**
 * Scan one section of soc_rates.json for the strongest match.
 * Title hits outrank description hits; then longer phrases; then `priority`
 * (1 = strongest) so a tie between two eligible codes resolves deterministically.
 */
function bestSection(section, normalizedTitle, normalizedDescription) {
  let winner = null;
  for (const [code, entry] of Object.entries(section)) {
    if (code.startsWith('_')) continue;
    const titleMatch = bestCoverMatch(normalizedTitle, entry);
    const descriptionMatch = titleMatch ? null : bestCoverMatch(normalizedDescription, entry);
    const matched = titleMatch ?? descriptionMatch;
    if (!matched) continue;
    const candidate = {
      code,
      title: entry.title,
      matchedPhrase: matched,
      inTitle: Boolean(titleMatch),
      priority: Number(entry.priority ?? 99),
    };
    if (!winner
      || (candidate.inTitle !== winner.inTitle && candidate.inTitle)
      || (candidate.inTitle === winner.inTitle && candidate.matchedPhrase.length > winner.matchedPhrase.length)
      || (candidate.inTitle === winner.inTitle
        && candidate.matchedPhrase.length === winner.matchedPhrase.length
        && candidate.priority < winner.priority)) {
      winner = candidate;
    }
  }
  return winner;
}

/**
 * Infer the SOC code for a role from its title and description.
 *
 * When the role matches BOTH an eligible (1xxx/2xxx) and an ineligible
 * (below-RQF6) code, the eligible code is returned — but flagged
 * `socRisk: true` with `confidence: "low"`, because how the employer writes
 * the duties decides which code the sponsorship is actually filed under.
 */
export function inferSOC(jobTitle, jobDescription, options = {}) {
  const rates = loadRates(options.rates);
  const normalizedTitle = normalize(jobTitle);
  const normalizedDescription = normalize(jobDescription);

  const eligible = bestSection(rates.eligible, normalizedTitle, normalizedDescription);
  const ineligible = bestSection(rates.ineligible_below_rqf6, normalizedTitle, normalizedDescription);

  if (!eligible && !ineligible) {
    return { code: null, title: null, eligible: null, confidence: 'none', socRisk: false, matchedPhrase: null };
  }

  // Ambiguous: the same role reads as both an analyst code and a support code.
  if (eligible && ineligible) {
    return {
      code: eligible.code,
      title: eligible.title,
      eligible: true,
      confidence: 'low',
      socRisk: true,
      matchedPhrase: eligible.matchedPhrase,
      competingCode: ineligible.code,
      competingTitle: ineligible.title,
    };
  }

  const winner = eligible ?? ineligible;
  return {
    code: winner.code,
    title: winner.title,
    eligible: Boolean(eligible),
    confidence: winner.inTitle ? 'high' : 'medium',
    socRisk: false,
    matchedPhrase: winner.matchedPhrase,
  };
}

/**
 * Count analysis-flavoured vs support-flavoured phrases in a job description.
 *
 * Same person, same work — the verbs decide the code. A description that leads
 * with analysis/advisory language is far more likely to be sponsorable under
 * 2431 than one written in support/coordination language.
 */
export function scoreLanguage(jobDescription, options = {}) {
  const rates = loadRates(options.rates);
  const signals = rates.language_signals ?? {};
  const normalized = normalize(jobDescription);

  const tally = (phrases = []) => {
    const matched = [];
    let total = 0;
    for (const phrase of phrases) {
      const needle = normalize(phrase);
      if (!needle.trim()) continue;
      let count = 0;
      let index = normalized.indexOf(needle);
      // Step by needle.length - 1 so the shared trailing space can open the next match.
      while (index !== -1) {
        count++;
        index = normalized.indexOf(needle, index + needle.length - 1);
      }
      if (count > 0) {
        matched.push(phrase);
        total += count;
      }
    }
    return { total, matched };
  };

  const analysis = tally(signals.pushes_toward_2431_eligible);
  const support = tally(signals.pushes_toward_3543_ineligible);

  return {
    analysisScore: analysis.total,
    supportScore: support.total,
    verdict: analysis.total > support.total ? 'analysis-led' : 'support-led',
    analysisMatches: analysis.matched,
    supportMatches: support.matched,
  };
}

/** Parse an advertised salary ("£42,500", "45000 GBP", 38000) to a number, or null. */
export function parseSalary(advertisedSalary) {
  if (advertisedSalary === null || advertisedSalary === undefined || advertisedSalary === '') return null;
  if (typeof advertisedSalary === 'number') return Number.isFinite(advertisedSalary) ? advertisedSalary : null;
  const digits = String(advertisedSalary).replace(/[^0-9.]/g, '');
  if (!digits) return null;
  const value = Number.parseFloat(digits);
  return Number.isFinite(value) ? value : null;
}

/**
 * Decide whether an advertised salary clears the Skilled Worker floors for a
 * given SOC code.
 *
 * Codes below RQF6 are not available to a first-time applicant at any salary,
 * so they short-circuit before the salary is even considered.
 */
export function salaryVerdict(socCode, advertisedSalary, options = {}) {
  const rates = loadRates(options.rates);
  const code = String(socCode ?? '');

  if (Object.prototype.hasOwnProperty.call(rates.ineligible_below_rqf6, code) && !code.startsWith('_')) {
    return {
      status: 'INELIGIBLE',
      reason: 'below RQF6 - not available to a first-time Skilled Worker applicant',
      code,
      title: rates.ineligible_below_rqf6[code].title,
    };
  }

  const entry = rates.eligible[code];
  if (!entry) {
    return { status: 'UNKNOWN', action: 'ask recruiter early', reason: 'unrecognized SOC code', code };
  }

  const salary = parseSalary(advertisedSalary);
  if (salary === null) {
    return {
      status: 'UNKNOWN',
      action: 'ask recruiter early',
      code,
      title: entry.title,
      newEntrantFloor: entry.new_entrant_floor,
      experiencedFloor: entry.experienced_floor,
    };
  }

  const base = {
    code,
    title: entry.title,
    salary,
    goingRate: entry.going_rate,
    newEntrantFloor: entry.new_entrant_floor,
    experiencedFloor: entry.experienced_floor,
  };

  if (salary >= entry.experienced_floor) return { status: 'PASS_ANY_TIME', ...base };
  if (salary >= entry.new_entrant_floor) {
    return { status: 'NEW_ENTRANT_ONLY', deadline: rates._meta.new_entrant_deadline, ...base };
  }
  return { status: 'FAIL', ...base };
}

/**
 * Classify a role's remote posture.
 *
 * UK signals are checked before the other-country reject list on purpose:
 * "must be based in the UK" contains the generic reject phrase "must be based
 * in", and a UK role must not be misread as a foreign one.
 */
export function classifyRemote(jobDescription, options = {}) {
  const rates = loadRates(options.rates);
  const signals = rates.remote_classification ?? {};
  const normalized = normalize(jobDescription);
  const anyOf = (phrases = []) => phrases.some(phrase => containsPhrase(normalized, phrase));

  if (anyOf(signals.global_no_visa_needed)) return 'GLOBAL';
  if (anyOf(signals.uk_only_visa_still_required)) return 'UK_ONLY';
  if (anyOf(signals.other_country_reject)) return 'OTHER_COUNTRY';
  return 'ONSITE';
}

/**
 * Whole days from today (UTC) until the new-entrant deadline in soc_rates.json.
 * Negative once the deadline has passed. `today` is injectable for testing.
 */
export function daysUntilDeadline(today = new Date(), options = {}) {
  const rates = loadRates(options.rates);
  const deadline = Date.parse(`${rates._meta.new_entrant_deadline}T00:00:00Z`);
  const reference = today instanceof Date ? today : new Date(today);
  const startOfToday = Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate());
  return Math.round((deadline - startOfToday) / 86400000);
}

if (isMainModule(import.meta.url)) {
  const [jobTitle, jdPath, salary] = process.argv.slice(2);
  if (!jobTitle) {
    console.error('Usage: node soc-engine.mjs "<job title>" [jd.txt] [advertised_salary]');
    process.exit(1);
  }
  let description = '';
  if (jdPath) {
    try {
      description = readFileSync(jdPath, 'utf8');
    } catch (error) {
      console.error(`Unable to read JD file: ${error.message}`);
      process.exit(1);
    }
  }
  const soc = inferSOC(jobTitle, description);
  console.log(JSON.stringify({
    soc,
    language: scoreLanguage(description),
    salary: soc.code ? salaryVerdict(soc.code, salary) : { status: 'UNKNOWN', action: 'ask recruiter early' },
    remote: classifyRemote(description),
    daysUntilNewEntrantDeadline: daysUntilDeadline(),
  }, null, 2));
}
