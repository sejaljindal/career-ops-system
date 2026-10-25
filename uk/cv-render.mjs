#!/usr/bin/env node
/**
 * cv-render.mjs — parse cv.md and render it in the candidate's preferred layout.
 *
 * Written 2026-09-11. The previous renderer inside tailor-cv.mjs silently
 * discarded most of the CV: it understood a flat "Experience / Education /
 * Skills" shape and nothing else, so the Key Achievements pool, the three
 * grouped Skills blocks, the eleven certifications with their Core-skills
 * lines and the Extra-Curricular section were all parsed away. The generated
 * CVs looked thin because they WERE thin — roughly half the source never
 * reached the page.
 *
 * ── THE LAYOUT, AND WHY IT IS IN THIS ORDER ──────────────────────────────
 *   Professional Summary
 *   Skills                     (three named groups, bullet-separated)
 *   Key Achievements           (four, chosen for this JD)
 *   Experience                 (role | company left, dates right)
 *   Education and Qualifications
 *   Professional Development   (cert | provider + Core skills line)
 *   Extra-Curricular Activities and Interests
 *
 * Skills and Key Achievements sit ABOVE Experience on purpose: a recruiter
 * skimming the top third sees the capability grid and the four strongest
 * results before the chronology. That is the whole point of the layout and
 * it is why the order is not configurable here.
 *
 * ── WHAT TAILORING MAY TOUCH ─────────────────────────────────────────────
 * Only three things: the Summary, the ORDER of terms inside each Skills
 * group, and WHICH four Key Achievements are surfaced. Every other line
 * renders exactly as written in cv.md. Nothing is reworded.
 *
 * Key Achievements are a re-surfacing of lines that also appear verbatim in
 * Experience — never a second, differently-worded set of claims.
 */

import { readFileSync } from 'fs';
import {
  Document, Paragraph, TextRun, AlignmentType, BorderStyle, TabStopType, TabStopPosition, ShadingType,
  ExternalHyperlink,
} from 'docx';

// ── parse ────────────────────────────────────────────────────────────────

/**
 * cv.md is a small, fixed grammar rather than general markdown:
 *   **Label:** value        contact block, before the first H2
 *   ## Section              a section
 *   ### Heading             an entry within a section (job, degree, cert,
 *                           or a Skills group name)
 *   plain line after ###    the entry's date/period line
 *   - bullet                a bullet within the current entry or section
 *   other text              a body line (Skills terms, Core skills, modules)
 */
export function parseCv(md) {
  const lines = md.split('\n').map((l) => l.replace(/\r$/, ''));
  const cv = { contact: {}, sections: [] };
  let section = null, entry = null, inComment = false;

  for (const raw of lines) {
    const line = raw.trim();

    // HTML comments in cv.md are editorial notes to a human, never content —
    // with one exception. A `<!-- conditional: kw kw kw -->` marker on an entry
    // says "include this only when the job description warrants it". the candidate's
    // Mitie facilities role and her Salesforce/HubSpot certificates are real,
    // but belong on a CV only for roles that touch operations or sales; on a
    // business-analyst CV they dilute rather than add.
    if (line.startsWith('<!--')) {
      const cond = line.match(/<!--\s*conditional:\s*(.+?)\s*-->/i);
      if (cond && entry) entry.conditional = cond[1].split(/\s+/).filter(Boolean);
      inComment = !line.includes('-->');
      continue;
    }
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }

    if (!line || /^-{3,}$/.test(line)) continue;
    if (/^#\s+/.test(line)) continue;                      // the document title

    if (/^##\s+/.test(line)) {
      section = { title: line.replace(/^##\s+/, '').trim(), entries: [], bullets: [], body: [] };
      cv.sections.push(section);
      entry = null;
      continue;
    }

    if (!section) {
      const m = line.match(/^\*\*(.+?):\*\*\s*(.+)$/);
      if (m) cv.contact[m[1].trim().toLowerCase()] = m[2].trim();
      continue;
    }

    if (/^###\s+/.test(line)) {
      entry = { heading: line.replace(/^###\s+/, '').trim(), date: '', body: [], bullets: [], conditional: null };
      section.entries.push(entry);
      continue;
    }

    if (/^[-•]\s+/.test(line)) {
      const text = line.replace(/^[-•]\s+/, '').trim();
      (entry ? entry.bullets : section.bullets).push(text);
      continue;
    }

    // First plain line directly under a ### is that entry's date/period.
    if (entry && !entry.date && !entry.body.length && !entry.bullets.length
      && /\d{4}|ongoing|completed|present/i.test(line) && line.length < 60) {
      entry.date = line;
      continue;
    }

    (entry ? entry.body : section.body).push(line);
  }
  return cv;
}

const findSection = (cv, re) => cv.sections.find((s) => re.test(s.title));
const strip = (s) => String(s)
  .replace(/\*\*/g, '').replace(/(^|\s)\*(\S)/g, '$1$2').replace(/\*$/, '')
  // FIXED 2026-09-24: no em dashes anywhere in a generated CV, full stop.
  // Job titles pulled verbatim off an employer's site ("Project Consultant —
  // Business Consulting") and the bullet-variant bank both used them. A
  // surrounded em dash becomes " - "; a bare one (rare, mid-word) just
  // becomes "-" so nothing is left doubled up or orphaned.
  .replace(/\s*—\s*/g, ' - ')
  .replace(/—/g, '-');

// ── building blocks ──────────────────────────────────────────────────────

const FONT = 'Times New Roman';
const RIGHT_TAB = [{ type: TabStopType.RIGHT, position: 10458 }];

const sectionHeading = (text) => new Paragraph({
  spacing: { before: 220, after: 90 },
  shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'D9D9D9' },
  children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 21, color: '1F497D' })],
});

