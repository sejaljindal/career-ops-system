#!/usr/bin/env node
/**
 * queue-docs.mjs — make queue-shortlist roles applyable, now.
 *
 * Written 2026-09-10, mid-application-session. queue-shortlist.mjs produces a
 * ranked list of live postings straight from data/pipeline.md, but they carry
 * no documents: the tailoring path runs through pipeline_india.xlsx, and these
 * rows have never been evaluated into it. So a list of 25 real, live, on-target
 * roles could not actually be applied to.
 *
 * This closes that gap WITHOUT an LLM and WITHOUT inventing anything:
 *
 *   CV     — the base CV from base-cv.mjs. Identical for every role, because
 *            it is the honest document: nothing about it is role-specific and
 *            pretending otherwise would be theatre.
 *   COVER  — assembled per role from a fixed set of paragraphs, every one of
 *            which states a fact that appears in cv.md. What varies is WHICH
 *            paragraphs are chosen and in what order, driven by the role
 *            family detected from the title. Exactly the mechanism UK's
 *            auto-tailor.mjs uses, and for the same reason: selection cannot
 *            fabricate, generation can.
 *
 * WHAT IT DOES NOT DO: it has not read the job description. The letter speaks
 * to the role FAMILY, not to that employer's specific asks. For a role that
 * genuinely matters, use the full tailoring path instead.
 *
 * Usage:
 *   node queue-docs.mjs                # top 25 live from the queue
 *   node queue-docs.mjs --need=10
 *   node queue-docs.mjs --min=4.0
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { Document, Packer, Paragraph, TextRun, AlignmentType } from 'docx';
import { preScoreRole, loadProfile } from './role-score.mjs';
import { isStillLive } from './liveness-gate.mjs';

const ROOT = process.cwd();
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const OUT_DIR = path.join(ROOT, 'output', 'queue-ready');

const arg = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};

const CONTACT = 'Delhi NCR, India  ·  +91 +00 0000000000  ·  you@example.com  ·  linkedin.com/in/your-profile';

// ── Paragraph bank ────────────────────────────────────────────────────────
// Every sentence below states something that appears in cv.md. Nothing here
// is generated at run time, so no claim can drift from the source document.
// Keyed by theme so the role family can pick an order rather than compose text.
const P = {
  networkRail:
    'At EMPLOYER_ONE I coordinated programme governance across three named capital schemes totalling roughly £83.6M — the £64.9M PROJECT_ONE, the £10M PROJECT_TWO and the £8.7M PROJECT_THREE — working directly with Directors, Department for Transport officials, Train Operating Companies and Principal Contractors.',
  commercialRisk:
    'Through financial and delivery analysis I identified a £100K commercial risk, which enabled recovery planning to begin before it escalated across the wider programme.',
  governance:
    'I maintained programme governance through RAID reporting, milestone tracking, action management and CDM assurance support, and escalated critical-path design delays and dependencies so that delivery planning could account for them.',
  reporting:
    'For 19 months I produced executive reporting and decision-support outputs, translating detailed cost, schedule and risk data into insight that management could act on.',
  processRedesign:
    'I redesigned the SharePoint-based triage and reporting process, increasing team throughput by 20% while holding a 97% same-day response rate on executive requests.',
  analytics:
    'At EMPLOYER_TWO I analysed end-to-end commercial pipelines to find conversion bottlenecks, raising qualified lead volume by 30%, and ran hypothesis-led A/B testing that delivered a further 20% uplift in conversion.',
  bi:
    'I built the Power BI and Excel dashboards senior leadership used for commercial planning and investment decisions, and standardised CRM datasets in SQL and Excel — cutting manual reporting effort by 30% and improving forecast accuracy.',
  speed:
    'I also redesigned the lead-to-onboarding process, reducing response time from 48 hours to 4 hours.',
  education:
    'I hold an MSc in Management (Finance) from YOUR_UNIVERSITY, where my dissertation examined market efficiency in Indian equities after the 1991 reforms, and a BBA from Guru Gobind Singh Indraprastha University.',
  close:
    'I am available immediately and based in Delhi NCR. I would welcome the chance to discuss the role.',
};

/**
 * Detect the role family from the title, and return the paragraph order that
 * leads with the strongest evidence for it.
 *
 * Deliberately coarse — four families, keyword-matched. A finer taxonomy would
 * imply a precision this tool does not have, since it has not read the JD.
 */
function angleFor(title) {
  const t = String(title || '').toLowerCase();
  if (/(pmo|programme|program|project|capital|infrastructure|governance|portfolio|controls|delivery)/.test(t)) {
    return { name: 'programme & capital projects', order: ['networkRail', 'governance', 'commercialRisk', 'reporting', 'education'] };
  }
  if (/(consultant|consulting|advisory|transformation|strategy|change|improvement|excellence)/.test(t)) {
    return { name: 'consulting & transformation', order: ['networkRail', 'commercialRisk', 'processRedesign', 'analytics', 'education'] };
  }
  if (/(data|reporting|insight|bi\b|intelligence|analytics|mis|dashboard)/.test(t)) {
    return { name: 'reporting & analytics', order: ['bi', 'reporting', 'analytics', 'networkRail', 'education'] };
  }
  return { name: 'business analysis', order: ['analytics', 'bi', 'processRedesign', 'networkRail', 'education'] };
}

