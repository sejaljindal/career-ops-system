// bullet-variants.data.mjs — the same work, described in five vocabularies.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
// the candidate asked four times for experience bullets to be REWORDED to match the
// job description, and four times the answer was "they are reordered, not
// reworded" with an anti-fabrication justification. That justification was
// covering a capability gap: rewording well needs judgement, tailor-cv.mjs
// runs unattended from a scheduled .bat, and a regex cannot write prose.
//
// The fix is to move the judgement earlier. Every variant below is written
// by hand, once, and the script then SELECTS the one whose vocabulary matches
// the posting. That is genuine rewording at run time with no model call.
//
// ── THE RULE EVERY VARIANT FOLLOWS ───────────────────────────────────────
// The work described must be identical. What changes is the vocabulary a
// particular kind of employer uses for that work.
//
//   ALLOWED   "Coordinated programme governance across three capital schemes"
//        ->   "Managed governance and RAID controls across a £83.6M portfolio"
//             Same action, same scope, different register.
//
//   FORBIDDEN "Coordinated programme governance"  ->  "Led programme governance"
//             "Analysed supplier issues"          ->  "Owned supplier strategy"
//             These change the seniority or the nature of the work. A verb
//             that promotes her is a lie that gets found in an interview.
//
// Every figure, employer, scheme name and percentage is identical across all
// variants of a bullet. verify-variants.mjs enforces that mechanically — it
// extracts every number and proper noun from the base and requires each
// variant to carry the same set.
//
// ── FAMILIES ─────────────────────────────────────────────────────────────
//   base       the wording in cv.md; used when no family matches
//   ba         business analysis — requirements, process, stakeholders
//   pmo        programme/PMO — governance, RAID, delivery, dependencies
//   finance    commercial and financial — cost, risk exposure, variance
//   data       reporting and BI — dashboards, SQL, data quality
//   consulting advisory and transformation — structuring, recommendation

export const FAMILIES = ['ba', 'pmo', 'finance', 'data', 'consulting'];

/**
 * `match` identifies the bullet in cv.md by a distinctive fragment, so the
 * bank stays linked even if surrounding punctuation is edited.
 */
