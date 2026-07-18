// src/utils/sorting.js
//
// Every list endpoint that supports `?sort=` re-implemented the same
// `startsWith('-')` / `replace('-','')` / whitelist-array pattern
// independently (container.controller.js, ledger.controller.js,
// task.controller.js, member.controller.js), each with slightly
// different variable names and fallback defaults — the same shape of
// duplication getPagination() (utils/pagination.js) was created to solve
// for pagination, but never generalized to sorting (audit finding 6.2).
//
// getSort() mirrors getPagination()'s shape: pass the allowed field list
// and a default (a clean field name, optionally descending by default),
// get back { field, ascending } ready to pass straight into a Supabase
// query builder's `.order(field, { ascending })`.

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
