#!/usr/bin/env node
/**
 * role-score.mjs — deterministic in-process PRE-SCORER. INDIA PIPELINE.
 *
 * Written 2026-09-07. This is NOT a replacement for the full 1-5 "Global"
 * score defined in modes/_shared.md's Scoring System — that score is
 * explicitly a holistic LLM judgment across CV-match, archetype fit, comp,
 * culture and red flags ("no arithmetic formula"). CV-gap analysis, culture
 * signals and red flags all require reading JD prose and comparing it to
 * cv.md — that is real judgment, not something this file can do.
 *
 * What this file DOES do deterministically, cheaply, and before any API
 * call is spent: role-title match against config/profile.yml's target
 * archetypes, CTC-vs-floor banding, and location-priority banding — plus the
 * existing hard gates (experienceGate's scopeCheck, agency.mjs's isAgency).
 * Combined into a single 0-5 "preScore" and a tier label used to PRIORITIZE
 * and PRE-FILTER pending postings before the paid --eval step runs, not to
 * reproduce its final number. See run-daily.mjs's role-match pre-gate for
 * how this plugs in, and validate-role-score.mjs for how it's checked
 * against the 31 already-scored reports (agreement of direction, not exact
 * decimal match — the two scores measure different things by design).
 *
 * NO visa/SOC/sponsorship logic. India-only.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { scopeCheck, normaliseTitle } from './experience-gate.mjs';

// ── UK-bridge (intra-company transfer) lookup ─────────────────────────
// Loaded once from india_targets.csv, which was enriched 2026-09-24 with a
// "UK Sponsor + Track Record" column. Matches an India employer to a
// scoring bonus reflecting their real UK hiring capacity: the pool ICT
// transfers actually come from. Not a substitute for a good role-match;
// tiebreaker in a hot list.
let _ukBridgeCache = null;
function loadUkBridge() {
  if (_ukBridgeCache) return _ukBridgeCache;
  const csvPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'india_targets.csv');
  if (!existsSync(csvPath)) { _ukBridgeCache = new Map(); return _ukBridgeCache; }
  const map = new Map();
  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) { _ukBridgeCache = map; return map; }
  const parseLine0 = (line) => {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const header = parseLine0(lines[0]);
  const orgIdx = header.indexOf('Organisation');
  const bridgeIdx = header.indexOf('UK Sponsor + Track Record');
  if (bridgeIdx < 0) { _ukBridgeCache = map; return map; }
  // Proper CSV parse — the "Typical Cities" field contains commas inside
  // quotes ("Delhi NCR/Gurugram, Bengaluru, Mumbai"). A naive split reads
  // city fragments as later columns and breaks the bridgeIdx lookup.
  const parseLine = (line) => {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  for (let i = 1; i < lines.length; i++) {
    const parts = parseLine(lines[i]);
    const org = (parts[orgIdx] || '').trim().toLowerCase();
    const bridge = (parts[bridgeIdx] || '').trim();
    if (org && bridge) map.set(org, bridge);
  }
  _ukBridgeCache = map;
  return map;
}
export function ukBridgeFor(company) {
  if (!company) return { tag: '', bonus: 0 };
  const bridge = loadUkBridge().get(String(company).trim().toLowerCase());
  if (!bridge) return { tag: '', bonus: 0 };
  const isRegister = /rating/i.test(bridge);
  const isIct = /ict.active/i.test(bridge);
  // +0.3 register-match, +0.2 ICT-active, additive; capped at +0.5 combined.
  const bonus = Math.min(0.5, (isRegister ? 0.3 : 0) + (isIct ? 0.2 : 0));
  return { tag: bridge, bonus };
}
import { isAgency } from './agency.mjs';
import { resolveLpaFloor, CTC_FLOOR_LPA, classifyLocationPriority } from './ctc-location.mjs';

const ROOT = process.cwd();
const PROFILE_YML = path.join(ROOT, 'config', 'profile.yml');

let _profileCache = null;
export function loadProfile() {
  if (_profileCache) return _profileCache;
  if (!existsSync(PROFILE_YML)) {
    _profileCache = { targetRoles: {}, excludedTitles: [], priorityTiers: [], ctcFloor: CTC_FLOOR_LPA };
    return _profileCache;
  }
  const doc = yaml.load(readFileSync(PROFILE_YML, 'utf8')) || {};
  _profileCache = {
    targetRoles: doc.target_roles || {},
    excludedTitles: doc.excluded_titles || [],
    priorityTiers: doc.location?.priority || [],
    ctcFloor: doc.compensation?.target_ctc_lpa_minimum || CTC_FLOOR_LPA,
  };
  return _profileCache;
}

// Test-only hook — never called from production code paths.
export function _resetProfileCacheForTests() { _profileCache = null; }

// ── tokenizing ──────────────────────────────────────────────────────────
// A small local stopword set, deliberately looser than role-matcher.mjs's
// ROLE_STOPWORDS: that file's job is telling two JOB POSTINGS apart (so it
// treats a specialization suffix as disqualifying); this file's job is
// telling whether a title IS one of a short list of canonical archetypes,
// where a suffix like "- Direct Channels" or ", Customer Journey Mapping"
// must NOT prevent the match.
const WORD_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'for', 'in', 'at', 'to', 'with', 'on',
]);

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[_/|]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !WORD_STOPWORDS.has(w));
}

/**
 * True when every content word of `target` appears as a whole word
 * somewhere in `title`. Extra words on the title side (department,
 * location, project-suffix qualifiers) are ignored on purpose — a JD titled
 * "Business Analyst - Direct Channels" IS a Business Analyst posting.
 *
 * This word-boundary requirement is the guard against the "Creative
 * Manager scored 5.0" failure mode: a single shared generic word (e.g.
 * "Manager") is never enough on its own unless it's the ENTIRE target
 * title, because every other word of a real target (e.g. "Program" in
 * "Program Manager") must also be present.
 */