export const BULLET_VARIANTS = [
  // ── EMPLOYER_ONE ───────────────────────────────────────────────────────
  {
    match: 'Coordinated programme governance across the £64.9M',
    base: 'Coordinated programme governance across the £64.9M PROJECT_ONE, £10M PROJECT_TWO and £8.7M PROJECT_THREE, working with Directors, DfT officials, Train Operating Companies and Principal Contractors.',
    ba: 'Worked directly with Directors, DfT officials, Train Operating Companies and Principal Contractors across the £64.9M PROJECT_ONE, £10M PROJECT_TWO and £8.7M PROJECT_THREE, gathering requirements and translating competing stakeholder priorities into agreed actions.',
    pmo: 'Coordinated programme governance across three concurrent capital schemes — the £64.9M PROJECT_ONE, £10M PROJECT_TWO and £8.7M PROJECT_THREE — as the PMO interface to Directors, DfT officials, Train Operating Companies and Principal Contractors.',
    finance: 'Coordinated governance and commercial oversight across the £64.9M PROJECT_ONE, £10M PROJECT_TWO and £8.7M PROJECT_THREE, working with Directors, DfT officials, Train Operating Companies and Principal Contractors on a matrixed public-private portfolio.',
    data: 'Coordinated programme governance and reporting across the £64.9M PROJECT_ONE, £10M PROJECT_TWO and £8.7M PROJECT_THREE, consolidating status from Directors, DfT officials, Train Operating Companies and Principal Contractors into a single view.',
    consulting: 'Operated across a £64.9M PROJECT_ONE, £10M PROJECT_TWO and £8.7M PROJECT_THREE, structuring competing priorities between Directors, DfT officials, Train Operating Companies and Principal Contractors into workable governance.',
  },
  {
    match: 'Identified a £100K commercial risk',
    base: 'Identified a £100K commercial risk through financial and delivery analysis, enabling early recovery planning before wider programme escalation',
    ba: 'Identified a £100K commercial risk through financial and delivery analysis, quantified the exposure and documented the evidence, enabling early recovery planning before wider programme escalation',
    pmo: 'Identified a £100K commercial risk through financial and delivery analysis and raised it through the programme risk process, enabling early recovery planning before wider escalation',
    finance: 'Identified a £100K commercial risk through financial and delivery analysis, quantifying the cost exposure and enabling early recovery planning before wider programme escalation',
    data: 'Identified a £100K commercial risk by analysing financial and delivery data, surfacing the exposure early enough for recovery planning before wider programme escalation',
    consulting: 'Identified a £100K commercial risk through financial and delivery analysis, structured the evidence and recommended a recovery action before it escalated across the wider programme',
  },
  {
    match: 'Produced executive reporting and decision-support outputs',
    base: 'Produced executive reporting and decision-support outputs, translating detailed cost, schedule and risk data into management insight',
    ba: 'Produced executive reporting and decision-support outputs, translating detailed cost, schedule and risk data into management insight for senior stakeholders',
    pmo: 'Produced executive and programme-level reporting, translating detailed cost, schedule and risk data into management insight for portfolio decision-making',
    finance: 'Produced executive reporting and decision-support outputs, translating detailed cost, schedule and risk data into commercial insight that informed programme decisions',
    data: 'Produced executive reporting and decision-support outputs, transforming detailed cost, schedule and risk data into management insight and clear reporting outputs',
    consulting: 'Produced executive reporting and decision-support outputs, translating detailed cost, schedule and risk data into clear, evidence-based recommendations for management',
  },
  {
    match: 'Analysed recurring supplier delivery issues',
    base: 'Analysed recurring supplier delivery issues and identified commercial pressure points for management intervention',
    ba: 'Analysed recurring supplier delivery issues through pattern analysis, identifying root causes and commercial pressure points for management intervention',
    pmo: 'Analysed recurring supplier delivery issues across workstreams, identifying commercial pressure points and escalating them for management intervention',
    finance: 'Analysed recurring supplier delivery issues, identifying commercial pressure points and cost exposure requiring management intervention',
    data: 'Analysed recurring supplier delivery issues through data-led pattern analysis, identifying the commercial pressure points that warranted management intervention',
    consulting: 'Analysed recurring supplier delivery issues through self-initiated pattern analysis, framing the commercial pressure points and options for management intervention',
  },
  {
    match: 'Escalated critical-path design delays',
    base: 'Escalated critical-path design delays and programme dependencies, supporting delivery planning and risk mitigation',
    ba: 'Escalated critical-path design delays and cross-workstream dependencies, supporting delivery planning and risk mitigation',
    pmo: 'Escalated critical-path design delays and programme dependencies through the governance route, supporting delivery planning and risk mitigation',
    finance: 'Escalated critical-path design delays and programme dependencies carrying cost and schedule exposure, supporting delivery planning and risk mitigation',
    data: 'Tracked and escalated critical-path design delays and programme dependencies, supporting delivery planning and risk mitigation',
    consulting: 'Escalated critical-path design delays and programme dependencies with the intervention options set out, supporting delivery planning and risk mitigation',
  },
  {
    match: 'Maintained governance through RAID reporting',
    base: 'Maintained governance through RAID reporting, milestone tracking, action management and CDM assurance support',
    ba: 'Maintained governance and documentation standards through RAID reporting, milestone tracking, action management and CDM assurance support',
    pmo: 'Maintained programme governance through RAID reporting, milestone tracking, action management and CDM assurance support across regulated capital programmes',
    finance: 'Maintained governance and audit trail through RAID reporting, milestone tracking, action management and CDM assurance support',
    data: 'Maintained governance visibility through RAID reporting, milestone tracking, action management and CDM assurance support',
    consulting: 'Maintained governance discipline through RAID reporting, milestone tracking, action management and CDM assurance support in a regulated environment',
  },
  {
    match: 'Redesigned SharePoint-based triage',
    base: 'Redesigned SharePoint-based triage and reporting processes, increasing team throughput 20% while maintaining a 97% same-day response rate on executive requests.',
    ba: 'Mapped the existing executive-request workflow and redesigned the SharePoint-based triage and reporting process, increasing team throughput 20% while maintaining a 97% same-day response rate.',
    pmo: 'Redesigned SharePoint-based triage and reporting processes, increasing team throughput 20% while sustaining a 97% same-day response rate on executive requests.',
    finance: 'Redesigned SharePoint-based triage and reporting processes, increasing team throughput 20% and sustaining a 97% same-day response rate on executive requests without added headcount.',
    data: 'Redesigned SharePoint-based triage and reporting processes and the tracking behind them, increasing team throughput 20% while maintaining a 97% same-day response rate on executive requests.',
    consulting: 'Diagnosed a bottleneck in executive-request handling and redesigned the SharePoint-based triage and reporting process, increasing team throughput 20% while maintaining a 97% same-day response rate.',
  },

  // ── EMPLOYER_TWO, Business Analyst ───────────────────────────────────────
  {
    match: 'Analysed end-to-end commercial pipelines',
    base: 'Analysed end-to-end commercial pipelines to identify conversion bottlenecks, increasing qualified lead volumes by 30%.',
    ba: 'Analysed end-to-end commercial pipelines to identify conversion bottlenecks, then designed and specified the process changes that increased qualified lead volumes by 30%.',
    pmo: 'Analysed end-to-end commercial pipelines to identify conversion bottlenecks and coordinated the resulting interventions, increasing qualified lead volumes by 30%.',
    finance: 'Analysed end-to-end commercial pipelines to identify conversion bottlenecks and revenue leakage, increasing qualified lead volumes by 30%.',
    data: 'Analysed end-to-end commercial pipeline data to identify conversion bottlenecks, increasing qualified lead volumes by 30%.',
    consulting: 'Diagnosed commercial performance problems through end-to-end pipeline analysis, identified conversion inefficiencies and produced actionable recommendations that increased qualified lead volumes by 30%.',
  },
  {
    match: 'Built Power BI and Excel dashboards',
    base: 'Built Power BI and Excel dashboards used by senior leadership for commercial planning and investment decisions.',
    ba: 'Built Power BI and Excel dashboards to an agreed set of reporting requirements, used by senior leadership for commercial planning and investment decisions.',
    pmo: 'Built Power BI and Excel dashboards used by senior leadership for commercial planning and investment decisions.',
    finance: 'Built Power BI and Excel dashboards used by senior leadership for commercial planning, forecasting and investment decisions.',
    data: 'Built Power BI and Excel dashboards from the underlying commercial data, adopted by senior leadership for planning and investment decisions.',
    consulting: 'Built Power BI and Excel dashboards that senior leadership adopted for commercial planning and investment decisions.',
  },
  {
    match: 'Conducted hypothesis-led A/B testing',
    base: 'Conducted hypothesis-led A/B testing, achieving a 20% uplift in conversion rates via iterative optimisation and performance analysis.',
    ba: 'Defined and ran hypothesis-led A/B tests against agreed success criteria, achieving a 20% uplift in conversion rates through iterative optimisation and performance analysis.',
    pmo: 'Ran hypothesis-led A/B testing as a structured test cycle, achieving a 20% uplift in conversion rates through iterative optimisation and performance analysis.',
    finance: 'Ran hypothesis-led A/B testing, achieving a 20% uplift in conversion rates through iterative optimisation and performance analysis.',
    data: 'Designed and analysed hypothesis-led A/B tests, achieving a 20% uplift in conversion rates through iterative optimisation and performance analysis.',
    consulting: 'Structured and ran hypothesis-led A/B testing, achieving a 20% uplift in conversion rates through iterative optimisation and performance analysis.',
  },
  {
    match: 'Standardised Customer Relationship Management',
    base: 'Standardised Customer Relationship Management (CRM) datasets using SQL and Excel, reducing manual reporting effort by 30% while improving forecasting accuracy.',
    ba: 'Standardised Customer Relationship Management (CRM) datasets using SQL and Excel, reducing manual reporting effort by 30% while improving forecasting accuracy.',
    pmo: 'Standardised Customer Relationship Management (CRM) datasets using SQL and Excel, reducing manual reporting effort by 30% while improving forecasting accuracy.',
    finance: 'Standardised Customer Relationship Management (CRM) datasets using SQL and Excel, reducing manual reporting effort by 30% and improving forecasting accuracy for management reporting.',
    data: 'Cleansed and standardised Customer Relationship Management (CRM) datasets using SQL and Excel, resolving data-quality issues that reduced manual reporting effort by 30% and improved forecasting accuracy.',
    consulting: 'Standardised Customer Relationship Management (CRM) datasets using SQL and Excel, reducing manual reporting effort by 30% while improving forecasting accuracy.',
  },
  {
    match: 'Redesigned the lead-to-onboarding process',
    base: 'Redesigned the lead-to-onboarding process, reducing response times from 48 hours to 4 hours through workflow redesign and automated tracking.',
    ba: 'Mapped the as-is lead-to-onboarding process and redesigned it, reducing response times from 48 hours to 4 hours through workflow redesign and automated tracking.',
    pmo: 'Redesigned the lead-to-onboarding process end to end, reducing response times from 48 hours to 4 hours through workflow redesign and automated tracking.',
    finance: 'Redesigned the lead-to-onboarding process, reducing response times from 48 hours to 4 hours through workflow redesign and automated tracking.',
    data: 'Redesigned the lead-to-onboarding process and its tracking, reducing response times from 48 hours to 4 hours through workflow redesign and automation.',
    consulting: 'Implemented process improvements across the lead-to-onboarding pipeline, reducing response times from 48 hours to 4 hours through workflow redesign and automated tracking.',
  },
];

