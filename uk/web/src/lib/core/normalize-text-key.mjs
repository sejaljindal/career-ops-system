// Client-safe MIRROR of normalizeTextKey in tracker-parse.mjs (#2666).
//
// A "use client" component (explorer-view.tsx) and a plain module like
// registry.ts cannot dynamically import the user's live checkout the way
// web/src/lib/core/text-key.ts does for server routes — so this file exists to
// be the ONE declared copy instead of a third private reimplementation.
// test-all.mjs's #2666 parity check runs this against the core's function on
// every push; if the core's rule changes, update this file to match — never
// let it drift back to an ASCII-only strip (`[^a-z0-9]`), which is what
// collapsed "Nestlé"→"nestl", "Škoda"→"koda" and emptied CJK names in the
// original bug.
//
// See tracker-parse.mjs's normalizeTextKey doc comment for why NFKC (not NFD)
// and why the combining-dot strip removes only the Turkish dotted-capital
// lowercasing artifact, never a typed diacritic (Żubr, Ėmė, Ġenerali, Škoda,
// Nestlé all stay distinct from their ASCII spellings).

/**
 * @param {unknown} value
 * @param {string} [separator]
 * @returns {string}
 */
export function normalizeTextKey(value, separator = "") {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/̇/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, separator)
    .trim();
}
