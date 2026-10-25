#!/usr/bin/env node
/**
 * fetch-jd-api.mjs — zero-token, zero-browser JD text fetch for ATS-hosted postings.
 *
 * WebFetch can't render Workday's client-side JS, so triage/liveness checks against
 * myworkdayjobs.com URLs were coming back empty and getting misclassified as
 * SKIP/expired. resolveAtsApi() (liveness-api.mjs) already knows how to map a
 * Workday/Greenhouse/Lever posting URL to its public JSON API — this file adds the
 * one missing piece: pulling the actual JD text out of that JSON (not just a
 * liveness verdict) so triage/eval can read real content instead of nothing.
 *
 * Usage: node fetch-jd-api.mjs <url>   -> prints extracted JD text to stdout
 *        import { fetchJdViaApi } from this file for programmatic use.
 */
import { resolveAtsApi } from './liveness-api.mjs';
import { DEFAULT_USER_AGENT } from './user-agent.mjs';

const TIMEOUT_MS = 10_000;

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Each ATS's JSON response shapes its JD text differently.
function extractText(ats, json) {
  if (ats === 'workday') {
    const html = json?.jobPostingInfo?.jobDescription;
    return stripHtml(html);
  }
  if (ats === 'greenhouse') {
    return stripHtml(json?.content);
  }
  if (ats === 'lever') {
    return stripHtml(json?.description) || stripHtml(json?.descriptionPlain) || '';
  }
  if (ats === 'ashby') {
    // org-level board payload; caller already resolved the specific job via `interpret`
    // in liveness-api.mjs for liveness, but for text we need the job's own descriptionHtml.
    return '';
  }
  return '';
}

/**
 * @param {string} url
 * @returns {Promise<{ ok: true, ats: string, text: string, title?: string } | { ok: false, reason: string }>}
 */
export async function fetchJdViaApi(url) {
  const resolved = resolveAtsApi(url);
  if (!resolved) return { ok: false, reason: 'not a recognized ATS API URL' };
  const { ats, apiUrl, timeoutMs } = resolved;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (e) {
      return { ok: false, reason: `network error: ${e.message}` };
    }
    if (res.status === 404 || res.status === 410) {
      return { ok: false, reason: `ATS API ${res.status} — posting removed` };
    }
    if (res.status !== 200) {
      return { ok: false, reason: `ATS API returned ${res.status}` };
    }
    let json;
    try {
      json = await res.json();
    } catch {
      return { ok: false, reason: 'ATS API response was not valid JSON' };
    }
    const text = extractText(ats, json);
    if (!text) return { ok: false, reason: `ATS API returned 200 but no JD text field found (ats=${ats})` };
    const title = json?.jobPostingInfo?.title || json?.title || json?.text || undefined;
    return { ok: true, ats, text, title };
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') || process.argv[1]?.endsWith('fetch-jd-api.mjs')) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node fetch-jd-api.mjs <url>');
    process.exit(1);
  }
  const result = await fetchJdViaApi(url);
  if (!result.ok) {
    console.error(`FAILED: ${result.reason}`);
    process.exit(1);
  }
  console.log(`=== ${result.title || '(no title)'} [${result.ats}] ===\n`);
  console.log(result.text);
}
