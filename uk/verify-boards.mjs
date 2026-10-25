#!/usr/bin/env node
/**
 * verify-boards.mjs — prove that each resolved ATS board actually belongs to
 * the employer it was attached to.
 *
 * WHY THIS EXISTS. discover-ats.mjs resolves a company to a board by guessing a
 * slug. A guess that RESOLVES is not a guess that is CORRECT: generic
 * single-word slugs collide with unrelated companies that happen to own that
 * word. Real examples caught here:
 *
 *   "Edinburgh"            -> greenhouse/edinburgh  = Edinburgh Animal Hospital, Virginia
 *   "University of Warwick"-> greenhouse/warwick    = Warwick Animal Hospital, Oklahoma
 *   "London"               -> greenhouse/london     = a retail chain
 *   "Arcadia University"   -> lever/arcadia         = a US healthcare-data firm
 *
 * Attaching a stranger's job board to an employer is worse than having no board
 * at all — it silently feeds wrong roles into the pipeline. So every board is
 * scored on evidence and anything unproven is demoted.
 *
 * EVIDENCE (any one is enough to CONFIRM):
 *   - a distinctive name token from the employer appears in the board's own
 *     job URLs, titles or locations
 *   - the board serves UK locations AND the slug is not a bare generic word
 *
 * Verdicts: CONFIRMED · SUSPECT (generic slug, no UK signal, no name match)
 *           · DEAD (board no longer returns jobs)
 *           · UNVERIFIABLE (host behind a CAPTCHA/WAF — cannot be checked;
 *             kept, never demoted, and never counted as verified)
 *
 * Usage:
 *   node verify-boards.mjs              # report only
 *   node verify-boards.mjs --demote     # strip SUSPECT/DEAD boards (UNVERIFIABLE is kept)
 */

