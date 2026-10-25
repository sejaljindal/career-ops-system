#!/usr/bin/env node
// auto-tailor.mjs — CV/Cover Letter tailoring for pipeline_india.xlsx rows.
//
// HONESTY NOTE ON ARCHITECTURE: deciding "am I honestly a fit for this role"
// and writing genuinely tailored CV/cover-letter language is an AI-judgment
// task against cv.md and 03_Master_Profile.md — the same judgment Blocks A-G
// already makes during evaluation. A plain script has no access to an LLM
// and cannot make that call; pretending otherwise would risk exactly the
// fabrication this tool is supposed to prevent. So this is a two-phase tool:
//
//   SELECT phase (`--select`, mechanical):
//     Reads pipeline_india.xlsx, filters rows scoring >= 4.0 (honours
//     --limit), fetches each JD's live text (best-effort), and writes one
//     "bundle" JSON per row to output/tailor-bundles/{row}.json containing
//     the JD text, the full cv.md and 03_Master_Profile.md content, and row
//     metadata. Nothing is judged or written yet.
//
//   RENDER phase (`--render <bundle-or-decision.json>`, mechanical):
//     Takes a decision JSON (fit verdict + reason, and if fit=true, the
//     tailored CV/cover content) — produced by reading a bundle and making
//     the actual honest judgment call — and:
//       - fit=false: writes "NOT A FIT - {reason}" to the row's Notes column,
//         generates nothing, and stops.
//       - fit=true: runs a fabrication safety-net check (every proper noun
//         and numeric claim in the tailored text must appear in the bundle's
//         cv.md/03_Master_Profile.md source — anything that doesn't is
//         printed as a WARNING, not silently allowed through), converts any
//         £ figure to an approximate bracketed INR equivalent, applies
//         Indian-English spelling conventions, checks UK-experience framing
//         is actually present (warns if not — the rule says ALWAYS surface
//         it), renders CV.docx and Cover.docx, and writes both filenames
//         back into that row's CV File / Cover Letter columns in place
//         (never touches Status/Applied On/Notes/Contact — those stay
//         exactly as the sheet's own protection rules already guarantee).
//
// Usage:
//   node auto-tailor.mjs --select [--limit N]
//   node auto-tailor.mjs --render output/tailor-bundles/{row}.decision.json
//
// Decision JSON schema (what the judgment step must produce):
// {
//   "row": 1,
//   "fit": true,
//   "reason": "short summary either way",
//   "cv": {
//     "headline": "...",
//     "summary": "1 short paragraph",
//     "experience": [ { "title": "...", "org": "...", "dates": "...", "bullets": ["...", ...] }, ... ],
//     "education": [ { "degree": "...", "org": "...", "dates": "...", "detail": "..." }, ... ],
//     "skills": ["...", ...]
//   },
//   "cover": { "opening": "...", "body": ["...", ...], "closing": "..." }
// }

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { scopeCheck, experienceGate } from './experience-gate.mjs';
import { isAgency, AGENCY_FRAMING_NOTE } from './agency.mjs';
import { isStillLive } from './liveness-gate.mjs';
import { jdVetoCheck, logJdRejection } from './jd-veto.mjs';

const ROOT = process.cwd();
const XLSX_PATH = path.join(ROOT, 'output', 'pipeline_india.xlsx');
const CV_MD_PATH = path.join(ROOT, 'cv.md');
const MASTER_PROFILE_PATH = path.join(ROOT, '03_Master_Profile.md');
const BUNDLES_DIR = path.join(ROOT, 'output', 'tailor-bundles');
const OUTPUT_DIR = path.join(ROOT, 'output');
const SHEET_NAME = 'Pipeline (India)';
const SCORE_FLOOR = 4.0;

// Approximate, clearly-labeled — not a live FX rate. Update this constant
// if it drifts too far; the bracketed figure is always marked "approx".
const GBP_TO_INR_APPROX = 105;

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── xlsx I/O ─────────────────────────────────────────────────────────────

async function loadWorkbook() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  return wb;
}

