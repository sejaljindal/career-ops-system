#!/usr/bin/env node
/**
 * eligibility.mjs — the gate that decides whether a role is the candidate's at all.
 *
 * WHY THIS EXISTS, WRITTEN PLAINLY
 *
 * On 2026-09-12 the candidate audited a list of 25 UK roles I had scored 4+ and
 * tailored CVs for. Eleven of the 25 were roles she could never apply to: a
 * Cloud FinOps Engineer, a Solutions Design Engineer, three Manager-grade
 * posts, a role with "Security Cleared" in the title, and three requiring a
 * qualified accountant. Of the 131 roles I produced that day, 90 failed the
 * same audit.
 *
 * The constraints were not missing from the repo. experience-gate.mjs encodes
 * seniority. role-score.mjs has a gated ceiling. run-daily.mjs has a security
 * clearance blocker with 14 passing tests. All of it works. And none of it is
 * called by ready-to-send.mjs or tailor-cv.mjs — the two files that actually
 * decide what reaches her. Weeks of gate-building sat in modules the delivery
 * path skips.
 *
 * So this module is deliberately not another scorer. Scoring rewards keyword
 * density, which is exactly how "Continuous Improvement & Business Systems
 * Manager" reached 4.2 — it is dense with her vocabulary and wrong on every
 * dimension that matters. This is a hard yes/no, applied at the point of
 * delivery, and it returns the REASON so a rejection can be audited rather
 * than trusted.
 *
 * ── HER ACTUAL PROFILE ───────────────────────────────────────────────────
 *   ~2 years' experience. MSc Management (Finance), YOUR_UNIVERSITY. BBA.
 *   Business graduate — NOT an engineer, NOT a software developer,
 *   NOT a qualified accountant (no ACA/ACCA/CIMA/CPA).
 *   Cannot obtain UK security clearance.
 *
 * ── HER PRIORITY ORDER, AS SHE STATED IT ─────────────────────────────────
 *   1. Project management / project controls / PMO / programme delivery
 *   2. Strategy and operations
 *   3. Transformation / management consulting
 *   4. Business Analyst — BOTTOM, and business/management BA only
 *
 * Tier 4 being last is load-bearing. Left to itself the pipeline returns
 * almost nothing but Business Analyst, because that phrase appears in every
 * job advert she has ever matched.
 *
 * ── HER OWN TARGET TITLE LIST, VERBATIM ──────────────────────────────────
 *
 * She gave me this at the start and I compressed it into four families,
 * which silently dropped several of them. Widened 2026-09-12 after she
 * pointed that out. Her words: "I'm targeting strategy and operations
 * consulting, transformation and programme delivery roles."
 *
 *   PMO Analyst                       Delivery Consultant
 *   Programme Controls Analyst        Operations Consultant
 *   Assistant Project Manager         Performance Improvement Analyst
 *   Business Analyst                  Infrastructure Consultant
 *   Strategy & Operations Analyst     Project Controls Consultant
 *   Transformation Analyst            Business Transformation Consultant
 *   Consulting Analyst                Programme Analyst
 *   Management Consultant Analyst
 *   Associate Consultant
 *   Business Consultant
 *
 * Every one of those must match a tier. There is a test case for each.
 */

// ── HARD BLOCKS ──────────────────────────────────────────────────────────
// Each of these is a reason a real posting was wrongly sent to her.

/**
 * Engineering and software. The word "engineer" alone is not enough to block —
 * "Project Controls Engineer" is genuinely her discipline at some firms — but
 * it IS enough to demote, because those reqs usually ask for an engineering or
 * quantity-surveying degree. Handled as TECHNICAL_TITLE below.
 */
const SOFTWARE = /\b(software|developer|programmer|full[- ]?stack|front[- ]?end|back[- ]?end|devops|sre\b|site reliability|kubernetes|terraform|cloud (?:engineer|architect)|finops|solutions? architect|technical architect|infrastructure engineer|network engineer|data engineer|ml engineer|machine learning engineer|qa engineer|test engineer|automation engineer|systems engineer|platform engineer|security engineer|penetration|embedded|firmware|mechanical|electrical|civil engineer|structural engineer|design engineer|solutions design)\b/i;

