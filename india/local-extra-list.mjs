// One-off: India roles that HAVE a tailored CV but are not in pipeline_india.xlsx,
// so ready-to-send.mjs cannot see them. Liveness-checked before listing.
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { isStillLive } from './liveness-gate.mjs';
const ROOT = process.cwd(), OUT = path.join(ROOT, 'output');
const safe = (s) => String(s||'').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60);
const have = new Set(readdirSync(OUT).filter(f=>f.endsWith('_CV.docx')));
const seen = new Set(); const rows = [];
for (const line of readFileSync(path.join(ROOT,'data','pipeline.md'),'utf8').split('\n')) {
  const m = line.match(/^- \[[ x]\] (\S+) \| ([^|]+) \| ([^|]+) \|/);
  if (!m) continue;
  const [,url,company,role] = m.map(s=>typeof s==='string'?s.trim():s);
  const f = `${safe(company)}_${safe(role)}_CV.docx`;
  if (!have.has(f) || seen.has(f)) continue;
  seen.add(f); rows.push({ url, company, role, f });
}
let n = 0;
for (const r of rows) {
  if (n >= 20) break;
  const v = await isStillLive(r.url);
  if (v.state === 'gone') continue;
  n++;
  console.log(`${n}. ${r.company} — ${r.role}`);
  console.log(`   ${r.url}`);
  console.log(`   CV : output/${r.f}`);
}
console.log(`\n${n} live with a tailored CV (of ${rows.length} candidates).`);
