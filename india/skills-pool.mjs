#!/usr/bin/env node
/**
 * skills-pool.mjs — the full verified skill vocabulary, and JD-driven selection.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 * The Skills section was previously a fixed list of 29 terms, REORDERED per
 * role. That is not tailoring. It left "Market & Competitive Analysis" on a
 * Business Analyst CV whose JD never mentions markets, while omitting every
 * term the JD actually used — requirements gathering, user stories, UAT,
 * data modelling, Jira, backlog management — all of which the candidate genuinely has
 * through her certifications.
 *
 * The real pool is 116 terms: the 29 from cv.md's Skills section plus 90 more
 * from the "Core skills" lines of her eleven certifications, deduplicated.
 * Every one is already in cv.md, so selecting from here adds nothing new —
 * it stops throwing three quarters of her vocabulary away.
 *
 * ── HOW SELECTION WORKS ──────────────────────────────────────────────────
 *   1. A term scores 3 if the JD contains it outright.
 *   2. It scores 2 if the JD matches its `m` pattern — the words a JD
 *      actually uses for that capability, which are often not the term
 *      itself ("BRD", "user stories" and "elicitation" all mean
 *      requirements work).
 *   3. It scores 1 if the JD uses its head noun.
 *   4. `core: true` terms get a floor of 1 so a thin or unfetchable JD still
 *      produces a credible section rather than three near-empty lines.
 *
 * Terms scoring 0 are DROPPED. That is the half that was missing: a CV that
 * omits what the reader did not ask about is a CV that looks written for them.
 *
 * NOTHING IS INVENTED. Every string below appears verbatim in cv.md, either
 * in the Skills section or in a certification's Core-skills line.
 */

const G1 = 'Business Analysis';
const G2 = 'Programme, Transformation & Delivery';
const G3 = 'Data, Reporting & Technology';

/**
 * t = term, exactly as written in cv.md
 * g = which of the three groups it renders under
 * m = extra JD wording that should surface this term (optional)
 * c = core — always worth showing unless the JD is clearly a different trade
 */