function containsAllWords(titleWords, target) {
  const targetWords = words(target);
  if (targetWords.length === 0) return false;
  const titleSet = new Set(titleWords);
  return targetWords.every(w => titleSet.has(w));
}

function sharesAnyWord(titleWords, target) {
  const targetWords = new Set(words(target));
  return titleWords.some(w => targetWords.has(w));
}

// ── excluded titles (hard exclude, independent of the seniority gate) ────

export function isExcludedTitle(title, profile = loadProfile()) {
  const t = normaliseTitle(title).toLowerCase();
  return (profile.excludedTitles || []).some((ex) => {
    const exWords = words(ex);
    if (exWords.length === 0) return false;
    // Phrase-level match: the excluded phrase's words must appear, in
    // order, as a contiguous run in the title — "Graduate" must not exclude
    // "Graduate Programme Manager, Delivery Excellence" if that's somehow a
    // real senior title (it won't be, per excluded_titles_note, but a bare
    // word-set match would also wrongly exclude "Undergraduate Studies
    // Consultant"-shaped false positives). Word-boundary substring check on
    // the joined phrase is close enough for this short, curated list.
    const re = new RegExp('\\b' + exWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+') + '\\b', 'i');
    return re.test(t);
  });
}

// ── Step 1: role-match score (0-5) ────────────────────────────────────────

/**
 * @returns {{score: number, tier: string, matchedOn: string|null}}
 */
export function roleMatchScore(title, profile = loadProfile()) {
  if (isExcludedTitle(title, profile)) {
    return { score: 0, tier: 'excluded', matchedOn: 'excluded_titles' };
  }

  const titleWords = words(title);
  const tr = profile.targetRoles || {};

  const archetypeNames = (tr.archetypes || []).map(a => a.name).filter(Boolean);
  const primary = [...(tr.primary || []), ...archetypeNames];
  const tier1 = [...(tr.tier_1_core || []), ...(tr.india_grade_equivalents || [])];
  const tier2 = tr.tier_2_programme_infrastructure || [];
  const tier3 = Object.values(tr.tier_3_adjacent || {}).flat();

  // Exact (case/whitespace-insensitive) title match against a primary
  // target is the cleanest possible signal — always 5, regardless of what
  // token logic below would otherwise compute.
  const norm = normaliseTitle(title).toLowerCase();
  if (primary.some(p => String(p).toLowerCase() === norm)) {
    return { score: 5, tier: 'primary (exact)', matchedOn: primary.find(p => String(p).toLowerCase() === norm) };
  }

  // A single-word target (e.g. "Analyst") is too generic to decide a tier on
  // its own — it would outrank a genuinely specific tier-2/tier-3 target
  // (e.g. "PMO Analyst") purely because it's a subset of nearly every
  // analyst-shaped title. Loose containsAllWords matching therefore only
  // considers multi-word targets; a lone single-word target can still win
  // via the exact-match check above, or the weak-overlap fallback below.
  const findMatch = (list) => list.find(t => words(t).length >= 2 && containsAllWords(titleWords, t));

  const mPrimary = findMatch(primary);
  if (mPrimary) return { score: 5, tier: 'primary', matchedOn: mPrimary };

  const mTier1 = findMatch(tier1);
  if (mTier1) return { score: 4, tier: 'tier_1_core / grade_equivalent', matchedOn: mTier1 };

  const mTier2 = findMatch(tier2);
  if (mTier2) return { score: 3, tier: 'tier_2_programme_infrastructure', matchedOn: mTier2 };

  const mTier3 = findMatch(tier3);
  if (mTier3) return { score: 3, tier: 'tier_3_adjacent', matchedOn: mTier3 };

  // No full-target match. A weak, single-generic-word overlap (e.g. the
  // title merely contains "Manager" or "Analyst" somewhere) is worth
  // something but must stay well below any real match — this is exactly
  // the band a sloppy scorer would instead push to 5.0.
  const allTargets = [...primary, ...tier1, ...tier2, ...tier3];
  if (allTargets.some(t => sharesAnyWord(titleWords, t))) {
    return { score: 1.5, tier: 'weak/generic overlap only', matchedOn: null };
  }

  return { score: 1, tier: 'no archetype overlap', matchedOn: null };
}

// ── Step 2: CTC-band score (0-5) ──────────────────────────────────────────

/**
 * Parses ₹18-24 LPA / 18,00,000 / "not disclosed" style Indian CTC text.
 * Absent/unparseable CTC is scored NEUTRAL (3.0) — it must neither reject a
 * role outright nor get credited as if it cleared the floor.
 */
export function ctcScore(advertisedComp, profile = loadProfile()) {
  const floor = resolveLpaFloor(advertisedComp);
  const ctcFloor = profile.ctcFloor || CTC_FLOOR_LPA;

  if (floor === null) {
    return { score: 3, band: advertisedComp ? 'stated but unparseable' : 'unknown', lpa: null };
  }
  if (floor < ctcFloor) {
    return { score: 1, band: `below floor (<${ctcFloor} LPA)`, lpa: floor };
  }
  if (floor < ctcFloor * 1.25) {
    return { score: 3.5, band: `meets floor (${ctcFloor}-${(ctcFloor * 1.25).toFixed(0)} LPA)`, lpa: floor };
  }
  if (floor < ctcFloor * 1.75) {
    return { score: 4.5, band: `comfortably above floor (${(ctcFloor * 1.25).toFixed(0)}-${(ctcFloor * 1.75).toFixed(0)} LPA)`, lpa: floor };
  }
  return { score: 5, band: `well above floor (≥${(ctcFloor * 1.75).toFixed(0)} LPA)`, lpa: floor };
}

// ── Step 3: location-priority score (0-5) ─────────────────────────────────

export function locationScore(location, { remote = false } = {}, profile = loadProfile()) {
  if (remote) return { score: 5, band: 'remote (priority-1 equivalent)' };
  if (!location) return { score: 3, band: 'unstated (neutral)' };

  const classified = classifyLocationPriority(profile.priorityTiers || [], location, null);
  if (!classified) return { score: 3, band: 'unstated (neutral)' };
  // Scored below the lowest EXPLICIT tier on purpose: a city the profile
  // deliberately tracks (even at the bottom of its list) is a known, weighed
  // trade-off, while a location outside the list entirely is unweighed risk.
  if (classified === 'Not in priority list') return { score: 1.3, band: 'not in priority list' };

  const m = classified.match(/Priority (\d+)/);
  if (!m) return { score: 3, band: classified };
  const tier = Number(m[1]);
  const maxTier = Math.max(1, ...((profile.priorityTiers || []).map(t => t.tier)));
  // Tier 1 -> 5.0, linearly down to ~1.5 at the lowest configured tier.
  const score = Math.max(1.5, 5 - ((tier - 1) / Math.max(1, maxTier - 1)) * 3.5);
  return { score: Math.round(score * 10) / 10, band: `Priority ${tier}` };
}

// ── combined pre-score ─────────────────────────────────────────────────

const WEIGHTS = { role: 0.5, ctc: 0.25, location: 0.25 };

// Hard ceiling for a role that failed the seniority/scope gate. Deliberately
// below tierLabel's lowest named band (2.0) so a gated role always sorts under
// every ungated one, while still ordering sensibly among themselves — a gated
// "Senior Manager, Business Planning" in Gurugram should sit above a gated
// "Chief Revenue Officer" in Kochi. Excluded titles keep a true 0: those are
// the candidate's own do-not-want list, not a judgement call worth surfacing.
export const GATED_CEILING = 1.9;

export function tierLabel(preScore) {
  if (preScore >= 4.3) return 'Strong candidate — prioritize';
  if (preScore >= 3.3) return 'Worth eval';
  if (preScore >= 2.0) return 'Marginal — low priority';
  return 'Low priority';
}

/**
 * @param {object} posting
 * @param {string} posting.title
 * @param {string} [posting.location]
 * @param {boolean} [posting.remote]
 * @param {string} [posting.advertisedComp]
 * @param {string} [posting.jdText] - full JD body, if fetched
 * @param {boolean} [posting.jdFetched]
 */
export function preScoreRole(posting, profile = loadProfile()) {
  const { title, location, remote = false, advertisedComp = null, jdText = '', jdFetched = false } = posting;

  const excluded = isExcludedTitle(title, profile);
  const gate = scopeCheck(title, jdFetched ? jdText : '');
  const agency = isAgency(posting.company);

  const role = roleMatchScore(title, profile);
  const ctc = ctcScore(advertisedComp, profile);
  const loc = locationScore(location, { remote }, profile);

  if (excluded) {
    return {
      preScore: 0, tier: 'EXCLUDED (excluded_titles)', gatePass: false,
      role, ctc, loc, agency, gateReason: 'title matches config/profile.yml excluded_titles',
    };
  }
  if (!gate.pass) {
    // CHANGED 2026-09-09. A gated role used to score a hard 0 and disappear.
    // Validation against the 31 LLM-scored reports showed that cost real
    // opportunities: Novartis "Senior Manager, Business Planning & Analysis"
    // was scored 4.0 by the LLM and 0 here, and "Associate Director, IMO AI
    // and Business Excellence" 3.6 vs 0 — 2 of the 13 roles the LLM rated
    // >= 3.5, i.e. ~15% of qualified upside deleted rather than deprioritised.
    //
    // The gate's JUDGEMENT is not being softened — a Senior Manager grade is
    // still a stretch against ~2.5 years and must never outrank a real match.
    // What changes is the CONSEQUENCE: instead of vanishing, the role keeps a
    // score capped below every ungated band so it sorts to the bottom of the
    // list, visible and clearly labelled, where a human can overrule it.
    //
    // GATED_CEILING sits below tierLabel's 2.0 "Marginal" boundary, so a gated
    // role can never be ranked above an ungated one no matter how well it
    // scores on role/CTC/location. gatePass stays false, so any caller that
    // filters on the gate (run-daily.mjs's pre-gate, auto-tailor's eligibility)
    // behaves exactly as before — this only affects ordering and visibility.
    const raw = (role.score * WEIGHTS.role + ctc.score * WEIGHTS.ctc + loc.score * WEIGHTS.location);
    const preScore = Math.round(Math.min(GATED_CEILING, raw / 5) * 10) / 10;
    const bridgeG = ukBridgeFor(posting.company);
    return {
      preScore, tier: `GATED — review only (${gate.reason})`, gatePass: false,
      role, ctc, loc, agency, gateReason: gate.reason,
      ukBridge: bridgeG.tag, ukBridgeBonus: 0,
    };
  }

  const rawScore = (role.score * WEIGHTS.role + ctc.score * WEIGHTS.ctc + loc.score * WEIGHTS.location);
  const bridge = ukBridgeFor(posting.company);
  // Cap at 5.0 — the bonus tiebreaks and promotes UK-bridge employers,
  // it doesn't manufacture a fake perfect score.
  const preScore = Math.round(Math.min(5.0, rawScore + bridge.bonus) * 10) / 10;

  return {
    preScore, tier: tierLabel(preScore), gatePass: true,
    role, ctc, loc, agency, gateReason: gate.reason,
    ukBridge: bridge.tag, ukBridgeBonus: bridge.bonus,
  };
}

// ── self-test ─────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (label, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL: ${label}`); } };

  const profile = {
    targetRoles: {
      primary: ['Business Analyst', 'Management Consultant', 'Consultant'],
      tier_1_core: ['Business Consultant'],
      india_grade_equivalents: ['Senior Analyst', 'Analyst'],
      tier_2_programme_infrastructure: ['PMO Analyst', 'Programme Analyst'],
      tier_3_adjacent: { commercial_and_cost: ['Cost Analyst'] },
      archetypes: [{ name: 'Business Analyst' }],
    },
    excludedTitles: ['Graduate', 'Intern', 'Management Trainee'],
    priorityTiers: [
      { tier: 1, locations: ['Delhi NCR', 'Gurugram', 'Noida'] },
      { tier: 2, locations: ['Hyderabad'] },
      { tier: 3, locations: ['Pune'] },
      { tier: 4, locations: ['Bengaluru'] },
      { tier: 5, locations: ['Mumbai'] },
      { tier: 6, locations: ['Chennai'] },
    ],
    ctcFloor: 8,
  };

  // ── Step 1: role match ──
  ok('exact primary match = 5', roleMatchScore('Business Analyst', profile).score === 5);
  ok('primary with suffix still = 5 (not sloppy-diluted)',
    roleMatchScore('Business Analyst - Direct Channels', profile).score === 5);
  ok('primary with prefix qualifier still = 5',
    roleMatchScore('Senior Business Analyst', profile).score === 5);
  ok('grade-equivalent = 4', roleMatchScore('Senior Analyst - Customer Journey Mapping', profile).score === 4);
  ok('tier_2 = 3', roleMatchScore('PMO Analyst, Infrastructure', profile).score === 3);
  ok('tier_3 = 3', roleMatchScore('Cost Analyst', profile).score === 3);
  ok('excluded title = 0', roleMatchScore('Graduate Management Trainee', profile).score === 0);
  ok('excluded title tier label', roleMatchScore('Intern - Business Analyst', profile).tier === 'excluded');
  // The regression this file exists to prevent: a role sharing only ONE
  // generic word with a target must NOT reach anywhere near 5.
  ok('"Creative Manager" (no real match) scores low, not 5',
    roleMatchScore('Creative Manager', profile).score <= 1.5);
  ok('totally unrelated title scores lowest band',
    roleMatchScore('Warehouse Forklift Operator', profile).score === 1);

  // ── Step 2: CTC ──
  ok('unknown CTC is neutral (3), not rejecting', ctcScore(null, profile).score === 3);
  ok('unknown CTC is neutral (3), not over-crediting', ctcScore(null, profile).score < 4);
  ok('"not disclosed" text is neutral', ctcScore('CTC: Not Disclosed', profile).score === 3);
  ok('₹18-24 LPA well above floor', ctcScore('₹18-24 LPA', profile).score === 5);
  ok('18,00,000 (=18 LPA) parses and scores well above floor',
    ctcScore('₹18,00,000 per annum', profile).score === 5);
  ok('8 LPA exactly meets floor band', ctcScore('8 LPA', profile).score === 3.5);
  ok('6 LPA below floor scores low', ctcScore('6 LPA', profile).score === 1);
  ok('12 LPA comfortably above floor', ctcScore('12 LPA', profile).score === 4.5);

  // ── Step 3: location ──
  ok('Delhi NCR = tier 1 = 5', locationScore('Delhi NCR, India', {}, profile).score === 5);
  ok('Gurugram = tier 1 = 5', locationScore('Gurugram', {}, profile).score === 5);
  ok('remote scores same as tier 1', locationScore(null, { remote: true }, profile).score === 5);
  ok('Chennai (lowest tier) scores low but above not-in-list',
    locationScore('Chennai', {}, profile).score < 5 && locationScore('Chennai', {}, profile).score >= 1.5);
  ok('unlisted Indian city scores below lowest tier',
    locationScore('Kochi', {}, profile).score < locationScore('Chennai', {}, profile).score);
  ok('no location stated is neutral', locationScore(null, {}, profile).score === 3);

  // ── combined ──
  const strong = preScoreRole({ title: 'Business Analyst', location: 'Gurugram', advertisedComp: '15 LPA', company: 'Acme' }, profile);
  ok('strong match combined tier', strong.tier === 'Strong candidate — prioritize');
  ok('gate passes for ordinary analyst title', strong.gatePass === true);

  const gated = preScoreRole({ title: 'Director of Strategy', location: 'Gurugram', company: 'Acme' }, profile);
  ok('seniority gate overrides everything', gated.gatePass === false && gated.tier.startsWith('GATED'));
  // 2026-09-09: gated roles are DEMOTED, not deleted — visible for review but
  // never able to outrank a role that actually cleared the gate.
  ok('gated role keeps a non-zero score (visible, not deleted)', gated.preScore > 0);
  ok('gated role always sorts below every ungated band', gated.preScore < 2.0);
  const strongForCompare = preScoreRole({ title: 'Business Analyst', location: 'Gurugram', advertisedComp: '15 LPA', company: 'Acme' }, profile);
  ok('a gated role can never outrank an ungated one', gated.preScore < strongForCompare.preScore);
  const gatedWeak = preScoreRole({ title: 'Chief Revenue Officer', location: 'Kochi', company: 'X' }, profile);
  ok('gated roles still order sensibly among themselves', gatedWeak.preScore < gated.preScore);

  const excludedPosting = preScoreRole({ title: 'Graduate Trainee', location: 'Gurugram', company: 'Acme' }, profile);
  ok('excluded title overrides everything', excludedPosting.tier.startsWith('EXCLUDED'));

  const agencyPosting = preScoreRole({ title: 'Business Analyst', location: 'Gurugram', company: 'TeamLease' }, profile);
  ok('agency detected but does not block scoring', agencyPosting.agency === true && agencyPosting.gatePass === true);

  console.log(`${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) selfTest();