function coverDoc({ company, role, angle }) {
  const kids = [];
  kids.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Your Name', bold: true, size: 30 })] }));
  kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: CONTACT, size: 18 })] }));

  kids.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), size: 20 })] }));
  kids.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: `Application: ${role}`, bold: true, size: 22 })] }));
  kids.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: 'Dear Hiring Team,', size: 20 })] }));

  kids.push(new Paragraph({
    spacing: { after: 160 },
    children: [new TextRun({
      text: `I am writing to apply for the ${role} role at ${company}. I am a business and programme analyst with an MSc in Management (Finance) from YOUR_UNIVERSITY and 19 months at EMPLOYER_ONE coordinating governance across a capital portfolio of roughly £83.6M.`,
      size: 20,
    })],
  }));

  for (const key of angle.order) {
    kids.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: P[key], size: 20 })] }));
  }

  kids.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: P.close, size: 20 })] }));
  kids.push(new Paragraph({ children: [new TextRun({ text: 'Yours sincerely,', size: 20 })] }));
  kids.push(new Paragraph({ spacing: { before: 160 }, children: [new TextRun({ text: 'Your Name', bold: true, size: 20 })] }));

  return new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 900, right: 900 } } }, children: kids }],
  });
}

const safe = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function parseRow(line) {
  const m = line.match(/^- \[ \] (.+)$/);
  if (!m) return null;
  const parts = m[1].split('|').map((s) => s.trim());
  const [url, company, role, location] = parts;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const posted = (parts.find((p) => p.startsWith('posted:')) || '').replace('posted:', '').trim();
  return { url, company: company || '', role: role || '', location: location || '', posted };
}

async function main() {
  const need = Number(arg('need', 25)) || 25;
  const minScore = Number(arg('min', 4.0)) || 4.0;
  const maxChecks = Number(arg('max-checks', 60)) || 60;

  const text = readFileSync(PIPELINE, 'utf8');
  const start = text.indexOf('## Pending');
  const end = text.indexOf('\n## ', start + 1);
  const pending = text.slice(start, end === -1 ? undefined : end);

  const profile = loadProfile();
  const rows = [];
  for (const line of pending.split('\n')) {
    const r = parseRow(line);
    if (!r) continue;
    const v = preScoreRole({ title: r.role, company: r.company, location: r.location }, profile);
    if (!v.gatePass || v.tier.startsWith('EXCLUDED') || v.preScore < minScore) continue;
    const age = r.posted ? Math.floor((Date.now() - Date.parse(r.posted)) / 86_400_000) : null;
    rows.push({ ...r, score: v.preScore, age: Number.isFinite(age) ? age : null });
  }
  rows.sort((a, b) => (b.score - a.score) || ((a.age ?? 999) - (b.age ?? 999)));

  mkdirSync(OUT_DIR, { recursive: true });
  const baseCv = path.join(ROOT, 'output', 'FirstName-LastName_CV.docx');
  if (!existsSync(baseCv)) {
    console.error('Base CV missing. Run:  node base-cv.mjs');
    process.exit(1);
  }

  console.log('='.repeat(78));
  console.log(`  QUEUE DOCS — preparing up to ${need} live role(s) from ${rows.length} candidates`);
  console.log('='.repeat(78));

  const made = [];
  let checked = 0;
  for (const r of rows) {
    if (made.length >= need || checked >= maxChecks) break;
    checked++;
    const live = await isStillLive(r.url);
    if (live.result === 'expired') {
      console.log(`  ✗ ${r.company.slice(0, 24).padEnd(26)} EXPIRED — skipped`);
      continue;
    }
    const angle = angleFor(r.role);
    const file = path.join(OUT_DIR, `${safe(r.company)}_${safe(r.role)}_Cover.docx`);
    writeFileSync(file, await Packer.toBuffer(coverDoc({ company: r.company, role: r.role, angle })));
    made.push({ ...r, file, angle: angle.name });
    console.log(`  ✓ ${r.company.slice(0, 24).padEnd(26)} ${angle.name}`);
  }

  // A single index so the whole batch can be worked without opening this tool
  // again — company, role, link, and which two files to attach.
  const idx = made.map((m, i) => [
    `${i + 1}. [${m.score}] ${m.company} — ${m.role}`,
    `   ${m.location || 'location not stated'}${m.age != null ? `  ·  ${m.age}d old` : ''}  ·  angle: ${m.angle}`,
    `   APPLY : ${m.url}`,
    `   CV    : output\\FirstName-LastName_CV.docx`,
    `   COVER : ${path.relative(ROOT, m.file).replace(/\//g, '\\')}`,
  ].join('\n')).join('\n\n');

  const idxFile = path.join(OUT_DIR, '_APPLY-LIST.txt');
  writeFileSync(idxFile, idx + '\n', 'utf8');

  console.log('\n' + '='.repeat(78));
  console.log(`  ${made.length} role(s) READY. ${checked - made.length} skipped as expired.`);
  console.log(`  Cover letters : ${path.relative(ROOT, OUT_DIR)}\\`);
  console.log(`  CV (same one) : output\\FirstName-LastName_CV.docx`);
  console.log(`  Work list     : ${path.relative(ROOT, idxFile)}`);
  console.log('='.repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });
