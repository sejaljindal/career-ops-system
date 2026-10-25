// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Adzuna provider — title-first search across a whole national job market.
//
// Unlike the per-employer ATS readers (greenhouse, workday, lever), and unlike
// the board-wide remote feeds (remotive, himalayas) which are developer-heavy,
// Adzuna aggregates the mainstream market: agency listings, direct employer
// postings, and the big national boards it syndicates from. For a business
// analyst / consulting search this is the widest single source available
// without scraping.
//
// It is TITLE-FIRST, not employer-first: you give it search terms, it returns
// matching postings from any employer. That is the half the employer-walk
// architecture structurally cannot reach — a company only surfaces if it is
// already on the tracked list.
//
// ── Credentials ──────────────────────────────────────────────────────────────
// Free key (instant, no card) from https://developer.adzuna.com. Put them in
// .env at the repo root — which is gitignored, so they never reach a commit:
//
//   ADZUNA_APP_ID=xxxxxxxx
//   ADZUNA_APP_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//
// They are deliberately NOT read from portals.yml. Even though portals.yml is
// gitignored here, config belongs in config and secrets belong in .env; a user
// who later un-ignores portals.yml should not thereby publish their key.
//
// ── portals.yml wiring ───────────────────────────────────────────────────────
//   job_boards:
//     - name: Adzuna India
//       provider: adzuna
//       enabled: true
//       country: in            # ISO-ish Adzuna country code, see COUNTRIES
//       pages: 2               # pages per query (50 results/page)
//       queries:               # optional — omit to use DEFAULT_QUERIES
//         - business analyst
//         - management consultant
//
// ── Cost ─────────────────────────────────────────────────────────────────────
// One HTTP call per query per page. The default 8 queries x 2 pages = 16 calls
// per board per run, well inside the free tier's daily allowance. Raising
// `pages` is the cheapest way to widen; raising `queries` is the most effective.

const API_BASE = 'https://api.adzuna.com/v1/api/jobs';

// Adzuna's supported country codes. Anything outside this list is a config
// typo, and is rejected loudly rather than producing a confusing 404 body.
// The value is the currency Adzuna quotes salaries in for that market. The
// API never states the currency itself, so it has to be attached here —
// without it, salary_filter's currency check has nothing to compare and a
// 65000 (GBP) and a 650000 (INR) are indistinguishable numbers.
const COUNTRIES = new Map([
  ['gb', 'GBP'], ['us', 'USD'], ['at', 'EUR'], ['au', 'AUD'], ['be', 'EUR'],
  ['br', 'BRL'], ['ca', 'CAD'], ['ch', 'CHF'], ['de', 'EUR'], ['es', 'EUR'],
  ['fr', 'EUR'], ['in', 'INR'], ['it', 'EUR'], ['mx', 'MXN'], ['nl', 'EUR'],
  ['nz', 'NZD'], ['pl', 'PLN'], ['sg', 'SGD'], ['za', 'ZAR'],
]);

// Fallback search terms when the board entry declares none. Deliberately broad
// role families rather than exact seniorities — the scanner's own title_filter
// and the seniority pre-gate do the narrowing downstream, and an over-narrow
// query here silently costs coverage that no later stage can recover.
const DEFAULT_QUERIES = [
  'business analyst',
  'management consultant',
  'business transformation',
  'project manager',
  'programme manager',
  'business consultant',
  'process improvement',
  'operations analyst',
];

const MAX_RESULTS_PER_PAGE = 50; // Adzuna's hard ceiling
const MAX_PAGES = 10;            // sanity bound on a runaway config value
const MAX_QUERIES = 40;          // ditto — protects the daily call allowance

/**
 * Clamp an integer into a range, falling back for NaN/absent values.
 * @param {unknown} val
 * @param {number} def
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function intInRange(val, def, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Normalize one Adzuna result object into the scanner's Job shape.
 *
 * Returns null for anything missing a usable title or absolute URL, so a
 * malformed row is dropped rather than poisoning the dedup key.
 *
 * @param {any} r - Raw Adzuna result.
 * @param {string} boardName - Fallback company label.
 * @param {string} currency - ISO currency for this Adzuna market.
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: {min: number|null, max: number|null, currency: string}}|null}
 */
