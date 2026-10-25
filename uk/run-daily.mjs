#!/usr/bin/env node
/**
 * run-daily.mjs — the nightly pipeline, end to end.
 *
 *   flags -> batch (oldest-first) -> scan -> gate -> score -> coverage
 *         -> pipeline.xlsx -> auto-tailor -> report
 *
 * Coverage is written per employer AS IT GOES, so a run killed halfway still
 * counts everything it actually scanned and the employers it never reached stay
 * at the front of tomorrow's queue. There is no batch cursor to corrupt.
 *
 * Scoring implements modes/_profile.md via the machine-readable mirror in
 * config/profile.yml (`evaluation:`) and soc-engine.mjs:
 *   STEP 1  hard gate      — delete / rank-bottom, with the reason recorded
 *   STEP 2  six dimensions — role, skills, seniority, location, freshness, sponsorship
 *   STEP 3  adjustments    — global remote +1.0, analysis-led +0.5, support-led -0.5,
 *                            curated list +0.3; NEW_ENTRANT_ONLY and SOC risk warn only
 *   STEP 4  edge flag      — framing note, never affects the score
 *
 * Usage:
 *   node run-daily.mjs                          # --mode=curated, 300 employers
 *   node run-daily.mjs --mode=register-only --max=300
 *   node run-daily.mjs --list=Council --tier=0 --max=50
 *   node run-daily.mjs --max=5 --skip-tailor    # quick smoke run
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { isMainModule } from './lib/is-main-module.mjs';
import * as yaml from 'js-yaml';

import { SITES, scanEmployer, openSession, targetTitles } from './aggregator-scan.mjs';
import { boardIndex, scanEmployerViaAts, sig as atsSig } from './ats-scan.mjs';
import { fetchJd } from './auto-tailor.mjs';
import * as tracker from './coverage-tracker.mjs';
import { inferSOC, scoreLanguage, salaryVerdict, classifyRemote, daysUntilDeadline, loadRates } from './soc-engine.mjs';
import { resolveSalary, unknownSalaryNote } from './pay-bands.mjs';
import { experienceGate, EXPERIENCE_YEARS, NUMERIC_PASS_CEILING } from './experience-gate.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Politeness delay between JD fetches. Was a hardcoded 400ms at four separate
 * call sites — roughly a third of the per-posting cost, since the fetch itself
 * averages ~800ms. At --jd-top=400 that difference is ~100 seconds of pure
 * waiting. 150ms still keeps requests comfortably serialised against a single
 * host; these are public job adverts, one at a time, no concurrency.
 */
const JD_SLEEP_MS = Number(process.env.JD_SLEEP_MS || 150);

/** Cached GET, mirroring aggregator-scan's Tier-1 cache semantics. */
async function fetchCachedForRun(url, ttl) {
  const { createHash } = await import('crypto');
  const { join } = await import('path');
  const dir = join('.cache', 'aggregator');
  const file = join(dir, createHash('sha1').update(url).digest('hex') + '.json');
  if (existsSync(file)) {
    try {
      const o = JSON.parse(readFileSync(file, 'utf8'));
      if (Date.now() - o.at <= (ttl || 20 * 3600 * 1000)) return { ...o, cached: true };
    } catch { /* fall through and refetch */ }
  }
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ url, at: Date.now(), status: res.status, body }), 'utf8');
  return { url, body, status: res.status, cached: false };
}
const LOG = 'output/daily_log.txt';
const BRIEF = 'output/morning_brief.md';
const HITS = 'data/daily-hits.json';

const TAILOR_PROGRESS = 'output/tailor-progress.json';

/**
 * LOCAL calendar date, not UTC.
 *
 * toISOString() converts to UTC first. IST is UTC+05:30, so a run firing at
 * 04:30 local lands on 23:00 the PREVIOUS day in UTC — and the 27 August run
 * produced a brief headed "2026-08-26". Every scheduled scan is at 02:00 local,
 * squarely inside that window, so the brief was going to be misdated on every
 * single run. The date a human reads has to be the date on their own clock.
 */
export const localDate = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Overwritten immediately when a run STARTS, then overwritten again by the
 * real report when it FINISHES. If run-daily.mjs dies anywhere in between —
 * mid-scan, mid-tailor, wherever — this stub is what's left on disk, and it
 * carries tonight's date and an explicit "in progress" marker, not
 * yesterday's completed brief silently masquerading as tonight's.
 */
function writeMorningBriefStub({ started, mode, list, tier }) {
  const M = [
    `# Morning brief — ${localDate(started)}`,
    '',
    `**Mode:** ${mode}${list ? ` / ${list}` : ''}${tier !== '' && tier ? ` / tier ${tier}` : ''}`,
    '',
    `⚠️ **RUN IN PROGRESS** — started at ${started.toISOString()}. This file will be replaced with the full brief when the run finishes. If you're reading this and it's been a while, the run likely died before completing — check ${LOG} and ${TAILOR_PROGRESS} for how far it got.`,
    '',
  ];
  writeFileSync(BRIEF, M.join('\n') + '\n', 'utf8');
}

/** Read auto-tailor's own checkpoint file rather than trust captured stdout —
 *  stdout is silently truncated/lost if the process was killed mid-batch,
 *  but the checkpoint file is rewritten atomically after every single role,
 *  so it is always the more honest source for "how far did it actually get". */
function loadTailorProgress() {
  if (!existsSync(TAILOR_PROGRESS)) return null;
  try { return JSON.parse(readFileSync(TAILOR_PROGRESS, 'utf8')); } catch { return null; }
}

/** Written only by a scan run (this file), never by followup-review.mjs. */
export function writeMorningBrief({ started, mode, list, tier, rates, st, scanned, failed,
  unique, finalRows, top, cvsMade, notFit, tailorLog, exported, fallbackNote = '' }) {
  const days = daysUntilDeadline();
  const M = [];
  M.push(`# Morning brief — ${localDate(started)}`);
  M.push('');
  M.push(`**Mode:** ${mode}${list ? ` / ${list}` : ''}${tier !== '' && tier ? ` / tier ${tier}` : ''}`);
  M.push('**Run status:** finished cleanly');
  if (fallbackNote) M.push(`\n⚠️ **Mode fallback:** ${fallbackNote}`);
  M.push(`**Days until new-entrant deadline (${rates._meta.new_entrant_deadline}):** ${days}`);
  M.push('');
  M.push('## Coverage');
  M.push(`- Scanned ever: ${st.ever} of ${st.total} (${st.never} never scanned, ~${st.nightsToFullCycle} nights to a full cycle)`);
  M.push(`- This run: ${scanned} employers scanned OK, ${failed} failed`);
  M.push(`- Reachability: ${st.byCoverage.DIRECT_API} DIRECT_API · ${st.byCoverage.AGGREGATOR_ONLY} AGGREGATOR_ONLY · ${st.byCoverage.UNREACHABLE} UNREACHABLE`);
  if (st.licenceUnconfirmed) M.push(`- ⚠️ ${st.licenceUnconfirmed} employers flagged "licence not confirmed - check before applying"`);
  M.push('');
  M.push(`## New roles`);
  M.push(`${unique.length} new postings found this run, ${finalRows.length} survived every gate.`);
  M.push('');
  M.push('## Top 10');
  M.push('| Company | Role | Salary Verdict | SOC Code | Link |');
  M.push('|---|---|---|---|---|');
  for (const r of top.slice(0, 10)) {
    M.push(`| ${(r.company || '(unattributed)').replace(/\|/g, '/')} | ${r.title.replace(/\|/g, '/')} | ${r.salaryStatus || ''} | ${r.soc || ''} | ${r.url} |`);
  }
  if (!top.length) M.push('| _(nothing passed the gate today)_ | | | | |');
  M.push('');
  M.push('## CVs generated');
  const tp = loadTailorProgress();
  if (!tp) {
    M.push('Tailoring was skipped or never started this run.');
  } else {
    const madeRows = tp.processed.filter((p) => p.result === 'made');
    const notFitRows = tp.processed.filter((p) => p.result === 'not_fit');
    const interrupted = !tp.finishedAt;
    M.push(`Ranked list: ${tp.rankedEligibleTotal} role(s) scoring 4.0+ still need a CV. This run's budget: top ${tp.batchSize} (--limit=${tp.limit}).`);
    M.push(`Got through rank ${tp.processed.length} of ${tp.batchSize} tonight: ${madeRows.length} CV/cover pairs generated, ${notFitRows.length} marked NOT A FIT on JD review.`);
    if (interrupted) {
      M.push('');
      M.push(`⚠️ **This run stopped before finishing the batch** (no completion timestamp in ${TAILOR_PROGRESS}). The top of the ranked list is NOT fully covered yet.`);
    }
    if (tp.pending.length) {
      M.push('');
      M.push(interrupted ? '**Still pending — stay in tomorrow\'s queue, not dropped:**' : '**Ranked below this run\'s budget — pending for next time:**');
      M.push('| Rank | Company | Role |');
      M.push('|---|---|---|');
      for (const p of tp.pending.slice(0, 15)) M.push(`| ${p.rank} | ${p.company} | ${p.role} |`);
      if (tp.pending.length > 15) M.push(`| ... | _(${tp.pending.length - 15} more)_ | |`);
    }
    if (madeRows.length) {
      M.push('');
      M.push('**Generated tonight:**');
      for (const r of madeRows) M.push(`- ${r.company} — ${r.role} → \`${r.cvFile}\` / \`${r.coverFile}\``);
    }
  }
  M.push('');
  M.push('## Needs your decision');
  const neo = finalRows.filter((r) => r.salaryStatus === 'NEW_ENTRANT_ONLY').length;
  const expUnverified = finalRows.filter((r) => r.experienceStatus === 'UNVERIFIED').length;
  const rankBottom = finalRows.filter((r) => r.eligible === false).length;
  const decisions = [];
  if (neo) decisions.push(`${neo} role(s) are NEW_ENTRANT_ONLY — submit before ${rates._meta.new_entrant_deadline}.`);
  if (expUnverified) decisions.push(`${expUnverified} role(s) scored but capped at 3.5 — no real JD fetched to confirm the experience gate yet.`);
  if (rankBottom) decisions.push(`${rankBottom} role(s) kept but ranked bottom — below RQF6, not viable via Skilled Worker as a first-time applicant.`);
  if (!decisions.length) decisions.push('Nothing outstanding.');
  for (const d of decisions) M.push(`- ${d}`);
  M.push('');
  M.push(`pipeline.xlsx rows: ${exported}   ·   full log: ${LOG}`);

  writeFileSync(BRIEF, M.join('\n') + '\n', 'utf8');
}

