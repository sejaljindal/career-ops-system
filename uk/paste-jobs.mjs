#!/usr/bin/env node
// paste-jobs.mjs — manual intake for platforms that can't be automated
// (LinkedIn login-gated past the preview, Indeed and Glassdoor bot-walled,
// and any company careers page with no readable ATS behind it).
//
// PORTED TO THE UK PIPELINE 2026-09-09 from the India fork, unchanged except
// this header. data/pipeline.md has an identical `## Pending` row format in
// both repos, so the same parser works. agency.mjs came across with it and
// matters MORE here: 264 of 685 postings in the last UK run were
// agency-posted with the end employer withheld, which is exactly the case
// where a manually pasted listing needs flagging before a cover letter is
// drafted against the wrong company name.
//
// Accepts messy pasted text — not just a clean list of URLs. Splits it into
// per-listing chunks, and for each chunk extracts company, role, location,
// CTC, posted date, and the job link from whatever labeled or unlabeled text
// is present, falling back to fetching the URL's own page (JSON-LD /
// Open Graph / <title>) for any field the text didn't supply. Appends one
// row per successfully-linked listing to data/pipeline.md's ## Pending
// section, tagged `| source: MANUAL` (matches the Excel export's Source
// column exactly — see export-excel.mjs).
//
// IMPORTANT SCOPE NOTE: this script QUEUES listings for evaluation — it does
// not itself score them. Scoring (Blocks A-G, the Step 1 hard gate, comp
// research) is an AI-judgment process against cv.md and modes/_profile.md,
// the same one every automated-ATS role goes through; a script can't
// replicate that. Once queued here, run the evaluation pipeline (the same
// way the automated batch was evaluated — /career-ops pipeline, or an
// agent-driven batch run) to actually produce scores. After that,
// export-excel.mjs already picks up every evaluated report regardless of
// source, so there is no separate "merge" step — re-run it and Manual rows
// appear in pipeline.xlsx with Source = "Manual" like anything else.
//
// Usage:
//   node paste-jobs.mjs urls.txt              # a file of URLs or messy listing text
//   node paste-jobs.mjs                        # stdin, or falls back to input/manual_jobs.txt
//   node paste-jobs.mjs <url> <url> ...        # URLs as arguments
//
// A listing needs at least one URL to become a pipeline.md row (the row
// format requires one). Listings with no extractable URL are reported back,
// not silently dropped — see "COULD NOT PARSE" in the summary.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isAgency } from './agency.mjs';

// Data Root, not the codebase root — data/, input/ are user-layer, so they
// must follow CAREER_OPS_ROOT/.career-ops-data (#drift-guard).
const ROOT = getCareerOpsRoot();
const PIPELINE_PATH = path.join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY_TSV = path.join(ROOT, 'data', 'scan-history.tsv');
const DEFAULT_INPUT_PATH = path.join(ROOT, 'input', 'manual_jobs.txt');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;

// ── Input collection ────────────────────────────────────────────────────

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function collectRawText(argv) {
  if (argv.length === 1 && existsSync(argv[0])) {
    return { text: readFileSync(argv[0], 'utf8'), source: argv[0] };
  }
  if (argv.length > 0) {
    return { text: argv.join('\n'), source: 'command-line arguments' };
  }
  const stdinText = readStdin();
  if (stdinText.trim()) {
    return { text: stdinText, source: 'stdin' };
  }
  if (existsSync(DEFAULT_INPUT_PATH)) {
    return { text: readFileSync(DEFAULT_INPUT_PATH, 'utf8'), source: DEFAULT_INPUT_PATH };
  }
  return { text: '', source: null };
}

// ── URL extraction — tolerant of messy surrounding text: prose, email/Slack
// copy-paste, numbered/bulleted lists, markdown `[title](url)` links,
// angle-bracket-wrapped `<url>`, trailing sentence punctuation. ────────────

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  return matches.map(stripTrailingPunctuation).filter(Boolean);
}

function stripTrailingPunctuation(url) {
  let u = url.replace(/[.,;:!?'"]+$/, '');
  // A markdown link `[title](url)` or bare `(url)` leaves an unbalanced
  // trailing `)`/`]` in the raw regex match — strip only when unbalanced,
  // so a URL that legitimately contains a balanced paren is untouched.
  while (/[)\]]$/.test(u)) {
    const close = u.slice(-1);
    const open = close === ')' ? '(' : '[';
    const opens = (u.match(new RegExp('\\' + open, 'g')) || []).length;
    const closes = (u.match(new RegExp('\\' + close, 'g')) || []).length;
    if (closes > opens) u = u.slice(0, -1);
    else break;
  }
  return u;
}

