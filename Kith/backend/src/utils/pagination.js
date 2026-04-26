// src/utils/pagination.js

function getPagination(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.per_page) || 20));
  const offset = (page - 1) * perPage;
  return { page, perPage, offset };
}

function buildOrderBy(sortParam, allowedFields, defaultField = 'created_at', defaultDir = 'DESC') {
  if (!sortParam) return `${defaultField} ${defaultDir}`;
  const desc = sortParam.startsWith('-');
  const field = desc ? sortParam.slice(1) : sortParam;
  if (!allowedFields.includes(field)) return `${defaultField} ${defaultDir}`;
  return `${field} ${desc ? 'DESC' : 'ASC'}`;
}

module.exports = { getPagination, buildOrderBy };