function headerIndex(ws) {
  const idx = {};
  ws.getRow(1).eachCell((cell, col) => { idx[cell.value] = col; });
  return idx;
}

function rowToObject(ws, idx, rowNum) {
  const r = ws.getRow(rowNum);
  const obj = { _rowNum: rowNum };
  for (const [name, col] of Object.entries(idx)) obj[name] = r.getCell(col).value;
  return obj;
}

// ── JD fetch (best-effort — same tolerance as paste-jobs.mjs; a failed
// fetch is not fatal, the judgment step can still work from the row's own
// Job Role / Notes if the page is unreachable) ─────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ATS-API-first JD fetch. Added 2026-09-04.
 *
 * THE PROBLEM THIS SOLVES: every top-scoring India role sits on Workday, and
 * Workday postings are fully JavaScript-rendered. The plain HTML fetch below
 * therefore returned a near-empty shell for all of them — "page returned too
 * little content" — so NO tailor bundle had ever contained real JD text. That
 * is why row 19's CV came out generic: there was nothing to tailor against.
 * Browser automation and WebFetch both failed on the same wall.
 *
 * THE FIX: this repo already ships a tested mapper — resolveAtsApi() in
 * liveness-api.mjs — that converts a Workday/Greenhouse/Lever/Ashby posting
 * URL into its per-job JSON API endpoint. Those APIs return the description
 * as data, no JavaScript needed. This is the same public endpoint the ATS's
 * own front-end calls, and the same one coverage.mjs already scans with.
 *
 * Measured on the three blocked rows: Barclays returned 10,634 characters of
 * real JD text (HTTP 200). Sanofi and PwC returned HTTP 403 — those tenants
 * bot-block the API — so the HTML path below is still the fallback, and those
 * two still need a manual `npm run paste`. Partial success, honestly reported
 * rather than presented as a complete fix.
 */
async function fetchViaAtsApi(url) {
  try {
    const { resolveAtsApi } = await import('./liveness-api.mjs');
    const hit = resolveAtsApi(url);
    if (!hit || !hit.apiUrl) return null;
    const res = await fetch(hit.apiUrl, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      redirect: 'error',                      // SSRF guard, same as the providers
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    // Workday: jobPostingInfo.jobDescription. Greenhouse: content.
    // Lever: descriptionPlain. Ashby: descriptionHtml.
    const raw = json?.jobPostingInfo?.jobDescription
      ?? json?.content
      ?? json?.descriptionPlain
      ?? json?.descriptionHtml
      ?? '';
    const text = stripHtml(String(raw));
    return text.length >= 200 ? text.slice(0, 20000) : null;
  } catch {
    return null;                              // never fatal — fall through to HTML
  }
}

/**
 * Normalise a URL cell read back from the workbook.
 *
 * REGRESSION GUARD, added 2026-09-04. export-excel.mjs now writes Apply Link /
 * Job Posting Link as REAL Excel hyperlinks so they are clickable, which means
 * exceljs hands the cell back as an object `{ text, hyperlink }` rather than a
 * bare string. Every consumer that assumed a string then produced
 * "Failed to parse URL from [object Object]" and silently lost its JD fetch.
 * Accept both shapes rather than requiring every caller to remember.
 */
function asUrl(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return String(v.hyperlink || v.text || '').trim();
  return String(v).trim();
}

async function fetchJdText(rawUrl) {
  const url = asUrl(rawUrl);
  if (!url) return { text: null, error: 'no URL on this row' };

  // Try the structured API first — it is the only path that works on
  // JS-rendered boards, and it returns cleaner text than scraping ever does.
  const viaApi = await fetchViaAtsApi(url);
  if (viaApi) return { text: viaApi, error: null };

  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { text: null, error: `HTTP ${res.status}` };
    const html = await res.text();
    const text = stripHtml(html);
    if (text.length < 200) return { text: null, error: 'page returned too little content (likely JS-rendered or login-gated)' };
    return { text: text.slice(0, 20000), error: null }; // cap — this is context for a judgment step, not the full raw page
  } catch (err) {
    return { text: null, error: err.message || 'fetch failed' };
  }
}