import { readFileSync, writeFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import * as yaml from 'js-yaml';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Slugs that are places, common words, or otherwise not identifying. A board
// reached by one of these needs positive evidence before we trust it.
const GENERIC = new Set(['london', 'edinburgh', 'bath', 'cambridge', 'oxford', 'bristol', 'bradford', 'belfast',
  'warwick', 'arcadia', 'inverness', 'northampton', 'buckinghamshire', 'newcastle', 'york', 'durham', 'leeds',
  'manchester', 'liverpool', 'sheffield', 'nottingham', 'glasgow', 'cardiff', 'swansea', 'surrey', 'sussex',
  'kent', 'essex', 'stirling', 'aberdeen', 'dundee', 'exeter', 'reading', 'hull', 'salford', 'plymouth',
  'beam', 'curve', 'bird', 'flock', 'patch', 'impress', 'jude', 'nothing', 'otta', 'perse', 'vev', 'bud',
  'ember', 'stint', 'flink', 'huma', 'futr', 'yonder', 'tines', 'wonde', 'zilch', 'olio', 'hofy', 'kroo']);

const STOP = new Set(['the', 'of', 'and', 'university', 'college', 'limited', 'ltd', 'llp', 'plc', 'uk', 'group',
  'holdings', 'services', 'company', 'international', 'trust', 'foundation', 'nhs', 'council', 'borough']);

/** Distinctive lowercase tokens from an employer name. */
export function nameTokens(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

/**
 * Which vendor and tenant a careers URL points at. Each platform encodes the
 * tenant differently, and the distinction matters: Workday's tenant lives in
 * the SUBDOMAIN (acme.wd3.myworkdayjobs.com), which is exactly how a
 * collision hides — apollo.com resolved to hbfuller.wd1.myworkdayjobs.com,
 * i.e. H.B. Fuller's tenant attributed to Apollo. Reading the tenant out of
 * the host is what makes that checkable.
 */
export function parseVendor(url) {
  const u = String(url || '');
  let m;
  if ((m = u.match(/greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#&]+)/i))) return { vendor: 'greenhouse', slug: m[1] };
  if ((m = u.match(/lever\.co\/([^/?#]+)/i))) return { vendor: 'lever', slug: m[1] };
  if ((m = u.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i))) return { vendor: 'ashby', slug: m[1] };
  // Workday: tenant is the host label, site is the first path segment.
  if ((m = u.match(/https?:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/i))) {
    return { vendor: 'workday', slug: m[1], wd: m[2], site: m[3] };
  }
  if ((m = u.match(/https?:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com/i))) return { vendor: 'workday', slug: m[1], wd: m[2], site: '' };
  if ((m = u.match(/([a-z0-9-]+)\.icims\.com/i))) return { vendor: 'icims', slug: m[1] };
  return null;
}

async function getJson(api, body = null) {
  const res = await fetch(api, {
    method: body ? 'POST' : 'GET',
    headers: { 'user-agent': UA, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { status: res.status, data: null };
  return { status: 200, data: await res.json() };
}

async function fetchBoard(url, vendor, slug, extra = {}) {
  try {
    if (vendor === 'greenhouse' || vendor === 'lever') {
      const api = vendor === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`
        : `https://api.lever.co/v0/postings/${slug}?mode=json`;
      const { status, data } = await getJson(api);
      if (status !== 200) return { jobs: [], status };
      const jobs = Array.isArray(data) ? data : (data.jobs || []);
      return { status: 200, jobs: jobs.map((x) => ({
        title: x.title || x.text || '',
        location: x.location?.name || x.categories?.location || '',
        url: x.absolute_url || x.hostedUrl || '',
      })) };
    }

    if (vendor === 'ashby') {
      // Public posting-board GraphQL endpoint; organizationHostedJobsPageName
      // is the tenant, so a wrong tenant returns nothing rather than someone
      // else's jobs.
      const { status, data } = await getJson('https://jobs.ashbyhq.com/api/non-user-graphql', {
        operationName: 'ApiJobBoardWithTeams',
        variables: { organizationHostedJobsPageName: slug },
        query: 'query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) { jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) { jobPostings { title locationName } } }',
      });
      if (status !== 200) return { jobs: [], status };
      const posts = data?.data?.jobBoard?.jobPostings || [];
      return { status: 200, jobs: posts.map((x) => ({ title: x.title || '', location: x.locationName || '', url: '' })) };
    }

    if (vendor === 'workday') {
      const wd = extra.wd || 'wd3';
      const site = extra.site || 'careers';
      const api = `https://${slug}.${wd}.myworkdayjobs.com/wday/cxs/${slug}/${site}/jobs`;
      const { status, data } = await getJson(api, { appliedFacets: {}, limit: 20, offset: 0, searchText: '' });
      if (status !== 200) return { jobs: [], status };
      const posts = data?.jobPostings || [];
      return { status: 200, jobs: posts.map((x) => ({
        title: x.title || '', location: x.locationsText || '', url: x.externalPath || '',
      })) };
    }

    if (vendor === 'icims') {
      // iCIMS sits behind AWS WAF with a CAPTCHA challenge. EVERY path returns
      // 405 with `x-amzn-waf-action: captcha` — including "/" — on both the
      // careers-{tenant} and bare {tenant} host forms, and headless Playwright
      // gets the same "confirm you are human" interstitial. There is no
      // endpoint to fix; the host is gated.
      //
      // That makes these boards UNVERIFIABLE, which is NOT the same as DEAD.
      // DEAD means the board is gone and its URL should be stripped;
      // UNVERIFIABLE means we cannot check from here and the URL is probably
      // fine. Treating one as the other stripped 12 live careers pages.
      // No public JSON API. Fetch the board HTML and read job titles out of it —
      // enough to prove the board is live and to test for a name token.
      const res = await fetch(`https://${slug}.icims.com/jobs/search?ss=1&searchRelation=keyword_all`, {
        headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: AbortSignal.timeout(15000),
      });
      if (res.headers.get('x-amzn-waf-action') || res.status === 405) {
        return { jobs: [], status: 'WAF' };
      }
      if (!res.ok) return { jobs: [], status: res.status };
      const html = await res.text();
      const titles = [...html.matchAll(/<a[^>]+class="[^"]*title[^"]*"[^>]*>([\s\S]{3,120}?)<\/a>/gi)]
        .map((m) => m[1].replace(/<[^>]+>/g, '').trim());
      // Fall back to the page text so a live-but-differently-marked-up board
      // is not mistaken for a dead one.
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
      if (!titles.length && !/job|career|vacanc/i.test(text)) return { jobs: [], status: 200 };
      return { status: 200, jobs: (titles.length ? titles : ['(board live)']).map((t) => ({ title: t, location: text.slice(0, 4000), url: '' })) };
    }

    return null;
  } catch { return { jobs: [], status: 'ERR' }; }
}

const UK_RE = /\b(uk|united kingdom|england|scotland|wales|london|manchester|birmingham|leeds|bristol|glasgow|edinburgh|cardiff|belfast|oxford|cambridge|reading|sheffield|liverpool|newcastle|nottingham)\b/i;

export function judge({ name, slug, board }) {
  if (board && board.status === 'WAF') {
    return {
      verdict: 'UNVERIFIABLE',
      why: 'host is behind a CAPTCHA/WAF challenge — cannot be checked from here; NOT evidence the board is dead',
    };
  }
  if (!board || board.status !== 200 || !board.jobs.length) {
    return { verdict: 'DEAD', why: `board returned ${board?.status ?? 'nothing'} / 0 jobs` };
  }
  const blob = board.jobs.map((j) => `${j.title} ${j.location} ${j.url}`).join(' ').toLowerCase();

  // A name token only counts as evidence if it is DISTINCTIVE. Place names are
  // circular: "Edinburgh" matches Edinburgh Animal Hospital, "London" matches a
  // London retail job, "Warwick" matches Warwick Animal Hospital. Each looks
  // like proof and is worthless, because the matching token IS the generic word
  // that caused the collision.
  const toks = nameTokens(name).filter((t) => !GENERIC.has(t));
  const matched = toks.filter((t) => blob.includes(t));
  if (matched.length) return { verdict: 'CONFIRMED', why: `distinctive name token "${matched[0]}" appears on the board` };

  // No distinctive token at all (e.g. the employer name is just a place) means
  // there is nothing that COULD corroborate. Never confirm on that.
  if (!toks.length) {
    return { verdict: 'SUSPECT', why: `employer name "${name}" has no distinctive token — nothing can corroborate this board` };
  }

  const ukJobs = board.jobs.filter((j) => UK_RE.test(j.location)).length;
  if (!GENERIC.has(slug.toLowerCase()) && ukJobs > 0) {
    return { verdict: 'CONFIRMED', why: `distinctive slug + ${ukJobs}/${board.jobs.length} UK-located jobs` };
  }
  if (GENERIC.has(slug.toLowerCase())) {
    return { verdict: 'SUSPECT', why: `generic slug "${slug}" and no name token on the board` };
  }
  if (!ukJobs) return { verdict: 'SUSPECT', why: 'no UK-located jobs and no name token on the board' };
  return { verdict: 'SUSPECT', why: 'no corroborating evidence' };
}

async function main() {
  const demote = process.argv.includes('--demote');
  const text = readFileSync('portals.yml', 'utf8');
  const doc = yaml.load(text);

  const targets = (doc.tracked_companies || [])
    .map((c) => (c && c.careers_url ? { c, p: parseVendor(c.careers_url) } : null))
    .filter((x) => x && x.p);

  const byVendor = {};
  for (const { p } of targets) byVendor[p.vendor] = (byVendor[p.vendor] || 0) + 1;
  console.log(`verifying ${targets.length} boards: `
    + Object.entries(byVendor).map(([k, v]) => `${k} ${v}`).join(' · ') + '\n');

  const rows = [];
  for (const { c, p } of targets) {
    const board = await fetchBoard(c.careers_url, p.vendor, p.slug, p);
    const v = judge({ name: c.name, slug: p.slug, board });
    rows.push({ name: c.name, slug: p.slug, vendor: p.vendor, jobs: board?.jobs.length ?? 0, ...v });
    await new Promise((r) => setTimeout(r, 120));
  }

  const t = {};
  for (const r of rows) t[r.verdict] = (t[r.verdict] || 0) + 1;
  console.log('VERDICTS:', JSON.stringify(t), '\n');

  // UNVERIFIABLE is NOT demoted. It means "we could not check", not "this is
  // wrong" — stripping a URL on that basis discards a probably-good careers
  // page on the strength of a CAPTCHA. Only positively-bad verdicts are cut.
  const bad = rows.filter((r) => r.verdict === 'SUSPECT' || r.verdict === 'DEAD');
  if (bad.length) {
    console.log('NOT CONFIRMED:');
    for (const r of bad) console.log(`  ${r.verdict.padEnd(8)} ${r.name.slice(0, 42).padEnd(44)} ${r.vendor}/${r.slug}  — ${r.why}`);
  }

  writeFileSync('board-verification.csv',
    ['Organisation,Vendor,Slug,Jobs,Verdict,Why',
      ...rows.map((r) => [r.name, r.vendor, r.slug, r.jobs, r.verdict, r.why]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n'), 'utf8');
  console.log('\nwrote board-verification.csv');

  if (!demote) {
    console.log(`\n(report only — re-run with --demote to strip ${bad.length} unproven boards from portals.yml)`);
    return;
  }

  // Demote: drop the bad careers_url/api lines so the employer falls back to
  // its aggregator route instead of pointing at a stranger's board.
  let out = text;
  let n = 0;
  for (const r of bad) {
    const re = new RegExp(`(^  - name: (?:"${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"|${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\r?\\n)((?:    .*\\r?\\n)*)`, 'm');
    const m = out.match(re);
    if (!m) continue;
    const body = m[2]
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^\s{4}(careers_url|api):/.test(l))
      // The reason text itself can contain double quotes (it quotes the employer
      // name), which would terminate the YAML string early and corrupt the file.
      .map((l) => (/^\s{4}notes:/.test(l)
        ? l.replace(/"\s*$/, ` | board unverified (${r.verdict}: ${r.why.replace(/"/g, "'")}) - demoted"`)
        : l));
    out = out.replace(re, `$1${body.join('\n')}\n`);
    n++;
  }
  writeFileSync('portals.yml', out, 'utf8');
  console.log(`\ndemoted ${n} entries in portals.yml (careers_url/api removed, reason recorded in notes)`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
