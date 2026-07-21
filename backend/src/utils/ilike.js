// src/utils/ilike.js
//
// `%` and `_` are ILIKE wildcard metacharacters. Interpolating raw user
// input into a `%...%` pattern lets a user's own `%`/`_`/`\` characters
// silently change the matching behavior (broader or narrower than
// intended). Escape before building the pattern.

function escapeIlike(str) {
  return String(str ?? '').replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

/** Builds a safe `%...%` "contains" ILIKE pattern from raw user input. */
function containsPattern(str) {
  return `%${escapeIlike(str)}%`;
}

module.exports = { escapeIlike, containsPattern };