/** "Role | Company" on the left, dates hard-right on the same line. */
const headingWithDate = (left, right) => new Paragraph({
  tabStops: RIGHT_TAB,
  spacing: { before: 140, after: 20 },
  children: [
    new TextRun({ text: strip(left), bold: true, size: 21, color: '002060' }),
    ...(right ? [new TextRun({ text: `\t${strip(right)}`, bold: true, size: 21, color: '002060' })] : []),
  ],
});

const bullet = (text) => new Paragraph({
  bullet: { level: 0 },
  alignment: AlignmentType.JUSTIFIED,
  spacing: { after: 40 },
  children: [new TextRun({ text: strip(text), size: 21 })],
});

const body = (text, opts = {}) => new Paragraph({
  alignment: AlignmentType.JUSTIFIED,
  spacing: { after: opts.after ?? 50 },
  indent: opts.indent ? { left: 280 } : undefined,
  children: [new TextRun({ text: strip(text), size: opts.size ?? 21, italics: !!opts.italics })],
});

// ── render ───────────────────────────────────────────────────────────────

/**
 * @param {object} cv          parsed cv.md
 * @param {object} [tailor]    { summary, skillOrder, achievements, headline, extraCredentials }
 */
export function renderCv(cv, tailor = {}) {
  const c = [];

  // Header
  c.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 40 },
    children: [new TextRun({ text: 'Your Name', bold: true, size: 28 })],
  }));
  if (tailor.headline) {
    c.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 40 },
      children: [new TextRun({ text: strip(tailor.headline), bold: true, size: 21, color: '002060' })],
    }));
  }
  // Location and phone are plain text; email and LinkedIn are real
  // hyperlinks (mailto: / https:), same as the candidate's own reference CVs.
  const contactRuns = [];
  const pushSep = () => { if (contactRuns.length) contactRuns.push(new TextRun({ text: ' | ', size: 22 })); };
  if (cv.contact.location) { pushSep(); contactRuns.push(new TextRun({ text: cv.contact.location, size: 22 })); }
  if (cv.contact.phone) { pushSep(); contactRuns.push(new TextRun({ text: cv.contact.phone, size: 22 })); }
  if (cv.contact.email) {
    pushSep();
    contactRuns.push(new ExternalHyperlink({
      link: `mailto:${cv.contact.email}`,
      children: [new TextRun({ text: cv.contact.email, size: 22, style: 'Hyperlink' })],
    }));
  }
  if (cv.contact.linkedin) {
    pushSep();
    const url = cv.contact.linkedin.startsWith('http') ? cv.contact.linkedin : `https://${cv.contact.linkedin}`;
    contactRuns.push(new ExternalHyperlink({
      link: url,
      children: [new TextRun({ text: cv.contact.linkedin, size: 22, style: 'Hyperlink' })],
    }));
  }
  c.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 120 },
    children: contactRuns,
  }));

  // Professional Summary — tailored if supplied, else as written.
  const sum = findSection(cv, /summary/i);
  if (sum) {
    c.push(sectionHeading('Professional Summary'));
    c.push(body(tailor.summary || sum.body.join(' '), { after: 60 }));
  }

  // Skills — three named groups.
  //
  // `tailor.skills` supplies a fully SELECTED list per group, not a reordering
  // of cv.md's own 29 terms. That distinction is the point: the verified pool
  // is 116 terms (cv.md's Skills section plus every certification's Core-skills
  // line), and the JD decides which of them appear. Reordering a fixed 29 left
  // "Market & Competitive Analysis" on a CV for a role that never mentions
  // markets, while omitting the terms the JD actually used.
  const skills = findSection(cv, /^skills$/i);
  if (skills) {
    const groups = tailor.skills
      || skills.entries.map((g) => ({
        heading: g.heading,
        terms: g.body.join(' ').split('•').map((t) => t.trim()).filter(Boolean),
      }));
    if (groups.length) {
      c.push(sectionHeading('Skills'));
      for (const g of groups) {
        c.push(new Paragraph({
          spacing: { before: 70, after: 20 },
          children: [new TextRun({ text: strip(g.heading), bold: true, size: 20 })],
        }));
        c.push(body(g.terms.join(' • '), { after: 40 }));
      }
    }
  }

  // Key Achievements — four, JD-weighted.
  const ka = findSection(cv, /key achievements/i);
  if (ka && ka.bullets.length) {
    const picked = tailor.achievements ? tailor.achievements(ka.bullets) : ka.bullets.slice(0, 4);
    if (picked.length) {
      c.push(sectionHeading('Key Achievements'));
      for (const b of picked) c.push(bullet(b));
    }
  }

  // Experience
  const exp = findSection(cv, /experience/i);
  if (exp) {
    c.push(sectionHeading('Experience'));
    for (const job of exp.entries) {
      // A role dropped by the page-fit ladder is omitted entirely.
      if (tailor.jobFilter && !tailor.jobFilter(job.heading)) continue;
      c.push(headingWithDate(job.heading, job.date));
      const ordered = tailor.bulletOrder ? tailor.bulletOrder(job.heading, job.bullets) : job.bullets;
      for (const b of ordered) c.push(bullet(b));
    }
  }

  // Education
  const edu = findSection(cv, /education/i);
  if (edu) {
    c.push(sectionHeading('Education and Qualifications'));
    for (const e of edu.entries) {
      c.push(headingWithDate(e.heading, e.date));
      if (tailor.educationDetail !== false) {
        for (const line of e.body) c.push(body(line, { after: 25 }));
      }
    }
  }

  // Professional Development — cert + its Core skills line.
  const pd = findSection(cv, /professional development/i);
  if (pd) {
    // Only the certificates this role justifies. Listing all eleven — ten of
    // them "Ongoing, 2026" — reads as scattered rather than capable.
    const certs = tailor.certificates ? tailor.certificates(pd.entries) : pd.entries;
    c.push(sectionHeading('Professional Development'));
    for (const cert of certs) {
      c.push(headingWithDate(cert.heading, cert.date));
      // The Core-skills line is the first thing dropped when space is tight —
      // the certificate name still lands without it.
      if (false && tailor.certDetail !== false) {
        for (const line of cert.body) c.push(body(line, { after: 25, indent: true }));
      }
    }
    for (const extra of tailor.extraCredentials || []) c.push(bullet(extra));
  }

  // Extra-Curricular
  const ec = findSection(cv, /extra[- ]curricular/i);
  const ecBullets = tailor.extraCurricular ?? ec?.bullets ?? [];
  if (ecBullets.length) {
    c.push(sectionHeading('Extra-Curricular Activities and Interests'));
    for (const b of ecBullets) c.push(bullet(b));
  }

  return new Document({
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [{
      properties: { page: { margin: { top: 640, bottom: 640, left: 720, right: 720 } } },
      children: c,
    }],
  });
}

export function loadCv(file) { return parseCv(readFileSync(file, 'utf8')); }