/**
 * Hard boundary in 03_Master_Profile.md. Everything ABOVE it is fact and
 * quotable; everything BELOW is coaching, interview prep and generator
 * instructions. Truncating here means no parser bug, model lapse or future
 * subsection can leak commentary into an outbound document.
 *
 * Ported from the UK pipeline 2026-09-04, where exactly this bug shipped: a
 * spoken interview answer about immigration status, correctly labelled as
 * internal, was pulled into every generated cover letter because nothing
 * structurally stopped the generator reading it.
 *
 * Before this date, the India pipeline read the ENTIRE master profile into
 * every tailor bundle — including the "Known gaps and honest answers"
 * section and its sponsorship sentence — and relied only on a prompt
 * instruction (`noPrivateNotesLeak`) asking the model not to quote it. A
 * prompt is a request; this is a guarantee. Both are kept: defence in depth.
 */
const GUIDANCE_MARKER = '# PART 2 — GUIDANCE. NEVER QUOTED INTO A GENERATED DOCUMENT.';

export function loadProfileFacts(masterPath = MASTER_PROFILE_PATH) {
  const whole = readFileSync(masterPath, 'utf8');
  const cut = whole.indexOf(GUIDANCE_MARKER);
  if (cut === -1) {
    throw new Error(`${masterPath} is missing the PART 2 guidance divider — refusing to parse, `
      + 'since without it coaching notes, gap explanations and interview answers can be pulled '
      + 'into a CV or cover letter.');
  }
  return whole.slice(0, cut);
}

// ── SELECT phase ─────────────────────────────────────────────────────────