/** Tool-led and data-platform roles. She uses Power BI; she is not a BI dev. */
// Kept in step with the India gate. A module-specific SAP list let "SAP
// Investment Management Consultant" through on the word "Consultant", and IT
// service management (patch, incident, ITIL) was not covered at all.
const TECHNICAL_TOOLING = /\b(anaplan|onestream|\bsap\b|workday (?:integration|extend)|salesforce (?:developer|admin)|servicenow|mdm\b|master data management|data modelling|data modeling|etl\b|data warehouse|data platform|bi developer|power bi developer|tableau developer|informatica|application support|technical support|infrastructure support|data quality|patch management|vulnerability management|endpoint|itil\b|itsm\b|incident management|release management|middleware|api management)\b/i;

/** Titles carrying an engineer label even where the work might fit. */
const TECHNICAL_TITLE = /\bengineer(?:ing)?\b/i;

/**
 * Manager grade and above. She is ~2 years in. Split in two: OTHER_SENIOR
 * always blocks, but bare "manager" is excused when the title is an
 * assistant-level post ("Assistant Project Manager (PMO)") — an assistant
 * manager is junior, not the grade this gate exists to stop.
 */
const OTHER_SENIOR = /\b(head of|director|principal|chief|vp\b|avp\b|svp\b|partner|associate director|senior manager|lead analyst|team lead|controller of)\b/i;
const BARE_MANAGER = /\bmanager\b/i;
const ASSISTANT_LEVEL = /\bassistant\b/i;

/**
 * Big-4 / MBB whitelist. At EY / PwC / KPMG / Deloitte / Accenture /
 * Bain / BCG / McKinsey / Kearney specifically, "Senior [Analyst /
 * Associate / Consultant]" is a genuine 2-3 year band — not the 5+
 * year band that same title means at boutiques. So at these firms only,
 * "Senior + junior noun" passes as a stretch flag rather than being
 * hard-blocked with the other seniors. Added 2026-09-24 at the candidate's
 * explicit ask.
 */
const BIG4_MBB_TITLE = /\b(ey|pwc|kpmg|deloitte|accenture|bain|bcg|mckinsey|kearney)\b/i;
const BIG4_STRETCH_TITLE = /\bsenior\s+(analyst|associate|consultant)\b/i;

/**
 * REWRITTEN 2026-09-24: senior/lead titles are now a HARD BLOCK, not a
 * stretch flag. She has up to 3 years; a "Senior Consultant" at Big 4 is
 * typically 3-5 and at boutiques it's 5+. Even in the best case it's a
 * reach that outranked her genuine-fit roles because the sort put stretch
 * roles inside their tier ahead of non-stretch roles in the next tier.
 * She asked for these to rank last and be labelled stretch outright rather
 * than earn a score, so the cleanest fix is: block at the gate. If she
 * wants any specific senior posting through, adding it via `add-roles.mjs`
 * still generates its CV; it just won't clutter the send list by default.
 */
const SENIOR_TITLE = /\b(senior|lead|specialist ii|experienced)\b/i;

/** Requires a qualified accountant. Her MSc is Management (Finance). */
const NEEDS_ACCOUNTANCY = /\b(aca\b|acca\b|cima\b|cpa\b|icaew|chartered accountant|qualified accountant|newly qualified|part[- ]qualified|accountant|accounts (?:assistant|analyst|payable|receivable)|bookkeep|audit senior|statutory accounts|management accountant|financial accountant)\b/i;

/** Security clearance she cannot obtain. */
/**
 * Security clearance she cannot obtain.
 *
 * FIXED 2026-09-12 after the audit put "Vaucluse Associates — SC Cleared
 * Business Analyst, Central Government" in the KEEP list at tier 4.
 *
 * The alternative was `sc clear`, and the whole group is followed by `\b`. On
 * "SC Cleared" the engine matched "sc clear" and then demanded a word boundary
 * before the "e" of "Cleared" — there isn't one, so the whole match failed and
 * a central-government cleared role sailed through. `security clear(?:ed|ance)`
 * had the suffix handled, which is why the EKIM role blocked correctly and
 * this one did not.
 *
 * Bare `mod\b` is also gone: it fired on ordinary words and blocked Monzo's
 * "Finance Internal Controls Analyst", which has nothing to do with defence.
 */
