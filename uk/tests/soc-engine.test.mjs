import {
  classifyRemote,
  daysUntilDeadline,
  inferSOC,
  loadRates,
  parseSalary,
  salaryVerdict,
  scoreLanguage,
} from '../soc-engine.mjs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { pass, fail } from './helpers.mjs';

console.log('\nsoc-engine.mjs — SOC classification and salary rules');

function ok(label, condition) {
  if (condition) pass(label);
  else fail(label);
}

const rates = loadRates();

// ── inferSOC ────────────────────────────────────────────────────────────────

const businessAnalyst = inferSOC('Business Analyst', 'Deliver commercial insight for the programme.');
ok('inferSOC maps Business Analyst to 2431', businessAnalyst.code === '2431');
ok('inferSOC marks 2431 eligible', businessAnalyst.eligible === true);
ok('inferSOC is high confidence on a title match', businessAnalyst.confidence === 'high');
ok('inferSOC reports no SOC risk on a clean title', businessAnalyst.socRisk === false);
ok('inferSOC returns the occupation title', businessAnalyst.title === 'Management consultants and business analysts');

const pmo = inferSOC('PMO Analyst', 'Maintain the project log and arrange governance meetings.');
ok('inferSOC maps PMO Analyst to 3543', pmo.code === '3543');
ok('inferSOC marks 3543 ineligible', pmo.eligible === false);

const itBa = inferSOC('IT Business Analyst', 'Systems design for a trading platform.');
ok('inferSOC prefers the longest covers phrase (IT Business Analyst -> 2133)', itBa.code === '2133');

const descriptionOnly = inferSOC('Analyst', 'You will act as a management consultant across client engagements.');
ok('inferSOC falls back to the description', descriptionOnly.code === '2431');
ok('inferSOC is medium confidence on a description-only match', descriptionOnly.confidence === 'medium');

const ambiguous = inferSOC('Business Analyst / Project Support Officer', 'Analysis plus project administration.');
ok('inferSOC returns the eligible code when both match', ambiguous.code === '2431');
ok('inferSOC flags socRisk when both match', ambiguous.socRisk === true);
ok('inferSOC drops to low confidence when both match', ambiguous.confidence === 'low');
ok('inferSOC names the competing ineligible code', ambiguous.competingCode === '3543');
ok('inferSOC still reports eligible:true when both match', ambiguous.eligible === true);

const noMatch = inferSOC('Underwater Welder', 'Offshore rig maintenance.');
ok('inferSOC returns null on no match', noMatch.code === null);
ok('inferSOC reports confidence none on no match', noMatch.confidence === 'none');
ok('inferSOC reports eligible null on no match', noMatch.eligible === null);

ok('inferSOC matches on word boundaries, not substrings', inferSOC('Data Analytics Lead', 'Nothing relevant.').code !== '3544');
ok('inferSOC tolerates missing description', inferSOC('Commercial Analyst').code === '2432');
ok('inferSOC tolerates empty input', inferSOC('', '').code === null);

// ── scoreLanguage ───────────────────────────────────────────────────────────

const analysisLed = scoreLanguage('You will analyse delivery data, advise senior stakeholders and recommend options. Produce a business case and options appraisal.');
ok('scoreLanguage counts analysis phrases', analysisLed.analysisScore > 0);
ok('scoreLanguage returns analysis-led when analysis dominates', analysisLed.verdict === 'analysis-led');
ok('scoreLanguage lists which analysis phrases matched', analysisLed.analysisMatches.includes('business case'));

const supportLed = scoreLanguage('You will support the team, coordinate meetings, maintain the tracker, collate reports and administer the diary.');
ok('scoreLanguage counts support phrases', supportLed.supportScore > 0);
ok('scoreLanguage returns support-led when support dominates', supportLed.verdict === 'support-led');

const tied = scoreLanguage('You will analyse the data and support the team.');
ok('scoreLanguage breaks ties toward support-led', tied.analysisScore === tied.supportScore && tied.verdict === 'support-led');

ok('scoreLanguage handles empty input', scoreLanguage('').analysisScore === 0 && scoreLanguage('').verdict === 'support-led');
const repeated = scoreLanguage('analysis analysis analysis');
ok('scoreLanguage counts repeated occurrences, not just presence', repeated.analysisScore === 3);

// ── salaryVerdict ───────────────────────────────────────────────────────────

ok('salaryVerdict rejects a below-RQF6 code outright', salaryVerdict('3543', 60000).status === 'INELIGIBLE');
ok('salaryVerdict gives the RQF6 reason', /below RQF6/.test(salaryVerdict('3543', 60000).reason));
ok('salaryVerdict rejects below-RQF6 even with no salary', salaryVerdict('3544', null).status === 'INELIGIBLE');

