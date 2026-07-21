// src/utils/sorting.js
//
// getSort() centralizes the `?sort=` parsing pattern (leading `-` for
// descending + an allowed-field whitelist) so every list endpoint that
// supports sorting shares one implementation instead of reimplementing
// it slightly differently per controller.

function getSort(query, { allowed, defaultField, defaultDescending = false }) {
  const raw = typeof query.sort === 'string' && query.sort.length ? query.sort : null;

  if (!raw) {
    return { field: defaultField, ascending: !defaultDescending };
  }

  const ascending = !raw.startsWith('-');
  const field = raw.replace(/^-/, '');
  const safeField = allowed.includes(field) ? field : defaultField;

  return { field: safeField, ascending };
}

module.exports = { getSort };
