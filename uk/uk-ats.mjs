#!/usr/bin/env node
/**
 * uk-ats.mjs — UK-market ATS platform detection and reachability classification.
 *
 * career-ops ships providers for the US-centric vendors (Greenhouse, Ashby,
 * Lever, Workday, SuccessFactors, iCIMS, Oracle Cloud, Cornerstone). UK public
 * sector and mid-market employers overwhelmingly use a different set, which is
 * why a name-based Greenhouse/Ashby/Lever sweep of the gov.uk sponsor register
 * resolves ~0.6% of employers.
 *
 * This module adds detection for those platforms and — critically — classifies
 * how each one can actually be READ:
 *
 *   json     — public JSON endpoint, no auth, no browser
 *   html     — server-rendered HTML, parseable with plain fetch
 *   browser  — JS-rendered or WAF-protected; needs Playwright
 *
 * DETECTION IS FROM THE EMPLOYER'S careers_url, never from a guessed hostname.
 * Guessing tenant subdomains (`<company>.tribepad.com`) mostly returns DNS
 * failures and tells you nothing about whether the platform is reachable.
 *
 * Reachability values below marked `verified: true` were probed live against a
 * real endpoint. Those marked `verified: false` are pattern definitions whose
 * class is inferred from the platform's architecture and NOT yet confirmed
 * against a live tenant — treat them as best-effort until a real careers_url
 * for that platform is seen in the wild.
 */

import { isMainModule } from './lib/is-main-module.mjs';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * UK ATS platform registry.
 * `match` runs against the employer's careers_url (lowercased).
 * `jobsUrl(u)` derives the machine-readable endpoint where one exists.
 */
