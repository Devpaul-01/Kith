// src/utils/queryFilter.js
//
// Reads `filter[name]=value` query params. Express 4's default "extended"
// query parser (qs) turns `?filter[role]=admin` into `req.query.filter =
// { role: 'admin' }`, so reading the literal flat key
// `req.query['filter[role]']` always returns undefined and the filter is
// silently ignored. This accepts both shapes (nested from qs, flat from
// the "simple" parser or a pre-flattened query).
function getFilter(query, name) {
  if (!query) return undefined;
  const flat = query[`filter[${name}]`];
  if (flat !== undefined) return flat;
  const nested = query.filter;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested[name];
  return undefined;
}

module.exports = { getFilter };
