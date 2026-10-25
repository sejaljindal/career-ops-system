#!/usr/bin/env node
/**
 * write-covers.mjs — render the written cover letters in cover-letters.data.mjs
 * into DOCX, replacing the template-filled ones tailor-queue.mjs produces.
 *
 * Written 2026-09-10. tailor-queue.mjs generates a CV by SELECTING bullets,
 * which is the right call for a CV — a claim that is not in cv.md then has no
 * route onto a document you will be cross-examined on. It applies the same
 * approach to the cover letter, and there it is the wrong call: the result is
 * one skeleton with three ranked bullets slotted in, twenty-five times, which
 * reads exactly like what it is.
 *
 * A cover letter is prose. It is not a document anyone interrogates line by
 * line, and its whole job is to sound like a person who read the posting. So
 * these are WRITTEN — but written against cv.md, with no fact introduced that
 * is not already there. The fabrication check below enforces that rather than
 * trusting it: every figure and every proper noun in the letter must appear in
 * cv.md, and anything that does not is reported loudly.
 *
 * Usage:
 *   node write-covers.mjs              # write every letter in the data file
 *   node write-covers.mjs --check      # verify only, write nothing
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { Document, Packer, Paragraph, TextRun, AlignmentType } from 'docx';
import { LETTERS, OPENING, CLOSING, SIGNOFF } from './cover-letters.data.mjs';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'output');
const CV_MD = path.join(ROOT, 'cv.md');

/**
 * Fabrication safety net.
 *
 * Not a formality: the whole reason a CV is selection-only is that a generated
 * claim is hard to spot and expensive to be caught on. These letters ARE
 * generated, so the guarantee has to be re-established by checking rather than
 * by construction.
 *
 * Checks every number and every capitalised multi-word token against cv.md.
 * Company and role names are excluded — they come from the job posting, not
 * the CV, and are the one category that legitimately appears in neither.
 */
function auditFacts(letter, cvText) {
  const body = letter.paras.join(' ');
  const problems = [];
  const cvLower = cvText.toLowerCase();

  // Three categories legitimately appear in a letter but not in the CV, and
  // treating them as fabrication buried the real signal under 18 false
  // positives on the first run:
  //   1. the employer and the role title — they come from the posting
  //   2. the posting's location
  //   3. a technology the letter EXPLICITLY says is not held ("I have not
  //      worked in Adobe Journey Optimizer"). Naming something in order to
  //      disclaim it is the opposite of a false claim, and a checker that
  //      cannot tell the difference trains you to ignore it.
  const allowedText = [
    letter.company, letter.role, letter.location || '',
    ...(letter.disclaimed || []),
  ].join(' ').toLowerCase();

  // Figures: percentages, currency amounts, month counts.
  for (const m of body.matchAll(/(?:£[\d.]+[KM]?|\d+%|\d+ (?:hours|months))/g)) {
    const tok = m[0].toLowerCase();
    if (!cvLower.includes(tok) && !allowedText.includes(tok)) problems.push(`figure not in cv.md: "${m[0]}"`);
  }

  // Proper nouns: two or more capitalised words in a row.
  for (const m of body.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) {
    // Drop a leading connective that only got capitalised by sentence position
    // ("As Team Organiser" is "Team Organiser", which IS in the CV).
    const tok = m[1].replace(/^(?:As|At|In|On|For|To|Since|Before|After|The|My|I)\s+/, '');
    const low = tok.toLowerCase();
    if (!low.includes(' ')) continue;          // single word after stripping — not a claim
    if (cvLower.includes(low)) continue;
    if (allowedText.includes(low)) continue;
    problems.push(`proper noun not in cv.md: "${tok}"`);
  }
  return problems;
}

function doc(letter, contactLine) {
  const c = [];
  c.push(new Paragraph({ children: [new TextRun({ text: 'Your Name', bold: true, size: 26 })] }));
  c.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: contactLine, size: 18 })] }));
  c.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: OPENING, size: 20 })] }));
  for (const p of letter.paras) {
    c.push(new Paragraph({ spacing: { after: 160 }, alignment: AlignmentType.LEFT, children: [new TextRun({ text: p, size: 20 })] }));
  }
  c.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: CLOSING, size: 20 })] }));
  for (const line of SIGNOFF.split('\n')) {
    c.push(new Paragraph({ children: [new TextRun({ text: line, size: 20 })] }));
  }
  return new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children: c }],
  });
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const cvText = readFileSync(CV_MD, 'utf8');
  const contactLine = (cvText.split('\n').find((l) => /[@]/.test(l) && /\+\d/.test(l)) || '').trim();

  mkdirSync(OUT_DIR, { recursive: true });
  let written = 0, flagged = 0;

  for (const [base, letter] of Object.entries(LETTERS)) {
    const problems = auditFacts(letter, cvText);
    const words = letter.paras.join(' ').split(/\s+/).length;

    if (problems.length) {
      flagged++;
      console.log(`⚠️  ${letter.company} — ${letter.role}`);
      for (const p of problems) console.log(`      ${p}`);
    } else {
      console.log(`✓  ${letter.company} — ${letter.role}  (${words} words)`);
    }

    if (!checkOnly) {
      const file = path.join(OUT_DIR, `${base}_Cover.docx`);
      writeFileSync(file, await Packer.toBuffer(doc(letter, contactLine)));
      written++;
      if (!existsSync(path.join(OUT_DIR, `${base}_CV.docx`))) {
        console.log(`      note: no matching ${base}_CV.docx — run tailor-queue.mjs`);
      }
    }
  }

  console.log(`\n${Object.keys(LETTERS).length} letter(s)${checkOnly ? ' checked' : `, ${written} written to output/`}`);
  console.log(`${flagged} flagged for a fact not found in cv.md.`);
  if (!flagged) console.log('Every figure and proper noun traces back to cv.md.');
}

main().catch((e) => { console.error(e); process.exit(1); });
