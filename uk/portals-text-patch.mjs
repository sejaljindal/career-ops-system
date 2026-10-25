/**
 * portals-text-patch.mjs — apply small field-level edits to portals.yml
 * WITHOUT a yaml.load()/yaml.dump() round-trip.
 *
 * WHY THIS EXISTS: group-dedupe.mjs and apply-stage2-tier0.mjs both used to
 * mutate the parsed YAML doc in memory and write it back with yaml.dump().
 * Plain js-yaml does not preserve comments on a round-trip — it silently
 * dropped every `#` line in portals.yml, including the curated-list section
 * headers (`# -- University — N companies --`) that loadCuratedPrimaryLists()
 * in uk-coverage.mjs depends on. That went unnoticed for several nights
 * (from 2026-08-27 19:23 onward) and undercounted curated employers by
 * ~350 until it was found and fixed on 2026-08-31.
 *
 * This module patches only the specific lines that need to change —
 * `careers_url:` and `notes:` under a matched `- name: X` entry — leaving
 * every other byte of the file, including comments, untouched. This is the
 * same approach merge-discovered.mjs already uses successfully.
 *
 * Usage:
 *   import { patchPortalsYmlText } from './portals-text-patch.mjs';
 *   const updated = patchPortalsYmlText(originalText, new Map([
 *     ['Some Company', { careers_url: 'https://...', notesAppend: 'note text' }],
 *   ]));
 *
 * `careers_url` is set/replaced verbatim if provided. `notesAppend` is
 * appended to any existing notes text (joined with " | "), never replacing
 * what was already there — matching the append-only convention the two
 * calling scripts already used before this fix.
 */

function unquoteYamlScalar(raw) {
  const s = raw.trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function quoteYamlScalar(value) {
  // Always double-quote on write — safe for any content (pipes, colons,
  // apostrophes) and avoids re-deriving YAML's unquoted-scalar rules.
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function patchPortalsYmlText(text, updates) {
  if (!(updates instanceof Map)) updates = new Map(Object.entries(updates || {}));
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  let patchedCount = 0;

  while (i < lines.length) {
    const line = lines[i];
    const nameMatch = line.match(/^(\s*)-\s+name:\s*(.+?)\s*$/);
    if (!nameMatch) { out.push(line); i++; continue; }

    const baseIndent = nameMatch[1].length;
    const name = unquoteYamlScalar(nameMatch[2]);
    const update = updates.get(name);

    // Collect the full block for this entry (this line, plus every following
    // line indented deeper than the '- ' marker) regardless of whether it
    // matches, so we always advance `i` correctly.
    const block = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '') { block.push(next); i++; continue; }
      const nextIndent = next.match(/^(\s*)/)[1].length;
      const isNewListItem = /^\s*-\s/.test(next);
      if (nextIndent <= baseIndent && isNewListItem) break;
      if (nextIndent <= baseIndent) break; // dedented out of the list entirely
      block.push(next);
      i++;
    }

    if (!update) { out.push(...block); continue; }

    const fieldIndent = ' '.repeat(baseIndent + 2);
    let sawCareersUrl = false;
    let sawNotes = false;

    for (let bi = 0; bi < block.length; bi++) {
      const bline = block[bi];
      if (update.careers_url !== undefined && /^\s*careers_url:\s*/.test(bline)) {
        block[bi] = `${fieldIndent}careers_url: ${update.careers_url}`;
        sawCareersUrl = true;
      } else if (update.notesAppend && /^\s*notes:\s*/.test(bline)) {
        const current = unquoteYamlScalar(bline.replace(/^\s*notes:\s*/, ''));
        const merged = current ? `${current} | ${update.notesAppend}` : update.notesAppend;
        block[bi] = `${fieldIndent}notes: ${quoteYamlScalar(merged)}`;
        sawNotes = true;
      }
    }
    if (update.careers_url !== undefined && !sawCareersUrl) {
      block.splice(1, 0, `${fieldIndent}careers_url: ${update.careers_url}`);
    }
    if (update.notesAppend && !sawNotes) {
      block.splice(1, 0, `${fieldIndent}notes: ${quoteYamlScalar(update.notesAppend)}`);
    }
    patchedCount++;
    out.push(...block);
  }

  return { text: out.join('\n'), patchedCount };
}
