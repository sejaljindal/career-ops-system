import { readFileSync, appendFileSync } from 'fs';
import { fetchJdViaApi } from '../fetch-jd-api.mjs';

const [, , inputFile, outputFile] = process.argv;
const urls = readFileSync(inputFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const CONCURRENCY = 2;
const STAGGER_MS = 2000;
let idx = 0, ok = 0, fail = 0;

async function worker() {
  while (idx < urls.length) {
    const i = idx++;
    const url = urls[i];
    await new Promise((r) => setTimeout(r, STAGGER_MS));
    let result;
    try { result = await fetchJdViaApi(url); } catch (e) { result = { ok: false, reason: `exception: ${e.message}` }; }
    if (result.ok) ok++; else fail++;
    appendFileSync(outputFile, JSON.stringify({ url, ...result }) + '\n');
    if ((i + 1) % 20 === 0) console.log(`${i + 1}/${urls.length} (ok=${ok} fail=${fail})`);
  }
}
console.log(`Retrying ${urls.length} URLs, concurrency=${CONCURRENCY}, stagger=${STAGGER_MS}ms...`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`Done. ok=${ok} fail=${fail}`);