// ── config ───────────────────────────────────────────────────────────

function loadCfg() {
  const cfg = yaml.load(readFileSync('config/profile.yml', 'utf8')) || {};
  const ev = cfg.evaluation || {};
  return {
    targets: cfg.target_roles?.primary || [],
    practices: cfg.target_roles?.practice_names || [],
    excluded: cfg.target_roles?.excluded || [],
    priorities: cfg.location?.uk_locations_priority || {},
    excludedRegions: cfg.location?.uk_excluded_regions || [],
    adj: ev.adjustments || {},
    maxAge: ev.hard_gate?.max_posting_age_days ?? 7,
    edge: ev.edge_flags || {},
  };
}

const rx = (s) => new RegExp(`\\b${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');

/**
 * Recruitment agencies and job-board reposters.
 *
 * This matters more here than in an ordinary job search: a sponsor licence
 * belongs to the END EMPLOYER, never to the agency advertising the role. An
 * agency listing therefore says nothing about whether the actual hiring company
 * can sponsor, so it must not inherit the sponsorship confidence of a curated,
 * licence-verified employer.
 */
// Trading names matter more than parent brands: a posting says "Pontoon", not
// "Pontoon Solutions, part of the Adecco Group". Detection has to key on the
// name that actually appears on the advert. Pontoon slipped through and its
// letter went out with direct-employer framing ("what draws me to Pontoon
// specifically") — the same error the Harnham letter had, just less obvious.
// Names below are staffing/consulting-supply brands whose postings are for a
// client, not for themselves.
const AGENCY_RE = new RegExp('\\b(' + [
  // generic markers
  'recruit\\w*', 'resourcing', 'staffing', 'placements?', 'locums?',
  'search & selection', 'talent solutions', 'talent group', 'talent partners',
  'employment agency', 'headhunt\\w*', 'executive search', 'rpo\\b',
  // trading names (the form that appears on adverts)
  'michael page', 'page group', 'page personnel', 'hays', 'robert walters',
  'robert half', 'reed', 'harnham', 'sanderson', 'nigel wright', 'morgan mckinley',
  'jonathan lee', 'selby jennings', 'efinancialcareers', 'adecco', 'pontoon',
  'randstad', 'manpower', 'sthree', 'lorien', 'akkodis', 'experis', 'la fosse',
  'hudson', 'nash squared', 'harvey nash', 'spring technology', 'modis',
  'impellam', 'lorien global', 'gattaca', 'matchtech', 'networkers',
  'huxley', 'computer futures', 'real staffing', 'understanding recruitment',
  // Trading names confirmed as recruiters by their own naming, seen in this
  // pipeline's own results. Deliberately NOT added: K3 Advisory Group
  // (restructuring/tax/transactions), Fideres Partners (economic consulting),
  // Acosta Europe (sales & marketing) — those hire for themselves, and
  // mislabelling a direct employer as an agency produces the mirror-image
  // error: recruiter framing sent to a hiring manager.
  'amtis', 'atrium workforce', 'parkside', 'ncounter', 'eaglecliff',
  'marc daniels', 'avencia', 'corriculo', 'intec select',
  // Tenth Revolution Group (parent of Jefferson Frank / Mason Frank / Nigel
  // Frank) reached a cover letter with direct-employer framing before being
  // caught. Added with its trading brands, plus other distinctive UK tech and
  // finance recruitment names.
  //
  // RESOLVED 2026-09-05. Four of these were previously omitted as "too generic"
  // — Altum Consulting, Oliver James, People First, Everywhen — and were left
  // as a manual-check burden after all four appeared in a single day's top 20.
  // The omission was based on assumption, not measurement. Tested as full
  // phrases against all 9,327 register entries: exactly ONE match, and it is
  // the agency itself (Oliver James Associates Limited). Zero direct employers
  // match, so the mirror-image error the original note feared cannot occur for
  // these four. Added as multi-word phrases only — the bare words ("altum",
  // "everywhen") are NOT used.
  'altum consulting', 'oliver james', 'people first', 'everywhen',
  // STILL deliberately omitted, unmeasured or genuinely ambiguous: Cedar,
  // Empiric, Eligo. Each is a real recruiter but each is a single common word
  // that would also match ordinary company names — and labelling a direct
  // employer as an agency sends recruiter framing to a hiring manager, which is
  // the mirror-image error and just as bad.
  'tenth revolution', 'jefferson frank', 'mason frank', 'nigel frank', 'frank recruitment',
  'anson mccade', 'nicoll curtin', 'burns sheehan', 'trust in soda', 'third republic',
  'henderson scott', 'barclay simpson', 'goodman masson', 'marks sattin', 'camino search',
  'pro-finance', 'wade macdonald', 'sheridan maine', 'ada meher', 'spectrum it',
  'client server', 'cathcart', 'investigo', 'xpertise', 'infosec people',

  // ── Generic recruiter markers, added 2026-09-04 ──────────────────────────
  // Added after a real run put 13 agencies in the top 20 all classified as
  // direct employers, which would have sent end-employer framing to a
  // recruiter. Each marker below was measured against all 9,668 register
  // entries BEFORE being added; every one matches recruiters only:
  //   talent            8 entries, all recruiters (Meraki Talent, MARKET TALENT, …)
  //   recruitment       5 entries, all recruiters
  //   resourcing        2 entries, all recruiters
  //   staffing          4 entries, all healthcare staffing agencies
  //   search & selection 2 entries, both recruiters
  //   recruiters        0 entries today, harmless and obviously correct
  //
  // "employment" was TESTED AND REJECTED as a generic marker: it matches
  // 5 entries, of which "Balfour Beatty Group Employment Limited" is a
  // genuine direct employer and "GQ Employment Law LLP" is a law firm — a
  // 40% false-positive rate. Mislabelling a direct employer as an agency is
  // the mirror-image error and just as damaging, so the three real agencies
  // using that word are listed by full name below instead.
  'talent', 'recruitment', 'resourcing', 'staffing', 'search & selection', 'recruiters',

  // ── Named agencies seen in real top-20 output, 2026-09-04 ────────────────
  // Each verified to match exactly ONE register entry, i.e. no collateral.
  // Listed individually rather than by generic word for the same reason as
  // the omissions noted above.
  'sellick partnership', 'morson', 'broster buchanan', 'teemz', 'vaucluse',
  'norton blake', 'nick buick', 'meraki',
  'essential employment', 'positive employment', 'walsh employment',
].join('|') + ')\\b', 'i');

export const isAgency = (company) => AGENCY_RE.test(String(company || ''));

/**
 * Titles that are simply not this profile's work, however many matching
 * keywords the JD happens to contain. Without this, a JD stuffed with
 * "reporting / stakeholder / process / analysis" can push a clinical, housing
 * or board-appointment posting to a 5.
 */
const OFF_PROFILE_RE = new RegExp([
  // clinical / therapeutic
  'nurse', 'nursing', 'midwif\\w*', 'clinical', 'clinician', 'paramedic', 'physiotherap\\w*',
  'therapist', 'therapy', 'speech and language', 'speech & language', 'autism',
  'psycholog\\w*', 'radiograph\\w*', 'dental', 'pharmac\\w*', 'phlebotom\\w*', 'healthcare assistant',
  // care / social
  'social worker', 'safeguarding', 'homelessness', 'support worker', 'care worker',
  'care assistant', 'carer', 'residential care', 'domiciliary',
  // housing / facilities / trades
  'housing (officer|options|applications)', 'caretaker', 'cleaner', 'driver', 'chef',
  'catering', 'electrician', 'plumber', 'labourer',
  // education
  'teacher', 'teaching assistant', 'lecturer', 'tutor', 'headteacher', 'early years',
  // legal / governance appointments
  'solicitor', 'barrister', 'paralegal', 'chair', 'trustee', 'non[- ]executive', 'volunteer',
  // media / production
  'multi[- ]?media', 'producer', 'videograph\\w*', 'photograph\\w*', 'copywriter',
  // administrative / facilities / operational
  'admin assistant', 'administrative assistant', 'finance assistant', 'accounts assistant',
  'receptionist', 'porter', 'estates officer', 'facilities officer', 'security officer',
  'warehouse', 'logistics operative', 'kitchen',
  // other
  'creative', 'marketing operations',
].map((s) => `\\b${s}\\b`).join('|'), 'i');

/**
 * FIX 2 — does this posting actually belong to the employer we searched for?
 *
 * Reed and NHS Jobs keyword-MATCH, they do not filter by employer. Searching
 * "Aldeia Impact Advisory Ltd" returns anything containing "advisory", which is
 * how a speech-and-language therapy post got credited to an advisory firm.
 *
 * Matching must be on whole distinctive tokens, never substrings — the same
 * class of bug as "Bain" matching inside "Bainbridge". An employer is only
 * credited when its distinctive name tokens appear as WORDS in the posting's
 * own company name.
 */
const CORPORATE_STOPWORDS = new Set(['ltd', 'limited', 'llp', 'plc', 'lp', 'uk', 'group', 'holdings',
  'services', 'company', 'international', 'the', 'and', 'of', 'advisory', 'consulting', 'consultancy',
  'partners', 'associates', 'solutions', 'management', 'capital', 'impact', 'global', 'trust',
  'council', 'borough', 'district', 'city', 'county', 'university', 'college', 'nhs', 'foundation']);

export function distinctiveTokens(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !CORPORATE_STOPWORDS.has(w));
}

/** True only when the posting's own company name really is the searched employer. */
export function matchesEmployer(postingCompany, searchedFor) {
  const got = String(postingCompany || '').trim();
  if (!got) return false;                       // no employer given — cannot attribute
  const a = distinctiveTokens(got);
  const b = distinctiveTokens(searchedFor);
  if (!b.length) return false;
  if (!a.length) return false;
  // Every distinctive token of the searched employer must appear as a WHOLE
  // token in the posting's company. "bain" never matches "bainbridge".
  const setA = new Set(a);
  return b.every((tok) => setA.has(tok));
}

/**
 * Register-lookup name normalisation — deliberately SEPARATE from
 * distinctiveTokens()/matchesEmployer().
 *
 * matchesEmployer() decides whether a posting may be attributed to an employer
 * at all, and must stay strict: loosening it would credit postings to the wrong
 * company. Register lookup answers a different question ("is this employer on
 * the sponsor register?"), where the failure mode is the opposite — a miss
 * wrongly caps a genuine sponsor's score. So it gets its own, slightly more
 * forgiving tokeniser, and the strict one is left exactly as it was.
 *
 * Measured problem this solves (test-register-lookup.mjs, was 16/20):
 *   - "EY" never matched anything: distinctiveTokens() drops tokens of <= 2
 *     characters, so the signature came out empty.
 *   - "PwC" never reached "PricewaterhouseCoopers": no abbreviation expansion.
 *   - "Arup" / "Bristol-Myers Squibb" failed because lookup required EXACT
 *     signature equality, so a trading name could not match the longer
 *     registered entity that contains it.
 * Legal-suffix stripping was NOT the cause — CORPORATE_STOPWORDS already
 * removes ltd/limited/llp/plc.
 */
const REGISTER_ABBREVIATIONS = new Map([
  ['pwc', ['pricewaterhousecoopers']],
  ['ey', ['ernst', 'young']],
  ['bms', ['bristol', 'myers', 'squibb']],
  ['dxc', ['dxc']],
  ['ibm', ['ibm']],
  ['bt', ['bt']],
  ['gsk', ['glaxosmithkline']],
  ['jlr', ['jaguar', 'land', 'rover']],
  ['rbs', ['royal', 'bank', 'scotland']],
  ['hsbc', ['hsbc']],
  // Expansions must only contain tokens that SURVIVE the stopword filter on
  // the register side, or they can never match. "consultancy" and "services"
  // are stopwords, so TCS expands to "tata" alone.
  ['tcs', ['tata']],
]);

/**
 * Like distinctiveTokens(), but expands known abbreviations and lets short
 * abbreviations through the length filter. Used ONLY for register lookup.
 */
export function registerTokens(name) {
  const raw = String(name || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  for (const w of raw) {
    const expanded = REGISTER_ABBREVIATIONS.get(w);
    if (expanded) { out.push(...expanded); continue; }
    if (w.length > 2 && !CORPORATE_STOPWORDS.has(w)) out.push(w);
  }
  return out;
}

/**
 * Index every employer we know of, keyed by distinctive-token signature, so a
 * company name found on a job board can be checked against the gov.uk sponsor
 * register in one lookup.
 *
 * Returns a Map (unchanged contract for any existing caller doing idx.get()).
 * The token sets needed for the subset fallback are attached as a plain
 * property rather than changing the return type.
 */
export function buildRegisterIndex(map) {
  const idx = new Map();
  const entries = [];
  for (const rec of map.values()) {
    const toks = registerTokens(rec.org);
    if (!toks.length) continue;
    const sig = toks.slice().sort().join(' ');
    if (!idx.has(sig)) idx.set(sig, rec);
    entries.push({ set: new Set(toks), rec });
  }
  idx.subsetEntries = entries;
  return idx;
}

/**
 * Look a posting's company up against the register.
 *
 * Exact signature match first. If that fails, fall back to a subset match —
 * but ONLY when exactly one register entry contains every one of the query's
 * tokens. Zero matches or two-plus ambiguous matches both return null, so the
 * fallback can never invent a sponsor that isn't there. A false positive here
 * would be worse than the miss it replaces: it would tell us an employer can
 * sponsor when they cannot.
 */
export function lookupRegister(company, idx) {
  const toks = registerTokens(company);
  if (!toks.length) return null;

  const sig = toks.slice().sort().join(' ');
  const exact = idx.get(sig);
  if (exact) return exact;

  const entries = idx.subsetEntries;
  if (!Array.isArray(entries)) return null;      // index built by older code

  let found = null;
  for (const e of entries) {
    if (toks.every((t) => e.set.has(t))) {
      if (found) return null;                    // ambiguous — refuse to guess
      found = e.rec;
    }
  }
  return found;
}

// ── STEP 1: hard gate ────────────────────────────────────────────────

export function hardGate({ title, text, salary, posted, cfg }) {
  const soc = inferSOC(title, text);
  const remote = classifyRemote(text);

  if (remote === 'OTHER_COUNTRY') return { drop: true, reason: 'remote restricted to a non-UK country' };

  if (soc.code) {
    const sv = salaryVerdict(soc.code, salary ?? null);
    if (sv.status === 'FAIL') return { drop: true, reason: 'salary below the new-entrant floor' };
  }
  if (posted) {
    const age = Math.floor((Date.now() - Date.parse(posted)) / 86400000);
    if (Number.isFinite(age) && age > cfg.maxAge) return { drop: true, reason: `older than ${cfg.maxAge} days` };
  }
  // "No sponsorship" only fires on explicit wording, and never for a genuinely
  // global-remote role, which needs no UK sponsorship at all.
  if (/\b(no sponsorship|cannot sponsor|unable to sponsor|must (already )?have the right to work|no visa sponsorship)\b/i.test(text)
    && remote !== 'GLOBAL') {
    return { drop: true, reason: 'states it will not sponsor' };
  }
  // ── SECURITY CLEARANCE (added 2026-09-10, corrected same day) ───────────
  // UK clearance is gated on RESIDENCY, not nationality or merit. The gate
  // therefore has to compare the JD's stated requirement against the actual
  // residency figure — a blanket block on the word "clearance" throws away
  // roles that are genuinely reachable.
  //
  // CORRECTION: the first cut of this used 19 months, which is the Network
  // Rail EMPLOYMENT length, not the residency. Actual UK residency is
  // Oct 2022 (YOUR_UNIVERSITY) to Feb 2026 — see UK_RESIDENCY_MONTHS below. Against
  // the standard thresholds that changes the answer for two whole tiers:
  //
  //   BPSS   3 years   -> MET      (40 months)
  //   CTC    3 years   -> MET
  //   SC     5 years   -> not met, ~20 months short
  //   DV    10 years   -> not met
  //
  // So BPSS and CTC roles are applications worth making and must not be
  // dropped. Only the tiers she genuinely cannot reach are blocked.
  //
  // A DBS check is NOT clearance — it is a criminal-records check for
  // safeguarding and safety-critical work, a separate regime from HMG
  // vetting. the candidate holds a clear DBS from EMPLOYER_ONE; it does not satisfy
  // SC, but it is real evidence of a checkable, clean record and belongs in
  // the covering letter for any BPSS/CTC role, not in this gate.
  //
  // NOT blocked either way: "clearance desirable", "willingness to undergo
  // clearance", or a passing mention. Those are recruiter boilerplate as often
  // as requirements.
  const UK_RESIDENCY_MONTHS = 40;                  // Oct 2022 – Feb 2026
  const UK_RESIDENCY_YEARS = UK_RESIDENCY_MONTHS / 12;
  const CLEARANCE_YEARS = { bpss: 3, ctc: 3, nppv: 3, sc: 5, dv: 10 };

  const softened = /\b(?:desirable|preferred|advantageous|nice to have|beneficial|willing(?:ness)? to (?:undergo|obtain|apply))\b/i.test(text);

  // 1. An explicit residency requirement, in years. Decisive — the JD has
  //    stated the bar, so compare against it directly rather than guessing.
  const resMatch = text.match(/\b(\d{1,2})\s*(?:\+|or more)?\s*years?['’]?\s*(?:of\s+)?(?:continuous\s+)?(?:uk\s+)?(?:residency|residence)\b|\b(?:continuously\s+)?(?:resided|lived)\s+in\s+the\s+uk\s+for\s+(?:the\s+(?:last|past)\s+)?(\d{1,2})\s*years?\b/i);
  if (resMatch) {
    const required = Number(resMatch[1] ?? resMatch[2]);
    if (Number.isFinite(required) && required > UK_RESIDENCY_YEARS) {
      return { drop: true, reason: `requires ${required}y continuous UK residency (have ${UK_RESIDENCY_YEARS.toFixed(1)}y)` };
    }
    // Requirement met — fall through. This is the case the first version got
    // wrong: a 3-year residency ask is satisfied and the role is applicable.
  }

  // 2. A named clearance level with no years stated. Map it to its standard
  //    threshold and apply the same comparison.
  if (!softened) {
    const lvl = text.match(/\b(?:must (?:hold|have|be able to obtain)|required to (?:hold|obtain)|holds?|active|current|eligible for)\s+(?:a\s+|an\s+)?(bpss|ctc|nppv|sc|dv)\b[^.]{0,30}?(?:clearance|cleared|vetting|check)\b|\b(bpss|ctc|nppv|sc|dv)\s+cleared\b|\b(developed vetting)\b/i);
    if (lvl) {
      const raw = (lvl[1] || lvl[2] || lvl[3] || '').toLowerCase();
      const key = raw === 'developed vetting' ? 'dv' : raw;
      const required = CLEARANCE_YEARS[key];
      if (required && required > UK_RESIDENCY_YEARS) {
        return { drop: true, reason: `requires ${key.toUpperCase()} clearance (${required}y UK residency, have ${UK_RESIDENCY_YEARS.toFixed(1)}y)` };
      }
    }
    // An unspecified "security clearance is required" defaults to SC, which is
    // both the most common and the one she cannot currently meet.
    if (/\bsecurity\s+clearance\s+is\s+(?:required|mandatory|essential)\b/i.test(text)
      && !/\b(bpss|ctc|nppv|baseline)\b/i.test(text)) {
      return { drop: true, reason: `requires security clearance, assumed SC (5y UK residency, have ${UK_RESIDENCY_YEARS.toFixed(1)}y)` };
    }
  }

  // Below RQF6 is kept and ranked last — still viable on another visa route.
  if (soc.eligible === false) {
    return { drop: false, rankBottom: true, reason: `INELIGIBLE - below RQF6 (SOC ${soc.code})`, soc, remote };
  }
  return { drop: false, rankBottom: false, soc, remote };
}

// ── STEP 2 + 3: score ────────────────────────────────────────────────

export const UNATTRIBUTED_CAP = 3.5;

// SAFETY DEFAULT CHANGED 2026-09-04: registerVerified now defaults to FALSE.
//
// It defaulted to `true`, which made this gate fail OPEN: any caller that
// omitted the parameter — or passed undefined because the employer was absent
// from coverage.csv entirely — was scored as though the sponsor register had
// confirmed them. Real consequence, found in the live workbook: "Eaglecliff
// Limited" is on no register under any spelling, is absent from coverage.csv,
// and therefore arrived here as `undefined`. It scored 4.7, ranked 4th, was
// marked Eligible: YES, and had a CV and cover letter generated — against a
// handoff note from 2026-08-30 explicitly saying documents for that employer
// must be held back.
//
// A sponsorship check must fail CLOSED. Unknown is not the same as verified.
export function scoreRole({ title, company, text, salary, location, sourceLists, cfg, gate, attributed = true, registerVerified = false }) {
  const soc = gate.soc;
  const lang = scoreLanguage(text);
  const remote = gate.remote;

  // role match — a 5 must be EARNED by a real target title or practice name.
  // The old fallback handed any "...Manager" a 3, which is how "Creative
  // Manager" reached 5.0 overall.
  let role = 1;
  if (cfg.targets.some((t) => rx(t).test(title))) role = 5;
  else if (cfg.practices.some((p) => rx(p.split('—').pop().trim()).test(text))) role = 5;
  else if (/(analyst|consultant)/i.test(title)) role = 3;
  else if (/(advisor|adviser|manager|lead)/i.test(title)) role = 1;
  if (cfg.excluded.some((e) => rx(e).test(title))) role = 0;
  if (OFF_PROFILE_RE.test(title)) role = 0;

  // skills match — against the profile's own skill list
  const skills = (yaml.load(readFileSync('config/profile.yml', 'utf8'))?.narrative?.superpowers || []).length ? 0 : 0;
  const SKILL_WORDS = ['power bi', 'sql', 'excel', 'sharepoint', 'stakeholder', 'governance', 'raid',
    'reporting', 'commercial', 'risk', 'programme', 'process', 'analysis', 'dashboard', 'forecast'];
  const hits = SKILL_WORDS.filter((w) => text.toLowerCase().includes(w)).length;
  const skillScore = Math.min(5, hits);

  // seniority
  let seniority = 3;
  if (cfg.excluded.some((e) => rx(e).test(title))) seniority = 0;
  else if (/\b(head of|director|principal|chief)\b/i.test(title)) seniority = 2;
  else if (/\b(senior|lead)\b/i.test(title)) seniority = 4;

  // location priority
  let loc = 3;
  const hay = `${location} ${text}`;
  if (remote === 'GLOBAL') loc = 5;
  else if (cfg.excludedRegions.some((r) => rx(r).test(hay))) loc = 0;
  else {
    for (const [tier, places] of Object.entries(cfg.priorities)) {
      if ((places || []).some((p) => rx(p).test(hay))) { loc = [5, 5, 4, 3, 2][Number(tier)] ?? 3; break; }
    }
  }

  // freshness — unknown age is neutral, never a penalty
  const freshness = 3;

  // sponsorship confidence — an agency hides the employer that holds the licence
  const agency = isAgency(company);
  const sponsorship = agency ? 2 : (sourceLists ? 5 : 3);

  const base = (role + skillScore + seniority + loc + freshness + sponsorship) / 6;

  let score = base;
  const notes = [];
  if (remote === 'GLOBAL') { score += cfg.adj.remote_global ?? 1.0; notes.push('GLOBAL +1.0'); }
  if (lang.verdict === 'analysis-led') { score += cfg.adj.language_analysis_led ?? 0.5; notes.push('analysis-led +0.5'); }
  else { score += cfg.adj.language_support_led ?? -0.5; notes.push('support-led -0.5'); }
  if (sourceLists) { score += 0.3; notes.push('curated +0.3'); }

  if (agency) { score -= 0.4; notes.push('agency -0.4'); }   // end employer unverifiable
  // A posting with no identifiable employer cannot be sponsor-verified at all.
  // Keep it visible, but cap it below the 4.0 apply threshold so it can never be
  // recommended on the strength of its wording alone.
  if (attributed === false) {
    score = Math.min(score, UNATTRIBUTED_CAP);
    notes.push(`unattributed cap ${UNATTRIBUTED_CAP}`);
  }
  // A named employer that isn't on the sponsor register at all (and isn't on a
  // curated list — curated employers are always register-verified, since
  // sourceLists only ever comes from a matched register record) cannot be
  // confirmed able to sponsor. Same cap as an unattributed posting, for the
  // same reason: visible, never silently dropped, but never recommendable on
  // wording alone. lookupRegister previously had a measured ~20% false-negative
  // rate on name-variant mismatches (abbreviations like "PwC"/"EY", or a
  // trading name shorter than the registered entity). Fixed 2026-09-04 via
  // abbreviation expansion + a unique-subset fallback; test-register-lookup.mjs
  // now reports 20/20, 0% false negatives. Some residual miss rate is still
  // expected on name variants not covered by the test set, so erring toward
  // exclusion here remains deliberate.
  // STRICT-EQUALITY BUG FIXED 2026-09-04. This read `registerVerified === false`,
  // so ONLY the literal boolean false triggered the cap. undefined, null, '' and
  // the string 'NO' all sailed past it — and undefined is exactly what an
  // employer absent from coverage.csv produces. Now only an explicit `true`
  // avoids the cap; every other value is treated as "not confirmed".
  if (registerVerified !== true && !sourceLists) {
    score = Math.min(score, UNATTRIBUTED_CAP);
    notes.push(`not register-verified, cap ${UNATTRIBUTED_CAP}`);
  }
  if (role === 0) score = Math.min(score, 1.5);   // off-profile: never recommendable
  score = Math.max(0, Math.min(5, score));

  const sv = soc?.code ? salaryVerdict(soc.code, salary ?? null) : { status: 'UNKNOWN' };
  return {
    score: Math.round(score * 10) / 10, base: Math.round(base * 10) / 10, notes,
    soc, lang, remote, salaryVerdict: sv, agency,
    dimensions: { role, skills: skillScore, seniority, location: loc, freshness, sponsorship },
  };
}

/**
 * Pull an advertised salary out of JD prose.
 *
 * This is what makes Salary Verdict mean anything: without a figure every role
 * collapses to UNKNOWN and the new-entrant floor can never be tested. Ranges
 * take the LOWER bound — the floor test must pass on the number actually
 * guaranteed, not on the top of a band nobody starts at.
 */
export function extractSalary(text) {
  const t = String(text).replace(/,/g, '');
  // "£38000 - £45000", "£38k-£45k", "£38,000 per annum"
  const range = t.match(/£\s?(\d{2,3})(k\b|\d{3})\s*(?:-|–|to)\s*£?\s?(\d{2,3})(k\b|\d{3})/i);
  if (range) {
    const lo = range[2].toLowerCase() === 'k' ? Number(range[1]) * 1000 : Number(range[1] + range[2]);
    if (lo >= 15000 && lo <= 250000) return lo;
  }
  const single = t.match(/£\s?(\d{2,3})(k\b|\d{3})(?!\d)/i);
  if (single) {
    const v = single[2].toLowerCase() === 'k' ? Number(single[1]) * 1000 : Number(single[1] + single[2]);
    if (v >= 15000 && v <= 250000) return v;
  }
  return null;
}

export function edgeFlag(text, cfg) {
  const map = [
    ['capital_projects_or_infrastructure', /capital project|infrastructure|rail|construction|programme/i],
    ['financial_services', /bank|financial|finance|invest|insur/i],
    ['consulting', /consult|advisory/i],
    ['tech_product_or_data', /data|product|software|digital|analytics/i],
    ['public_sector', /council|nhs|government|public sector|university/i],
    ['stakeholder_management', /stakeholder|governance|pmo|portfolio/i],
  ];
  for (const [k, re] of map) if (re.test(text) && cfg.edge[k]) return cfg.edge[k];
  return '';
}

// ── main ─────────────────────────────────────────────────────────────

function arg(args, n, d = '') { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; }

async function main() {
  const args = process.argv.slice(2);
  const mode = arg(args, 'mode', 'curated');
  const list = arg(args, 'list');
  const tier = arg(args, 'tier');
  const entity = arg(args, 'entity');
  const max = Number(arg(args, 'max', '300'));
  // Title-first search sources. reed + nhsjobs are tier-1 (plain fetch, fast).
  // jobsgopublic is tier-2 (Playwright-driven) and covers UK public sector —
  // councils, universities, housing associations — which is a large slice of the
  // sponsor register that no tier-1 source reaches. It costs browser time, so it
  // is in the default but can be dropped with --sites=reed,nhsjobs on a fast run.
  // healthjobsuk (TRAC) is available but overlaps nhsjobs heavily; add it
  // explicitly with --sites=reed,nhsjobs,jobsgopublic,healthjobsuk if wanted.
  const sitesArg = arg(args, 'sites', 'reed,nhsjobs,jobsgopublic');
  const skipTailor = args.includes('--skip-tailor');
  const opts = { ttl: Number(arg(args, 'ttl-hours', '20')) * 3600 * 1000 };

  const cfg = loadCfg();
  const rates = loadRates();
  const started = new Date();
  mkdirSync('output', { recursive: true });
  mkdirSync('data', { recursive: true });

  writeMorningBriefStub({ started, mode, list, tier });

  // ── FUNNEL ─────────────────────────────────────────────────────────
  //
  // --by-title is now the PRIMARY route. On the last curated run, 99% of
  // by-employer results could not be attributed to the employer searched for,
  // because Reed and NHS Jobs keyword-MATCH rather than filter — searching an
  // employer's name mostly returns OTHER employers' jobs. Searching a TITLE
  // across the whole board returns real roles, and every company found is then
  // checked against the sponsor register.
  //
  // by-employer survives only where attribution is structurally reliable: an
  // ATS API returns that employer's own postings and nobody else's.
  const map = tracker.load();
  if (!map.size) { console.error('no roster — run: node coverage-tracker.mjs init'); process.exit(1); }
  const registerIdx = buildRegisterIndex(map);

  const strategy = arg(args, 'strategy', 'title');       // title | employer | both
  let fallbackNote = '';   // set if the scheduled mode had nothing due (see below)
  const maxTitles = Number(arg(args, 'max-titles', '0'));
  const force = args.includes('--force');

  const siteIds = sitesArg.split(',').map((s) => s.trim()).filter((s) => SITES[s]);
  const needsBrowser = siteIds.some((s) => SITES[s].tier === 2);

  const rows = [];
  const dropped = {};
  let rawPostings = 0, gatePassed = 0, rankBottom = 0;
  let scanned = 0, failed = 0;
  let discovered = 0, onRegister = 0, offRegister = 0;

  const session = needsBrowser ? await openSession({}) : null;
  try {
    // ── PRIMARY: title-first across the whole board ──
    if (strategy === 'title' || strategy === 'both') {
      const titles = targetTitles(maxTitles);
      console.log(`title-first: ${titles.length} target titles across ${siteIds.join(', ')}...`);
      let done = 0;
      for (const site of siteIds) {
        const cfgSite = SITES[site];
        for (const term of titles) {
          const url = cfgSite.byTitle(term);
          let found = [];
          try {
            if (cfgSite.tier === 1) {
              const r = await fetchCachedForRun(url, opts.ttl);
              if (r.status === 200) found = cfgSite.parse(r.body);
              if (!r.cached) await sleep(600);
            } else {
              await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
              await session.page.waitForSelector(cfgSite.waitFor, { timeout: 12000 }).catch(() => {});
              found = await session.page.evaluate(cfgSite.extract).catch(() => []);
              await sleep(2500);
            }
          } catch { /* one bad query must not kill the run */ }

          rawPostings += found.length;
          for (const j of found) {
            const company = j.company || '';
            // Cross-reference every result against the sponsor register.
            const reg = company ? lookupRegister(company, registerIdx) : null;
            const attributed = Boolean(company);      // the board named the employer
            if (company) { if (reg) onRegister++; else offRegister++; }

            const lists = reg ? (reg.lists || '') : '';
            const text = `${j.title} ${company} ${lists}`;
            const resolved = resolveSalary(text);
            const gate = hardGate({ title: j.title, text, salary: resolved.salary, posted: '', cfg });
            if (gate.drop) { dropped[gate.reason] = (dropped[gate.reason] || 0) + 1; continue; }
            const sc = scoreRole({
              title: j.title, company, text, salary: resolved.salary, location: '',
              sourceLists: lists, cfg, gate, attributed, registerVerified: Boolean(reg),
            });
            if (gate.rankBottom) rankBottom++;
            gatePassed++;
            rows.push({
              title: j.title, url: j.url, company, site,
              score: gate.rankBottom ? 0 : sc.score,
              salaryStatus: sc.salaryVerdict.status, salary: resolved.salary ?? '',
              salarySource: resolved.source, salaryBasis: resolved.basis,
              soc: sc.soc?.code || '', socRisk: Boolean(sc.soc?.socRisk),
              eligible: sc.soc?.eligible, remote: sc.remote, language: sc.lang.verdict,
              agency: sc.agency, edge: edgeFlag(text, cfg),
              sourceLists: lists, attributed,
              registerVerified: Boolean(reg), foundVia: `title:${term}`,
              experienceStatus: 'UNVERIFIED', experienceReason: 'no JD fetched yet',
            });

            // Self-expansion: an employer seen on a board that is NOT yet in the
            // roster gets added, so tomorrow's coverage includes it. Agencies are
            // never added — they are not the sponsoring employer.
            if (company && !reg && !isAgency(company)) {
              if (!map.has(company)) {
                map.set(company, {
                  org: company, lists: '', tier: '', cityPriority: '',
                  lastScanned: '', lastStatus: 'never', timesScanned: 0, postingsLast: 0,
                  ats: 'discovered-via-title', failures: 0, totalPostings: 0, broken: false,
                  entityType: '',
                });
                discovered++;
              }
            }
          }
          if (++done % 10 === 0) console.log(`  ${done} queries · ${rawPostings} postings · ${gatePassed} through the gate`);
        }
      }
      tracker.save(map);
    }

    // ── SECONDARY: by-employer, ONLY via a real ATS API ──
    //
    // Reed and NHS Jobs are deliberately NOT used here. Measured on a
    // 15-employer sample: 0 of 325 postings could be attributed to the employer
    // searched for, because those boards keyword-MATCH rather than filter.
    // An ATS API returns that employer's own postings and nobody else's, so
    // attribution is structural — 100% by construction, not by checking.
    if (strategy === 'employer' || strategy === 'both') {
      const idx = boardIndex();
      // AUTO-FALLBACK. If the scheduled mode has nothing left to scan — list
      // exhausted, or everything inside the 14-day cooldown — switch to the
      // other mode rather than returning an empty run. Curated is 658
      // employers and will routinely be fully covered, so a curated night
      // would otherwise report zero until the cooldown expires.
      let effMode = mode;
      let fellBack = false;
      let { batch } = tracker.nextBatch(map, { max, mode, list, tier, entity, force });
      if (!batch.length && (mode === 'curated' || mode === 'register-only')) {
        const other = mode === 'curated' ? 'register-only' : 'curated';
        const alt = tracker.nextBatch(map, { max, mode: other, list, tier, entity, force });
        if (alt.batch.length) {
          batch = alt.batch;
          effMode = other;
          fellBack = true;
          fallbackNote = `mode "${mode}" had no employers due (list exhausted or all within the ${tracker.RESCAN_DAYS}-day cooldown) — automatically switched to "${other}" for this run`;
          console.log(`\n⚠️  ${fallbackNote}\n`);
        }
      }
      const reliable = batch.filter((e) => idx.has(atsSig(e.org)));
      console.log(`by-employer: ${reliable.length} of ${batch.length} employers have a machine-readable ATS board `
        + `(${batch.length - reliable.length} skipped — no board, and keyword boards cannot attribute)`);

      for (const emp of reliable) {
        const res = await scanEmployerViaAts(emp.org, idx);
        rawPostings += res.rows.length;
        for (const j of res.rows) {
          const reg = lookupRegister(emp.org, registerIdx);
          const lists = reg ? (reg.lists || '') : (emp.lists || '');
          const text = `${j.title} ${emp.org} ${j.location || ''} ${lists}`;
          const resolved = resolveSalary(text);
          const gate = hardGate({ title: j.title, text, salary: resolved.salary, posted: '', cfg });
          if (gate.drop) { dropped[gate.reason] = (dropped[gate.reason] || 0) + 1; continue; }
          const sc = scoreRole({
            title: j.title, company: emp.org, text, salary: resolved.salary,
            location: j.location || '', sourceLists: lists, cfg, gate, attributed: true,
            registerVerified: Boolean(reg),
          });
          if (gate.rankBottom) rankBottom++;
          gatePassed++;
          rows.push({
            title: j.title, url: j.url, company: emp.org, site: `ats:${res.vendor}`,
            score: gate.rankBottom ? 0 : sc.score,
            salaryStatus: sc.salaryVerdict.status, salary: resolved.salary ?? '',
            salarySource: resolved.source, salaryBasis: resolved.basis,
            soc: sc.soc?.code || '', socRisk: Boolean(sc.soc?.socRisk),
            eligible: sc.soc?.eligible, remote: sc.remote, language: sc.lang.verdict,
            agency: sc.agency, edge: edgeFlag(text, cfg),
            sourceLists: lists, attributed: true,
            registerVerified: Boolean(reg), foundVia: `ats:${res.vendor}`,
            experienceStatus: 'UNVERIFIED', experienceReason: 'no JD fetched yet',
          });
        }
        tracker.record(emp.org, {
          status: res.ok ? 'success' : 'failed', postings: res.rows.length, ats: res.vendor || emp.ats,
        }, map);
        tracker.save(map);
        if (res.ok) scanned++; else failed++;
      }
    }
  } finally {
    if (session) await session.close();
  }

  // Dedupe on canonical URL (query strings stripped — NHS Jobs appends the
  // search keyword, so one vacancy otherwise arrives as several distinct URLs)
  // and on company+title for boards that vary the URL another way.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const canonUrl = (u) => String(u || '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
  const seenUrl = new Set();
  const seenRole = new Set();
  const unique = [];
  for (const r of rows) {
    const key = canonUrl(r.url);
    if (seenUrl.has(key)) continue;
    const roleKey = `${norm(r.company)}||${norm(r.title)}`;
    if (norm(r.company) && seenRole.has(roleKey)) continue;
    seenUrl.add(key);
    if (norm(r.company)) seenRole.add(roleKey);
    unique.push(r);
  }
  const duplicates = rows.length - unique.length;

  // ── PASS 2: JD enrichment for the top provisional scores ──
  //
  // Pass 1 scores from the job TITLE only, which is all an aggregator listing
  // gives. That systematically understates every role: the skills dimension has
  // nothing to match, scoreLanguage sees no analysis verbs so almost everything
  // takes the support-led penalty, and salary is unknown so the floor test never
  // runs. Fetching the real JD for the strongest candidates and re-scoring is
  // what lets a role legitimately clear 4.0 — and lets the hard gate actually
  // fire on salary and sponsorship wording.
  const jdTopArg = arg(args, 'jd-top', '400');
  const jdTop = /^all$/i.test(jdTopArg) ? Infinity : Number(jdTopArg);
  let enriched = 0, jdFailed = 0, droppedAfterJd = 0, droppedByExperience = 0;
  if (jdTop > 0 && !args.includes('--no-jd')) {
    const ranked = [...unique].sort((a, b) => b.score - a.score).slice(0, jdTop);
    console.log(`
fetching JDs for the top ${ranked.length} by provisional score...`);
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i];
      const jd = await fetchJd(r.url, r.title);
      if (!jd.ok) { r.jdStatus = `unavailable (${jd.reason})`; jdFailed++; await sleep(JD_SLEEP_MS); continue; }

      const text = `${r.title} ${r.company || ''} ${jd.text}`;
      const resolved = resolveSalary(`${r.title} ${jd.text}`);
      const salary = resolved.salary;
      const gate = hardGate({ title: r.title, text, salary, posted: '', cfg });
      if (gate.drop) {
        r.dropAfterJd = gate.reason;
        dropped[gate.reason] = (dropped[gate.reason] || 0) + 1;
        droppedAfterJd++;
        await sleep(JD_SLEEP_MS);
        continue;
      }

      // ── EXPERIENCE / SENIORITY HARD GATE ──────────────────────────────
      // Separate from, and applied AFTER, the SOC/salary/visa gate above —
      // that gate is untouched. Only runs on roles that already cleared SOC
      // eligibility and the salary floor (rankBottom roles are already
      // disqualified on visa grounds; running this gate on them too would add
      // nothing and risks changing their existing "kept, ranked bottom"
      // visibility, which must not change).
      if (!gate.rankBottom) {
        const exp = experienceGate({ title: r.title, jdText: jd.text, jdFetched: true });
        r.experienceStatus = exp.status;
        r.experienceReason = exp.reason;
        r.experienceYears = exp.years ?? '';
        if (exp.status === 'FAIL') {
          r.dropAfterJd = `experience gate: ${exp.reason}`;
          dropped[`experience gate: ${exp.check}`] = (dropped[`experience gate: ${exp.check}`] || 0) + 1;
          droppedAfterJd++;
          droppedByExperience++;
          await sleep(JD_SLEEP_MS);
          continue;
        }
      }

      const sc = scoreRole({
        title: r.title, company: r.company, text, salary, location: '',
        sourceLists: r.sourceLists, cfg, gate, attributed: r.attributed,
        // Coerce explicitly: r.registerVerified can arrive undefined for an
        // employer absent from coverage.csv, and undefined must read as
        // "not confirmed", never as "verified". See the scoreRole() header.
        registerVerified: r.registerVerified === true,
      });
      r.scoreFromTitle = r.score;
      r.score = gate.rankBottom ? 0 : sc.score;
      r.salary = salary ?? '';
      r.salarySource = resolved.source;
      r.salaryBasis = resolved.basis;
      r.salaryConfidence = resolved.confidence || '';
      r.salaryStatus = sc.salaryVerdict.status;
      if (resolved.source === 'UNKNOWN' && sc.soc?.code) {
        r.salaryAsk = unknownSalaryNote(sc.soc.code, rates);
      }
      r.soc = sc.soc?.code || r.soc;
      r.socRisk = Boolean(sc.soc?.socRisk);
      r.eligible = sc.soc?.eligible;
      r.remote = sc.remote;
      r.language = sc.lang.verdict;
      r.edge = edgeFlag(text, cfg) || r.edge;
      r.agency = sc.agency;
      r.jdStatus = 'enriched';
      enriched++;
      if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${ranked.length} JDs`);
      await sleep(JD_SLEEP_MS);
    }
  }
  const finalRows = unique.filter((r) => !r.dropAfterJd);

  // "Do not score or PASS any role evaluated without a real JD fetch." A role
  // that never made it into the JD-enrichment top-N still carries its pass-1,
  // title-only score — capped here so it can never cross the 4.0 apply
  // threshold while its experience requirement remains unchecked. Once
  // JD-enriched, experienceStatus becomes PASS (score stands) or the row is
  // dropped entirely above (FAIL) — this cap only ever binds on UNVERIFIED.
  const EXPERIENCE_UNVERIFIED_CAP = 3.5;
  for (const r of finalRows) {
    if (r.experienceStatus === 'UNVERIFIED') r.score = Math.min(r.score, EXPERIENCE_UNVERIFIED_CAP);
  }

  writeFileSync(HITS, JSON.stringify(finalRows, null, 2), 'utf8');

  // 6. export
  const exp = spawnSync(process.execPath, ['export-excel.mjs', `--from=${HITS}`], { encoding: 'utf8' });
  const exported = (exp.stdout || '').match(/total rows\s*:\s*(\d+)/)?.[1] ?? '?';

  // 7. tailor
  let cvsMade = 0, notFit = 0, spawnedTailorStdout = '';
  if (!skipTailor) {
    const tl = spawnSync(process.execPath, ['auto-tailor.mjs', '--limit=25'], { encoding: 'utf8' });
    spawnedTailorStdout = tl.stdout || '';
    cvsMade = Number(spawnedTailorStdout.match(/documents generated\s*:\s*(\d+)/)?.[1] ?? 0);
    notFit = Number(spawnedTailorStdout.match(/marked NOT A FIT\s*:\s*(\d+)/)?.[1] ?? 0);
  }

  // 8. report
  const st = tracker.stats(tracker.load(), { nightly: max || 300, mode, list, tier, entity });
  const scored4 = finalRows.filter((r) => r.score >= 4.0);
  const neo = finalRows.filter((r) => r.salaryStatus === 'NEW_ENTRANT_ONLY').length;
  const globalRemote = finalRows.filter((r) => r.remote === 'GLOBAL').length;
  const ineligible = finalRows.filter((r) => r.eligible === false).length;
  const top = [...finalRows].sort((a, b) => b.score - a.score).slice(0, 20);

  const L = [];
  L.push('====== UK JOB PIPELINE ======');
  L.push(`Date: ${localDate(started)}   Mode: ${mode}${list ? ` / ${list}` : ''}${tier !== '' && tier ? ` / tier ${tier}` : ''}   Strategy: ${strategy}${strategy !== 'employer' ? `   Titles searched: ${targetTitles(maxTitles).length}` : ''}`);
  L.push(`Days until new entrant deadline (${rates._meta.new_entrant_deadline}): ${daysUntilDeadline()}`);
  L.push('');
  L.push(`Run status: finished cleanly`);
  if (fallbackNote) L.push(`⚠️  MODE FALLBACK: ${fallbackNote}`);
  L.push(`Coverage: ${st.ever} of ${st.total} scanned ever, ${st.never} never, ~${st.nightsToFullCycle} nights to a full cycle`);
  L.push(`Reachability: ${st.byCoverage.DIRECT_API} DIRECT_API · ${st.byCoverage.AGGREGATOR_ONLY} AGGREGATOR_ONLY · ${st.byCoverage.UNREACHABLE} UNREACHABLE · ${st.licenceUnconfirmed} licence not confirmed - check before applying`);
  L.push(`Employers this run: ${scanned} scanned OK, ${failed} failed`);
  L.push('');
  L.push(`New postings: ${rawPostings}   Passed hard gate: ${gatePassed}   Deleted: ${rawPostings - gatePassed}   Duplicate postings merged: ${duplicates}`);
  L.push(`Unique postings after dedupe: ${unique.length}`);
  if (Object.keys(dropped).length) {
    for (const [why, n] of Object.entries(dropped).sort((a, b) => b[1] - a[1])) L.push(`  deleted ${n}: ${why}`);
  } else {
    L.push('  deleted 0');
  }
  if (rankBottom) L.push(`  kept but ranked bottom: ${rankBottom} (below RQF6 — viable on another visa route)`);
  L.push('');
  L.push(`JD enrichment: ${enriched} fetched and re-scored, ${jdFailed} unavailable, ${droppedAfterJd} dropped by the gate once the JD was read`);
  L.push(`Scoring 4.0+: ${scored4.length}   CVs generated: ${cvsMade}${skipTailor ? ' (tailor skipped)' : ''}${notFit ? `   marked NOT A FIT: ${notFit}` : ''}`);
  const bandLookup = finalRows.filter((r) => r.salarySource === 'BAND_LOOKUP').length;
  const advertised = finalRows.filter((r) => r.salarySource === 'ADVERTISED').length;
  const unknownSal = finalRows.filter((r) => !r.salarySource || r.salarySource === 'UNKNOWN').length;
  const unattributed = finalRows.filter((r) => !r.attributed).length;
  L.push(`Funnel: ${strategy}-first · register cross-reference: ${onRegister} on register, ${offRegister} not on register · ${discovered} new employers auto-added`);
  L.push(`Salary resolved: ${advertised} advertised · ${bandLookup} from BAND_LOOKUP · ${unknownSal} still unknown`);
  L.push(`Unattributed to the searched employer: ${unattributed} of ${finalRows.length} (no curated bonus applied)`);
  const expPass = finalRows.filter((r) => r.experienceStatus === 'PASS').length;
  const expUnverified = finalRows.filter((r) => r.experienceStatus === 'UNVERIFIED').length;
  L.push(`Experience gate: ${droppedByExperience} FAILed and dropped · ${expPass} PASSed (JD-verified) · ${expUnverified} UNVERIFIED (capped at ${EXPERIENCE_UNVERIFIED_CAP}, no JD fetched)`);
  L.push(`Agency-posted (end employer unknown): ${finalRows.filter((r) => r.agency).length} of ${finalRows.length}   ·   direct employers scoring 4.0+: ${scored4.filter((r) => !r.agency).length}`);
  L.push(`NEW_ENTRANT_ONLY: ${neo}   Global remote: ${globalRemote}   INELIGIBLE: ${ineligible}`);
  L.push('');
  L.push('TOP 20 TODAY');
  L.push('rank | company | role | score | salary verdict | link');
  L.push('-'.repeat(112));
  top.forEach((r, i) => {
    L.push([
      String(i + 1).padStart(4),
      ((r.agency ? '[agy] ' : '') + (r.company || '(unattributed)')).slice(0, 28).padEnd(28),
      r.title.slice(0, 34).padEnd(34),
      String(r.score).padStart(4),
      (r.salaryStatus || '').padEnd(16),
      r.url,
    ].join(' | '));
  });
  if (!top.length) L.push('  (nothing passed the gate today)');
  L.push('');
  L.push(`pipeline.xlsx rows: ${exported}   ·   log: ${LOG}`);
  L.push('='.repeat(30));

  const out = L.join('\n');
  console.log('\n' + out);
  writeFileSync(LOG, out + '\n', 'utf8');

  writeMorningBrief({
    started, mode, list, tier, rates, st, scanned, failed, unique, finalRows, top,
    cvsMade, notFit, tailorLog: skipTailor ? '' : (spawnedTailorStdout || ''), exported, fallbackNote,
  });
  console.log(`morning brief: ${BRIEF}`);
}

