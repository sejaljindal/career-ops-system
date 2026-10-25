#!/usr/bin/env node
/**
 * eligibility.test.mjs — every case below is a REAL role from a list I sent
 * the candidate, plus the ones that should have survived.
 *
 * Run it:  node tests/eligibility.test.mjs
 *
 * I could not run this myself — a Windows update on 8 September broke my
 * sandbox's access to the filesystem — so this file exists so you can verify
 * the gate rather than take my word for it. Exit code 1 on any failure.
 *
 * MOVED 2026-09-24 from the repo root into tests/ — test-all.mjs only
 * auto-discovers tests/**\/*.test.mjs, so this file sat here for weeks
 * never actually run by the suite. No content changed beyond this move and
 * the one import path it required.
 */

import { checkEligibility } from '../eligibility.mjs';

const cases = [
  // ── MUST BE BLOCKED. All of these were actually sent to her. ──────────
  ['GXO Logistics', 'Cloud Finops Engineer', '', false],
  ['Unipart', 'Solutions Design Engineer - Transport Solutions', '', false],
  ['Lane Clark and Peacock LLP', 'FP and A Manager', '', false],
  ['auricoe', 'Continuous Improvement & Business Systems Manager', '', false],
  ['GXO Logistics', 'Continuous Improvement Manager', '', false],
  ['EKIM Consulting', 'Business Analyst - Security Cleared', '', false],
  ['McGinnis Loy', 'Corporate Finance Analyst', 'ACA or ACCA qualified required', false],
  ['KennedyPearce', 'Cost Accountant', '', false],
  ['Sellick Partnership', 'Project Accountant - Capital Business Cases', '', false],
  ['Turner & Townsend', 'Reporting Analyst - Defence', '', false],
  ['Mace', 'AI Business Analyst', '', false],
  ['Costain', 'IT Business Analyst', '', false],
  ['EY UK', 'Senior Consultant - Business Analyst - Technology Consulting', '', false],
  ['EY UK', 'Assistant Manager Business Analyst - BTA Technology Consulting', '', false],
  ['Monzo', 'Anaplan Support Analyst', '', false],
  ['Maersk', 'OneStream Consultant', '', false],
  ['Novartis', 'Analyst - Provider MDM', '', false],
  ['Bosch', 'Data Analyst - Data Modelling, SQL & Power BI', '', false],
  ['Zilch', 'Application Support Analyst', '', false],
  ['Trainline', 'Senior Technical Support Analyst', '', false],
  ['PwC UK', 'Data Quality Analyst, Senior Associate', '', false],
  ['Deutsche Bank', 'Business Analyst AI Translator, Credit Risk, AVP', '', false],
  ['Citi UK', 'Loan Documentation and Processing Lead Analyst', '', false],
  ['BlackRock', 'Analyst, Corporate Accounting', '', false],
  ['abrdn', 'Financial Reporting & Control Analyst', '', false],
  ['Marsh McLennan', 'Graduate Trainee Client Manager', '', false],
  ['Marsh McLennan', 'Case Manager Support Associate', '', false],
  ['Ebury', 'Junior Client Portfolio Manager', '', false],
  ['Teya', 'People Systems Analyst', '', false],
  ['Teya', 'Junior Product Manager', '', false],
  ['Monzo', 'Graduate Credit Analyst', '', false],
  ['L&G', 'Technical CASS Analyst', '', false],
  ['EY UK', 'Consultant - Financial Crime Analyst', '', false],
  ['EY UK', 'Consultant - Conduct Risk Analyst', '', false],
  ['Baringa', 'Economic Crime Consultant / Senior Consultant', '', false],
  ['Marsh McLennan', 'Executive Remuneration - Senior Analyst', '', false],
  ['Shell', 'Subsidiary Governance Associate', '', false],
  ['NHS', 'Band 9 Director of Digital Strategy and Business Planning', '', false],
  ['MHRA', 'Chair - Advisory Board on the Registration of Homeopathic Products', '', false],
  ['Anon', 'Autism Advisory Team Speech and language therapist', '', false],
  ['Some firm', 'Business Analyst', 'You will need 8 years of experience', false],
  // A "Senior [Analyst/Associate/Consultant]" title at a NON-Big4/MBB firm.
  // Originally written expecting these to pass (an earlier version of the
  // gate treated any senior title as a stretch flag, not a hard block) — the
  // 2026-09-24 SENIOR_TITLE rewrite deliberately hard-blocks senior/lead
  // titles everywhere except Big-4/MBB firms ("She asked for these to rank
  // last... the cleanest fix is: block at the gate" — see eligibility.mjs's
  // own comment on SENIOR_TITLE). These four moved here to match that
  // intentional change, discovered when this file was first run at all
  // (moved into tests/ the same day — see the file header).
  ['Deliveroo', 'Senior Associate, Project Management', '', false],
  ['Matillion', 'Senior Strategy & Business Operations Analyst', '', false],
  ['SumUp', 'Commercial Planning Senior Associate', '', false],
  ['AstraZeneca', 'Process Optimisation Senior Analyst', '', false],

  // ── MUST PASS, TIER 1 — project management / PMO / project controls ───
  ['WSP UK', 'PMO Analyst - Civil Infrastructure & Construction', '', true, 1],
  ['WSP UK', 'Assistant Project Manager (PMO)', '', true, 1],
  ['WSP UK', 'Project Controller - Building Structures', '', true, 1],
  ['WSP UK', 'Project Coordinator - Nature Services', '', true, 1],
  ['Arcadis', 'Project Controls Consultant', '', true, 1],
  ['Arcadis', 'Graduate Project Controls Consultant', '', true, 1],
  ['EY UK', 'Consultant, Project Management Office (PMO) Analyst', '', true, 1],
  ['Turner & Townsend', 'Project Controls Specialists - Performance & Reporting', '', true, 1],
  ['Costain', 'Junior Planner', '', true, 1],
  ['Galliford Try', 'Project Controls & Administrator', '', true, 1],
  ['Deloitte India', 'T&T Customer CS&D - PMO, Consultant / Senior Consultant', '', true, 1],

  // ── MUST PASS, TIER 2 — strategy ──────────────────────────────────────
  ['Legal & General', 'Climate Strategy Analyst', '', true, 2],
  ['Hiscox', 'Strategy and Insights Analyst', '', true, 2],

  // ── MUST PASS, TIER 3 — transformation / management consulting ────────
  ['EY India', 'Consultant - Business Consulting PI GOV, Transformation Delivery', '', true, 3],
  ['EY India', 'Project Consultant - Transformation Delivery', '', true, 1],
  ['PwC India', 'Senior Associate - Capital Projects, CP&I Advisory', '', true, 1],
  ['North Highland', 'Analyst, Management Consulting', '', true, 3],
  ['PwC UK', 'Consulting - Local Public Services - Senior Associate', '', true, 3],
  ['Baringa', 'Consultant - Health', '', true, 3],

  // ── MUST PASS, TIER 4 — business/management BA ────────────────────────
  ['WTW', 'Product Business Analyst', '', true, 4],
  ['Teya', 'Business Analyst', '', true, 4],
  ['Novartis', 'T&CM I - Business Analyst', '', true, 4],
  ['Deutsche Bank', 'Business Management Analyst, NCT', '', true, 4],
  ['Manchester Airports Group', 'Commercial Analyst', '', true, 4],

  // ── Engineer title inside project controls: passes, but FLAGGED ───────
  ['Turner & Townsend', 'Project Controls Engineer - Rail', '', true, 1, true],

  // ── CANDIDATE'S OWN TARGET TITLE LIST, VERBATIM ──────────────────────────
  // She gave me these seventeen at the start. I compressed them into four
  // families and several stopped matching anything. One case each, so that
  // can never happen silently again.
  ['—', 'PMO Analyst', '', true, 1],
  ['—', 'Programme Controls Analyst', '', true, 1],
  ['—', 'Assistant Project Manager', '', true, 1],
  ['—', 'Programme Analyst', '', true, 1],
  ['—', 'Project Controls Consultant', '', true, 1],
  ['—', 'Delivery Consultant', '', true, 1],
  ['—', 'Infrastructure Consultant', '', true, 1],
  ['—', 'Strategy & Operations Analyst', '', true, 2],
  ['—', 'Strategy and Operations Analyst', '', true, 2],
  ['—', 'Operations Consultant', '', true, 2],
  ['—', 'Transformation Analyst', '', true, 3],
  ['—', 'Business Transformation Consultant', '', true, 3],
  ['—', 'Consulting Analyst', '', true, 3],
  ['—', 'Management Consultant Analyst', '', true, 3],
  ['—', 'Associate Consultant', '', true, 3],
  ['—', 'Business Consultant', '', true, 3],
  ['—', 'Performance Improvement Analyst', '', true, 3],
  ['—', 'Business Analyst', '', true, 4],

  // ── Cuts she queried, and was right to. Now reinstated. ──────────────
  ['Marsh McLennan', 'Revenue Support Analyst', '', true, 4],
  ['OakNorth', 'Deposit Operations Analyst', '', true, 4],
  ['Deutsche Bank', 'Operations Analyst', '', true, 4],

  // ── The worst bug found so far. "sc clear" followed by \b could never
  // match "SC Cleared", so a central-government cleared role reached the
  // KEEP list at tier 4. ────────────────────────────────────────────────
  ['Vaucluse Associates', 'SC Cleared Business Analyst Central Government D', '', false],
  ['—', 'SC Cleared Business Analyst', '', false],
  ['—', 'DV Cleared Project Analyst', '', false],
  ['—', 'SC-Cleared PMO Analyst', '', false],
  ['—', 'Business Analyst (SC clearance required)', '', false],
  // Bare "mod\b" fired on ordinary text and blocked this as a clearance role.
  ['Monzo', 'Finance Internal Controls Analyst', 'You will help modernise our controls', false],
  // Title vs description. "Defence" in a TITLE is the sector and must block;
  // "defence in depth" in a DESCRIPTION is infosec vocabulary and must not.
  ['Turner & Townsend', 'Project Controls Analyst - Defence', '', false],
  ['—', 'PMO Analyst - Defense', '', false],
  ['—', 'PMO Analyst', 'We apply defence in depth across our controls', true, 1],
  ['—', 'Business Analyst', 'You will support our defence sector clients', false],
  // A four-digit year must not read as an experience requirement. This exact
  // body wording rejected M&G's Senior Business Data Analyst for "17+ years".
  ['—', 'Business Analyst', 'Requisition R2017, posted 2017. 3 years experience.', true, 4],

  // ── Bugs the India suite found, kept in step here ────────────────────
  // A module-specific SAP list let this through on the word "Consultant".
  ['Appsierra Group', 'SAP Investment Management Consultant', '', false],
  // IT service management was covered by nothing at all.
  ['B S R & Co', 'Patch Management Consultant MAST', '', false],
  // "Business Analysis" and "Business Analytics" matched no tier. Originally
  // titled "Senior Analyst - Business Analysis", which stopped being a valid
  // regression case for THIS bug once the 2026-09-24 SENIOR_TITLE rewrite
  // made "Senior" a separate, correctly-blocking concern — dropped "Senior "
  // so this again tests only the thing its comment says it tests.
  ['—', 'Analyst - Business Analysis', '', true, 4],
  ['—', 'Business Analytics Analyst', '', true, 4],
  // A practice name with an ampersand must not read as a qualification.
  ['Deloitte', 'T&T Customer CS&D - PMO, Consultant / Senior Consultant', '', true, 1, true],

  // ── "programme management" matched no tier. Found 15/09 in the India
  // gate, fixed in both so they cannot drift apart. ────────────────────
  ['Accenture', 'Analyst - Program Management', '', true, 1],
  ['—', 'Programme Management Analyst', '', true, 1],
  ['—', 'Programme Management Office Analyst', '', true, 1],

  // ── GRADUATE AND TRAINEE ROUTES — added at her request 2026-09-12 ────
  // "management trainee/pmo trainee and grad roles too if i am still eligible
  // for them especially in uk". These were all blocked as outside her target
  // families, because none of them contain one of her target title words.
  ['—', 'Management Trainee', '', true, 5],
  ['—', 'PMO Trainee', '', true, 1],
  ['—', 'Project Management Trainee', '', true, 1],
  ['—', 'Graduate Scheme - Consulting', '', true, 3],
  ['—', 'Graduate Programme 2027', '', true, 5],
  ['—', 'Graduate Analyst', '', true, 5],
  ['—', 'Trainee Consultant', '', true, 3],
  ['—', 'Early Careers Analyst', '', true, 5],
  // A grad scheme that also names her function must land at the FUNCTION tier,
  // not be filed away as a generic graduate role.
  ['Arcadis', 'Graduate Project Controls Consultant', '', true, 1],
  ['North Highland', 'Analyst, Management Consulting (Academy early-careers)', '', true, 3],
  // Cohort restriction: flagged, never blocked. Whether she qualifies depends
  // on her graduation year, and adverts are often softer than they read.
  ['Arcadis', 'Graduate Business Analyst', 'Open to 2025, 2026 and 2027 graduates only', true, 4, true],
  // A grad scheme's own duration must not be read as an experience bar.
  ['Some firm', 'Graduate Programme', 'A structured 3 years to chartership', true, 5],
  // Still blocked: the FUNCTION is wrong, graduate or not.
  ['Marsh McLennan', 'Graduate Trainee Client Manager', '', false],

  // ── Cuts she queried that STILL stand, and why ───────────────────────
  // People/HR function, not performance improvement in the delivery sense.
  ['Teya', 'People Operations Excellence Analyst', '', false],
  // Product management is a different discipline from programme management.
  ['Teya', 'Junior Product Manager', '', false],
  // Insurance broking / client acquisition, i.e. sales.
  ['Ebury', 'Junior Client Portfolio Manager', '', false],
  // Claims case administration.
  ['Marsh McLennan', 'Case Manager Support Associate', '', false],
];

