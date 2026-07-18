// src/utils/ilike.js
//
// `%` and `_` are ILIKE wildcard metacharacters. Interpolating raw user
// input into a `%...%` pattern lets a user's own `%`/`_`/`\` characters
// silently change the matching behavior (broader or narrower than
// intended). Escape before building the pattern.
//
// Extracted from workspace.controller.js (where it was previously scoped
// to just searchWorkspace) into a shared utility so every ILIKE call site
// in the app uses the same escaping — see audit finding 5.3, where this
// exact fix had been applied to searchWorkspace but not to the
// structurally identical `display_name` search in
// member.controller.js#listMembers.

function escapeIlike(str) {
  return String(str ?? '').replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

/** Builds a safe `%...%` "contains" ILIKE pattern from raw user input. */
function containsPattern(str) {
  return `%${escapeIlike(str)}%`;
}

module.exports = { escapeIlike, containsPattern };
