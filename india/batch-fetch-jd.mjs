#!/usr/bin/env node
/**
 * batch-fetch-jd.mjs — paced bulk JD recovery for Workday SKIPs from a triage run.
 *
 * Reads a list of URLs (one per line) from argv[2], fetches each via
 * fetch-jd-api.mjs's fetchJdViaApi (zero-token, zero-browser), with limited
 * concurrency + a small stagger per request to avoid re-tripping Workday's
 * per-tenant rate limiting that caused 403s when many agents hit it in a burst.
 * Writes one JSON manifest line per URL to argv[3] (JSONL): {url, ok, text?, reason?}
 */
import { readFileSync, appendFileSync } from 'fs';
import { fetchJdViaApi } from './fetch-jd-api.mjs';

const [, , inputFile, outputFile] = process.argv;
if (!inputFile || !outputFile) {
  console.error('Usage: node batch-fetch-jd.mjs <urls.txt> <output.jsonl>');
  process.exit(1);
}

const urls = readFileSync(inputFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const CONCURRENCY = 4;
const STAGGER_MS = 250;

let idx = 0;
let okCount = 0;
let failCount = 0;

async function worker() {
  while (idx < urls.length) {
    const i = idx++;
    const url = urls[i];
    await new Promise((r) => setTimeout(r, STAGGER_MS));
    let result;
    try {
      result = await fetchJdViaApi(url);
    } catch (e) {
      result = { ok: false, reason: `exception: ${e.message}` };
    }
    if (result.ok) okCount++; else failCount++;
    appendFileSync(outputFile, JSON.stringify({ url, ...result }) + '\n');
    if ((i + 1) % 50 === 0) {
      console.log(`${i + 1}/${urls.length} processed (ok=${okCount} fail=${failCount})`);
    }
  }
}

console.log(`Fetching ${urls.length} URLs with concurrency=${CONCURRENCY}, stagger=${STAGGER_MS}ms...`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`Done. ok=${okCount} fail=${failCount} total=${urls.length}`);