// ── Split raw pasted text into per-listing chunks ───────────────────────
// Rough formats vary a lot, so this tries a few strategies in order and
// picks whichever actually separates the listings:
//   1. Explicit separator lines (---, ===, or 3+ blank lines) — most
//      deliberate copy-paste-and-clean-up input.
//   2. Blank-line-delimited paragraphs (2+ newlines) — the common case when
//      pasting several job-board entries one after another.
//   3. If neither produces more than one chunk but multiple URLs are
//      present, split right before each URL — handles a flat list where
//      every line is "Company - Role - link, one after another" with no
//      blank lines at all.

function splitIntoChunks(text) {
  const bySeparator = text.split(/\n[-=*_]{3,}\n|\n{3,}/).map(s => s.trim()).filter(Boolean);
  if (bySeparator.length > 1) return bySeparator;

  const byBlankLine = text.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
  if (byBlankLine.length > 1) return byBlankLine;

  const urls = extractUrls(text);
  if (urls.length > 1) {
    const positions = urls.map(u => text.indexOf(u)).filter(p => p >= 0);
    const chunks = [];
    for (let i = 0; i < positions.length; i++) {
      const start = i === 0 ? 0 : positions[i];
      const end = i + 1 < positions.length ? positions[i + 1] : text.length;
      chunks.push(text.slice(start, end).trim());
    }
    return chunks.filter(Boolean);
  }

  return text.trim() ? [text.trim()] : [];
}

// ── Field extraction from a single rough-text chunk ─────────────────────
// Tries labeled fields first ("Company: X", "Role: Y", ...), then a couple
// of unlabeled heuristics for CTC and posted date, which are the two fields
// a URL page-fetch can never recover (neither appears in JSON-LD/OG tags on
// most Indian job boards).

const LABEL_PATTERNS = {
  company: /(?:^|\n)\s*(?:company|employer|organi[sz]ation)\s*[:\-]\s*(.+)/i,
  role: /(?:^|\n)\s*(?:role|title|position|job\s*title)\s*[:\-]\s*(.+)/i,
  location: /(?:^|\n)\s*(?:location|city|based\s*in)\s*[:\-]\s*(.+)/i,
  ctcLabeled: /(?:^|\n)\s*(?:ctc|salary|compensation|comp)\s*[:\-]\s*(.+)/i,
  postedLabeled: /(?:^|\n)\s*(?:posted|posted\s*date|date\s*posted|listed)\s*[:\-]\s*(.+)/i,
};

// Unlabeled fallback: a number followed by LPA/lakh, anywhere in the chunk.
const CTC_PATTERN = /(₹?\s*\d+(?:\.\d+)?\s*(?:-|to)\s*₹?\s*\d+(?:\.\d+)?\s*(?:LPA|lakh|lakhs)|₹?\s*\d+(?:\.\d+)?\s*(?:LPA|lakh|lakhs))/i;
// Unlabeled fallback: an ISO date, or a relative "N days/weeks ago" phrase.
const DATE_PATTERN = /(\d{4}-\d{2}-\d{2}|\d+\s*(?:day|week|month)s?\s*ago|today|yesterday)/i;

function firstLine(s) {
  return s ? s.split('\n')[0].trim() : s;
}

function parseChunk(chunk) {
  const urls = extractUrls(chunk);
  const url = urls[0]; // first URL in the chunk is the listing's link

  const companyM = chunk.match(LABEL_PATTERNS.company);
  const roleM = chunk.match(LABEL_PATTERNS.role);
  const locationM = chunk.match(LABEL_PATTERNS.location);
  const ctcM = chunk.match(LABEL_PATTERNS.ctcLabeled) || chunk.match(CTC_PATTERN);
  const postedM = chunk.match(LABEL_PATTERNS.postedLabeled) || chunk.match(DATE_PATTERN);

  return {
    url,
    company: companyM ? firstLine(companyM[1]) : undefined,
    role: roleM ? firstLine(roleM[1]) : undefined,
    location: locationM ? firstLine(locationM[1]) : undefined,
    ctc: ctcM ? firstLine(ctcM[1] ?? ctcM[0]) : undefined,
    postedDate: postedM ? firstLine(postedM[1] ?? postedM[0]) : undefined,
    rawChunk: chunk,
  };
}