async function runSelect(limit) {
  if (!existsSync(XLSX_PATH)) {
    console.error(`${XLSX_PATH} not found — run export-excel.mjs first.`);
    process.exit(1);
  }
  if (!existsSync(CV_MD_PATH)) { console.error('cv.md not found.'); process.exit(1); }
  if (!existsSync(MASTER_PROFILE_PATH)) { console.error('03_Master_Profile.md not found.'); process.exit(1); }

  const cvMd = readFileSync(CV_MD_PATH, 'utf8');
  const masterProfileMd = loadProfileFacts();

  const wb = await loadWorkbook();
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) { console.error(`Sheet "${SHEET_NAME}" not found in ${XLSX_PATH}.`); process.exit(1); }
  const idx = headerIndex(ws);

  let candidates = [];
  const gateSkipped = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const obj = rowToObject(ws, idx, i);
    const score = Number(obj.Score);
    if (!Number.isFinite(score) || score < SCORE_FLOOR) continue;

    // Seniority/scope gate (experience-gate.mjs). Deliberately TITLE-ONLY here:
    // the JD body has not been fetched at this point, and a title like
    // "Senior Manager" or "AVP" is on its own sufficient evidence that the role
    // sits above this candidate's level regardless of the years figure quoted.
    // Verified before wiring: zero of the 71 target titles in config/profile.yml
    // are caught by this, so it cannot exclude a role actually being targeted.
    // The full two-check gate (numeric + scope on the JD body) runs in the
    // render step, where real JD text is available.
    const scope = scopeCheck(obj['Job Role'] || '', '');
    if (!scope.pass) {
      gateSkipped.push(`  row ${obj._rowNum} [${obj.Score}] ${obj.Company} — ${obj['Job Role']}  (${scope.reason})`);
      continue;
    }
    candidates.push(obj);
  }
  if (gateSkipped.length) {
    console.log(`${gateSkipped.length} row(s) skipped by the seniority/scope gate:`);
    gateSkipped.forEach((l) => console.log(l));
  }
  candidates.sort((a, b) => Number(b.Score) - Number(a.Score));
  if (limit) candidates = candidates.slice(0, limit);

  console.log(`${candidates.length} row(s) scoring >= ${SCORE_FLOOR} selected${limit ? ` (--limit ${limit})` : ''}.`);
  mkdirSync(BUNDLES_DIR, { recursive: true });

  const postGateSkipped = [];
  const expiredSkipped = [];
  const vetoSkipped = [];
  for (const c of candidates) {
    const url = c['Apply Link'] || c['Job Posting Link'];

    // ── LIVENESS GATE (added 2026-09-10, parity with the UK pipeline) ─────
    // Preparing a bundle for a closed posting wastes the one genuinely
    // expensive step in this pipeline: the human/agent fit judgment that has
    // to read it. On the UK side the same omission produced a 5.0-scored CV
    // and cover letter for a Reed posting that had already 404'd.
    //
    // FAIL-OPEN: only a confident "gone" skips. A timeout, a 403, a bot-block
    // or an unrecognised host all pass through as live, because rejecting a
    // real role for absence of evidence is the worse error — the same
    // principle the UNVERIFIED case below already follows.
    const live = await isStillLive(url);
    if (live.result === 'expired') {
      expiredSkipped.push(`  row ${c._rowNum} [${c.Score}] ${c.Company} — ${c['Job Role']}  (${live.reason})`);
      console.log(`Row ${c._rowNum} [${c.Score}] ${c.Company} — ${c['Job Role']} ... EXPIRED (${live.reason}) — skipped`);
      continue;
    }

    process.stdout.write(`Row ${c._rowNum} [${c.Score}] ${c.Company} — ${c['Job Role']} ... fetching JD ... `);
    const { text: jdText, error: jdFetchError } = await fetchJdText(url);
    console.log(jdFetchError ? `WARN: ${jdFetchError}` : `ok (${jdText.length} chars)`);

    // ── JD content veto (2026-09-25, ported from the UK repo) ────────────
    // Runs right after the fetch, before the post-fetch experience gate and
    // before a bundle is written: it's the cheapest, most specific
    // disqualifier available (an over-level title, an internal-only
    // posting, a required qualification she doesn't hold), so it's worth
    // spending first — a vetoed row never gets a bundle written, which
    // means neither disk space nor the judgment step's token budget is
    // spent on it. Placed in --select rather than --render because this
    // pipeline's fit judgment is deliberately an LLM-in-the-loop call on
    // the rendered bundle (see this file's header comment) — jd-veto is a
    // mechanical pre-filter, not part of that judgment, so it belongs in
    // the mechanical phase.
    const veto = jdVetoCheck(jdText, {}, { title: c['Job Role'] || '', company: c.Company });
    if (!veto.fit) {
      logJdRejection({ company: c.Company, role: c['Job Role'], url, reason: veto.reason, evidence: veto.evidence });
      vetoSkipped.push(`  row ${c._rowNum} [${c.Score}] ${c.Company} — ${c['Job Role']}  (${veto.reason})`);
      console.log(`  -> JD VETO: ${veto.reason}`);
      continue;
    }

    // ── Post-fetch gate — parity with the UK pipeline ────────────────────
    // The scopeCheck() above runs before any JD exists, so it can only see the
    // TITLE. The full two-check gate (numeric years requirement + scope signals
    // in the JD BODY) needs the fetched text, which only exists here.
    //
    // Added 2026-09-05. Until this date experienceGate was imported at the top
    // of this file but never called, so no body signal could ever fire. The two
    // Barclays rows both state "Assistant Vice President Expectations" in the
    // JD body and were reaching CV generation regardless.
    //
    // UNVERIFIED (nothing fetched) deliberately does NOT block, matching the
    // UK behaviour at auto-tailor.mjs:382 — rejecting a role for absence of
    // evidence would discard good postings behind a 403.
    const jdFetched = !jdFetchError && Boolean(jdText && jdText.length);
    const exp = experienceGate({ title: c['Job Role'] || '', jdText: jdText || '', jdFetched });
    if (exp.status === 'FAIL') {
      postGateSkipped.push(`  row ${c._rowNum} [${c.Score}] ${c.Company} — ${c['Job Role']}  (${exp.reason})`);
      console.log(`  -> GATED after JD fetch: ${exp.reason}`);
      continue;
    }

    const bundle = {
      row: c._rowNum,
      company: c.Company,
      role: c['Job Role'],
      score: c.Score,
      sector: c.Sector,
      archetype: null, // not stored on the sheet; the judgment step can infer from role/sector
      // asUrl(): these cells are Excel hyperlink objects since the clickable-
      // links change, not plain strings. Store the URL, not "[object Object]".
      applyLink: asUrl(c['Apply Link']),
      jobPostingLink: asUrl(c['Job Posting Link']),
      jdText,
      jdFetchError,
      // Agency detection (added 2026-09-05). india_targets.csv contains no
      // agencies, but `npm run paste` accepts free-text Naukri listings and
      // Naukri is full of staffing firms. Framing a recruiter as the employer
      // is a real, visible error in a cover letter.
      isAgencyPosting: isAgency(c.Company),
      cvMd,
      masterProfileMd,
      instructions: {
        decideFit: 'Read the JD text (or, if jdFetchError is set, the Job Role/Company/Notes on the row) against cv.md and 03_Master_Profile.md. If not honestly a fit, set fit=false and reason to a short, direct explanation — do not generate content.',
        ...(isAgency(c.Company) ? { agencyFraming: AGENCY_FRAMING_NOTE } : {}),
        neverInvent: 'Never invent an employer, title, tool, date, qualification, or result not present in cv.md or 03_Master_Profile.md.',
        noPrivateNotesLeak: 'The profile text you receive is PART 1 only — loadProfileFacts() truncates at the PART 2 divider, so internal prep notes and gap justifications are already excluded structurally. Do not reintroduce them: never write about employment gaps, work authorisation, visas or sponsorship in a generated CV or cover letter. The candidate has full right to work in India and there is nothing to disclose.',
        leadAngle: 'Lead with the £100K commercial risk catch for analytical/commercial roles; lead with the £83.6M UK portfolio for infrastructure/programme roles.',
        alwaysSurfaceUk: 'ALWAYS surface the UK experience prominently — it is scarce and valued in the Indian market, especially at GCCs and global firms. Do not bury it.',
        gbpToInr: 'Leave £ figures as-is in the content you write — the render phase converts them to a bracketed approx-INR figure automatically.',
        length: 'Target 1.5 to 2 pages, two pages maximum — roughly 700-900 words of body content total across CV summary + bullets. Two pages is the standard for this candidate in both the India and UK pipelines; do NOT compress to one page. Never delete a whole section or a whole role to fit: trim weak bullets or tighten wording instead. Trim order: professional-development skill lines, then education modules, then weakest experience bullets, then least-relevant skills within a category.',
        englishConventions: 'Indian English conventions (British spelling) — the render phase also normalizes common US spellings automatically, but write it that way from the start.',
        noCliche: 'No "I hope this finds you well" or equivalent filler in the cover letter.',
      },
    };
    const bundlePath = path.join(BUNDLES_DIR, `${c._rowNum}.json`);
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');
  }

  if (vetoSkipped.length) {
    console.log(`\n${vetoSkipped.length} row(s) rejected by the JD content veto:`);
    vetoSkipped.forEach((l) => console.log(l));
  }
  if (postGateSkipped.length) {
    console.log(`\n${postGateSkipped.length} row(s) gated after the JD was fetched (body-level seniority/scope):`);
    postGateSkipped.forEach((l) => console.log(l));
  }
  if (expiredSkipped.length) {
    console.log(`\n${expiredSkipped.length} row(s) skipped — posting no longer live:`);
    expiredSkipped.forEach((l) => console.log(l));
  }
  console.log(`\n${candidates.length - vetoSkipped.length - postGateSkipped.length - expiredSkipped.length} bundle(s) written to ${BUNDLES_DIR}/{row}.json`);
  console.log('Next: read each bundle, make the honest fit judgment, write a decision JSON (see schema in the file header), then run:');
  console.log('  node auto-tailor.mjs --render <decision.json>');
}

// ── Fabrication safety-net: every proper-noun-like phrase and numeric claim
// in the tailored text must appear somewhere in the source bundle text.
// Heuristic, not perfect — false positives on common capitalized words are
// possible, so this WARNS rather than blocks. It is a net under the agent's
// own judgment, not a replacement for it. ──────────────────────────────────

function extractClaims(text) {
  // [ \t] not \s for the internal word-joiner — a bare \s would let the
  // phrase match bridge across the newlines used to separate unrelated
  // tailored-content fields, producing nonsense phrases that span two
  // different sentences.
  const properNouns = [...new Set((text.match(/\b[A-Z][a-zA-Z&]{2,}(?:[ \t]+[A-Z][a-zA-Z&]{2,}){0,3}\b/g) || [])
    .filter(w => !/^(The|This|That|Summary|Experience|Education|Skills|Cover|Letter)\b/.test(w)))];
  const numbers = [...new Set((text.match(/[£₹$]\s?[\d,.]+[KkMm%]?|\b\d+%|\b\d+\s?(?:years?|months?|LPA)\b/g) || []))];
  return [...properNouns, ...numbers];
}

// excludeTerms: the TARGET employer/role name is expected to never appear in
// cv.md — that's not fabrication, it's the whole point of applying somewhere
// new. Only the candidate's own claimed history/results need verifying.
function checkFabrication(tailoredText, sourceText, excludeTerms = []) {
  const sourceLower = sourceText.toLowerCase();
  const excludeLower = excludeTerms.filter(Boolean).map(t => t.toLowerCase());
  const claims = extractClaims(tailoredText);
  return claims.filter(c => {
    const cLower = c.toLowerCase();
    if (excludeLower.some(ex => ex.includes(cLower) || cLower.includes(ex))) return false;
    return !sourceLower.includes(cLower);
  });
}