ok('salaryVerdict passes at the experienced floor', salaryVerdict('2431', 50200).status === 'PASS_ANY_TIME');
ok('salaryVerdict passes above the experienced floor', salaryVerdict('2431', 62000).status === 'PASS_ANY_TIME');
ok('salaryVerdict flags new-entrant-only below the experienced floor', salaryVerdict('2431', 40000).status === 'NEW_ENTRANT_ONLY');
ok('salaryVerdict returns the deadline on new-entrant-only', salaryVerdict('2431', 40000).deadline === '2027-02-22');
ok('salaryVerdict passes exactly at the new entrant floor', salaryVerdict('2431', 35140).status === 'NEW_ENTRANT_ONLY');
ok('salaryVerdict fails one pound below the new entrant floor', salaryVerdict('2431', 35139).status === 'FAIL');
ok('salaryVerdict fails well below the floor', salaryVerdict('2431', 28000).status === 'FAIL');

ok('salaryVerdict returns UNKNOWN with no salary', salaryVerdict('2431', null).status === 'UNKNOWN');
ok('salaryVerdict tells you to ask the recruiter', salaryVerdict('2431', null).action === 'ask recruiter early');
ok('salaryVerdict treats an empty string as no salary', salaryVerdict('2431', '').status === 'UNKNOWN');
ok('salaryVerdict returns UNKNOWN for an unrecognized code', salaryVerdict('9999', 50000).status === 'UNKNOWN');

ok('salaryVerdict parses formatted salaries', salaryVerdict('2431', '£50,200').status === 'PASS_ANY_TIME');
ok('parseSalary strips currency and separators', parseSalary('£42,500 per annum') === 42500);
ok('parseSalary returns null on unparseable text', parseSalary('competitive') === null);

ok('salaryVerdict surfaces the floors it used', salaryVerdict('2431', 40000).newEntrantFloor === 35140);
ok('2434 uses the general new entrant minimum', salaryVerdict('2434', 31000).status === 'NEW_ENTRANT_ONLY');
ok('2434 below the general minimum fails', salaryVerdict('2434', 30000).status === 'FAIL');

// ── classifyRemote ──────────────────────────────────────────────────────────

ok('classifyRemote detects global remote', classifyRemote('We hire globally — work from anywhere.') === 'GLOBAL');
ok('classifyRemote detects employer of record as global', classifyRemote('Engaged via an Employer of Record.') === 'GLOBAL');
ok('classifyRemote detects UK-only remote', classifyRemote('This is a UK remote role.') === 'UK_ONLY');
ok('classifyRemote detects other-country restriction', classifyRemote('US only. Must be based in Texas.') === 'OTHER_COUNTRY');
ok('classifyRemote falls back to onsite', classifyRemote('Five days per week in our London office.') === 'ONSITE');
ok('classifyRemote handles empty input', classifyRemote('') === 'ONSITE');
ok(
  'classifyRemote does not misread "must be based in the UK" as another country',
  classifyRemote('Remote, but you must reside in the UK.') === 'UK_ONLY',
);
ok('classifyRemote prefers global over a UK mention', classifyRemote('UK based team but you can work from anywhere.') === 'GLOBAL');

// ── daysUntilDeadline ───────────────────────────────────────────────────────

ok('daysUntilDeadline counts forward', daysUntilDeadline(new Date('2027-02-12T00:00:00Z')) === 10);
ok('daysUntilDeadline is zero on the deadline', daysUntilDeadline(new Date('2027-02-22T00:00:00Z')) === 0);
ok('daysUntilDeadline goes negative after the deadline', daysUntilDeadline(new Date('2027-03-01T00:00:00Z')) === -7);
ok('daysUntilDeadline ignores the time of day', daysUntilDeadline(new Date('2027-02-12T23:59:00Z')) === 10);
ok('daysUntilDeadline crosses a leap-free year boundary', daysUntilDeadline(new Date('2026-08-13T00:00:00Z')) === 193);
ok('daysUntilDeadline defaults to today', Number.isInteger(daysUntilDeadline()));
ok('daysUntilDeadline reads the deadline from soc_rates.json', rates._meta.new_entrant_deadline === '2027-02-22');

// ── CLI ─────────────────────────────────────────────────────────────────────

const cliPath = fileURLToPath(new URL('../soc-engine.mjs', import.meta.url));
try {
  execFileSync(process.execPath, [cliPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ok('CLI reports missing arguments cleanly', false);
} catch (error) {
  ok('CLI reports missing arguments cleanly', /Usage: node soc-engine.mjs/.test(error.stderr));
}

try {
  execFileSync(process.execPath, [cliPath, 'Business Analyst', 'does-not-exist-jd.txt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ok('CLI reports an unreadable JD cleanly', false);
} catch (error) {
  ok('CLI reports an unreadable JD cleanly', /Unable to read JD file/.test(error.stderr));
}

const cliOutput = JSON.parse(execFileSync(process.execPath, [cliPath, 'Business Analyst'], { encoding: 'utf8' }));
ok('CLI emits the inferred SOC code', cliOutput.soc.code === '2431');
ok('CLI emits a days-to-deadline countdown', Number.isInteger(cliOutput.daysUntilNewEntrantDeadline));
