// tests/jd-veto.test.mjs — one test per jdVetoCheck() rejection category,
// plus one pass case.
//
// PROVENANCE: this repo has no archived verbatim JD text anywhere on disk to
// pull real excerpts from — reports/*.md (the mandated archive location) is
// empty, jds/ is empty, and output/AGENT-SCAN-*.md carries only company/role/
// link tables, never JD body text. Per the fallback instruction, every
// excerpt below is realistic (matches real UK JD phrasing this candidate has
// actually seen) rather than a genuine archived one — not a citation.

import { jdVetoCheck } from '../jd-veto.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\njd-veto.mjs — one test per rejection category');

function expectReject(label, jd, title, categorySubstring) {
  const r = jdVetoCheck(jd, {}, { title });
  if (r.fit) { fail(`${label}: expected rejection, got fit:true`); return; }
  if (!r.reason || !r.reason.toLowerCase().includes(categorySubstring.toLowerCase())) {
    fail(`${label}: reason "${r.reason}" does not mention "${categorySubstring}"`);
    return;
  }
  if (!r.evidence || r.evidence.length > 200) {
    fail(`${label}: evidence missing or exceeds 200 chars (got ${r.evidence?.length ?? 'null'})`);
    return;
  }
  pass(`${label}: rejected — ${r.reason}`);
}

// 1. required YoE > 3 ────────────────────────────────────────────────────
expectReject(
  'YoE > 3',
  `PMO Analyst — Programme Office
   We're looking for a PMO Analyst with a minimum of 5 years' experience
   running programme governance in a regulated environment. RAID log
   ownership, stakeholder reporting and steering committee packs.`,
  'PMO Analyst',
  'years',
);

// Exemption check folded into the same category, not a separate top-level
// test — the same JD text, but a graduate-band title, must NOT be rejected.
{
  const r = jdVetoCheck(
    `Graduate PMO Analyst — Programme Office
     We're looking for a candidate with a minimum of 5 years' experience...`,
    {}, { title: 'Graduate PMO Analyst' },
  );
  if (r.fit) pass('YoE > 3 exemption: a graduate-titled role is not rejected on the same wording');
  else fail(`YoE > 3 exemption: graduate title was wrongly rejected (${r.reason})`);
}

// 2. reverse graduation-year phrasings excluding 2024 grads ──────────────
expectReject(
  'graduation cohort excludes 2024',
  `Graduate Business Analyst Scheme 2027
   This programme is open to students who are expected to graduate in 2027
   with a 2:1 or above in any discipline. Assessment centre in November.`,
  'Graduate Business Analyst',
  'graduat',
);

// 3. security / national clearance ────────────────────────────────────────
expectReject(
  'security clearance',
  `Business Analyst — Central Government Programme
   The successful candidate must hold active SC clearance prior to start, or
   be willing and eligible to undergo SC vetting. 5 years' UK residency
   required for clearance purposes.`,
  'Business Analyst',
  'clearance',
);

// 4. required professional license she doesn't hold ──────────────────────
expectReject(
  'professional license',
  `Investment Analyst — Asset Management
   CFA Level II or above is required for this role. You will support
   portfolio managers with valuation models and client reporting.`,
  'Investment Analyst',
  'licence',
);

// 5. required specific degree she doesn't have ────────────────────────────
expectReject(
  'required degree',
  `Junior Software Engineer — Platform Team
   A degree in Computer Science is required, along with demonstrable
   experience shipping production code. You'll work across our backend
   services team.`,
  'Junior Software Engineer',
  "degree she doesn't have",
);

// 6. required native-level language other than English ───────────────────
expectReject(
  'native language requirement',
  `Business Analyst — DACH Region Support
   Native German speaker required, C1 minimum in written and spoken German,
   as you will liaise directly with our Frankfurt office daily.`,
  'Business Analyst',
  'german',
);

// 7. explicit no-sponsorship ───────────────────────────────────────────────
expectReject(
  'no visa sponsorship',
  `PMO Analyst — Financial Services
   Applicants must have the right to work in the UK without sponsorship, as
   we are unable to support any visa applications for this role.`,
  'PMO Analyst',
  'sponsorship',
);

// 8. title-vs-body mismatch ────────────────────────────────────────────────
expectReject(
  'title-vs-body mismatch',
  `Design, build and maintain scalable microservices using Python and Go.
   Develop and optimise SQL queries against our data warehouse. Build ETL
   pipelines using Airflow and dbt. Write unit tests and maintain our CI/CD
   pipeline. Deploy services to Kubernetes and monitor production systems.`,
  'Business Analyst',
  'software-engineering',
);

// 9. sub-threshold salary ──────────────────────────────────────────────────
//
// FIXED 2026-09-24: this used to test a flat SPONSOR_SALARY_FLOOR (£41,700)
// that jd-veto no longer has — the category now calls the SAME SOC-code-aware
// salaryVerdict() machinery used elsewhere in the pipeline. "PMO Analyst"
// used to be the fixture title here, but it resolves to SOC 3543 (Project
// support officers) — RQF6-ineligible, not a salary-floor case at all, so it
// silently stopped exercising this category once the flat number was
// removed. "Business Analyst" resolves to SOC 2431 (Management consultants
// and business analysts, RQF6-eligible), whose real New Entrant floor is
// £35,140 per soc_rates.json — £32,000 is genuinely below it.
expectReject(
  'sub-threshold salary',
  `Business Analyst — Local Authority
   Salary: £32,000 per annum, 35 hours per week, hybrid working (2 days
   office). Supporting the programme office with reporting and governance.`,
  'Business Analyst',
  'New Entrant floor',
);

// pass case: a genuine, unremarkable JD that should survive every category ─
{
  const jd = `PMO Analyst — Infrastructure Programme
   You will support the programme office with RAID log ownership,
   stakeholder reporting, governance packs and steering committee coordination.
   1-2 years' relevant experience preferred. Salary £45,000 - £52,000.
   Hybrid working, 2 days in our London office.`;
  const r = jdVetoCheck(jd, {}, { title: 'PMO Analyst' });
  if (r.fit && r.reason === null && r.evidence === null) {
    pass('PASS case: an ordinary, unremarkable JD survives every category');
  } else {
    fail(`PASS case: an ordinary JD was wrongly rejected — ${JSON.stringify(r)}`);
  }
}

// empty/missing JD: no evidence to veto on, must not be treated as a rejection
{
  const r = jdVetoCheck('', {}, { title: 'PMO Analyst' });
  if (r.fit) pass('empty JD text is treated as no evidence, not a rejection');
  else fail(`empty JD text was wrongly rejected — ${JSON.stringify(r)}`);
}
