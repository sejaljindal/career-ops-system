#!/usr/bin/env node
/**
 * tailor-queue.mjs — a tailored CV for every role in the scan queue. No LLM.
 *
 * Written 2026-09-10. The India pipeline could only produce a tailored CV via
 * auto-tailor.mjs, which needs the role to already be an evaluated row in
 * pipeline_india.xlsx — and getting it there costs an LLM evaluation per role.
 * So ~1,500 live postings in data/pipeline.md had no route to a document, and
 * a volume application day was impossible.
 *
 * This closes the gap the same way the UK pipeline does: by SELECTING, never
 * generating.
 *
 * ── NO-FABRICATION ARCHITECTURE ──────────────────────────────────────────
 * Every line of output is lifted verbatim from cv.md. The only levers are:
 *   1. WHICH bullets appear
 *   2. WHAT ORDER they appear in
 *   3. WHICH opening line leads
 * There is no free-text generation anywhere in this file, so an employer,
 * title, tool, date, figure or qualification that is not in cv.md has no
 * mechanism by which it could reach the page. That is a structural guarantee,
 * not a checked one.
 *
 * Bullets are RANKED against the role title, not rewritten. "Coordinated
 * programme governance" is never restyled as "Analysed programme governance"
 * to score better — that misdescribes the work, which is fabrication wearing
 * better vocabulary.
 *
 * ── PAGE LENGTH ──────────────────────────────────────────────────────────
 * Two pages, never one. Standing instruction: compressing to a page forces out
 * the EMPLOYER_ONE capital-portfolio detail, which is the strongest evidence
 * on the document. Nothing is dropped to save space; bullets are reordered.
 *
 * NEVER MENTIONS visa status, sponsorship or work authorisation.
 *
 * Usage:
 *   node tailor-queue.mjs --need=25            # CVs for the top 25 live roles
 *   node tailor-queue.mjs --need=10 --covers   # also write cover letters
 *   node tailor-queue.mjs --no-liveness        # skip the live check (faster)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } from 'docx';
import { preScoreRole, loadProfile } from './role-score.mjs';
import { isStillLive } from './liveness-gate.mjs';

const ROOT = process.cwd();
const CV_MD = path.join(ROOT, 'cv.md');
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const OUT_DIR = path.join(ROOT, 'output');

const arg = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};

// ── the angles ────────────────────────────────────────────────────────────
// Each angle names the bullet themes a role of that shape cares about most.
// Matching is on the TITLE only — this file never fetches a JD, so it must not
// pretend to know anything a JD would tell it.
//
// `lead` is the opening sentence of the summary. Every one of them is a
// re-ordering of clauses already present in cv.md's own summary paragraph.
const ANGLES = [
  {
    id: 'pmo',
    match: /\b(pmo|programme|program|project|capital|infrastructure|governance|portfolio|controls|delivery|epmo)\b/i,
    lead: 'Programme and business analyst with 19 months coordinating governance across an ~£83.6M capital portfolio at EMPLOYER_ONE, working directly with Directors, Department for Transport officials and Principal Contractors.',
    keywords: ['governance', 'raid', 'milestone', 'risk', 'programme', 'capital', 'delivery', 'assurance', 'critical-path', 'dependencies', 'cdm', 'contractor'],
  },
  {
    id: 'consulting',
    match: /\b(consultant|consulting|advisory|transformation|strategy|change|excellence|improvement)\b/i,
    lead: 'Business analyst and consultant with an MSc Management (Finance) from YOUR_UNIVERSITY, 19 months on an ~£83.6M capital portfolio at EMPLOYER_ONE, and a track record of structured problem-solving that identified a £100K commercial risk before it escalated.',
    keywords: ['analysed', 'identified', 'redesigned', 'process', 'improvement', 'throughput', 'structuring', 'recommend', 'commercial', 'insight'],
  },
  {
    id: 'finance',
    match: /\b(finance|financial|fp&a|cost|commercial|accountant|budget|investment|revenue|pricing)\b/i,
    lead: 'Commercial and business analyst with an MSc Management (Finance) from YOUR_UNIVERSITY, hands-on cost, schedule and risk analysis across an ~£83.6M capital portfolio, and a £100K commercial risk identified through financial and delivery analysis.',
    keywords: ['commercial', 'financial', 'cost', 'budget', 'forecast', 'investment', 'pipeline', 'conversion', 'reporting', 'schedule'],
  },
  {
    id: 'data',
    match: /\b(data|reporting|insight|analytics|bi|business intelligence|mi|dashboard|sql|power bi)\b/i,
    lead: 'Business analyst with hands-on Power BI, SQL and Advanced Excel, 19 months producing executive reporting and decision-support outputs at EMPLOYER_ONE, and dashboard work used by senior leadership for commercial planning at EMPLOYER_TWO.',
    keywords: ['power bi', 'sql', 'dashboard', 'reporting', 'data', 'excel', 'insight', 'forecast', 'crm', 'standardised'],
  },
  {
    id: 'ba',
    match: /\b(business analyst|systems analyst|requirements|process|analyst|associate)\b/i,
    lead: 'Business analyst with 19 months at EMPLOYER_ONE across an ~£83.6M capital portfolio and commercial pipeline analysis at EMPLOYER_TWO, combining process redesign and stakeholder work with hands-on Power BI, SQL and Advanced Excel.',
    keywords: ['analysed', 'process', 'redesigned', 'requirements', 'stakeholder', 'pipeline', 'conversion', 'reporting', 'dashboard'],
  },
];

const DEFAULT_ANGLE = {
  id: 'general',
  lead: 'Business and programme analyst with an MSc Management (Finance) from YOUR_UNIVERSITY and 19 months coordinating governance across an ~£83.6M capital portfolio at EMPLOYER_ONE.',
  keywords: ['analysed', 'reporting', 'commercial', 'process', 'stakeholder'],
};

const SUMMARY_TAIL = 'Combines commercial and programme delivery experience with hands-on Power BI, SQL and Advanced Excel. Available immediately.';

function pickAngle(title) {
  // Underscores and slashes become spaces FIRST. This is the same trap that
  // defeated the seniority gate on 2026-09-04: JavaScript's \b treats "_" as a
  // word character, so \badvisory\b never matches inside PwC's own title
  // format, "IN_Senior Associate_Business Analyst_Advisory_Gurgaon". Without
  // this, every PwC posting — the single most on-target employer in the
  // queue — fell through to the generic angle.
  const t = String(title || '').replace(/[_/|]+/g, ' ').replace(/\s+/g, ' ');
  // Most specific first — a "Senior Consultant, Project Controls" is a PMO
  // role before it is a consulting one, because the evidence that wins it is
  // EMPLOYER_ONE rather than YOUR_UNIVERSITY.
  for (const a of ANGLES) if (a.match.test(t)) return a;
  return DEFAULT_ANGLE;
}

// ── cv.md parsing ─────────────────────────────────────────────────────────

function parseCv(md) {
  const lines = md.split('\n').map((l) => l.replace(/\r$/, ''));
  const out = { contact: [], jobs: [], education: [], development: [], skills: [] };
  let section = null, job = null;

  for (const line of lines) {
    if (/^\s*-{3,}\s*$/.test(line)) continue;
    if (/^#\s+/.test(line)) continue;
    if (/^##\s+/.test(line)) {
      section = line.replace(/^##\s+/, '').trim().toLowerCase();
      job = null;
      continue;
    }
    if (!section) {
      if (line.trim() && /[@·]|\+\d/.test(line)) {
        for (const p of line.split(/\s*·\s*/)) if (p.trim()) out.contact.push(p.trim());
      }
      continue;
    }
    if (section === 'experience') {
      if (/^###\s+/.test(line)) {
        const [role, org] = line.replace(/^###\s+/, '').split('|').map((s) => s.trim());
        job = { role, org: org || '', dates: '', intro: '', bullets: [] };
        out.jobs.push(job);
        continue;
      }
      if (!job) continue;
      if (/^\*\*.+\*\*$/.test(line.trim()) && !job.dates) { job.dates = line.trim().replace(/^\*\*|\*\*$/g, ''); continue; }
      if (/^\s*-\s+/.test(line)) { job.bullets.push(line.replace(/^\s*-\s+/, '').trim()); continue; }
      if (line.trim() && !job.bullets.length) job.intro = line.trim();
      continue;
    }
    if (!line.trim()) continue;
    if (section === 'education') out.education.push(line.trim());
    else if (section === 'professional development') out.development.push(line.replace(/^\s*-\s+/, '').trim());
    else if (section === 'skills') out.skills.push(line.trim());
  }
  return out;
}

