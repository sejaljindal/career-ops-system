#!/usr/bin/env node
/**
 * liveness-gate.mjs — "is this posting still open?", cheaply and safely.
 *
 * Extracted 2026-09-10 so auto-tailor.mjs and ready-to-send.mjs can share it.
 * It lives in its own module for a concrete reason: the India auto-tailor.mjs
 * calls main() at module scope, so importing THAT file to reach one helper
 * kicks off a full select phase as a side effect. A leaf module with no
 * top-level effects cannot do that to a caller.
 *
 * Files prefixed with _ are skipped by the provider loader; this is not a
 * provider, so it keeps its plain name.
 */

/**
 * Is this posting still open? Two cheap rungs, no Playwright.
 *
 * Added 2026-09-10. The expensive failure it prevents is documented at the
 * call site: tailoring a role whose posting has already closed.
 *
 *   Rung 1 — the ATS API (liveness-api.mjs). Free, no browser, authoritative
 *            for Workday / Greenhouse / Lever / Ashby. Returns null for
 *            anything it doesn't recognise (Reed, NHS Jobs, company sites).
 *   Rung 2 — a plain HTTP GET. 404 and 410 are the only verdicts trusted;
 *            that is precisely how the Sopra Steria closure showed up, and
 *            it needs no browser. Deliberately NOT Playwright: this runs
 *            per-role inside the tailoring loop and must stay fast.
 *
 * FAIL-OPEN. Every path that is not a confident "gone" returns 'unknown',
 * which the caller treats as live. A timeout, a bot-block, a 403, a DNS
 * failure or an unrecognised host must never cost a real application. The
 * check can only ever remove work, never invent a rejection.
 *
 * @param {string} url
 * @returns {Promise<{result: 'expired'|'active'|'unknown', reason: string}>}
 */
export async function isStillLive(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { result: 'unknown', reason: 'no usable URL' };
  }

  // Rung 1 — ATS API.
  try {
    const { checkLivenessViaApi } = await import('./liveness-api.mjs');
    const api = await checkLivenessViaApi(url);
    if (api && (api.result === 'expired' || api.result === 'active')) {
      return { result: api.result, reason: `${api.reason} (ats api)` };
    }
  } catch {
    // Module missing or threw — fall through to rung 2 rather than fail.
  }

  // Rung 2 — plain GET. Only 404/410 are trusted as "gone".
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT_FOR_LIVENESS },
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404 || res.status === 410) {
      return { result: 'expired', reason: `HTTP ${res.status}` };
    }
    return { result: 'active', reason: `HTTP ${res.status}` };
  } catch (err) {
    return { result: 'unknown', reason: `check failed (${err?.name || 'error'}) — treated as live` };
  }
}

const USER_AGENT_FOR_LIVENESS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