/**
 * A run can end three ways, and until now two of them looked identical on
 * disk: the stub said "RUN IN PROGRESS" whether the process hit a usage limit
 * or crashed on a null dereference. On an 8,900-employer sweep that is exactly
 * the distinction that matters — one means "resume tonight", the other means
 * "fix the bug first". This writes the reason, the error, and how far
 * tailoring got, so the morning brief never leaves it ambiguous.
 */
function writeInterruptedBrief(err, started, mode) {
  const msg = String(err?.message || err || 'unknown');
  // Usage/quota exhaustion has a recognisable shape and is NOT a defect —
  // it means the work was real and there was simply more of it than budget.
  const isLimit = /usage limit|rate limit|quota|429|too many requests|session limit|insufficient credit/i.test(msg);
  // Which morning the catch-up actually runs. Scans are Tue/Fri; the catch-up
  // pass is the following morning at 07:00 (Wed/Sat). Naming the real next
  // pass beats a generic "next run" — the whole point of the stop reason is
  // that you know what happens next without checking Task Scheduler.
  const CATCHUP_AFTER = { 2: 'Wednesday 07:00', 5: 'Saturday 07:00' };
  const nextPass = CATCHUP_AFTER[started.getDay()] || 'the next catch-up pass';

  let pendingCount = null;
  let tail = '';
  try {
    if (existsSync(TAILOR_PROGRESS)) {
      const tp = JSON.parse(readFileSync(TAILOR_PROGRESS, 'utf8'));
      const made = tp.processed.filter((p) => p.result === 'made').length;
      pendingCount = tp.pending.length;
      tail = `\n\nTailoring reached rank ${tp.processed.length} of ${tp.batchSize} (${made} pairs written). `
        + `${tp.pending.length} role(s) still pending — they keep their place in the queue and are picked up by the catch-up pass at ${nextPass}.`;
      if (tp.pending.length) {
        tail += '\n\n| Rank | Company | Role |\n|---|---|---|\n'
          + tp.pending.slice(0, 10).map((p) => `| ${p.rank} | ${p.company} | ${p.role} |`).join('\n');
      }
    }
  } catch { /* progress file unreadable — the reason above still stands */ }

  // Assembled AFTER the progress read so the pending count can go in the
  // headline, matching the specified form:
  //   "stopped: usage limit reached, N roles pending, resuming at 7am"
  const reason = isLimit
    ? `stopped: usage limit reached${pendingCount !== null ? `, ${pendingCount} role(s) pending` : ''}, resuming at ${nextPass}`
    : `stopped: error — ${msg.split('\n')[0].slice(0, 200)}`;

  const M = [
    `# Morning brief — ${localDate(started)}`,
    '',
    `**Mode:** ${mode}`,
    `**Run status:** ${reason}`,
    '',
    isLimit
      ? '⚠️ The run did not finish, but nothing is lost. Coverage is written per employer as it goes, so every employer actually scanned is recorded and the ones never reached stay at the front of the queue. Re-run to continue from where it stopped.'
      : `⚠️ The run stopped on an error, not a budget limit. This needs looking at before the next scheduled run — re-running will most likely fail the same way.\n\n\`\`\`\n${msg.slice(0, 600)}\n\`\`\``,
    tail,
    '',
    `Full log up to the failure: ${LOG}`,
  ];
  try { writeFileSync(BRIEF, M.join('\n') + '\n', 'utf8'); } catch { /* nothing further we can do */ }
  return reason;
}

if (isMainModule(import.meta.url)) {
  const startedAt = new Date();
  const modeArg = arg(process.argv.slice(2), 'mode', 'curated');
  main().catch((e) => {
    console.error(e);
    const reason = writeInterruptedBrief(e, startedAt, modeArg);
    console.error(`\n${reason}\nmorning brief records the stop reason: ${BRIEF}`);
    process.exit(1);
  });
}
