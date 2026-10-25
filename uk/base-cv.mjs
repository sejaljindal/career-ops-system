#!/usr/bin/env node
/**
 * base-cv.mjs — render cv.md into a clean, ATS-parseable DOCX.
 *
 * Written 2026-09-10 to close a gap that only became visible when it blocked a
 * real day's applications: there was no general-purpose CV anywhere. Every
 * document in output/ is tailored to one specific posting, and the only route
 * to a new one ran through auto-tailor.mjs, which needs the role to already be
 * a scored row in pipeline_india.xlsx. So for the ~1,500 postings sitting in
 * data/pipeline.md there was no CV that could be attached to anything, and
 * "just use your base CV" was advice that could not be followed.
 *
 * This is deliberately the SIMPLEST possible renderer:
 *   - it reads cv.md and nothing else
 *   - it SELECTS nothing, RANKS nothing and TAILORS nothing
 *   - every line of output comes verbatim from cv.md, so a claim that is not
 *     in that file cannot reach the page
 *
 * It is not a replacement for auto-tailor.mjs. For a role that genuinely
 * matters, tailor. This exists so that volume applications — the ones where a
 * portal parses the CV into form fields and no human reads the covering
 * letter — are possible at all.
 *
 * PAGE LENGTH: targets two pages and never compresses to one. That is a
 * standing instruction, not a default: a one-page CV forces the EMPLOYER_ONE
 * detail out, and that detail is the strongest thing on the document.
 *
 * NEVER MENTIONS visa status, sponsorship or work authorisation. Neither does
 * cv.md, and nothing is added here beyond what that file contains.
 *
 * Usage:
 *   node base-cv.mjs                     # -> output/FirstName-LastName_CV.docx
 *   node base-cv.mjs --out=path.docx
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, BorderStyle,
} from 'docx';

// Data Root, not the codebase root — cv.md/output/ are user-layer, so they
// must follow CAREER_OPS_ROOT/.career-ops-data (#drift-guard).
const ROOT = getCareerOpsRoot();
const CV_MD = path.join(ROOT, 'cv.md');
const OUT_DIR = path.join(ROOT, 'output');

const arg = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};

/**
 * Split cv.md into a header block and an ordered list of sections.
 *
 * cv.md's shape is stable and simple: an H1 title, a few bold "Label: value"
 * contact lines, then H2 sections, some with H3 sub-entries (one per job).
 * Parsing positionally rather than with a markdown library keeps this file
 * dependency-free and makes a malformed CV fail loudly rather than silently
 * dropping a section.
 */
function parseCv(md) {
  const lines = md.split('\n');
  const contact = [];
  const sections = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    // Horizontal rules are visual separators in the markdown, not content.
    // Without this they rendered as a literal "---" paragraph in the DOCX.
    if (/^\s*-{3,}\s*$/.test(line)) continue;
    if (/^#\s+/.test(line)) continue;                       // the "# Your Name" title
    if (/^##\s+/.test(line)) {
      current = { title: line.replace(/^##\s+/, '').trim(), blocks: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      // Header zone. The two repos write contact details differently and both
      // have to work, or the CV goes out with no way to reply to it:
      //   UK    "**Location:** Delhi NCR, India"   (one labelled line each)
      //   India "Delhi NCR, India · +91 ... · email · linkedin.com/..."
      // The India form was silently dropped by the label-only pattern, which
      // produced a CV with a name and no contact details at all.
      const labelled = line.match(/^\*\*(.+?):\*\*\s*(.+)$/);
      if (labelled) { contact.push(labelled[2].trim()); continue; }
      if (line.trim() && /[@·|]|\+\d/.test(line)) {
        for (const part of line.split(/\s*[·|]\s*/)) {
          const v = part.trim();
          if (v) contact.push(v);
        }
      }
      continue;
    }
    if (/^###\s+/.test(line)) {
      current.blocks.push({ type: 'sub', text: line.replace(/^###\s+/, '').trim() });
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      current.blocks.push({ type: 'bullet', text: line.replace(/^\s*-\s+/, '').trim() });
      continue;
    }
    if (line.trim()) current.blocks.push({ type: 'para', text: line.trim() });
  }
  return { contact, sections };
}

/** Markdown bold/italic to docx runs. Nothing else is interpreted. */
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ ...base, text: text.slice(last, m.index) }));
    const t = m[0];
    if (t.startsWith('**')) out.push(new TextRun({ ...base, text: t.slice(2, -2), bold: true }));
    else out.push(new TextRun({ ...base, text: t.slice(1, -1), italics: true }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ ...base, text: text.slice(last) }));
  return out.length ? out : [new TextRun({ ...base, text })];
}

function build({ contact, sections }, name) {
  const children = [];

  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: name, bold: true, size: 32 })],
  }));
  if (contact.length) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new TextRun({ text: contact.join('  ·  '), size: 18 })],
    }));
  }

  for (const s of sections) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 2 } },
      children: [new TextRun({ text: s.title.toUpperCase(), bold: true, size: 22 })],
    }));
    for (const b of s.blocks) {
      if (b.type === 'sub') {
        children.push(new Paragraph({
          spacing: { before: 120, after: 40 },
          children: runs(b.text, { bold: true, size: 21 }),
        }));
      } else if (b.type === 'bullet') {
        children.push(new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 40 },
          children: runs(b.text, { size: 20 }),
        }));
      } else {
        children.push(new Paragraph({
          spacing: { after: 60 },
          children: runs(b.text, { size: 20 }),
        }));
      }
    }
  }

  return new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [{
      properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
      children,
    }],
  });
}

async function main() {
  if (!existsSync(CV_MD)) {
    console.error('cv.md not found — nothing to render.');
    process.exit(1);
  }
  const md = readFileSync(CV_MD, 'utf8');
  const parsed = parseCv(md);
  if (!parsed.sections.length) {
    console.error('cv.md parsed to zero sections — refusing to write an empty CV.');
    process.exit(1);
  }

  const nameMatch = md.match(/^#\s+.*?[-–—]{1,2}\s*(.+)$/m);
  const name = (nameMatch ? nameMatch[1] : 'Your Name').trim();

  const out = arg('out', path.join(OUT_DIR, `${name.replace(/\s+/g, '-')}_CV.docx`));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, await Packer.toBuffer(build(parsed, name)));

  console.log(`Wrote ${path.relative(ROOT, out)}`);
  console.log(`  ${parsed.sections.length} section(s): ${parsed.sections.map((s) => s.title).join(' · ')}`);
  console.log('  Every line is verbatim from cv.md — nothing selected, ranked or invented.');
  console.log('  Attach this for volume applications; tailor properly for roles that matter.');
}

main().catch((e) => { console.error(e); process.exit(1); });