// ── £ → approx ₹ conversion, applied mechanically regardless of what the
// judgment step wrote, so the rule can never be silently skipped. ─────────

function convertGbpToInr(text) {
  return text.replace(/£\s?([\d,.]+)\s?([KkMm]?)/g, (match, numStr, suffix) => {
    let n = parseFloat(numStr.replace(/,/g, ''));
    if (Number.isNaN(n)) return match;
    if (/m/i.test(suffix)) n *= 1_000_000;
    else if (/k/i.test(suffix)) n *= 1_000;
    const inr = n * GBP_TO_INR_APPROX;
    const inrDisplay = inr >= 10_000_000 ? `₹${(inr / 10_000_000).toFixed(2)} Cr` : inr >= 100_000 ? `₹${(inr / 100_000).toFixed(1)}L` : `₹${Math.round(inr).toLocaleString('en-IN')}`;
    return `${match} (approx ${inrDisplay})`;
  });
}

// ── Indian English (British spelling) normalization — mechanical, applied
// regardless of what the judgment step wrote. Small, common-word list; not
// exhaustive. ───────────────────────────────────────────────────────────

const US_TO_UK = [
  [/\borganiz(e|ed|ing|ation|ations)\b/gi, m => m.replace(/z/i, 's')],
  [/\banaly[sz]e(d|s)?\b/gi, m => m.replace(/z/i, 's')],
  [/\bcolor(s|ed|ing)?\b/gi, m => m.replace(/color/i, 'colour')],
  [/\bfavor(s|ed|ing|ite)?\b/gi, m => m.replace(/favor/i, 'favour')],
  [/\bprogram(s)?\b/gi, m => m], // "program" (software) stays; "programme" (schedule) is a separate word the writer should already use correctly
  [/\bcenter(s|ed|ing)?\b/gi, m => m.replace(/center/i, 'centre')],
  [/\blicense\b/gi, 'licence'],
  [/\bdefense\b/gi, 'defence'],
  [/\btraveling\b/gi, 'travelling'],
  [/\bmodeling\b/gi, 'modelling'],
];