/**
 * Clearance is checked differently in the TITLE and in the JOB DESCRIPTION,
 * because the word "defence" behaves differently in each.
 *
 * In a title it is the sector: "Reporting Analyst - Defence" means defence
 * work and nothing else, and there is usually no word after it to qualify it.
 *
 * In a description it is very often ordinary vocabulary. "Defence in depth" is
 * standard information-security language, which is how Monzo's Finance
 * Internal Controls Analyst and Turner & Townsend's Risk Analyst were both
 * blocked as clearance roles when they are nothing of the kind.
 *
 * A first attempt made "defence" require a following word like "sector" in
 * both places. That fixed the false positives and immediately broke the real
 * case — the Turner & Townsend Defence posting started passing at tier 4.
 * Hence two patterns.
 */
const CLEARANCE_CORE = 'security clear(?:ed|ance)|sc[- ]clear(?:ed|ance)?|dv[- ]clear(?:ed|ance)?|developed vetting|list ?x\\b|ministry of defence|nuclear site licen|npsa\\b|uk security vetting|must be a british (?:citizen|national)|sole uk national';

/** Titles: bare "defence" or "defense" counts. */
const NEEDS_CLEARANCE_TITLE = new RegExp(`\\b(${CLEARANCE_CORE}|defen[cs]e\\b)`, 'i');

/** Descriptions: defence only counts when a following word names the sector. */
const NEEDS_CLEARANCE_BODY = new RegExp(`\\b(${CLEARANCE_CORE}|defen[cs]e (?:sector|industry|account|client|programme|program|business|contract))`, 'i');

/** Specialist domains with a licensing or deep-domain barrier. */
const SPECIALIST_DOMAIN = /\b(actuar|underwrit|claims handler|financial crime|economic crime|anti[- ]money|aml\b|kyc\b|sanctions|conduct risk|cass\b|solvency|reinsurance|credit risk|credit analyst|remuneration|payroll|tax (?:senior|manager|associate|advisor)|clinical|pharmacovigilance|regulatory affairs|legal counsel|company secretar|therapist|speech and language)\b/i;

/** Functions that are simply not what she does. */
const WRONG_FUNCTION = /\b(sales|account executive|business development (?:manager|executive|representative)|sdr\b|recruit|talent acquisition|people (?:operations|partner|systems)|hr\b|human resources|customer service|customer support|client manager|relationship (?:manager|executive)|marketing (?:manager|executive)|copywrit|creative|designer|nurse|teacher|driver|warehouse|administrator only)\b/i;

/**
 * Graduate schemes, management trainee and PMO trainee routes.
 *
 * Added 2026-09-12 at her request: "management trainee/pmo trainee and grad
 * roles too if i am still eligible for them especially in uk".
 *
 * These were being blocked as "outside her four target families", because
 * "Management Trainee" contains none of her target title words. They are a
 * legitimate route into exactly the work she wants, and UK consultancies run
 * structured PMO and consulting graduate intakes.
 *
 * THE ELIGIBILITY QUESTION IS COHORT, NOT CAPABILITY. Some schemes are open
 * to any graduate; others restrict to a named year ("2025/2026/2027
 * graduates" — the Arcadis Graduate Business Analyst did exactly this, which
 * is why it was cut). COHORT_RESTRICTED below detects that and flags it rather
 * than guessing at her graduation year, because guessing wrong in either
 * direction costs her either a wasted application or a missed one.
 */
// The first alternative used to be a fixed word list — graduate + one of
// scheme/programme/analyst/consultant/trainee — which missed "Graduate
// Business Analyst", the exact Arcadis posting that prompted this work,
// because "business" sat between the two words it was looking for. It now
// allows intervening words. The lookahead keeps "graduate degree" and
// "graduate calibre" out, since those are requirements in an ordinary advert
// rather than the name of a scheme.
const GRAD_TRAINEE = /\b(graduate\b(?!\s+(?:degree|level|calibre|studies))[^,|–—]*\b(?:scheme|programme|program|analyst|consultant|associate|trainee|role|opportunit)|management trainee|graduate trainee|pmo trainee|project management trainee|trainee (?:analyst|consultant|project|pmo)|early careers?|apprentice(?:ship)? (?:analyst|consultant)|rotational (?:scheme|programme|program))\b/i;

