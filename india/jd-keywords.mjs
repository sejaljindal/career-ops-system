#!/usr/bin/env node
/**
 * jd-keywords.mjs — read a job description and work out which of the candidate's real
 * experience evidences each thing it asks for, and in the JD's own words.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * The first cut of tailoring (tailor-queue.mjs) only reordered bullets and
 * swapped one canned opening sentence per angle. The bullet text was
 * byte-identical across all 22 CVs, so nothing an ATS or a reader would
 * actually notice changed. That was defended on anti-fabrication grounds,
 * and the defence was wrong:
 *
 *   FABRICATION is claiming work that did not happen.
 *   TAILORING is describing work that did happen in the reader's vocabulary.
 *
 * The narrow rule that IS worth keeping is about verbs that change the NATURE
 * of the work: rewriting "Coordinated programme governance" as "Analysed
 * programme governance" misstates what was done, and on a UK visa route that
 * is a signed document. So this file never rewrites the factual clause of a
 * bullet. It adds a LABEL in front of it — the JD's own term for that kind of
 * work — and only where a human (me, authoring the table below) has asserted
 * that the label honestly describes that specific bullet.
 *
 * ── HOW THE MAPPING IS DEFENDED ──────────────────────────────────────────
 * EVIDENCE below is a curated table, not a fuzzy match. Each entry says: "if
 * the JD uses this term, THIS bullet is honest evidence for it, and here is
 * the label to lead with." An unmapped JD term produces nothing — silence is
 * the correct output when the CV has no evidence, and is what stops this
 * becoming keyword stuffing.
 *
 * `bullet` indexes are into the EMPLOYER_ONE (nr) and EMPLOYER_TWO (mb) bullet
 * lists in cv.md, in file order.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Decode the double-escaped HTML some ATS APIs return, then strip tags. */
export function stripHtml(raw) {
  let s = String(raw || '');
  for (let i = 0; i < 2; i++) {
    s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  }
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort JD text. ATS API first (returns real data, no JavaScript), then
 * a plain fetch. A failure is never fatal — the caller falls back to
 * title-only tailoring, which is worse but not nothing.
 */
export async function fetchJd(url) {
  try {
    const { resolveAtsApi } = await import('./liveness-api.mjs');
    const hit = resolveAtsApi(url);
    if (hit?.apiUrl) {
      const r = await fetch(hit.apiUrl, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) {
        const j = await r.json();
        const raw = j?.jobPostingInfo?.jobDescription ?? j?.content ?? j?.descriptionPlain ?? j?.descriptionHtml ?? '';
        const t = stripHtml(raw);
        if (t.length >= 300) return { text: t.slice(0, 25_000), ok: true, via: 'ats-api' };
      }
    }
  } catch { /* fall through */ }

  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
    if (r.ok) {
      let t = stripHtml(await r.text());
      // FIXED 2026-09-19: LinkedIn's job page includes a "Similar jobs" /
      // "People also viewed" recommendation carousel AFTER the real posting,
      // listing unrelated roles at other companies. Left in, that carousel's
      // text gets searched by the clearance/qualification checks in
      // eligibility.mjs — a recommended defence-sector role sitting in a
      // sidebar wrongly blocked genuine, clearance-free postings as
      // "requires UK security clearance / UK nationality". The real JD
      // always ends at "Show more Show less" (LinkedIn's own description
      // truncation control) before that carousel begins, so cut there for
      // linkedin.com job pages.
      if (/linkedin\.com\/jobs\/view/i.test(url)) {
        const cut = t.search(/Show more\s+Show less/i);
        if (cut > -1) t = t.slice(0, cut);
      }
      if (t.length >= 800) return { text: t.slice(0, 25_000), ok: true, via: 'html' };
    }
  } catch { /* fall through */ }

  return { text: '', ok: false, via: 'none' };
}

/**
 * The curated evidence table.
 *
 * term      — regex matched against the JD text
 * label     — the JD's vocabulary, used to lead the bullet. Must be an honest
 *             description of the bullet it is attached to.
 * nr / mb   — indexes of the EMPLOYER_ONE / EMPLOYER_TWO bullets in cv.md that
 *             genuinely evidence this term. Empty means "the CV has no
 *             evidence" and nothing is emitted.
 * skill     — phrasing for the Skills section when the JD uses this term.
 */