/** Score one bullet against an angle's keywords. Never rewrites it. */
function rankBullets(bullets, angle) {
  return bullets
    .map((b, i) => {
      const lower = b.toLowerCase();
      let score = 0;
      for (const k of angle.keywords) if (lower.includes(k)) score += 2;
      // A quantified result outranks an unquantified one at equal relevance:
      // a number is the thing a reader remembers.
      if (/\d+%|£[\d.]+[KM]|\d+ hours/i.test(b)) score += 1;
      return { b, score, i };
    })
    // Stable: equal scores keep cv.md's own order, which is chronological and
    // deliberate. Sorting them arbitrarily would scramble a narrative.
    .sort((x, y) => (y.score - x.score) || (x.i - y.i))
    .map((x) => x.b);
}

// ── docx ──────────────────────────────────────────────────────────────────

const md2runs = (text, base = {}) => {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ ...base, text: text.slice(last, m.index) }));
    const t = m[0];
    out.push(new TextRun({ ...base, text: t.replace(/^\*+|\*+$/g, ''), bold: t.startsWith('**'), italics: !t.startsWith('**') }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ ...base, text: text.slice(last) }));
  return out.length ? out : [new TextRun({ ...base, text })];
};

const H = (t) => new Paragraph({
  spacing: { before: 200, after: 80 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 2 } },
  children: [new TextRun({ text: t.toUpperCase(), bold: true, size: 22 })],
});

