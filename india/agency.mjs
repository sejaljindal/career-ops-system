/**
 * agency.mjs — recruitment-agency detection for the INDIA pipeline.
 *
 * Ported from the UK pipeline's AGENCY_RE (run-daily.mjs) on 2026-09-05, with
 * an India-specific name list. This pipeline had NO agency detection at all
 * until then: india_targets.csv is curated and contains zero agencies, so the
 * gap was invisible — but `npm run paste` takes free-text Naukri/LinkedIn
 * listings, and Naukri is full of staffing firms. A posting from a staffing
 * firm needs recruiter framing, not hiring-manager framing.
 *
 * Contains NO visa, SOC, sponsorship or salary-floor logic — this is the India
 * pipeline.
 *
 * TWO ERRORS ARE POSSIBLE AND BOTH ARE REAL:
 *   1. Missing an agency  -> a cover letter addressed to a "hiring manager"
 *                            who is actually a recruiter.
 *   2. Flagging a direct employer as an agency -> recruiter framing sent to an
 *                            actual hiring manager. Equally damaging.
 * The list below is therefore deliberately conservative and was MEASURED, not
 * assumed, before adoption: 0 false positives across all 412 curated targets,
 * 0 against the Big 4 / strategy firms / GCCs, 21/21 on known Indian agencies.
 *
 * "consulting" and "consultancy" are deliberately ABSENT as generic markers.
 * The Big 4, MBB and every advisory firm are TARGETS here — matching on those
 * words would mislabel the highest-value employers in the pipeline as agencies.
 *
 * DELIBERATELY OMITTED — executive-search firms that are themselves targets:
 * Korn Ferry, Egon Zehnder, Heidrick & Struggles, Spencer Stuart, Amrop,
 * Stanton Chase. Korn Ferry India and Egon Zehnder India are both ON
 * india_targets.csv as employers she is targeting; flagging them would produce
 * error 2 above. The generic 'executive search' marker still catches firms that
 * describe themselves that way in their trading name.
 */
const AGENCY_RE = new RegExp('\\b(' + [
  // generic markers
  'recruit\\w*', 'resourcing', 'staffing', 'placements?', 'manpower',
  'executive search', 'headhunt\\w*', 'rpo\\b', 'search & selection',
  'talent solutions', 'talent group', 'talent partners', 'talent acquisition partners',
  'hr solutions', 'hr services', 'employment agency', 'job consultants?',
  // Indian staffing / recruitment trading names
  'abc consultants', 'teamlease', 'quess corp', 'ciel hr', 'careernet',
  'xpheno', 'crescendo global', 'antal', 'skillventory', 'huquo',
  'vahura', 'new era india', 'talentiser', 'talent corner',
  // global agencies with a large India presence
  'randstad', 'adecco', 'manpowergroup', 'michael page', 'page group',
  'hays', 'robert walters', 'robert half', 'sthree', 'allegis',
].join('|') + ')\\b', 'i');

export { AGENCY_RE };
export const isAgency = (company) => AGENCY_RE.test(String(company || ''));

/** Framing instruction to attach to a tailor bundle when isAgency() is true. */
export const AGENCY_FRAMING_NOTE =
  'This posting is from a RECRUITMENT AGENCY, not the hiring employer. Do not '
  + 'address the cover letter to a hiring manager or write as though the agency '
  + 'is the employer. Do not praise the agency\'s mission, products or culture — '
  + 'it has none relevant to this role. Address the recruiter, state the fit '
  + 'against the role, and do not name or assume an end client that the posting '
  + 'has not named.';