/**
 * A named-cohort restriction in the JD, e.g. "2027 graduates only".
 *
 * EXPANDED 2026-09-24 (ported from the UK repo, 2026-09-25): two reverse
 * phrasings were silently missing. "Class of 2026" is the single most common
 * idiom for naming a graduation cohort and matched nothing here — none of the
 * existing alternatives require the word "graduat" at all, and this one
 * doesn't contain it. "Expected graduation: 2026" (a form field label, no
 * "in"/"by" preposition between the noun and the year) also matched nothing —
 * the existing `graduat\w*\s+(?:in|by)\s+20\d\d` alternative requires that
 * preposition, and a bare colon or nothing at all is just as common in a real
 * posting.
 */
const COHORT_RESTRICTED = /\b(20\d\d)\s*(?:\/\s*20\d\d\s*)*graduat|graduat\w*\s+(?:in|by)\s+20\d\d|must (?:be|have) graduat\w*\s+(?:in|within|no earlier)|final[- ]year students?|penultimate year|class\s+of\s+20\d\d|expected\s+graduation(?:\s+date)?\s*:?\s*20\d\d/i;

/** Non-executive / governance appointments — not an employed role at all. */
const GOVERNANCE_APPOINTMENT = /\b(chair|chairperson|non-executive director|trustee|board member)\b/i;

/**
 * A "Business Analyst" title that is actually a technical/IT-flavoured role
 * wearing the BA phrase her CV keywords match on — not the business/management
 * BA at the bottom of her tier list.
 */
const TECH_FLAVORED_BA = /\b(ai|it)\s+business analyst\b|\bbusiness analyst\b.*\btechnology consulting\b|\btechnology consulting\b.*\bbusiness analyst\b/i;

// ── PRIORITY TIERS, IN HER ORDER ─────────────────────────────────────────

const TIER = [
  {
    n: 1,
    label: 'project management / PMO / project controls',
    // "programme controls analyst", "delivery consultant" and "infrastructure
    // consultant" are hers verbatim and were missing until 2026-09-12.
    // "program management" and "programme management" were both missing —
    // only "program manager" with the -er. Kept in step with the India gate,
    // which rejected a 2-5 year "Analyst - Program Management" role because of
    // it.
    re: /\b(pmo\b|project management office|programme management office|project management|program(?:me)? management|project manager|assistant project manager|programme manager|program manager|project controls?|programme controls?|program controls?|project controller|project coordinator|project consultant|project analyst|programme analyst|program analyst|project support|project planner|planner\b|scheduler|delivery (?:analyst|manager|lead|coordinator|consultant|specialist)|programme delivery|program delivery|portfolio (?:analyst|office|management)|benefits management|performance and reporting|programme office|capital projects?|infrastructure consultant|infrastructure advisory)\b/i,
  },
  {
    n: 2,
    label: 'strategy and operations',
    // "Strategy & Operations Analyst" and "Operations Consultant" are hers
    // verbatim. The bare "operations analyst" stays in tier 4.
    re: /\b(strategy|strategic planning|corporate development|commercial planning|business planning|market entry|growth strategy|strategy and operations|strategy & operations|business operations|operations consultant|operational strategy|commercial strategy)\b/i,
  },
  {
    n: 3,
    label: 'transformation / management consulting',
    // "consulting analyst", "management consultant analyst", "business
    // consultant", "business transformation consultant" and "performance
    // improvement analyst" are hers verbatim. "performance improvement" was
    // missing entirely — only "process improvement" was here.
    // Bare "consulting" was missing, so "Graduate Scheme - Consulting" fell
    // through to the graduate tier and lost its function. Every pattern here
    // that could be a technical consultancy is already caught upstream by
    // TECH_FLAVORED_BA and SOFTWARE.
    re: /\b(transformation|transformation (?:analyst|consultant|lead)|business transformation|change (?:analyst|consultant|lead|manager)|management consult(?:ing|ant|ancy)?|consulting\b|consulting analyst|consultant|associate consultant|senior associate|business consulting|business consultant|advisory|process (?:improvement|optimisation|optimization|excellence)|performance improvement|operational excellence|continuous improvement|operating model|business improvement)\b/i,
  },
  {
    n: 4,
    label: 'business analyst (business/management only)',
    // "revenue support analyst" was blocked as "outside her four target
    // families" on 2026-09-12 and she was right to query it — it is a
    // commercial analyst role under another name. Same for the plain
    // operations analyst titles at OakNorth and Deutsche Bank, which I cut
    // by hand rather than by rule and should not have.
    // "business analysis" and "business analytics" were both missing — a role
    // titled "Business Analysis" rather than "Business Analyst" matched no
    // tier at all.
    re: /\b(business analyst|business analysis|business analytics|business systems analyst|functional analyst|requirements analyst|business management analyst|commercial analyst|insight analyst|insights analyst|reporting analyst|performance analyst|operations analyst|business operations analyst|revenue analyst|revenue support|business support analyst|planning analyst|business partner)\b/i,
  },
  {
    n: 5,
    label: 'graduate / trainee scheme',
    // Checked LAST, so a grad scheme that also names her function — "Graduate
    // Project Controls Consultant" — lands at tier 1 where it belongs rather
    // than being filed as a generic grad role.
    re: GRAD_TRAINEE,
  },
];