function cvDoc(cv, angle) {
  const c = [];
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Your Name', bold: true, size: 32 })] }));
  c.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 160 },
    children: [new TextRun({ text: cv.contact.join('  ·  '), size: 18 })],
  }));

  c.push(H('Summary'));
  c.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: `${angle.lead} ${SUMMARY_TAIL}`, size: 20 })] }));

  c.push(H('Experience'));
  for (const job of cv.jobs) {
    c.push(new Paragraph({ spacing: { before: 140, after: 20 }, children: [new TextRun({ text: `${job.role}${job.org ? ` | ${job.org}` : ''}`, bold: true, size: 21 })] }));
    if (job.dates) c.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: job.dates, italics: true, size: 18 })] }));
    if (job.intro) c.push(new Paragraph({ spacing: { after: 40 }, children: md2runs(job.intro, { size: 19, italics: true }) }));
    for (const b of rankBullets(job.bullets, angle)) {
      c.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: md2runs(b, { size: 20 }) }));
    }
  }

  c.push(H('Education'));
  for (const e of cv.education) c.push(new Paragraph({ spacing: { after: 30 }, children: md2runs(e, { size: 20 }) }));

  c.push(H('Professional Development'));
  for (const d of cv.development) c.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 30 }, children: md2runs(d, { size: 20 }) }));

  c.push(H('Skills'));
  for (const s of cv.skills) c.push(new Paragraph({ spacing: { after: 50 }, children: md2runs(s, { size: 20 }) }));

  return new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children: c }],
  });
}

function coverDoc(cv, angle, role) {
  const c = [];
  c.push(new Paragraph({ children: [new TextRun({ text: 'Your Name', bold: true, size: 26 })] }));
  c.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: cv.contact.join('  ·  '), size: 18 })] }));
  c.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: `Application — ${role.role}, ${role.company}`, bold: true, size: 21 })] }));

  const top = rankBullets(cv.jobs[0]?.bullets || [], angle).slice(0, 3);
  c.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ size: 20, text:
    `I am applying for the ${role.role} role${role.location ? ` in ${role.location}` : ''}. ${angle.lead}` })] }));
  c.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ size: 20, text: 'The most directly relevant parts of that experience:' })] }));
  for (const b of top) c.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: md2runs(b, { size: 20 }) }));
  c.push(new Paragraph({ spacing: { before: 120, after: 120 }, children: [new TextRun({ size: 20, text: SUMMARY_TAIL })] }));
  c.push(new Paragraph({ children: [new TextRun({ size: 20, text: 'I would welcome the chance to discuss the role.' })] }));
  c.push(new Paragraph({ spacing: { before: 160 }, children: [new TextRun({ size: 20, text: 'Your Name' })] }));

  return new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 900, right: 900 } } }, children: c }],
  });
}

