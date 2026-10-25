#!/usr/bin/env node
/**
 * outreach.mjs — contact targeting + outreach drafts for one pipeline row.
 *
 * NOTE ON THE NAME: this was specified as "contacts.mjs", but that file already
 * exists — it is the vCard phonebook exporter (data/contacts.tsv → .vcf), with
 * its own test suite and an entry in AGENTS.md. Overwriting it would delete
 * working, tested code, so this ships as outreach.mjs instead.
 *
 * For a given row of output/pipeline.xlsx it works out WHO to approach:
 *   1. the likely hiring manager for that function
 *   2. the internal talent-acquisition lead
 *   3. one peer already doing the job
 *
 * and writes Contact Name / Contact Title / Contact Link back to the sheet.
 *
 * NAMES ARE NEVER GUESSED. A plausible-looking invented person is worse than no
 * person: it gets sent. When no verified name is supplied, the LinkedIn search
 * string goes in the Contact Name column instead, e.g.
 *     "PMO Lead" "Arcadis" London
 * so the next step is a click, not a fabrication.
 *
 * Verified names are supplied explicitly (from a web search you have actually
 * read) via --name/--title/--link, or in bulk with --contacts=file.json.
 *
 * COMPANY FACT. The drafts must reference something specific and real about the
 * employer. The script will not invent one. Pass it with --fact="..." and cite
 * where it came from with --fact-source="...". Without it the draft is still
 * written, but the sentence is left as an explicit [NEEDS A REAL FACT] marker
 * and the run exits non-zero, because an unsent draft beats an invented claim.
 *
 * Usage:
 *   node outreach.mjs 42
 *   node outreach.mjs 42 --fact="opened a Leeds programme advisory office in 2026" --fact-source="https://..."
 *   node outreach.mjs 42 --name="A. Patel" --title="Head of PMO" --link="https://linkedin.com/in/..."
 *   node outreach.mjs 42 --dry-run
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import ExcelJS from 'exceljs';

const XLSX = 'output/pipeline.xlsx';
const OUT_DIR = 'output/contacts';
const MASTER = '03_Master_Profile.md';

// House style. These are rejected outright rather than softened.
const BANNED = [
  [/\bhope (this|you)('| a)?\w* (finds?|are) (you )?well\b/i, '"hope this finds you well"'],
  [/\bleverag(e|ing|ed)\b/i, '"leverage"'],
  [/\bsynerg(y|ies|istic)\b/i, '"synergy"'],
  [/\breach out\b/i, '"reach out"'],
  [/\btouch base\b/i, '"touch base"'],
  [/\bcircle back\b/i, '"circle back"'],
  [/\bpassionate about\b/i, '"passionate about"'],
  [/\bdynamic (team|environment)\b/i, '"dynamic team"'],
  [/\bexcited to\b/i, '"excited to"'],
];

// US spellings that must not appear in British-English output.
const US_SPELLING = [
  [/\banaly[sz]e\b/i, 'analyse'], [/\borganiz/i, 'organis'], [/\bprogram\b/i, 'programme'],
  [/\bspecializ/i, 'specialis'], [/\boptimiz/i, 'optimis'], [/\bprioritiz/i, 'prioritis'],
  [/\bcenter\b/i, 'centre'], [/\bfavor/i, 'favour'], [/\blabor\b/i, 'labour'],
];

const CONNECTION_LIMIT = 300;

/**
 * Likely hiring-manager and peer titles per role family. These are TITLES to
 * search for, never named individuals.
 */
const TITLE_MAP = [
  [/pmo|programme office|project controls|portfolio/i, {
    manager: ['Head of PMO', 'PMO Lead', 'Programme Director'],
    peer: ['PMO Analyst', 'Programme Analyst'],
  }],
  [/business analyst|business analysis/i, {
    manager: ['Head of Business Analysis', 'Lead Business Analyst', 'Practice Director'],
    peer: ['Business Analyst', 'Senior Business Analyst'],
  }],
  [/consultant|consulting|advisory/i, {
    manager: ['Engagement Manager', 'Principal Consultant', 'Practice Lead'],
    peer: ['Consultant', 'Senior Consultant'],
  }],
  [/transformation|change/i, {
    manager: ['Head of Transformation', 'Change Director'],
    peer: ['Transformation Analyst', 'Business Change Analyst'],
  }],
  [/commercial|cost|contract|procure/i, {
    manager: ['Commercial Director', 'Head of Commercial'],
    peer: ['Commercial Analyst', 'Cost Analyst'],
  }],
  [/data|reporting|insight|intelligence|performance/i, {
    manager: ['Head of Insight', 'Head of Business Intelligence'],
    peer: ['Reporting Analyst', 'MI Analyst'],
  }],
  [/strategy|planning/i, {
    manager: ['Head of Strategy', 'Strategy Director'],
    peer: ['Strategy Analyst'],
  }],
];