export const UK_ATS = [
  {
    id: 'workday',
    label: 'Workday',
    reach: 'json',
    verified: true,
    note: 'CXS endpoint returns JSON (POST). Provider already shipped: providers/workday.mjs.',
    match: /\.myworkdayjobs\.com/i,
    jobsUrl(u) {
      const m = u.match(/https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com(?:\/[a-z]{2}-[A-Z]{2})?\/([^/?#]+)/i);
      return m ? `https://${m[1]}.${m[2]}.myworkdayjobs.com/wday/cxs/${m[1]}/${m[3]}/jobs` : null;
    },
  },
  {
    id: 'successfactors',
    label: 'SAP SuccessFactors',
    reach: 'html',
    verified: false,
    note: 'Career-site HTML varies by tenant. Provider shipped: providers/successfactors.mjs.',
    match: /successfactors\.(eu|com)|\/sfcareer\/|careers?\.sap\b/i,
    jobsUrl: () => null,
  },
  {
    id: 'oleeo',
    label: 'Oleeo (formerly WCN / tal.net)',
    reach: 'browser',
    verified: false,
    note: 'Tenants live on *.tal.net and *.oleeo.com. Job board is a session-scoped SPA; guessed tenant hosts did not resolve.',
    match: /\.tal\.net|\.oleeo\.com/i,
    jobsUrl: () => null,
  },
  {
    id: 'tribepad',
    label: 'Tribepad',
    reach: 'browser',
    verified: false,
    note: 'Tenants on *.tribepad.com and white-labelled customer domains. Guessed tenant hosts did not resolve.',
    match: /\.tribepad\.com|tribepad/i,
    jobsUrl: () => null,
  },
  {
    id: 'itrent',
    label: 'MHR iTrent / Webitrent',
    reach: 'html',
    verified: true,
    note: 'Host resolves and returns server-rendered HTML (200), but the vacancy list is session-scoped via etrec* entry points.',
    match: /webitrent\.com|engageats\.co\.uk|itrent/i,
    jobsUrl: () => null,
  },
  {
    id: 'eploy',
    label: 'Eploy',
    reach: 'html',
    verified: false,
    note: 'Tenant career sites are server-rendered; some expose /vacancies JSON. No live tenant confirmed.',
    match: /\.eploy\.net|eploy\.co\.uk/i,
    jobsUrl: (u) => (u.includes('/vacancies') ? u : null),
  },
  {
    id: 'talentlink',
    label: 'Lumesse TalentLink',
    reach: 'browser',
    verified: true,
    note: 'Vendor host emea*.recruitmentplatform.com returned 403 to plain fetch — WAF-protected, needs a browser.',
    match: /recruitmentplatform\.com|talentlink/i,
    jobsUrl: () => null,
  },
  {
    id: 'trac',
    label: 'TRAC / Health Jobs UK',
    reach: 'browser',
    verified: true,
    note: 'www.trac.jobs is the EMPLOYER-side portal; public vacancies live on healthjobsuk.com. Scrape https://www.healthjobsuk.com/job_list?JobSearch_q=... in Chromium (verified working). Job URLs embed the employing NHS trust.',
    match: /trac\.jobs/i,
    jobsUrl: () => null,
  },
  {
    id: 'jobsgopublic',
    label: 'Jobs Go Public',
    reach: 'browser',
    verified: true,
    note: 'Search page returned 200 but only ~3.7KB — the listing is client-rendered, so plain fetch sees no jobs.',
    match: /jobsgopublic\.com/i,
    jobsUrl: () => null,
  },
  {
    id: 'greenhouse',
    label: 'Greenhouse',
    reach: 'json',
    verified: true,
    note: 'Existing provider.',
    match: /greenhouse\.io/i,
    jobsUrl(u) {
      const m = u.match(/greenhouse\.io\/([^/?#]+)/i);
      return m ? `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs` : null;
    },
  },
  {
    id: 'ashby',
    label: 'Ashby',
    reach: 'json',
    verified: true,
    note: 'Existing provider.',
    match: /ashbyhq\.com/i,
    jobsUrl: () => null,
  },
  {
    id: 'lever',
    label: 'Lever',
    reach: 'json',
    verified: true,
    note: 'Existing provider.',
    match: /lever\.co/i,
    jobsUrl(u) {
      const m = u.match(/lever\.co\/([^/?#]+)/i);
      return m ? `https://api.lever.co/v0/postings/${m[1]}?mode=json` : null;
    },
  },
  {
    id: 'icims',
    label: 'iCIMS',
    reach: 'html',
    verified: false,
    note: 'Existing provider.',
    match: /icims\.com/i,
    jobsUrl: () => null,
  },
  {
    id: 'oraclecloud',
    label: 'Oracle Cloud (ORC)',
    reach: 'json',
    verified: false,
    note: 'Existing provider.',
    match: /oraclecloud\.com|\/hcmUI\//i,
    jobsUrl: () => null,
  },
];

/**
 * UK aggregators — the fallback route for employers with no reachable ATS.
 * Councils and universities post to these reliably, so an employer that is
 * AGGREGATOR_ONLY is still visible, just second-best.
 */
export const AGGREGATORS = [
  {
    id: 'findajob',
    label: 'GOV.UK Find a Job (CLOSED)',
    reach: 'dead',
    verified: true,
    note: 'SERVICE PERMANENTLY CLOSED — navigation returns HTTP 503 "This site is now closed". A plain fetch still returns 200 + ~166KB of app shell with zero jobs, which is why a naive probe reads as alive. Never route here.',
    search: (employer, what = '') =>
      `https://findajob.dwp.gov.uk/search?q=${encodeURIComponent(`${what} ${employer}`.trim())}`,
  },
  {
    id: 'healthjobsuk',
    label: 'Health Jobs UK (TRAC)',
    reach: 'browser',
    verified: true,
    note: 'Verified scraping in Chromium via /job_list?JobSearch_q=... — job URLs embed the employing NHS trust, so employer attribution is free.',
    search: (employer, what = '') =>
      `https://www.healthjobsuk.com/job_list?JobSearch_q=${encodeURIComponent(`${what} ${employer}`.trim())}`,
  },
  {
    id: 'nhsjobs',
    label: 'NHS Jobs',
    reach: 'html',
    verified: true,
    note: 'HTTP 200, server-rendered, job content present (~85KB). The /api/v1 endpoint is 403.',
    search: (employer, what = '') =>
      `https://www.jobs.nhs.uk/candidate/search/results?keyword=${encodeURIComponent(`${what} ${employer}`.trim())}`,
  },
  {
    id: 'reed',
    label: 'Reed',
    reach: 'html',
    verified: true,
    note: 'HTTP 200, server-rendered (~388KB). The official API requires a key (401 without).',
    search: (employer, what = '') =>
      `https://www.reed.co.uk/jobs/${encodeURIComponent(`${what}-jobs`.replace(/\s+/g, '-'))}?keywords=${encodeURIComponent(employer)}`,
  },
  {
    id: 'civilservice',
    label: 'Civil Service Jobs',
    reach: 'browser',
    verified: true,
    note: 'HTTP 200 but search is session-scoped behind an opaque SID param — needs a browser to drive.',
    search: () => 'https://www.civilservicejobs.service.gov.uk/csr/index.cgi',
  },
  {
    id: 'totaljobs',
    label: 'TotalJobs',
    reach: 'browser',
    verified: true,
    note: 'HTTP 403 to plain fetch — WAF-protected, needs a browser.',
    search: (employer, what = '') =>
      `https://www.totaljobs.com/jobs/${encodeURIComponent(`${what}`.trim().replace(/\s+/g, '-') || 'analyst')}?companyname=${encodeURIComponent(employer)}`,
  },
  {
    id: 'jobsgopublic',
    label: 'Jobs Go Public',
    reach: 'browser',
    verified: true,
    note: 'Client-rendered listing — needs a browser.',
    search: (employer) => `https://www.jobsgopublic.com/vacancies?keyword=${encodeURIComponent(employer)}`,
  },
];

/** Detect the ATS platform behind a careers_url. Returns null when unknown. */
export function detectPlatform(careersUrl) {
  const u = String(careersUrl || '').toLowerCase();
  if (!u) return null;
  for (const p of UK_ATS) if (p.match.test(u)) return p;
  return null;
}

/**
 * Which aggregators are worth trying for this employer, given its sector.
 * Sector-driven, not exclusive: a council also appears on Find a Job.
 */
export function aggregatorsFor(sector = '') {
  const s = String(sector).toLowerCase();
  // findajob deliberately absent: the service is closed.
  const ids = ['reed', 'nhsjobs'];
  if (/nhs|health/.test(s)) ids.unshift('nhsjobs', 'healthjobsuk');
  if (/local government|council|government|public|educat|universit/.test(s)) ids.unshift('jobsgopublic');
  // reach:'dead' entries (GOV.UK Find a Job) are never a route.
  return AGGREGATORS.filter((a) => ids.includes(a.id) && a.reach !== 'dead');
}

/**
 * Coverage class for one employer.
 *   DIRECT_API       — a machine-readable endpoint exists (json)
 *   AGGREGATOR_ONLY  — no direct endpoint, but reachable via an aggregator
 *   UNREACHABLE      — no careers_url and no usable aggregator route
 */
export function classifyCoverage({ careersUrl = '', name = '', sector = '' }) {
  const platform = detectPlatform(careersUrl);
  const endpoint = platform?.jobsUrl ? platform.jobsUrl(careersUrl) : null;

  if (platform && platform.reach === 'json' && endpoint) {
    return { coverage: 'DIRECT_API', platform: platform.id, endpoint, route: platform.label };
  }
  if (platform && platform.reach === 'json') {
    return { coverage: 'DIRECT_API', platform: platform.id, endpoint: '', route: platform.label };
  }

  // AGGREGATOR_ONLY has to mean something. Any employer name can technically be
  // typed into Reed, so "has a name" is not a coverage claim. It counts only
  // when there is a real reason to expect the roles to be findable:
  //
  //   (a) public sector — councils, universities, NHS, government bodies post
  //       to Find a Job / NHS Jobs / Jobs Go Public as a matter of course; or
  //   (b) we hold a careers_url, so there is a concrete page to read even if no
  //       API sits behind it.
  //
  // Everything else — a private employer known only as a line in the register,
  // with no careers page and no detected ATS — is UNREACHABLE. Name-searching
  // those on a job board is a guess, not coverage.
  const PUBLIC_SECTOR = /local government|council|nhs|health|educat|universit|college|school|government|public/i;
  const isPublic = PUBLIC_SECTOR.test(String(sector));
  const aggs = aggregatorsFor(sector);

  if (isPublic && aggs.length) {
    return {
      coverage: 'AGGREGATOR_ONLY',
      platform: platform?.id || (careersUrl ? 'unknown-ats' : ''),
      endpoint: '',
      route: aggs.map((a) => a.label).join(' / '),
    };
  }
  if (careersUrl) {
    return {
      coverage: 'AGGREGATOR_ONLY',
      platform: platform?.id || 'unknown-ats',
      endpoint: '',
      route: `careers page + ${aggs.map((a) => a.label).join(' / ')}`,
    };
  }
  return { coverage: 'UNREACHABLE', platform: platform?.id || '', endpoint: '', route: '' };
}

/** Live probe of a JSON endpoint. Returns {ok, status, count}. */
export async function probeEndpoint(url, { timeoutMs = 15000 } = {}) {
  if (!url) return { ok: false, status: 'none', count: 0 };
  const post = url.includes('/wday/cxs/');
  try {
    const res = await fetch(url, {
      method: post ? 'POST' : 'GET',
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'application/json',
        ...(post ? { 'content-type': 'application/json' } : {}),
      },
      ...(post ? { body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status, count: 0 };
    const j = await res.json();
    const count = j.total ?? j.totalCount ?? (Array.isArray(j) ? j.length : j.jobPostings?.length ?? 0);
    return { ok: true, status: res.status, count: Number(count) || 0 };
  } catch (e) {
    return { ok: false, status: 'ERR', count: 0, error: String(e.message || e).slice(0, 80) };
  }
}

if (isMainModule(import.meta.url)) {
  console.log('UK ATS platforms — reachability (verified = probed live)\n');
  console.log('ID'.padEnd(16), 'REACH'.padEnd(9), 'VERIFIED'.padEnd(9), 'PLATFORM');
  console.log('-'.repeat(96));
  for (const p of UK_ATS) {
    console.log(p.id.padEnd(16), p.reach.padEnd(9), String(p.verified).padEnd(9), p.label);
  }
  console.log('\nAggregators\n');
  console.log('ID'.padEnd(16), 'REACH'.padEnd(9), 'VERIFIED'.padEnd(9), 'PLATFORM');
  console.log('-'.repeat(96));
  for (const a of AGGREGATORS) {
    console.log(a.id.padEnd(16), a.reach.padEnd(9), String(a.verified).padEnd(9), a.label);
  }
}
