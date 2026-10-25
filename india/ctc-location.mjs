/**
 * ctc-location.mjs — shared CTC-floor and location-priority classification.
 *
 * Extracted 2026-09-07 from export-excel.mjs so role-score.mjs (the new
 * in-process pre-scorer) and export-excel.mjs share one implementation
 * instead of two copies drifting apart. Behaviour is unchanged from the
 * export-excel.mjs originals — this is a pure move, not a rewrite.
 *
 * INDIA PIPELINE. No visa/sponsorship/SOC-code logic — CTC and location only.
 */

export const CTC_FLOOR_LPA = 8;

// ── CTC parsing ─────────────────────────────────────────────────────────

/**
 * Extract the lower-bound LPA figure from an advertised-comp string.
 * Handles "₹18-24 LPA", "18 LPA", "20 lakh" and similar. Returns null when
 * the string doesn't contain a recognisable LPA/lakh figure (e.g. raw rupee
 * amounts, non-INR currencies, or no figure at all) — callers must treat
 * null as "unparseable", not "zero".
 */
export function parseLpaFloor(advertisedComp) {
  if (!advertisedComp || typeof advertisedComp !== 'string') return null;
  const m = advertisedComp.match(/(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*(LPA|lakh)/i);
  if (!m) return null;
  return parseFloat(m[1]);
}

/**
 * Extract an LPA figure from a raw Indian-formatted rupee amount, e.g.
 * "₹18,00,000", "Rs. 18,00,000", "INR 1800000" -> 18. Indian digit grouping
 * (2-2-3 from the right) is irrelevant to parsing here — commas are simply
 * stripped before the numeric parse, so "18,00,000" and "1800000" resolve
 * identically. Only fires when parseLpaFloor() found no LPA/lakh unit AND
 * the string carries a rupee marker (₹/Rs/INR) or a bare 6-7 digit figure —
 * a bare number with no currency context is NOT assumed to be rupees.
 */
export function parseRupeeFloor(advertisedComp) {
  if (!advertisedComp || typeof advertisedComp !== 'string') return null;
  const hasRupeeMarker = /(?:₹|rs\.?|inr)\s*[\d,]/i.test(advertisedComp);
  if (!hasRupeeMarker) return null;
  const m = advertisedComp.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num) || num <= 0) return null;
  // A raw rupee figure below ~1000 is almost certainly a mis-parse (e.g. a
  // stray "Rs. 5" fragment), not a real annual CTC — treat as unparseable.
  return num >= 1000 ? num / 100000 : null;
}

/** Best-effort LPA lower bound from any advertised-comp phrasing we recognise. */
export function resolveLpaFloor(advertisedComp) {
  const lpa = parseLpaFloor(advertisedComp);
  if (lpa !== null) return lpa;
  return parseRupeeFloor(advertisedComp);
}

const UNDISCLOSED_RE = /\b(not\s+disclosed|undisclosed|confidential|competitive|as\s+per\s+(industry\s+)?(norms?|standards?))\b/i;

export function classifyCtcStatus(advertisedComp) {
  const floor = resolveLpaFloor(advertisedComp);
  if (floor !== null) {
    return floor >= CTC_FLOOR_LPA ? `Meets floor (≥${CTC_FLOOR_LPA} LPA)` : `Below floor (<${CTC_FLOOR_LPA} LPA)`;
  }
  if (advertisedComp && !UNDISCLOSED_RE.test(advertisedComp)) return 'Stated (non-INR — see CTC column)';
  return 'Unknown — ask early';
}

// Cell fill color for CTC Status: green at/above floor, red below, grey unknown.
export function ctcStatusFillColor(ctcStatus) {
  if (/^Meets floor/.test(ctcStatus)) return 'FFC6EFCE'; // green
  if (/^Below floor/.test(ctcStatus)) return 'FFFFC7CE'; // red
  return 'FFD9D9D9'; // grey — Unknown or stated-but-not-comparable
}

// ── Location priority ───────────────────────────────────────────────────

export const CITY_ALIASES = {
  'bengaluru': ['bangalore'],
  'delhi ncr': ['new delhi', 'delhi'],
  'gurugram': ['gurgaon'],
};

export function cityMatches(locLower, tierCity) {
  const cityLower = tierCity.toLowerCase();
  if (locLower.includes(cityLower)) return true;
  const aliases = CITY_ALIASES[cityLower] || [];
  return aliases.some(a => locLower.includes(a));
}

export function classifyLocationPriority(priorityTiers, location, remoteType) {
  if (!location && !remoteType) return '';
  if (remoteType === 'Remote') return 'Remote (Priority 1 equivalent)';
  const loc = (location || '').toLowerCase();
  for (const t of priorityTiers) {
    if ((t.locations || []).some(city => cityMatches(loc, city))) {
      return `Priority ${t.tier}`;
    }
  }
  return location ? 'Not in priority list' : '';
}