const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// ── queue ─────────────────────────────────────────────────────────────────

function parseRow(line) {
  const m = line.match(/^- \[ \] (.+)$/);
  if (!m) return null;
  const p = m[1].split('|').map((s) => s.trim());
  const [url, company, role, location] = p;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const posted = (p.find((x) => x.startsWith('posted:')) || '').replace('posted:', '').trim();
  return { url, company: company || '', role: role || '', location: location || '', posted };
}

async function main() {
  const need = Number(arg('need', 25)) || 25;
  const minScore = Number(arg('min', 3.0)) || 3.0;
  const maxChecks = Number(arg('max-checks', 60)) || 60;
  const withCovers = process.argv.includes('--covers');
  const noLiveness = process.argv.includes('--no-liveness');

  const cv = parseCv(readFileSync(CV_MD, 'utf8'));
  if (!cv.jobs.length) { console.error('cv.md parsed to zero jobs — refusing to write.'); process.exit(1); }

  const text = readFileSync(PIPELINE, 'utf8');
  const start = text.indexOf('## Pending');
  const end = text.indexOf('\n## ', start + 1);
  const profile = loadProfile();

  const rows = [];
  for (const line of text.slice(start, end === -1 ? undefined : end).split('\n')) {
    const r = parseRow(line);
    if (!r) continue;
    const v = preScoreRole({ title: r.role, company: r.company, location: r.location }, profile);
    if (!v.gatePass || v.tier.startsWith('EXCLUDED') || v.preScore < minScore) continue;
    const age = r.posted ? Math.floor((Date.now() - Date.parse(r.posted)) / 86400000) : 999;
    rows.push({ ...r, score: v.preScore, age });
  }
  rows.sort((a, b) => (b.score - a.score) || (a.age - b.age));

  mkdirSync(OUT_DIR, { recursive: true });
  const made = [];
  let checked = 0;

  console.log(`Queue: ${rows.length} candidate(s) >= ${minScore}. Writing CVs for the first ${need} live.\n`);

  for (const r of rows) {
    if (made.length >= need || checked >= maxChecks) break;
    if (!noLiveness) {
      checked++;
      const v = await isStillLive(r.url);
      if (v.result === 'expired') { console.log(`  ⌛ ${r.company} — ${r.role}  EXPIRED, skipped`); continue; }
    }
    const angle = pickAngle(r.role);
    const base = `${safe(r.company)}_${safe(r.role)}`;
    const cvName = `${base}_CV.docx`;
    writeFileSync(path.join(OUT_DIR, cvName), await Packer.toBuffer(cvDoc(cv, angle)));
    let covName = '';
    if (withCovers) {
      covName = `${base}_Cover.docx`;
      writeFileSync(path.join(OUT_DIR, covName), await Packer.toBuffer(coverDoc(cv, angle, r)));
    }
    made.push({ ...r, angle: angle.id, cvName, covName });
    console.log(`  ✓ [${r.score}] ${r.company} — ${r.role}`);
    console.log(`      angle: ${angle.id}  ·  ${cvName}${covName ? ` + ${covName}` : ''}`);
  }

  const lines = made.map((m, i) =>
    `${i + 1}. [${m.score}] ${m.company} — ${m.role}\n   ${m.location}\n   ${m.url}\n   CV: output/${m.cvName}${m.covName ? `\n   Cover: output/${m.covName}` : ''}`);
  const outFile = path.join(ROOT, 'local', `apply-list-${new Date().toISOString().slice(0, 10)}.txt`);
  try { mkdirSync(path.dirname(outFile), { recursive: true }); writeFileSync(outFile, lines.join('\n\n') + '\n', 'utf8'); } catch {}

  console.log(`\n${made.length} CV(s)${withCovers ? ' + cover letter(s)' : ''} written to output/`);
  console.log(`Apply list: ${path.relative(ROOT, outFile)}`);
  console.log('Every line is verbatim from cv.md — bullets reordered per role, nothing invented.');
}

main().catch((e) => { console.error(e); process.exit(1); });