function toIndianEnglish(text) {
  let out = text;
  for (const [pattern, replacement] of US_TO_UK) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// UK-experience prominence check — heuristic keyword presence, warn-only.
function checkUkPresence(text) {
  return /(EMPLOYER_ONE|durham|united kingdom|\bUK\b)/i.test(text);
}

// ── DOCX rendering ───────────────────────────────────────────────────────

function processText(raw) {
  return toIndianEnglish(convertGbpToInr(raw));
}

function buildCvDocx(decision) {
  const cv = decision.cv;
  const children = [];

  children.push(new Paragraph({ text: 'Your Name', heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'YOUR_CITY, India  |  +91 +00 0000000000  |  you@example.com  |  linkedin.com/in/your-profile', size: 18 })],
  }));
  if (cv.headline) {
    children.push(new Paragraph({ children: [new TextRun({ text: processText(cv.headline), bold: true, size: 20 })], spacing: { before: 120, after: 80 } }));
  }
  if (cv.summary) {
    children.push(new Paragraph({ children: [new TextRun({ text: processText(cv.summary), size: 20 })], spacing: { after: 160 } }));
  }

  if (cv.experience?.length) {
    children.push(new Paragraph({ text: 'Experience', heading: HeadingLevel.HEADING_2 }));
    for (const job of cv.experience) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${job.title} — ${job.org}`, bold: true, size: 20 }),
          new TextRun({ text: job.dates ? `  (${job.dates})` : '', italics: true, size: 18 }),
        ],
        spacing: { before: 100 },
      }));
      for (const b of job.bullets || []) {
        children.push(new Paragraph({ text: processText(b), bullet: { level: 0 }, spacing: { after: 40 } }));
      }
    }
  }

  if (cv.education?.length) {
    children.push(new Paragraph({ text: 'Education', heading: HeadingLevel.HEADING_2, spacing: { before: 160 } }));
    for (const ed of cv.education) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `${ed.degree} — ${ed.org}`, bold: true, size: 20 }), new TextRun({ text: ed.dates ? `  (${ed.dates})` : '', italics: true, size: 18 })],
      }));
      if (ed.detail) children.push(new Paragraph({ text: processText(ed.detail), size: 18, spacing: { after: 60 } }));
    }
  }

  if (cv.skills?.length) {
    children.push(new Paragraph({ text: 'Skills', heading: HeadingLevel.HEADING_2, spacing: { before: 160 } }));
    children.push(new Paragraph({ text: cv.skills.map(processText).join(' · '), size: 18 }));
  }

  return new Document({
    sections: [{
      properties: { page: { margin: { top: 500, bottom: 500, left: 600, right: 600 } } },
      children,
    }],
  });
}

function buildCoverDocx(decision) {
  const cov = decision.cover;
  const children = [];
  children.push(new Paragraph({ text: `Re: ${decision.role} — ${decision.company}`, heading: HeadingLevel.HEADING_3 }));
  children.push(new Paragraph({ text: '' }));
  if (cov.opening) children.push(new Paragraph({ children: [new TextRun({ text: processText(cov.opening), size: 20 })], spacing: { after: 120 } }));
  for (const p of cov.body || []) {
    children.push(new Paragraph({ children: [new TextRun({ text: processText(p), size: 20 })], spacing: { after: 120 } }));
  }
  if (cov.closing) children.push(new Paragraph({ children: [new TextRun({ text: processText(cov.closing), size: 20 })] }));
  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({ text: 'Your Name', alignment: AlignmentType.LEFT }));

  return new Document({
    sections: [{ properties: { page: { margin: { top: 600, bottom: 600, left: 700, right: 700 } } }, children }],
  });
}

// ── RENDER phase ─────────────────────────────────────────────────────────

async function runRender(decisionPath) {
  if (!existsSync(decisionPath)) { console.error(`${decisionPath} not found.`); process.exit(1); }
  const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
  const bundlePath = path.join(BUNDLES_DIR, `${decision.row}.json`);
  const bundle = existsSync(bundlePath) ? JSON.parse(readFileSync(bundlePath, 'utf8')) : null;

  const wb = await loadWorkbook();
  const ws = wb.getWorksheet(SHEET_NAME);
  const idx = headerIndex(ws);
  const targetRowNum = decision.row;
  const rowObj = rowToObject(ws, idx, targetRowNum);
  if (!rowObj.Company) { console.error(`Row ${targetRowNum} not found or empty in the sheet.`); process.exit(1); }

  if (!decision.fit) {
    const note = `NOT A FIT - ${decision.reason || 'no reason given'}`;
    const notesCell = ws.getRow(targetRowNum).getCell(idx['Notes']);
    const existing = notesCell.value ? String(notesCell.value) : '';
    notesCell.value = existing ? `${existing} | ${note}` : note; // append — never destroy the original evaluation note
    await wb.xlsx.writeFile(XLSX_PATH);
    console.log(`Row ${targetRowNum} (${rowObj.Company} — ${rowObj['Job Role']}): ${note}`);
    console.log('No documents generated. Sheet updated (Notes only).');
    return;
  }

  // decision.company/role are optional in the schema (the row is already
  // identified by decision.row) — the sheet itself is the source of truth.
  decision.company = decision.company || rowObj.Company;
  decision.role = decision.role || rowObj['Job Role'];

  // Fabrication safety net
  // The fabrication check asks "does this claim appear in the source?" — so the
  // source must be FACTS ONLY. Including the guidance half would wrongly
  // validate fabricated claims: the "Known gaps" section contains the string
  // "over two years" (in a rule forbidding its use), which would let a CV
  // claiming "over two years" pass the check by matching the prohibition itself.
  const sourceText = bundle
    ? `${bundle.cvMd}\n${bundle.masterProfileMd}`
    : (existsSync(CV_MD_PATH) ? readFileSync(CV_MD_PATH, 'utf8') + loadProfileFacts() : '');
  const allTailoredText = [
    decision.cv?.headline, decision.cv?.summary,
    ...(decision.cv?.experience || []).flatMap(e => [e.title, e.org, ...(e.bullets || [])]),
    ...(decision.cv?.education || []).map(e => `${e.degree} ${e.org} ${e.detail || ''}`),
    ...(decision.cv?.skills || []),
    decision.cover?.opening, ...(decision.cover?.body || []), decision.cover?.closing,
  ].filter(Boolean).join('.\n');
  const unverified = sourceText ? checkFabrication(allTailoredText, sourceText, [decision.company, decision.role]) : [];
  if (unverified.length) {
    console.log(`⚠️  WARNING — ${unverified.length} claim(s) in the tailored content were NOT found in cv.md/03_Master_Profile.md:`);
    unverified.forEach(u => console.log(`    - "${u}"`));
    console.log('  Review before sending. Not blocking generation, but do not treat this as verified.');
  }

  const ukPresent = checkUkPresence(allTailoredText);
  if (!ukPresent) {
    console.log('⚠️  WARNING — no UK/EMPLOYER_ONE/YOUR_UNIVERSITY reference detected in the tailored content. The rule says ALWAYS surface UK experience prominently — this content currently doesn\'t.');
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const slug = (decision.company || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cvPath = path.join(OUTPUT_DIR, `${targetRowNum}-cv-firstname-lastname-${slug}.docx`);
  const coverPath = path.join(OUTPUT_DIR, `${targetRowNum}-cover-firstname-lastname-${slug}.docx`);

  const cvDoc = buildCvDocx(decision);
  const coverDoc = buildCoverDocx(decision);
  writeFileSync(cvPath, await Packer.toBuffer(cvDoc));
  writeFileSync(coverPath, await Packer.toBuffer(coverDoc));

  // Write back filenames only — never touch Status/Applied On/Notes/Contact.
  ws.getRow(targetRowNum).getCell(idx['CV File']).value = path.relative(ROOT, cvPath).replace(/\\/g, '/');
  ws.getRow(targetRowNum).getCell(idx['Cover Letter']).value = path.relative(ROOT, coverPath).replace(/\\/g, '/');
  await wb.xlsx.writeFile(XLSX_PATH);

  console.log(`Row ${targetRowNum} (${decision.company} — ${decision.role}): FIT — generated`);
  console.log(`  CV: ${cvPath}`);
  console.log(`  Cover: ${coverPath}`);
  console.log('  Sheet updated: CV File, Cover Letter columns only.');
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--select') opts.select = true;
    else if (argv[i] === '--render') opts.render = argv[++i];
    else if (argv[i] === '--limit') opts.limit = parseInt(argv[++i], 10);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.render) return runRender(opts.render);
  if (opts.select || !opts.render) return runSelect(opts.limit);
}

main().catch(err => {
  console.error('auto-tailor.mjs failed:', err.message);
  process.exit(1);
});