function normalize(r, boardName, currency) {
  if (!r || typeof r !== 'object') return null;

  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const url = typeof r.redirect_url === 'string' ? r.redirect_url.trim() : '';
  if (!title || !/^https?:\/\//i.test(url)) return null;

  const company = (r.company && typeof r.company.display_name === 'string' && r.company.display_name.trim())
    ? r.company.display_name.trim()
    : boardName;

  const location = (r.location && typeof r.location.display_name === 'string')
    ? r.location.display_name.trim()
    : '';

  /** @type {any} */
  const job = { title, url, company, location };

  // Adzuna truncates descriptions to ~250 chars with an ellipsis. That is
  // still enough for the content_filter's keyword checks and costs no extra
  // request, so it is passed through — but it is NOT a full JD, and nothing
  // downstream should treat its absence of a phrase as proof of absence.
  if (typeof r.description === 'string' && r.description.trim()) {
    job.description = r.description.trim();
  }

  // `created` is ISO 8601. Feeding postedAt lets max_posting_age_days do real
  // work on this source instead of passing everything through as undated.
  if (typeof r.created === 'string') {
    const ms = Date.parse(r.created);
    if (Number.isFinite(ms)) job.postedAt = ms;
  }

  // salary_is_predicted === "1" means the figure is Adzuna's own ML estimate,
  // not a number the employer published. Those are excluded: a predicted
  // salary that passes a salary floor is a false positive on a real decision,
  // and downstream a missing salary is handled conservatively (it passes)
  // whereas a wrong one is not detectable at all.
  const predicted = String(r.salary_is_predicted ?? '') === '1';
  const sMin = Number(r.salary_min);
  const sMax = Number(r.salary_max);
  if (!predicted && (Number.isFinite(sMin) || Number.isFinite(sMax))) {
    job.salary = {
      min: Number.isFinite(sMin) ? sMin : null,
      max: Number.isFinite(sMax) ? sMax : null,
      currency,
    };
  }

  return job;
}

/** @type {Provider} */
export default {
  id: 'adzuna',

  /**
   * Fetches postings from the Adzuna search API for every configured query.
   *
   * @param {{ name?: string, country?: string, queries?: unknown, pages?: unknown, results_per_page?: unknown, where?: string, max_days_old?: unknown, full_time?: boolean, permanent?: boolean }} entry
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any> }} ctx
   * @returns {Promise<Array<object>>}
   */
  async fetch(entry, ctx) {
    const appId = (process.env.ADZUNA_APP_ID || '').trim();
    const appKey = (process.env.ADZUNA_APP_KEY || '').trim();
    if (!appId || !appKey) {
      throw new Error(
        'adzuna: ADZUNA_APP_ID and ADZUNA_APP_KEY are not set. Get a free key at ' +
        'https://developer.adzuna.com and add both to .env at the repo root ' +
        '(copy .env.example to .env if it does not exist yet).'
      );
    }

    const boardName = entry.name || 'Adzuna';

    const country = (entry.country || 'gb').trim().toLowerCase();
    const currency = COUNTRIES.get(country);
    if (!currency) {
      throw new Error(
        `adzuna: unsupported country "${country}" for board "${boardName}". ` +
        `Supported: ${[...COUNTRIES.keys()].sort().join(', ')}`
      );
    }

    const queries = (Array.isArray(entry.queries)
      ? entry.queries.filter(q => typeof q === 'string' && q.trim()).map(q => q.trim())
      : []);
    const effectiveQueries = (queries.length ? queries : DEFAULT_QUERIES).slice(0, MAX_QUERIES);

    const pages = intInRange(entry.pages, 2, 1, MAX_PAGES);
    const perPage = intInRange(entry.results_per_page, MAX_RESULTS_PER_PAGE, 1, MAX_RESULTS_PER_PAGE);

    /** @type {Array<object>} */
    const out = [];
    // Adzuna returns the same posting for overlapping queries ("business
    // analyst" and "business consultant" both match a "Business Analyst
    // Consultant"). scan.mjs dedupes globally by URL, but deduping here first
    // keeps the per-board `found` count honest in the run summary.
    const seen = new Set();

    // Errors are collected, not thrown, so one bad query (or one transient
    // 5xx) does not discard the postings the other queries already returned.
    /** @type {string[]} */
    const failures = [];

    for (const what of effectiveQueries) {
      for (let page = 1; page <= pages; page++) {
        const params = new URLSearchParams({
          app_id: appId,
          app_key: appKey,
          results_per_page: String(perPage),
          what,
          'content-type': 'application/json',
        });
        if (typeof entry.where === 'string' && entry.where.trim()) {
          params.set('where', entry.where.trim());
        }
        const maxDaysOld = intInRange(entry.max_days_old, 0, 0, 365);
        if (maxDaysOld > 0) params.set('max_days_old', String(maxDaysOld));
        if (entry.full_time === true) params.set('full_time', '1');
        if (entry.permanent === true) params.set('permanent', '1');

        const url = `${API_BASE}/${country}/search/${page}?${params.toString()}`;

        let json;
        try {
          // redirect:'error' prevents SSRF via a server-side redirect.
          json = await ctx.fetchJson(url, { redirect: 'error' });
        } catch (err) {
          failures.push(`"${what}" p${page}: ${err instanceof Error ? err.message : String(err)}`);
          break; // later pages of a failing query are not worth the calls
        }

        if (!json || !Array.isArray(json.results)) {
          failures.push(`"${what}" p${page}: unexpected response shape`);
          break;
        }

        for (const raw of json.results) {
          const job = normalize(raw, boardName, currency);
          if (!job) continue;
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          out.push(job);
        }

        // Short page means the result set is exhausted — stop paging this query.
        if (json.results.length < perPage) break;
      }
    }

    // Only a total wipeout is fatal. A partial failure is surfaced on stderr
    // so it is visible in the run log without discarding good results.
    if (out.length === 0 && failures.length > 0) {
      throw new Error(`adzuna (${country}): all queries failed — ${failures.join('; ')}`);
    }
    if (failures.length > 0) {
      console.error(`⚠️  adzuna (${country}): ${failures.length} query/page failure(s) — ${failures.slice(0, 3).join('; ')}`);
    }

    return out;
  },
};