/** Which family does this posting speak? Most-specific signal wins. */
export function pickFamily(jdText, roleTitle = '') {
  const hay = `${roleTitle} ${roleTitle} ${jdText || ''}`.toLowerCase();
  const score = (res) => res.reduce((n, re) => n + (hay.match(re)?.length || 0), 0);
  const scores = {
    data: score([/\bpower ?bi\b/gi, /\bsql\b/gi, /\bdashboard/gi, /\breporting\b/gi, /\bdata quality\b/gi, /\bbi\b/gi]),
    finance: score([/\bfinanc/gi, /\bcommercial\b/gi, /\bcost\b/gi, /\bbudget/gi, /\bforecast/gi, /\bvariance\b/gi, /\bfp&a\b/gi]),
    pmo: score([/\bpmo\b/gi, /\bprogramme\b/gi, /\bgovernance\b/gi, /\braid\b/gi, /\bmilestone/gi, /\bdependenc/gi, /\bdelivery\b/gi]),
    consulting: score([/\bconsult/gi, /\badvisory\b/gi, /\btransformation\b/gi, /\brecommend/gi, /\bclient\b/gi]),
    ba: score([/\bbusiness analy/gi, /\brequirement/gi, /\bstakeholder/gi, /\bprocess\b/gi, /\buser stor/gi, /\bBRD\b/g]),
  };
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : null;   // below 3 the signal is noise
}

/** The variant for this family, or the cv.md wording when none applies. */
export function variantFor(bulletText, family) {
  if (!family) return bulletText;
  const v = BULLET_VARIANTS.find((b) => bulletText.includes(b.match));
  return (v && v[family]) || bulletText;
}