export const EVIDENCE = [
  { id: 'stakeholder', term: /\bstakeholder(s)?\b|\bstakeholder management\b|\bengag(e|ement) with (senior|business)\b/i,
    label: 'Stakeholder management', nr: [0], mb: [], skill: 'Stakeholder management' },

  { id: 'requirements', term: /\brequirement(s)? (gathering|elicitation|analysis)\b|\bgather(ing)? requirements\b|\bbusiness requirements\b|\bBRD\b|\buser stor(y|ies)\b/i,
    label: 'Requirements and process analysis', nr: [6], mb: [4], skill: 'Requirements gathering and documentation' },

  { id: 'process', term: /\bprocess (improvement|optimi[sz]ation|redesign|re-engineering|mapping)\b|\bas-is\b|\bto-be\b|\bworkflow\b/i,
    label: 'Process redesign', nr: [6], mb: [4], skill: 'Process mapping and optimisation' },

  { id: 'reporting', term: /\b(management|executive|MIS?|status) reporting\b|\bdashboard(s|ing)?\b|\breport(ing)? pack(s)?\b/i,
    label: 'Executive reporting', nr: [2], mb: [1], skill: 'Executive and management reporting' },

  { id: 'sql', term: /\bSQL\b|\bquer(y|ies)\b|\bdatabase(s)?\b|\bdata model(ling|ing)\b/i,
    label: 'Data analysis in SQL', nr: [], mb: [3], skill: 'SQL' },

  { id: 'powerbi', term: /\bPower ?BI\b|\bTableau\b|\bvisuali[sz]ation\b|\bBI tool(s)?\b/i,
    label: 'Power BI dashboard development', nr: [], mb: [1], skill: 'Power BI' },

  { id: 'excel', term: /\bexcel\b|\bspreadsheet(s)?\b|\bmodel(ling|ing)\b/i,
    label: 'Advanced Excel analysis', nr: [], mb: [1, 3], skill: 'Advanced Excel' },

  { id: 'risk', term: /\brisk (management|assessment|register|mitigation)\b|\bRAID\b|\bissue(s)? (log|management)\b/i,
    label: 'Risk and issue management', nr: [5, 4], mb: [], skill: 'Risk and issue management (RAID)' },

  { id: 'governance', term: /\bgovernance\b|\bcontrol(s| framework)\b|\bassurance\b|\bcompliance\b|\baudit\b/i,
    label: 'Governance and assurance', nr: [5, 0], mb: [], skill: 'Programme governance and assurance' },

  { id: 'pmo', term: /\bPMO\b|\bprogram(me)? management\b|\bproject management\b|\bportfolio\b|\bmilestone(s)?\b/i,
    label: 'PMO and programme coordination', nr: [0, 5], mb: [], skill: 'PMO and programme coordination' },

  { id: 'commercial', term: /\bcommercial\b|\bcontract(s|ual)?\b|\bvendor\b|\bsupplier\b|\bprocurement\b|\bcost (control|management)\b/i,
    label: 'Commercial and supplier analysis', nr: [3, 1], mb: [], skill: 'Commercial and supplier analysis' },

  { id: 'finance', term: /\bfinancial (analysis|planning|model)\b|\bbudget(ing|s)?\b|\bforecast(ing)?\b|\bvariance\b|\bP&L\b|\bFP&A\b/i,
    label: 'Financial and delivery analysis', nr: [1, 2], mb: [3], skill: 'Financial analysis, budgeting and forecasting' },

  { id: 'transformation', term: /\btransformation\b|\bchange management\b|\bcontinuous improvement\b|\boperational excellence\b|\bLean\b|\bSix Sigma\b/i,
    label: 'Transformation and continuous improvement', nr: [6], mb: [4, 2], skill: 'Business transformation and continuous improvement' },

  { id: 'crm', term: /\bCRM\b|\bSalesforce\b|\bcustomer data\b|\bpipeline\b|\blead(s)?\b/i,
    label: 'CRM data and pipeline analysis', nr: [], mb: [0, 3], skill: 'CRM data management and pipeline analysis' },

  { id: 'testing', term: /\bA\/B test(ing)?\b|\bexperiment(ation|s)?\b|\bhypothes(is|es)\b|\bUAT\b|\btest(ing)? (plan|case)\b/i,
    label: 'Hypothesis-led testing', nr: [], mb: [2], skill: 'Hypothesis-led testing and experimentation' },

  { id: 'escalation', term: /\bescalat(e|ion)\b|\bdependenc(y|ies)\b|\bcritical path\b|\bblocker(s)?\b/i,
    label: 'Dependency and escalation management', nr: [4], mb: [], skill: 'Dependency and escalation management' },

  { id: 'insight', term: /\binsight(s)?\b|\bdecision support\b|\bdata[- ]driven\b|\brecommendation(s)?\b/i,
    label: 'Decision support and insight', nr: [2, 1], mb: [0], skill: 'Decision support and insight' },

  { id: 'sharepoint', term: /\bSharePoint\b|\bdocument management\b|\bcollaboration (tool|platform)\b/i,
    label: 'SharePoint process design', nr: [6], mb: [], skill: 'SharePoint' },

  { id: 'infra', term: /\binfrastructure\b|\bcapital project(s)?\b|\bconstruction\b|\brail\b|\btransport(ation)?\b|\bengineering project(s)?\b/i,
    label: 'Capital projects and infrastructure', nr: [0, 4], mb: [], skill: 'Capital projects and infrastructure delivery' },

  { id: 'agile', term: /\bagile\b|\bscrum\b|\bsprint(s)?\b|\bkanban\b|\bJIRA\b/i,
    // Deliberately no evidence: nothing in cv.md is Agile delivery. An unmapped
    // term emits nothing rather than inventing a claim.
    label: null, nr: [], mb: [], skill: null },
];

/**
 * Which EVIDENCE entries this JD actually asks for, most-mentioned first.
 * Frequency is a decent proxy for what the posting cares about.
 */
export function matchJd(jdText, roleTitle = '') {
  const hay = `${roleTitle} ${roleTitle} ${jdText}`;   // title counted twice — it is the strongest signal
  const hits = [];
  for (const e of EVIDENCE) {
    const m = hay.match(new RegExp(e.term.source, 'gi'));
    if (!m) continue;
    hits.push({ ...e, count: m.length });
  }
  return hits.sort((a, b) => b.count - a.count);
}

/** Tools named in the JD that the candidate genuinely has, in the JD's spelling. */
export const OWNED_TOOLS = ['Power BI', 'SQL', 'Excel', 'SharePoint', 'Microsoft Project', 'Oracle', 'AssetWise', 'ProjectWise'];

export function toolsInJd(jdText) {
  const found = [];
  for (const t of OWNED_TOOLS) {
    if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(jdText)) found.push(t);
  }
  return found;
}