// ── Cleanup: strip tracking query params for known patterns so the same
// posting pasted twice (LinkedIn re-shares the same job with a fresh
// trackingId every time) dedupes correctly against pipeline.md and future
// pastes. Left untouched for domains where the query string might carry
// content-bearing state, not just tracking. ──────────────────────────────

function cleanUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (/(^|\.)linkedin\.com$/.test(u.hostname) && /\/jobs\/view\/\d+/.test(u.pathname)) {
      return `${u.origin}${u.pathname}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

// ── Page-fetch extraction (fallback for fields the text-parse didn't find)

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .trim();
}

function extractJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of blocks) {
    try {
      let data = JSON.parse(m[1].trim());
      const candidates = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const c of candidates) {
        if (c && (c['@type'] === 'JobPosting' || (Array.isArray(c['@type']) && c['@type'].includes('JobPosting')))) {
          const org = c.hiringOrganization?.name;
          const loc = c.jobLocation?.address?.addressLocality
            || c.jobLocation?.address?.addressRegion
            || (Array.isArray(c.jobLocation) ? c.jobLocation[0]?.address?.addressLocality : undefined);
          return {
            title: c.title ? decodeEntities(c.title) : undefined,
            company: org ? decodeEntities(org) : undefined,
            location: loc ? decodeEntities(loc) : undefined,
          };
        }
      }
    } catch { /* malformed JSON-LD block — try the next one */ }
  }
  return {};
}

function extractOpenGraph(html) {
  const og = {};
  for (const [, prop, content] of html.matchAll(/<meta[^>]+property=["']og:([a-z:]+)["'][^>]+content=["']([^"']*)["']/gi)) {
    og[prop] = decodeEntities(content);
  }
  return og;
}

function extractTitleTag(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1]) : undefined;
}

// LinkedIn's public <title> tag follows "{Title} hiring {Role} in {Location} | LinkedIn"
// or "{Role} - {Company} | LinkedIn"; best-effort parse, never load-bearing —
// JSON-LD (present on most LinkedIn job pages, even logged out) wins when found.
function parseLinkedInTitle(t) {
  if (!t) return {};
  const hiringMatch = t.match(/^(.+?)\s+hiring\s+(.+?)\s+in\s+(.+?)\s*\|\s*LinkedIn/i);
  if (hiringMatch) return { company: hiringMatch[1].trim(), title: hiringMatch[2].trim(), location: hiringMatch[3].trim() };
  const atMatch = t.match(/^(.+?)\s+at\s+(.+?)(?:\s*[—-]\s*(.+?))?\s*\|\s*LinkedIn(?:\s+Jobs)?/i);
  if (atMatch) return { title: atMatch[1].trim(), company: atMatch[2].trim(), location: atMatch[3]?.trim() };
  const dashMatch = t.match(/^(.+?)\s*-\s*(.+?)\s*\|\s*LinkedIn/i);
  if (dashMatch) return { title: dashMatch[1].trim(), company: dashMatch[2].trim() };
  return {};
}

// A pipe in any extracted field would corrupt pipeline.md's `|`-delimited
// row structure (silently creating a phantom extra column). Defensive
// regardless of which extraction path produced the value.
function sanitizeField(v) {
  return v ? v.replace(/\|/g, '/').replace(/\s+/g, ' ').trim() : v;
}

async function fetchPageFields(url) {
  let html;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    html = await res.text();
  } catch (err) {
    return { error: err.message || 'fetch failed' };
  }

  const jsonLd = extractJsonLd(html);
  const og = extractOpenGraph(html);
  const titleTag = extractTitleTag(html);
  const linkedInParsed = /linkedin\.com/.test(url)
    ? (parseLinkedInTitle(titleTag).title ? parseLinkedInTitle(titleTag) : parseLinkedInTitle(og.title))
    : {};

  return {
    title: sanitizeField(jsonLd.title || linkedInParsed.title || og.title),
    company: sanitizeField(jsonLd.company || linkedInParsed.company || og.site_name),
    location: sanitizeField(jsonLd.location || linkedInParsed.location),
  };
}

// ── pipeline.md I/O ──────────────────────────────────────────────────────

function readExistingPendingUrls() {
  if (!existsSync(PIPELINE_PATH)) return new Set();
  const content = readFileSync(PIPELINE_PATH, 'utf8');
  const urls = new Set();
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^- \[[ x!]\]\s*(?:#\S+\s*\|\s*)?(\S+)/);
    if (m) urls.add(cleanUrl(m[1]));
  }
  return urls;
}

function buildRow({ url, company, role, location, ctc, postedDate }) {
  const cols = [url];
  // Positional columns are strictly ordered: url | company | title | location | compensation.
  // A later column present forces earlier ones to exist (empty if unknown).
  if (company || role || location || ctc) cols.push(company || '');
  if (role || location || ctc) cols.push(role || '');
  if (location || ctc) cols.push(location || '');
  if (ctc) cols.push(ctc);

  let row = `- [ ] ${cols.join(' | ')}`;
  if (postedDate) row += ` | posted: ${postedDate}`;
  row += ` | source: MANUAL`;
  return row;
}

function buildUnextractableRow(url, reason) {
  return `- [ ] ${url} | source: MANUAL | note: could not auto-extract (${reason}) — paste the JD text or company/role manually before evaluating`;
}

// ── data/scan-history.tsv: the persistent Location/Posted Date log every
// scanner writes to, keyed by URL. export-excel.mjs reads THIS for Location
// and Posted Date, not the pipeline.md row — which loses those fields once a
// row is rewritten into ## Processed format. Writing here is what makes a
// manually-added listing behave identically to a scanned one downstream. ──

function normalizePostedDate(raw) {
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const today = new Date();
  if (/^today$/i.test(raw)) return today.toISOString().slice(0, 10);
  if (/^yesterday$/i.test(raw)) {
    today.setDate(today.getDate() - 1);
    return today.toISOString().slice(0, 10);
  }
  const rel = raw.match(/^(\d+)\s*(day|week|month)s?\s*ago$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const days = unit === 'day' ? n : unit === 'week' ? n * 7 : n * 30;
    today.setDate(today.getDate() - days);
    return today.toISOString().slice(0, 10);
  }
  return ''; // unrecognized format — leave blank rather than guess
}

// Added 2026-09-05. This is the one intake path that can bring a recruitment
// agency into the India pipeline — india_targets.csv is curated and has none,
// but Naukri and LinkedIn are full of staffing firms. Warn at intake so the
// row is known to be agency-sourced before any cover letter is drafted; the
// tailor bundle carries the same flag via isAgencyPosting.
function warnOnAgencies(entries) {
  const flagged = entries.filter((e) => isAgency(e.company));
  if (!flagged.length) return;
  console.log('');
  console.log(`NOTE: ${flagged.length} of ${entries.length} pasted posting(s) look like RECRUITMENT AGENCIES, not direct employers:`);
  flagged.forEach((e) => console.log(`  - ${e.company}${e.role ? ` — ${e.role}` : ''}`));
  console.log('The end employer is unknown for these. Any cover letter must use recruiter');
  console.log('framing and must not name or assume an end client the posting has not named.');
  console.log('');
}

function appendScanHistory(entries) {
  if (!entries.length) return;
  warnOnAgencies(entries);
  const header = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company';
  let content = existsSync(SCAN_HISTORY_TSV) ? readFileSync(SCAN_HISTORY_TSV, 'utf8') : '';
  if (!content.trim()) content = header + '\n';
  if (!content.endsWith('\n')) content += '\n';
  const today = new Date().toISOString().slice(0, 10);
  for (const e of entries) {
    const normCompany = (e.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    content += [
      e.url, today, 'manual-paste', e.role || '', e.company || '', 'added',
      e.location || '', '', normalizePostedDate(e.postedDate), '', '', normCompany,
    ].join('\t') + '\n';
  }
  writeFileSync(SCAN_HISTORY_TSV, content, 'utf8');
}

function appendToPipeline(rows) {
  let content = existsSync(PIPELINE_PATH)
    ? readFileSync(PIPELINE_PATH, 'utf8')
    : '# Pipeline — Pending URLs\n\nPaste job URLs below as `- [ ] {url}` then run `/career-ops pipeline`.\n\n## Pending\n\n## Processed\n';

  const pendingIdx = content.indexOf('## Pending');
  const processedIdx = content.indexOf('## Processed');
  if (pendingIdx === -1) {
    content += `\n## Pending\n\n${rows.join('\n')}\n`;
  } else {
    const insertAt = processedIdx > pendingIdx ? processedIdx : content.length;
    const before = content.slice(0, insertAt).replace(/\n*$/, '\n');
    const after = content.slice(insertAt);
    content = `${before}${rows.join('\n')}\n\n${after}`;
  }
  writeFileSync(PIPELINE_PATH, content, 'utf8');
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function main() {
  const { text, source } = collectRawText(process.argv.slice(2));
  if (!text.trim()) {
    console.error(
      `No input found. Usage: node paste-jobs.mjs <file.txt>  |  node paste-jobs.mjs <url> [url ...]  |  paste text into stdin\n` +
      `Or drop rough listing text into ${DEFAULT_INPUT_PATH} and re-run with no arguments.`
    );
    process.exit(1);
  }
  console.log(`Reading from: ${source}\n`);

  const chunks = splitIntoChunks(text);
  const parsed = chunks.map(parseChunk);

  const existing = readExistingPendingUrls();
  const rows = [];
  const historyEntries = [];
  const couldNotParse = [];
  const summary = { added: 0, skippedDuplicate: 0, textParsed: 0, pageFetched: 0, extractionFailed: 0 };

  for (const listing of parsed) {
    if (!listing.url) {
      couldNotParse.push(listing.rawChunk);
      continue;
    }
    const url = cleanUrl(listing.url);
    if (existing.has(url)) {
      console.log(`SKIP (already in pipeline.md): ${url}`);
      summary.skippedDuplicate++;
      continue;
    }

    let { company, role, location, ctc, postedDate } = listing;
    const gotFromText = !!(company || role);

    if (!company || !role || !location) {
      process.stdout.write(`Fetching ${url} for missing fields ... `);
      const fetched = await fetchPageFields(url);
      if (fetched.error) {
        console.log(`could not fetch (${fetched.error})`);
        if (!company && !role) {
          rows.push(buildUnextractableRow(url, fetched.error));
          existing.add(url);
          summary.added++;
          summary.extractionFailed++;
          continue;
        }
      } else {
        console.log('ok');
        company = company || fetched.company;
        role = role || fetched.title;
        location = location || fetched.location;
      }
    }

    if (!company && !role) {
      rows.push(buildUnextractableRow(url, 'no company/role found in pasted text or page fetch'));
      summary.extractionFailed++;
    } else {
      rows.push(buildRow({ url, company, role, location, ctc, postedDate }));
      historyEntries.push({ url, company, role, location, postedDate });
      if (gotFromText) summary.textParsed++; else summary.pageFetched++;
    }
    existing.add(url);
    summary.added++;
    console.log(`  -> ${company || '?'} — ${role || '?'}${location ? ` (${location})` : ''}${ctc ? ` | CTC: ${ctc}` : ''}${postedDate ? ` | posted: ${postedDate}` : ''}`);
  }

  if (rows.length) appendToPipeline(rows);
  if (historyEntries.length) appendScanHistory(historyEntries);

  console.log(
    `\nDone. Added ${summary.added} row(s) to data/pipeline.md ` +
    `(${summary.textParsed} parsed from pasted text, ${summary.pageFetched} filled in from the page, ${summary.extractionFailed} needing manual JD paste). ` +
    `${summary.skippedDuplicate} already present, skipped.`
  );

  if (couldNotParse.length) {
    console.log(`\n${couldNotParse.length} chunk(s) had NO extractable URL — nothing was added for these, fix the input and re-run:`);
    couldNotParse.forEach((c, i) => {
      const preview = c.replace(/\s+/g, ' ').trim().slice(0, 100);
      console.log(`  ${i + 1}. "${preview}${c.length > 100 ? '...' : ''}"`);
    });
  }

  console.log(
    `\nNext step: these are QUEUED, not scored. Run the evaluation pipeline ` +
    `(same process the automated batch used — Blocks A-G against cv.md, the ` +
    `Step 1 hard gate) to actually score them, then re-run export-excel.mjs ` +
    `to pick them up in pipeline.xlsx with Source = "Manual".`
  );
}

main().catch(err => {
  console.error('paste-jobs.mjs failed:', err.message);
  process.exit(1);
});
