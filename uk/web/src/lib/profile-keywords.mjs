// Client/web MIRROR of profileTargetKeywords in providers/_profile-keywords.mjs.
//
// The web app cannot import the core helper at build time: Turbopack's root
// is pinned to web/ and refuses modules outside it (see web/next.config.mjs).
// So this is a declared copy, not a derivation — kept in lockstep with the
// core by tests/profile-keywords-parity.test.mjs, which runs both on the same
// inputs and asserts the same keyword SET (not the same post-processing: the
// core de-dupes and trims, this mirror returns raw strings for the caller's
// own cleanup, e.g. cleanChips).
//
// A previous inline version read `primary` as a string when it is a list, and
// spread `archetypes` entries raw when they are {name, level, fit} objects —
// so the Explorer's profile.yml fallback silently returned [] for every
// profile the app itself writes. Match the core's shape exactly, do not
// "improve" on it here — improvements belong in providers/_profile-keywords.mjs
// first, with this file updated to follow.

/**
 * Extracts candidate search keywords from a parsed profile.yml's
 * `target_roles` block: `primary[]` plus `archetypes[].name`.
 * @param {any} profile
 * @returns {string[]}
 */
export function profileTargetKeywords(profile) {
  const roles = profile && profile.target_roles;
  if (!roles || typeof roles !== "object") return [];
  const primary = Array.isArray(roles.primary) ? roles.primary : [];
  const archetypeNames = Array.isArray(roles.archetypes)
    ? roles.archetypes.map((a) => a && a.name)
    : [];
  return [...primary, ...archetypeNames].filter((k) => typeof k === "string");
}
