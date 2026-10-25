#!/usr/bin/env node
/**
 * test-register-lookup.mjs — false-negative check for lookupRegister() before
 * it gates scoring. Picks known real sponsors already confirmed in this
 * session's coverage.csv, and tests common real-world name variants a job
 * board might actually print (Ltd/Limited, &/and, trading name vs legal
 * entity, abbreviated vs full) against the exact-signature lookup.
 */
import * as tracker from './coverage-tracker.mjs';
import { buildRegisterIndex, lookupRegister } from './run-daily.mjs';

const map = tracker.load();
const registerIdx = buildRegisterIndex(map);

// [exact register name, variant to actually test]
const CASES = [
  ['AECOM LIMITED', 'AECOM Ltd'],
  ['AECOM LIMITED', 'AECOM'],
  ['KPMG LLP', 'KPMG LLP'],
  ['KPMG LLP', 'KPMG'],
  ['PricewaterhouseCoopers LLP', 'PwC'],
  ['PricewaterhouseCoopers LLP', 'PricewaterhouseCoopers'],
  ['Ernst & Young', 'Ernst and Young'],
  ['Ernst & Young', 'EY'],
  ['Capgemini UK PLC', 'Capgemini UK Plc'],
  ['Capgemini UK PLC', 'Capgemini'],
  ['Arcadis Human Resources Limited', 'Arcadis'],
  ['Wipro Limited', 'Wipro Ltd'],
  ['Kier Group plc', 'Kier Group'],
  ['Turner & Townsend Ltd', 'Turner and Townsend'],
  ['Turner & Townsend Ltd', 'Turner & Townsend Limited'],
  ['Mott MacDonald Ltd', 'Mott MacDonald Limited'],
  ['Ove Arup and Partners International Ltd', 'Arup'],
  ['Siemens Mobility Limited', 'Siemens Mobility Ltd'],
  ['Bristol-Myers Squibb Pharmaceuticals Limited', 'Bristol-Myers Squibb'],
  ['DLA Piper UK LLP', 'DLA Piper'],
];

let ok = 0, fail = 0;
for (const [registered, variant] of CASES) {
  const hit = lookupRegister(variant, registerIdx);
  const pass = Boolean(hit);
  console.log(`${pass ? 'PASS' : 'FAIL'}  registered="${registered}"  tried="${variant}"  ->  ${hit ? 'MATCHED: ' + hit.org : 'NOT FOUND'}`);
  if (pass) ok++; else fail++;
}
console.log('='.repeat(78));
console.log(`${ok}/${CASES.length} matched, ${fail}/${CASES.length} false negatives (${((fail / CASES.length) * 100).toFixed(0)}%)`);