export const SKILL_POOL = [
  // ── Business Analysis ──────────────────────────────────────────────────
  { t: 'Business Analysis', g: G1, m: /\bbusiness analy(sis|st)\b|\bBA\b/i, c: true },
  { t: 'Requirements Gathering', g: G1, m: /\brequirement(s)?\b|\belicitation\b|\bBRD\b|\buser stor(y|ies)\b|\bfunctional spec/i },
  { t: 'Process Optimisation', g: G1, m: /\bprocess\b|\bworkflow\b|\bas[- ]is\b|\bto[- ]be\b|\bre[- ]engineering\b/i, c: true },
  { t: 'Business Performance Improvement', g: G1, m: /\bperformance\b|\bimprovement\b|\befficienc/i, c: true },
  { t: 'Strategic Analysis', g: G1, m: /\bstrateg/i },
  { t: 'Commercial Analysis', g: G1, m: /\bcommercial\b|\bcontract\b|\bvendor\b|\bsupplier\b|\bprocurement\b/i, c: true },
  { t: 'Operational Improvement', g: G1, m: /\boperation(s|al)\b|\bcontinuous improvement\b|\blean\b|\bsix sigma\b/i },
  { t: 'Business Case Support', g: G1, m: /\bbusiness case\b|\bcost[- ]benefit\b|\bappraisal\b|\bjustification\b/i },
  { t: 'Problem Structuring', g: G1, m: /\bproblem[- ]solving\b|\bstructur/i },
  { t: 'Market & Competitive Analysis', g: G1, m: /\bmarket\b|\bcompetit/i },
  { t: 'KPI Reporting', g: G1, m: /\bKPI\b|\bmetric(s)?\b|\bperformance indicator/i, c: true },
  { t: 'Strategic Decision-Making', g: G1, m: /\bdecision\b|\bprioriti[sz]/i },
  { t: 'Business Data Analysis', g: G1, m: /\bdata analy/i },
  { t: 'Analytical Thinking', g: G1, m: /\banalytical\b|\bcritical thinking\b/i },
  { t: 'Data-Driven Decision Making', g: G1, m: /\bdata[- ]driven\b|\binsight[- ]led\b/i },
  { t: 'Exploratory Data Analysis', g: G1, m: /\bexploratory\b|\bEDA\b|\bprofiling\b/i },
  { t: 'Scenario Analysis', g: G1, m: /\bscenario\b|\bsensitivit|\bwhat[- ]if\b/i },
  { t: 'Financial Modelling', g: G1, m: /\bfinancial model|\bmodelling\b|\bforecast/i },
  { t: 'Change Management', g: G1, m: /\bchange (management|control)\b|\btransformation\b/i },

  // ── Programme, Transformation & Delivery ───────────────────────────────
  { t: 'Programme Governance', g: G2, m: /\bgovernance\b|\bcontrol framework\b|\bassurance\b/i, c: true },
  { t: 'PMO', g: G2, m: /\bPMO\b|\bprogramme office\b|\bproject office\b/i, c: true },
  { t: 'RAID Management', g: G2, m: /\bRAID\b|\brisk(s)? and issue|\bassumption(s)?\b|\bdependenc/i },
  { t: 'RACI Coordination', g: G2, m: /\bRACI\b|\bresponsibilit(y|ies) matrix\b|\bownership\b/i },
  { t: 'Executive Reporting', g: G2, m: /\bexecutive\b|\bsenior (leadership|management)\b|\bboard\b|\bC[- ]suite\b/i, c: true },
  { t: 'Milestone & Dependency Management', g: G2, m: /\bmilestone\b|\bdependenc|\bcritical path\b|\bschedule\b/i },
  { t: 'Risk & Issue Management', g: G2, m: /\brisk\b|\bissue\b|\bmitigation\b/i, c: true },
  { t: 'Delivery Assurance', g: G2, m: /\bassurance\b|\bquality\b|\bcompliance\b|\baudit\b/i },
  { t: 'Stakeholder Engagement', g: G2, m: /\bstakeholder\b|\bengagement\b|\bliaison\b|\bpartner/i, c: true },
  { t: 'Stakeholder Communication', g: G2, m: /\bcommunicat/i },
  { t: 'Project Lifecycle Management', g: G2, m: /\blifecycle\b|\bend[- ]to[- ]end delivery\b|\bSDLC\b/i },
  { t: 'Project Planning', g: G2, m: /\bplanning\b|\bproject plan\b|\bwork breakdown\b/i },
  { t: 'Agile Methodology', g: G2, m: /\bagile\b|\biterative\b/i },
  { t: 'Scrum Framework', g: G2, m: /\bscrum\b|\bsprint\b|\bceremon/i },
  { t: 'Agile Sprint Management', g: G2, m: /\bsprint\b|\bvelocity\b|\biteration\b/i },
  { t: 'Backlog Management', g: G2, m: /\bbacklog\b|\bgrooming\b|\brefinement\b|\bprioriti[sz]ation\b/i },
  { t: 'Jira Project Tracking', g: G2, m: /\bjira\b|\bticket(s|ing)\b|\bissue tracking\b/i },
  { t: 'Confluence Documentation', g: G2, m: /\bconfluence\b|\bdocumentation\b|\bwiki\b|\bknowledge base\b/i },
  { t: 'Workflow Configuration', g: G2, m: /\bworkflow\b|\bconfigur/i },
  { t: 'Cross-Functional Team Coordination', g: G2, m: /\bcross[- ]functional\b|\bmulti[- ]disciplinary\b|\bmatrix\b/i },
  { t: 'PRINCE2 7th Edition Methodology', g: G2, m: /\bprince2\b|\bwaterfall\b|\bstructured method/i },
  { t: 'Stage Gate Management', g: G2, m: /\bstage[- ]gate\b|\bgate review\b|\bphase gate\b/i },
  { t: 'Structured Project Delivery', g: G2, m: /\bdelivery\b|\bexecution\b/i },
  { t: 'UK Infrastructure Project Standards', g: G2, m: /\binfrastructure\b|\bcapital project\b|\bconstruction\b|\brail\b|\bCDM\b/i },
  { t: 'Gantt Charts', g: G2, m: /\bgantt\b|\btimeline\b/i },

  // ── Data, Reporting & Technology ───────────────────────────────────────
  { t: 'Power BI', g: G3, m: /\bpower ?bi\b|\bBI tool|\bvisuali[sz]ation\b/i, c: true },
  { t: 'DAX Formulas', g: G3, m: /\bDAX\b|\bmeasure(s)?\b|\bcalculated column/i },
  { t: 'Power Query', g: G3, m: /\bpower query\b|\bETL\b|\bdata prep/i },
  { t: 'Data Modelling', g: G3, m: /\bdata model|\bstar schema\b|\bdimensional\b|\bsemantic\b/i },
  { t: 'Semantic Models', g: G3, m: /\bsemantic\b|\btabular model\b/i },
  { t: 'Interactive Dashboard Design', g: G3, m: /\bdashboard\b|\breport design\b/i, c: true },
  { t: 'Business Intelligence Reporting', g: G3, m: /\bbusiness intelligence\b|\bBI\b|\bMI\b/i },
  { t: 'Enterprise Reporting', g: G3, m: /\benterprise\b|\breporting suite\b/i },
  { t: 'Management Reporting', g: G3, m: /\bmanagement report|\bmonthly pack\b|\breporting pack\b/i, c: true },
  { t: 'SQL', g: G3, m: /\bSQL\b|\bquer(y|ies)\b|\bdatabase\b/i, c: true },
  { t: 'SQL Querying', g: G3, m: /\bSQL\b|\bSELECT\b|\bquery writing\b/i },
  { t: 'JOINs', g: G3, m: /\bjoin(s)?\b|\brelational\b/i },
  { t: 'Window Functions', g: G3, m: /\bwindow function|\banalytic function|\bover\s*\(/i },
  { t: 'CTEs', g: G3, m: /\bCTE(s)?\b|\bcommon table expression/i },
  { t: 'Subqueries', g: G3, m: /\bsubquer/i },
  { t: 'Database Management', g: G3, m: /\bdatabase\b|\bdata warehouse\b|\bdata store\b/i },
  { t: 'Data Cleaning', g: G3, m: /\bcleans|\bdata quality\b|\bvalidation\b|\breconcil/i },
  { t: 'Data Transformation', g: G3, m: /\btransform|\bETL\b|\bpipeline\b/i },
  { t: 'Data Visualisation', g: G3, m: /\bvisuali[sz]|\bchart|\bgraph/i },
  { t: 'Tableau Data Visualisation', g: G3, m: /\btableau\b/i },
  { t: 'Advanced Excel', g: G3, m: /\bexcel\b|\bspreadsheet\b/i, c: true },
  { t: 'Pivot-tables', g: G3, m: /\bpivot\b/i },
  { t: 'VLOOKUP', g: G3, m: /\bvlookup\b|\blookup\b/i },
  { t: 'INDEX MATCH', g: G3, m: /\bindex match\b|\bindex\/match\b/i },
  { t: 'Spreadsheet Automation', g: G3, m: /\bautomat/i },
  { t: 'SharePoint', g: G3, m: /\bsharepoint\b|\bdocument management\b|\bintranet\b/i },
  { t: 'Microsoft Project', g: G3, m: /\bms project\b|\bmicrosoft project\b|\bscheduling tool/i },
  { t: 'Oracle', g: G3, m: /\boracle\b|\bERP\b/i },
  { t: 'AssetWise', g: G3, m: /\bassetwise\b|\basset management\b/i },
  { t: 'ProjectWise', g: G3, m: /\bprojectwise\b|\bCDE\b|\bcommon data environment\b/i },
  { t: 'Generative AI Tools', g: G3, m: /\bgenerative ai\b|\bLLM\b|\bAI tool|\bcopilot\b|\bChatGPT\b/i },
  { t: 'Prompt Engineering', g: G3, m: /\bprompt\b|\bAI[- ]assisted\b/i },
  { t: 'Microsoft Copilot', g: G3, m: /\bcopilot\b|\bM365\b|\bmicrosoft 365\b/i },
];

export const GROUP_ORDER = [G1, G2, G3];

/**
 * Last words that are too common to carry meaning on their own. A term whose
 * head is one of these must match by its full name or its `m` pattern.
 */
const GENERIC_HEADS = new Set([
  'management', 'analysis', 'reporting', 'improvement', 'coordination',
  'engagement', 'communication', 'planning', 'delivery', 'design', 'support',
  'thinking', 'making', 'tools', 'framework', 'methodology', 'standards',
  'functions', 'models', 'charts', 'formulas', 'gathering', 'optimisation',
]);

/**
 * Choose the terms this JD actually asks for.
 *
 * @param {string} jdText
 * @param {string} roleTitle
 * @param {{perGroup?: number}} [opts]
 * @returns {Array<{heading: string, terms: string[]}>}
 */
export function selectSkills(jdText, roleTitle = '', opts = {}) {
  const perGroup = opts.perGroup ?? 10;
  const hay = `${roleTitle} ${roleTitle} ${jdText || ''}`;

  const scored = SKILL_POOL.map((s, i) => {
    let score = 0;
    if (new RegExp(`\\b${s.t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(hay)) score = 3;
    else if (s.m && s.m.test(hay)) score = 2;
    else {
      // Head-noun fallback, but NOT on a generic head. A first cut matched on
      // the last word of the term, which put "Agile Sprint Management" and
      // "Backlog Management" on a Finance Analyst CV purely because the JD
      // contained the word "management". These heads appear in half the pool
      // and carry no signal on their own.
      const head = s.t.toLowerCase().split(/\s*&\s*|\s+/).slice(-1)[0];
      if (head.length > 4 && !GENERIC_HEADS.has(head)
        && new RegExp(`\\b${head}`, 'i').test(hay)) score = 1;
    }
    if (score === 0 && s.c) score = 0.5;     // core floor — keeps a thin JD credible
    return { ...s, score, i };
  });

  return GROUP_ORDER.map((heading) => {
    const terms = scored
      .filter((s) => s.g === heading && s.score > 0)
      .sort((a, b) => (b.score - a.score) || (a.i - b.i))
      .slice(0, perGroup)
      .map((s) => s.t);
    return { heading, terms };
  }).filter((g) => g.terms.length);
}
