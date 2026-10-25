// tests/jd-veto.test.mjs — one test per jdVetoCheck() rejection category,
// plus one pass case.
//
// PORTED FROM THE UK REPO 2026-09-25. Salary-floor and no-sponsorship cases
// removed (both categories deleted — UK-only, see jd-veto.mjs header); the
// UK security-clearance case is also removed (that category was dropped too
// — India JDs don't carry SC/DV/BPSS clearance language, and "CTC" collides
// with the Indian salary term). Three India-specific cases added: over-level
// Senior title outside Big-4/MBB, the Big-4 exception, and internal-only
// postings.
//
// PROVENANCE: every excerpt below is realistic (matches real India JD
// phrasing) rather than a genuine archived one — not a citation.

import { jdVetoCheck } from '../jd-veto.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\njd-veto.mjs — one test per rejection category');

function expectReject(label, jd, title, categorySubstring, company) {
  const r = jdVetoCheck(jd, {}, { title, company });
  if (r.fit) { fail(`${label}: expected rejection, got fit:true`); return; }
  if (!r.reason || !r.reason.toLowerCase().includes(categorySubstring.toLowerCase())) {
    fail(`${label}: reason "${r.reason}" does not mention "${categorySubstring}"`);
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

// 3. required professional license she doesn't hold (incl. India's CA/ICAI) ─
expectReject(
  'professional license',
  `Investment Analyst — Asset Management
   CFA Level II or above is required for this role. You will support
   portfolio managers with valuation models and client reporting.`,
  'Investment Analyst',
  'licence',
);

expectReject(
  'professional license — India CA',
  `Financial Reporting Analyst — GCC Controllership
   A qualified CA (ICAI) is required for this role. You will own statutory
   accounts preparation and audit liaison for the India entity.`,
  'Financial Reporting Analyst',
  'licence',
);

// 4. required specific degree she doesn't have ────────────────────────────
expectReject(
  'required degree',
  `Junior Software Engineer — Platform Team
   A degree in Computer Science is required, along with demonstrable
   experience shipping production code. You'll work across our backend
   services team.`,
  'Junior Software Engineer',
  "degree she doesn't have",
);

// 5. required native-level language other than English ───────────────────
expectReject(
  'native language requirement',
  `Business Analyst — DACH Region Support
   Native German speaker required, C1 minimum in written and spoken German,
   as you will liaise directly with our Frankfurt office daily.`,
  'Business Analyst',
  'german',
);

// 6. title-vs-body mismatch ────────────────────────────────────────────────
expectReject(
  'title-vs-body mismatch',
  `Design, build and maintain scalable microservices using Python and Go.
   Develop and optimise SQL queries against our data warehouse. Build ETL
   pipelines using Airflow and dbt. Write unit tests and maintain our CI/CD
   pipeline. Deploy services to Kubernetes and monitor production systems.`,
  'Business Analyst',
  'software-engineering',
);

// 7. India-specific — Senior title outside Big-4/MBB ──────────────────────
expectReject(
  'Senior Consultant at TCS — over-level',
  '',
  'Senior Consultant',
  'senior analyst/associate/consultant',
  'TCS',
);

// 8. India-specific — Big-4 exception, NOT rejected ────────────────────────
{
  const r = jdVetoCheck('', {}, { title: 'Senior Consultant', company: 'Deloitte India' });
  if (r.fit) pass('Senior Consultant at Deloitte India: Big-4 exception — not rejected');
  else fail(`Senior Consultant at Deloitte India was wrongly rejected — ${r.reason}`);
}

// 9. India-specific — internal candidates only ─────────────────────────────
expectReject(
  'internal candidates only',
  `Strategy Analyst — Corporate Strategy
   This posting is for internal candidates only as part of our internal
   mobility programme. External applications will not be considered.`,
  'Strategy Analyst',
  'internal candidates',
);

// pass case: a genuine, unremarkable JD that should survive every category ─
{
  const jd = `PMO Analyst — Infrastructure Programme
   You will support the programme office with RAID log ownership,
   stakeholder reporting, governance packs and steering committee coordination.
   1-2 years' relevant experience preferred. CTC as per industry standards.
   Hybrid working, 2 days in our Bengaluru office.`;
  const r = jdVetoCheck(jd, {}, { title: 'PMO Analyst', company: 'Some GCC' });
  if (r.fit && r.reason === null && r.evidence === null) {
    pass('PASS case: an ordinary, unremarkable JD survives every category');
  } else {
    fail(`PASS case: an ordinary JD was wrongly rejected — ${JSON.stringify(r)}`);
  }
}

// empty/missing JD: no evidence to veto on, must not be treated as a rejection
{
  const r = jdVetoCheck('', {}, { title: 'PMO Analyst', company: 'Some GCC' });
  if (r.fit) pass('empty JD text is treated as no evidence, not a rejection');
  else fail(`empty JD text was wrongly rejected — ${JSON.stringify(r)}`);
}