// ── THE GATE ─────────────────────────────────────────────────────────────

/**
 * @param {string} title  the job title
 * @param {string} [jd]   the job description text, if fetched
 * @param {string} [company] the employer name, for the Big-4/MBB stretch
 *   exception below — a real job title almost never repeats the firm's own
 *   name, so that exception was checking a string that could never match it.
 * @returns {{ok: boolean, tier: number|null, label: string, reason: string, stretch: boolean}}
 */
export function checkEligibility(title, jd = '', company = '') {
  const t = String(title || '');
  // The JD is searched ONLY for clearance and qualification requirements. It is
  // deliberately not searched for the blocklists: a business analyst advert
  // routinely mentions "engineers" as stakeholders, and blocking on that would
  // throw away the good roles.
  const body = String(jd || '');

  const no = (reason) => ({ ok: false, tier: null, label: '', reason, stretch: false });

  if (NEEDS_CLEARANCE_TITLE.test(t) || NEEDS_CLEARANCE_BODY.test(body)) {
    return no('requires UK security clearance / UK nationality');
  }
  if (SOFTWARE.test(t)) return no('software or engineering discipline');
  if (TECHNICAL_TOOLING.test(t)) return no('tool-led or data-platform role');
  if (GOVERNANCE_APPOINTMENT.test(t)) return no('non-executive / governance appointment, not an employed role');
  if (TECH_FLAVORED_BA.test(t)) return no('technology/IT-flavoured business analyst role, not business/management BA');
  if (OTHER_SENIOR.test(t)) return no('manager grade or above');
  if (BARE_MANAGER.test(t) && !ASSISTANT_LEVEL.test(t)) return no('manager grade or above');
  if (NEEDS_ACCOUNTANCY.test(t)) return no('requires a qualified accountant');
  // Senior grade in the title — hard block, not a flag. See SENIOR_TITLE
  // comment for why. Assistant-level roles ("Assistant Project Manager")
  // and "Business Analyst II" style titles are already handled elsewhere.
  // Big-4/MBB exception: at those firms, "Senior Analyst/Associate/Consultant"
  // is a 2-3 year band and is allowed through as a stretch application.
  //
  // BUG FIXED 2026-09-24 (ported from the UK repo, 2026-09-25): this used to
  // test BIG4_MBB_TITLE against the title alone. A real posting's title is
  // "Consulting - Local Public Services - Senior Associate" — the firm name
  // lives in the company field, not the title text — so the exception could
  // never fire for any real-world case. Checked against company OR title now,
  // so a firm name embedded in the title (should that ever happen) still
  // matches too.
  const big4Senior = (BIG4_MBB_TITLE.test(t) || BIG4_MBB_TITLE.test(String(company || ''))) && BIG4_STRETCH_TITLE.test(t);
  if (SENIOR_TITLE.test(t) && !big4Senior) return no('senior/lead grade — 3+ years typical, outside her band');
  if (/\b(aca|acca|cima|cpa|icaew)\b/i.test(body) && /\b(qualified|qualification required|must be)\b/i.test(body)) {
    return no('job description requires an accountancy qualification');
  }
  if (SPECIALIST_DOMAIN.test(t)) return no('specialist domain with no route in');
  if (WRONG_FUNCTION.test(t)) return no('wrong function');

  // Stated experience requirement. Anything demanding more than 6 years is out;
  // 5-6 is a stretch rather than a block.
  //
  // Graduate schemes are exempt: their job descriptions routinely say things
  // like "two years of a structured programme" or "three years to chartership",
  // which is a description of the scheme, not an entry requirement, and it was
  // getting read as one.
  const isGrad = GRAD_TRAINEE.test(t);
  // The \b matters. Without it, "\d{1,2}" matched the TAIL of a longer number:
  // a requisition or a date like "2017" yielded "17", which is how M&G's
  // Senior Business Data Analyst was rejected for asking "17+ years".
  // The year figure must sit near the word "experience". Without that, M&G's
  // Senior Business Data Analyst was rejected for "17+ years" because the
  // advert's company blurb mentioned seventeen years of something else
  // entirely. A number of years is only a requirement when the advert says it
  // is one.
  const yrs = [
    ...body.matchAll(/\b(\d{1,2})\s*\+?\s*(?:to|-|–)?\s*(?:\d{1,2})?\s*(?:years?|yrs?)[^.;]{0,50}?experien/gi),
    ...body.matchAll(/experien[^.;]{0,50}?\b(\d{1,2})\s*\+?\s*(?:to|-|–)?\s*(?:\d{1,2})?\s*(?:years?|yrs?)/gi),
  ].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= 25);
  const minYrs = (isGrad || !yrs.length) ? 0 : Math.min(...yrs);
  // Match experience-gate.mjs: NUMERIC_PASS_CEILING = 3. Anything asking
  // for 4+ years is out. Previously this let 4-6 through as "stretch",
  // which is how the send list filled up with 5-year and 6-year asks.
  if (minYrs > 3) return no(`job description asks for ${minYrs}+ years`);

  const hit = TIER.find((x) => x.re.test(t));
  if (!hit) return no('outside her target families');

  // A graduate or trainee scheme with a named-cohort restriction. Never
  // blocked, always flagged with the years the advert names, because whether
  // she qualifies depends on her graduation year and an advert's cohort rule
  // is often softer in practice than on the page. Her call, not a regex's.
  if (isGrad && COHORT_RESTRICTED.test(body)) {
    const cohorts = [...new Set(body.match(/20\d\d/g) || [])].join('/');
    return {
      ok: true,
      tier: hit.n,
      label: hit.label,
      reason: `cohort-restricted grad scheme${cohorts ? ` (${cohorts})` : ''} — CHECK you qualify before writing anything`,
      stretch: true,
    };
  }

  // An engineer title inside an otherwise-matching family: allow it through
  // only at tier 1, flagged, because project controls is genuinely her work at
  // some firms. Everywhere else it is a block.
  if (TECHNICAL_TITLE.test(t)) {
    if (hit.n !== 1) return no('engineer title outside project controls');
    return { ok: true, tier: 1, label: hit.label, reason: 'engineer title — usually wants an engineering or QS degree', stretch: true };
  }

  // Senior/lead is now blocked upstream — EXCEPT for the Big-4/MBB "Senior
  // Analyst/Associate/Consultant" exception, which reaches here as a stretch.
  // Grad-cohort and engineer-title stretch cases handle themselves above.
  return {
    ok: true,
    tier: hit.n,
    label: hit.label,
    reason: big4Senior ? 'stretch — Big 4 / MBB senior title (2-3 yr band)' : '',
    stretch: big4Senior,
  };
}

/** Sort helper: tier order first, non-stretch before stretch. */
export function byPriority(a, b) {
  const ea = a.eligibility || checkEligibility(a.role, '', a.company);
  const eb = b.eligibility || checkEligibility(b.role, '', b.company);
  return (ea.tier - eb.tier) || (Number(ea.stretch) - Number(eb.stretch));
}
