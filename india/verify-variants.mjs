#!/usr/bin/env node
/**
 * verify-variants.mjs — prove every reworded bullet still states the same facts.
 *
 * Rewording is the one place on a CV where fabrication can enter unnoticed, so
 * it is checked mechanically rather than trusted. For each bullet, every
 * family variant must carry:
 *
 *   1. EXACTLY the same figures as the base — every £ amount, every
 *      percentage, every hour count. A variant that drops "£100K" has weakened
 *      the CV; one that changes it to "£150K" has broken it.
 *   2. EXACTLY the same named entities — employers, schemes, tools, bodies.
 *      PROJECT_ONE, PROJECT_TWO, PROJECT_THREE, CLIENT_ONE, SharePoint, Power BI, SQL,
 *      CRM, RAID, CDM.
 *   3. No promoted verb. "Led", "owned", "headed", "directed", "managed a
 *      team", "was responsible for the strategy" — none of these appear in the
 *      base wording, and a variant must not introduce them. That is the exact
 *      failure mode the whole selection-only approach was guarding against,
 *      and it is now guarded explicitly instead of by refusing to reword.
 *
 * Run it after any edit to bullet-variants.data.mjs:
 *   node verify-variants.mjs
 *
 * Exit code 1 on any failure, so it can gate a commit.
 */

import { BULLET_VARIANTS, FAMILIES } from './bullet-variants.data.mjs';

/** Every figure: £ amounts, percentages, hour counts. */
const figures = (t) => (String(t).match(/£[\d.,]+[KM]?|\d+%|\d+ hours?/gi) || [])
  .map((f) => f.toLowerCase()).sort();

/**
 * Named entities. Capitalised words and known acronyms, minus the ordinary
 * sentence-initial capital, which is not an entity.
 */
const STOP = new Set([
  'coordinated', 'identified', 'produced', 'analysed', 'escalated', 'maintained',
  'redesigned', 'built', 'conducted', 'standardised', 'worked', 'operated',
  'mapped', 'diagnosed', 'ran', 'designed', 'defined', 'implemented', 'cleansed',
  'tracked', 'the', 'a', 'an', 'same', 'business', 'structured', 'partnered',
  'raised', 'consolidated', 'transforming', 'quantified', 'surfacing', 'framing',
]);

/**
 * Entities that may legitimately appear in a variant but not in that
 * particular base line, because they are elsewhere in cv.md. "PMO" is the
 * case in point: it is the candidate's actual job title, so naming it in the
 * PMO-family variant is accurate, not an addition.
 */
const ALLOWED_EXTRA = new Set(['pmo']);
const entities = (t) => {
  const found = new Set();
  for (const m of String(t).matchAll(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\b/g)) {
    // Strip a leading verb that is only capitalised because it starts the
    // sentence. Without this, "Redesigned SharePoint" and "SharePoint" read as
    // two different entities and every rephrased opening looked like a
    // fabrication — six false failures on the first run, which is exactly how
    // a checker gets ignored.
    let tok = m[1];
    let first = tok.split(/\s+/)[0];
    while (STOP.has(first.toLowerCase()) && tok.includes(' ')) {
      tok = tok.slice(first.length).trim();
      first = tok.split(/\s+/)[0];
    }
    if (!tok || STOP.has(tok.toLowerCase())) continue;
    found.add(tok.toLowerCase());
  }
  for (const acr of String(t).match(/\b(?:RAID|CDM|DfT|CRM|SQL|PMO|BI)\b/g) || []) found.add(acr.toLowerCase());
  return [...found].sort();
};

/** Verbs that would promote her beyond what the base claims. */
// The negative lookbehind matters: "data-led pattern analysis" is not a claim
// to have led anything, and without it the checker flagged a legitimate variant.
const PROMOTED = /(?<![-\w])(?:led|leading|owned|owning|headed|directed|spearhead|oversaw|accountable for|responsible for the strategy|drove the strategy|managed (?:a |the )?team)\b/i;

let pass = 0, fail = 0;
const problems = [];

for (const b of BULLET_VARIANTS) {
  const baseFigs = figures(b.base);
  const baseEnts = entities(b.base);
  const basePromoted = PROMOTED.test(b.base);

  for (const fam of FAMILIES) {
    const v = b[fam];
    if (!v) { problems.push(`${b.match} · ${fam}: MISSING variant`); fail++; continue; }

    const f = figures(v);
    if (JSON.stringify(f) !== JSON.stringify(baseFigs)) {
      problems.push(`${b.match} · ${fam}: figures differ\n      base: ${baseFigs.join(', ') || '(none)'}\n      this: ${f.join(', ') || '(none)'}`);
      fail++; continue;
    }

    const e = entities(v);
    const missing = baseEnts.filter((x) => !e.includes(x));
    const added = e.filter((x) => !baseEnts.includes(x) && !ALLOWED_EXTRA.has(x));
    if (missing.length || added.length) {
      problems.push(`${b.match} · ${fam}: entities differ${missing.length ? `\n      dropped: ${missing.join(', ')}` : ''}${added.length ? `\n      added:   ${added.join(', ')}` : ''}`);
      fail++; continue;
    }

    if (!basePromoted && PROMOTED.test(v)) {
      problems.push(`${b.match} · ${fam}: introduces a promoted verb — "${v.match(PROMOTED)[0]}"`);
      fail++; continue;
    }

    pass++;
  }
}

console.log(`${BULLET_VARIANTS.length} bullet(s) × ${FAMILIES.length} families`);
if (problems.length) {
  console.log('');
  for (const p of problems) console.log(`  ✗ ${p}`);
}
console.log(`\n${pass} variant(s) verified, ${fail} failed.`);
if (!fail) console.log('Every variant states the same figures, the same entities, and no promoted verb.');
process.exitCode = fail ? 1 : 0;