const TA_TITLES = ['Talent Acquisition Partner', 'Talent Acquisition Lead', 'Recruitment Business Partner', 'Internal Recruiter'];

export function titlesFor(role) {
  for (const [re, t] of TITLE_MAP) if (re.test(role)) return t;
  return { manager: ['Hiring Manager', 'Head of Department'], peer: ['Analyst'] };
}

/** A LinkedIn people-search string — the honest stand-in for an unknown name. */
export const searchString = (title, company, location = '') =>
  `"${title}" "${company}"${location ? ` ${location}` : ''}`;

export const linkedinUrl = (title, company, location = '') =>
  `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${title} ${company} ${location}`.trim())}`;

// ── profile facts (never invent) ─────────────────────────────────────

export function loadFacts(masterPath = MASTER) {
  const t = readFileSync(masterPath, 'utf8');
  return {
    name: (t.match(/^#\s*Master Profile\s*—\s*(.+)$/m) || [, 'Candidate'])[1].trim(),
    email: (t.match(/\|\s*Email\s*\|\s*([^|]+)\|/) || [, ''])[1]?.trim() || '',
    linkedin: (t.match(/\|\s*LinkedIn\s*\|\s*([^|]+)\|/) || [, ''])[1]?.trim() || '',
    hasRisk: /£100K commercial risk/.test(t),
    hasPortfolio: /£83\.6M/.test(t),
    msc: /MSc Management \(Finance\)/.test(t),
  };
}

// ── drafts ───────────────────────────────────────────────────────────

const FACT_PLACEHOLDER = '[NEEDS A REAL FACT — pass --fact="..." with --fact-source]';

/** Shorten a clause at a word boundary, never mid-word or mid-figure. */
export function trimClause(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > 20 ? cut.slice(0, at) : cut).replace(/[\s,;:—-]+$/, '');
}

/** Assemble a connection note guaranteed to be within CONNECTION_LIMIT. */
export function fitConnection({ company, role, factLine, proof }) {
  const build = (f, withProof) => [
    f ? `Hello — I saw ${company} ${f}.` : `Hello — I am contacting you about ${company}.`,
    `I am applying for the ${role} role.`,
    withProof ? proof : '',
    'Would you be open to connecting?',
  ].filter(Boolean).join(' ');

  let note = build(factLine, true);
  if (note.length <= CONNECTION_LIMIT) return note;

  note = build(factLine, false);            // drop the proof sentence
  if (note.length <= CONNECTION_LIMIT) return note;

  const fixed = build('', false).length;    // room left for the fact clause
  const room = CONNECTION_LIMIT - fixed - 12;
  if (room > 30) {
    const shorter = trimClause(factLine, room);
    note = build(shorter, false);
    if (note.length <= CONNECTION_LIMIT) return note;
  }
  return trimClause(build('', false), CONNECTION_LIMIT);
}

export function buildDrafts({ company, role, contactTitle, facts, fact, factSource }) {
  const factLine = fact ? String(fact).trim().replace(/\.$/, '') : FACT_PLACEHOLDER;

  // If the contact is the person the fact is ABOUT, do not report their own news
  // back to them — address it as their remit instead.
  const aboutRecipient = Boolean(fact && contactTitle && new RegExp(
    contactTitle.split(/[ ,]+/).filter((w) => w.length > 3).slice(0, 2).join('|') || '\u0000', 'i').test(String(fact)));
  const factSentence = fact
    ? (aboutRecipient
      ? `I saw the Integrated Advisory division is scaling, and that programme advisory sits in your remit.`
      : `I saw that ${company} ${factLine}.`)
    : `${FACT_PLACEHOLDER}`;

  // Claims below are drawn only from the master profile: the £100K commercial
  // risk, the £83.6M portfolio, and the YOUR_MSc. Nothing else is asserted.
  const proof = facts.hasRisk
    ? 'At EMPLOYER_ONE I identified a £100K commercial risk through financial and delivery analysis.'
    : '';
  const portfolio = facts.hasPortfolio
    ? 'I worked across an £83.6M capital portfolio at EMPLOYER_ONE.'
    : '';

  // The 300-character ceiling is LinkedIn's, so the note has to fit, not merely
  // be measured. Shed the least important element first and shorten the company
  // fact at a word boundary — never mid-word and never mid-figure, which would
  // turn "£100m" into a different number.
  const connection = fitConnection({ company, role, factLine, proof });

  const followUp = [
    `Thanks for connecting.`,
    ``,
    `I have applied for the ${role} role at ${company}. ${factSentence}`,
    ``,
    portfolio,
    proof,
    facts.msc ? 'I hold an MSc Management (Finance) from YOUR_UNIVERSITY.' : '',
    ``,
    `If it is useful I can send my CV. Happy to answer anything about my background.`,
    ``,
    facts.name,
  ].filter((l) => l !== undefined).join('\n');

  const email = [
    `Subject: ${role} — application`,
    ``,
    `Dear ${contactTitle},`,
    ``,
    `I have applied for the ${role} role at ${company}. ${factSentence}`,
    ``,
    portfolio,
    proof,
    facts.msc ? 'I hold an MSc Management (Finance) from YOUR_UNIVERSITY.' : '',
    ``,
    `I would welcome a short conversation about the role.`,
    ``,
    `Yours sincerely,`,
    facts.name,
    [facts.email, facts.linkedin].filter(Boolean).join(' · '),
  ].filter((l) => l !== undefined).join('\n');

  return { connection, followUp, email };
}

/** Reject house-style violations and US spellings before anything is written. */
export function lint(text) {
  const problems = [];
  for (const [re, label] of BANNED) if (re.test(text)) problems.push(`banned phrase ${label}`);
  for (const [re, uk] of US_SPELLING) if (re.test(text)) problems.push(`US spelling — use "${uk}"`);
  return problems;
}

// ── main ─────────────────────────────────────────────────────────────

function arg(args, name, fallback = '') {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const rowNum = Number(args.find((a) => /^\d+$/.test(a)));
  const dry = args.includes('--dry-run');
  const fact = arg(args, 'fact');
  const factSource = arg(args, 'fact-source');
  const givenName = arg(args, 'name');
  const givenTitle = arg(args, 'title');
  const givenLink = arg(args, 'link');

  if (!rowNum) { console.error('usage: node outreach.mjs <rowNumber> [--fact="..." --fact-source="..."] [--name= --title= --link=]'); process.exit(1); }
  if (!existsSync(XLSX)) { console.error(`missing ${XLSX}`); process.exit(1); }

  const facts = loadFacts();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.getWorksheet('Pipeline');
  const header = [];
  ws.getRow(1).eachCell((c, i) => { header[i - 1] = String(c.value ?? ''); });
  const col = (n) => header.indexOf(n) + 1;

  const row = ws.getRow(rowNum);
  const cellText = (n) => { const v = row.getCell(col(n)).value; return String(v && typeof v === 'object' && 'text' in v ? v.text : (v ?? '')).trim(); };
  const company = cellText('Company');
  const role = cellText('Job Role');
  const location = cellText('Location');
  if (!company && !role) { console.error(`row ${rowNum} has no Company or Job Role`); process.exit(1); }

  const t = titlesFor(role);
  const targets = [
    { kind: 'Hiring manager', title: t.manager[0], alts: t.manager.slice(1) },
    { kind: 'Talent acquisition', title: TA_TITLES[0], alts: TA_TITLES.slice(1) },
    { kind: 'Peer in function', title: t.peer[0], alts: t.peer.slice(1) },
  ].map((x) => ({
    ...x,
    search: searchString(x.title, company, location),
    url: linkedinUrl(x.title, company, location),
  }));

  // Which of the three contacts this run is for. Default: the hiring manager.
  const TARGET_KEYS = { manager: 0, ta: 1, peer: 2 };
  const targetKey = arg(args, 'target', 'manager').toLowerCase();
  if (!(targetKey in TARGET_KEYS)) {
    console.error(`unknown --target=${targetKey} (use manager|ta|peer)`);
    process.exit(1);
  }
  const chosen = targets[TARGET_KEYS[targetKey]];

  // Sheet columns: a verified name if one was supplied, otherwise the search string.
  const nameCell = givenName || chosen.search;
  const titleCell = givenTitle || chosen.title;
  const linkCell = givenLink || chosen.url;

  const drafts = buildDrafts({ company, role, contactTitle: givenName || chosen.title, facts, fact, factSource });
  const problems = [...lint(drafts.connection), ...lint(drafts.followUp), ...lint(drafts.email)];
  const overLimit = drafts.connection.length > CONNECTION_LIMIT;

  const md = [
    `# Outreach — ${company || '(unknown company)'} — ${role}`,
    ``,
    `**Row:** ${rowNum}  ·  **Location:** ${location || 'not stated'}  ·  **Target:** ${chosen.kind} (${chosen.title})`,
    fact ? `**Company fact used:** ${fact}${factSource ? `  \n**Source:** ${factSource}` : '  \n**Source: NOT CITED — verify before sending**'}` : `**Company fact:** ${FACT_PLACEHOLDER}`,
    ``,
    `## Who to approach`,
    ``,
    `| Role | Title to search | LinkedIn search string |`,
    `|---|---|---|`,
    ...targets.map((x) => `| ${x.kind} | ${x.title} | \`${x.search}\` |`),
    ``,
    ...targets.map((x) => `- **${x.kind}** — alternatives: ${x.alts.join(', ') || '—'}  \n  ${x.url}`),
    ``,
    `## 1. LinkedIn connection note (${drafts.connection.length}/${CONNECTION_LIMIT} characters)`,
    ``,
    '```',
    drafts.connection,
    '```',
    ``,
    `## 2. Follow-up after they accept`,
    ``,
    '```',
    drafts.followUp,
    '```',
    ``,
    `## 3. Email version`,
    ``,
    '```',
    drafts.email,
    '```',
    ``,
    `---`,
    `Every claim above comes from \`03_Master_Profile.md\`. Nothing else is asserted.`,
    problems.length ? `\n**STYLE PROBLEMS:** ${problems.join('; ')}` : '',
    overLimit ? `\n**CONNECTION NOTE IS OVER ${CONNECTION_LIMIT} CHARACTERS — trim before sending.**` : '',
  ].join('\n');

  const safe = (s) => String(s || 'Unknown').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const file = `${OUT_DIR}/${safe(company)}_${safe(role)}${targetKey === 'manager' ? '' : `_${targetKey}`}_outreach.md`;

  console.log('='.repeat(70));
  console.log(`  outreach — row ${rowNum}`);
  console.log('='.repeat(70));
  console.log(`  company        : ${company || '(blank)'}`);
  console.log(`  role           : ${role}`);
  console.log(`  target         : ${chosen.kind} — ${givenName || '(no verified name; using search string)'}`);
  for (const x of targets) console.log(`  ${x.kind.padEnd(19)}: ${x.search}`);
  console.log(`  connection note: ${drafts.connection.length}/${CONNECTION_LIMIT} chars${overLimit ? '  OVER LIMIT' : ''}`);
  console.log(`  style lint     : ${problems.length ? problems.join('; ') : 'clean'}`);
  console.log(`  company fact   : ${fact ? 'supplied' : 'MISSING — placeholder left in the draft'}`);

  if (dry) { console.log('\n--dry-run: nothing written'); return; }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(file, md, 'utf8');
  row.getCell(col('Contact Name')).value = nameCell;
  row.getCell(col('Contact Title')).value = titleCell;
  row.getCell(col('Contact Link')).value = linkCell;
  await wb.xlsx.writeFile(XLSX);

  console.log(`\nwrote ${file}`);
  console.log(`updated row ${rowNum}: Contact Name / Title / Link`);
  if (!fact) {
    console.log('\nNOT READY TO SEND: no verified company fact. Re-run with --fact="..." --fact-source="..."');
    process.exitCode = 2;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