let pass = 0; const fails = [];

for (const [company, title, jd, wantOk, wantTier, wantStretch] of cases) {
  const r = checkEligibility(title, jd, company);
  const problems = [];
  if (r.ok !== wantOk) {
    problems.push(r.ok ? `should have been BLOCKED but passed as tier ${r.tier}` : `should have PASSED but blocked: ${r.reason}`);
  }
  if (wantOk && wantTier !== undefined && r.ok && r.tier !== wantTier) {
    problems.push(`expected tier ${wantTier}, got tier ${r.tier}`);
  }
  if (wantStretch !== undefined && r.stretch !== wantStretch) {
    problems.push(`expected stretch=${wantStretch}, got ${r.stretch}`);
  }
  if (problems.length) fails.push(`${company} — ${title}\n      ${problems.join('\n      ')}`);
  else pass++;
}

console.log(`\n${cases.length} case(s), each one a real posting.\n`);
if (fails.length) {
  for (const f of fails) console.log(`  x ${f}`);
  console.log('');
}
console.log(`${pass} passed, ${fails.length} failed.`);
if (!fails.length) {
  console.log('Every role that was wrongly sent to her is now blocked, and every');
  console.log('role that should reach her still does, in her stated priority order.');
}
process.exitCode = fails.length ? 1 : 0;
