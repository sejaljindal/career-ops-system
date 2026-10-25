#!/usr/bin/env node
/**
 * eligibility.test.mjs — INDIA. Every case is a real posting from the India
 * pipeline, plus the candidate's own target title list.
 *
 * Run it:  node eligibility.test.mjs
 * Exit code 1 on any failure, so it can gate a run.
 *
 * NO VISA OR WORK-AUTHORISATION CASES EXIST HERE BY DESIGN.
 */

import { checkEligibility } from './eligibility.mjs';

const cases = [
  // ── HER OWN TARGET TITLE LIST, VERBATIM — all must pass ──────────────
  ['—', 'PMO Analyst', '', true, 1],
  ['—', 'Programme Controls Analyst', '', true, 1],
  ['—', 'Assistant Project Manager', '', true, 1],
  ['—', 'Programme Analyst', '', true, 1],
  ['—', 'Project Controls Consultant', '', true, 1],
  ['—', 'Delivery Consultant', '', true, 1],
  ['—', 'Infrastructure Consultant', '', true, 1],
  ['—', 'Strategy & Operations Analyst', '', true, 2],
  ['—', 'Operations Consultant', '', true, 2],
  ['—', 'Transformation Analyst', '', true, 3],
  ['—', 'Business Transformation Consultant', '', true, 3],
  ['—', 'Consulting Analyst', '', true, 3],
  ['—', 'Management Consultant Analyst', '', true, 3],
  ['—', 'Associate Consultant', '', true, 3],
  ['—', 'Business Consultant', '', true, 3],
  ['—', 'Performance Improvement Analyst', '', true, 3],
  ['—', 'Business Analyst', '', true, 4],

  // ── REAL INDIA POSTINGS THAT MUST PASS ───────────────────────────────
  ['Deloitte India', 'T&T Customer CS&D - PMO, Consultant / Senior Consultant', '', true, 1],
  ['Deloitte India', 'Senior Associate - Project Management (PMO)', '', true, 1],
  ['EY India', 'Project Consultant - Business Consulting PI GOV, Transformation Delivery', '', true, 1],
  ['EY India', 'Consultant - Business Consulting PI GOV, Transformation Delivery', '', true, 3],
  ['PwC India', 'Senior Associate - Infra Transformation, Capital Projects & Infrastructure', '', true, 1],
  ['PwC India', 'Senior Associate - Capital Projects, CP&I Advisory', '', true, 1],
  ['Deutsche Bank', 'Business Management Analyst, NCT', '', true, 4],
  ['Deutsche Bank', 'Operations Analyst', '', true, 4],
  ['Wells Fargo', 'Business Execution Consultant - Market Data', '', true, 3],
  ['Novartis', 'T&CM I - Business Analyst', '', true, 4],
  ['AstraZeneca', 'Process Optimisation Senior Analyst', '', true, 3],
  ['Maersk', 'Sr. Analyst, Supply Chain Development', '', false],

  // ── REAL INDIA POSTINGS THAT MUST BLOCK ──────────────────────────────
  ['Deutsche Bank', 'Business Analyst AI Translator, Credit Risk, AVP', '', false],
  ['BlackRock', 'Analyst, Corporate Accounting', '', false],
  ['Novartis', 'Analyst - Provider MDM', '', false],
  ['ZS Associates', 'Business Technology Solutions Associate - MDM', '', false],
  ['Maersk', 'Analyst - MDM', '', false],
  ['Maersk', 'OneStream Consultant', '', false],
  ['Sanofi', 'Analyst - Data Process Management', '', false],
  ['Bosch', 'Data Analyst - Data Modelling, SQL & Power BI', '', false],
  ['Accenture', 'Security Managed Services Senior Analyst', '', false],
  ['Accenture', 'Copywriting Senior Analyst', '', false],
  ['Accenture', 'Creative Production Senior Analyst', '', false],
  ['Accenture', 'Sales Operations Senior Analyst', '', false],
  ['Accenture', 'Security Platform Eng Senior Analyst', '', false],
  ['Deloitte India', 'WMS Manhattan Senior Consultant - Technical Transformation', '', false],
  ['Appsierra Group', 'SAP Investment Management Consultant', '', false],
  ['Medtronic', 'Senior IT Business Analyst - ITIL', '', false],
  ['B S R & Co', 'Patch Management Consultant MAST', '', false],
  ['Shell', 'Subsidiary Governance Associate', '', false],
  ['Some GCC', 'Deputy Manager - Business Analysis', '', false],
  ['Some firm', 'Chartered Accountant - Financial Reporting', '', false],
  ['Some firm', 'Manager, Business Transformation', '', false],
  ['Some firm', 'Business Analyst', 'Minimum 9 years of experience required', false],
  ['Some firm', 'Transformation Consultant', 'CA qualified mandatory for this role', false],

  // ── Bugs found 15/09 when real Accenture roles were pasted in ────────
  // "program management" and "programme management" matched no tier at all —
  // only "program manager" with the -er. This is a 2-5 year Analyst-grade
  // programme management role and the gate called it outside her families.
  ['Accenture', 'Analyst - Program Management', '', true, 1],
  ['—', 'Programme Management Analyst', '', true, 1],
  ['—', 'Program Management Associate', '', true, 1],
  ['—', 'Programme Management Office Analyst', '', true, 1],
  // The qualification check fired when "ca" or "cs" appeared ANYWHERE and
  // "required" appeared ANYWHERE. In a long advert both nearly always do.
  ['Accenture', 'Management Consulting CFO and Enterprise Value Analyst',
   'Support CFO agenda in Canada and the US. Strong Excel skills required. Location: CA.', true, 3],
  // Still blocked when the two actually sit together.
  ['—', 'Transformation Consultant', 'CA qualified mandatory for this role', false],
  ['—', 'Business Analyst', 'Candidates must have CFA Level 2', false],

  // ── GRADUATE AND TRAINEE ROUTES — added at her request 2026-09-12 ────
  ['—', 'Management Trainee', '', true, 5],
  ['—', 'PMO Trainee', '', true, 1],
  ['—', 'Graduate Analyst', '', true, 5],
  ['—', 'Trainee Consultant', '', true, 3],
  ['—', 'Early Careers Analyst', '', true, 5],
  ['Arcadis India', 'Graduate Project Controls Consultant', '', true, 1],
  // Cohort restriction: flagged, never blocked.
  ['Some GCC', 'Graduate Trainee - Business Analysis', 'Only 2026 batch graduates may apply', true, 4, true],
  // A scheme's own duration must not be read as an experience bar.
  ['Some firm', 'Management Trainee', 'A structured 2 year rotational programme', true, 5],
  // Engineering intakes stay blocked - GET is an engineering route.
  ['Some firm', 'Graduate Engineer Trainee', '', false],

  // ── Stretch, not blocked ─────────────────────────────────────────────
  ['EY India', 'Senior Consultant - Transformation Delivery', '', true, 3, true],
  ['Sanofi', 'Senior Analyst - Business Analytics', '4 to 6 years of experience', true, 4, true],
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

console.log(`\nINDIA gate — ${cases.length} case(s).\n`);
if (fails.length) {
  for (const f of fails) console.log(`  x ${f}`);
  console.log('');
}
console.log(`${pass} passed, ${fails.length} failed.`);
process.exitCode = fails.length ? 1 : 0;
