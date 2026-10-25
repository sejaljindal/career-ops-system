// tests/register-verification-gate.test.mjs — a non-sponsor employer must be
// caught by EVERY code path that can produce a score or a CV, not just the
// one where the cap was first found (run-daily.mjs::scoreRole, #2026-09-04).
//
// The 2026-09-24 audit found the cap wired into exactly one of three:
// tailor-cv.mjs (loadRows, loadAgentRows) and auto-tailor.mjs (decideFit)
// never checked registerVerified/sourceLists at all. This file pins all
// three so a future edit that re-opens any one of them fails loudly.
//
// loadRows() hardcodes its path to the real output/pipeline.xlsx rather than
// accepting one as a parameter, so this file does not drive a fixture through
// it directly — swapping the real workbook out from under a live pipeline for
// the duration of a test is a worse risk than the coverage gap it would close.
// registerCapped() is the exact function loadRows calls to do the capping;
// asserting on it directly, plus a real loadAgentRows() run against a
// disposable fixture, covers the same code without touching real data.

import { unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';
import { buildRegisterIndex } from '../run-daily.mjs';
import * as coverageTracker from '../coverage-tracker.mjs';
import { registerCapped, loadAgentRows } from '../tailor-cv.mjs';
import { decideFit } from '../auto-tailor.mjs';
import { scoreRole, UNATTRIBUTED_CAP } from '../run-daily.mjs';

console.log('\nregister-verification-gate — a non-sponsor must be caught on every path');

const NON_SPONSOR = 'NotARealSponsor Consulting Ltd';
const MIN_SCORE = 4.0;
const registerIdx = buildRegisterIndex(coverageTracker.load());

// ── path 1: run-daily.mjs::scoreRole ────────────────────────────────────────
// The original fix. Kept here so all three live in one place and a future
// regression on any of them shows up in the same file.
{
  const cfg = { targets: ['project manager'], practices: [], excluded: [], excludedRegions: [], priorities: {}, adj: {} };
  const gate = { soc: { code: '2422', eligible: true }, remote: 'UK' };
  const sc = scoreRole({
    title: 'Project Manager', company: NON_SPONSOR,
    text: 'project manager, stakeholder governance, reporting, risk, programme',
    salary: null, location: 'London', sourceLists: null, cfg, gate, attributed: true,
    // registerVerified deliberately omitted — the real-world case for any
    // employer absent from coverage.csv.
  });
  pass(`scoreRole: score capped at ${UNATTRIBUTED_CAP} for an unverified employer (got ${sc.score})`);
  if (sc.score > UNATTRIBUTED_CAP) fail(`scoreRole: score ${sc.score} exceeds the cap`);
  if (sc.score >= MIN_SCORE) fail(`scoreRole: score ${sc.score} still clears the ${MIN_SCORE} send floor`);
  else pass(`scoreRole: score ${sc.score} falls below the ${MIN_SCORE} send floor`);
}

// ── path 2: tailor-cv.mjs (loadRows' own capping fn + loadAgentRows) ────────
{
  const raw = 4.5; // what the row would have scored uncapped
  const capped = registerCapped(raw, NON_SPONSOR, registerIdx);
  if (capped.registerVerified) fail('tailor-cv.mjs registerCapped: unverified employer reported as verified');
  else pass('tailor-cv.mjs registerCapped: unverified employer correctly reported as NOT verified');
  if (capped.score > UNATTRIBUTED_CAP) fail(`tailor-cv.mjs registerCapped: score ${capped.score} exceeds the cap`);
  else pass(`tailor-cv.mjs registerCapped: score capped to ${capped.score}`);
  if (capped.score >= MIN_SCORE) fail(`tailor-cv.mjs registerCapped: score ${capped.score} still clears the ${MIN_SCORE} send floor`);
  else pass(`tailor-cv.mjs registerCapped: score ${capped.score} falls below the ${MIN_SCORE} send floor`);

  // loadAgentRows: real function, disposable fixture, cleaned up in finally
  // even if an assertion above already failed.
  const fixtureName = 'AGENT-SCAN-register-verification-gate-test.md';
  const fixturePath = join(ROOT, 'output', fixtureName);
  const fixtureMd = [
    '| Company | Role | Link | Notes |',
    '|---|---|---|---|',
    `| ${NON_SPONSOR} | PMO Project Manager | https://example.invalid/job/register-gate-test | fixture |`,
  ].join('\n');
  writeFileSync(fixturePath, fixtureMd, 'utf8');
  try {
    const rows = loadAgentRows(fixtureName, registerIdx, MIN_SCORE);
    if (rows.some((r) => r.company === NON_SPONSOR)) {
      fail(`tailor-cv.mjs loadAgentRows: unverified employer "${NON_SPONSOR}" survived the ${MIN_SCORE} floor`);
    } else {
      pass(`tailor-cv.mjs loadAgentRows: unverified employer "${NON_SPONSOR}" dropped below the ${MIN_SCORE} floor`);
    }
  } finally {
    try { unlinkSync(fixturePath); } catch { /* already gone */ }
  }
}

// ── path 3: auto-tailor.mjs::decideFit ──────────────────────────────────────
{
  const profile = { allSkills: ['stakeholder management', 'reporting', 'governance', 'risk', 'programme'] };
  const verdict = decideFit({
    role: 'PMO Project Manager',
    company: NON_SPONSOR,
    jd: 'PMO project manager, stakeholder governance, reporting, risk, programme, dashboard, forecast',
    profile, salary: '45000', jdOk: true, targetTitles: ['project manager', 'pmo'],
    registerIdx,
  });
  if (verdict.fit) fail(`auto-tailor.mjs decideFit: unverified employer "${NON_SPONSOR}" passed as fit`);
  else pass(`auto-tailor.mjs decideFit: unverified employer "${NON_SPONSOR}" rejected (${verdict.reason})`);

  // Control: the SAME role at a real, register-verified employer must still
  // pass. Without this, a test that only ever asserts rejection cannot tell
  // "the gate works" apart from "the gate rejects everything".
  const controlVerdict = decideFit({
    role: 'PMO Project Manager',
    company: 'AECOM LIMITED',
    jd: 'PMO project manager, stakeholder governance, reporting, risk, programme, dashboard, forecast',
    profile, salary: '45000', jdOk: true, targetTitles: ['project manager', 'pmo'],
    registerIdx,
  });
  if (!controlVerdict.fit) fail(`auto-tailor.mjs decideFit control: verified employer AECOM LIMITED was rejected (${controlVerdict.reason})`);
  else pass('auto-tailor.mjs decideFit control: verified employer AECOM LIMITED still passes');
}
