// src/utils/pagination.js
//
// Single implementation of page/per_page/offset math, wired into every
// paginated list endpoint (ledger, disputes, cycles, audit log,
// notifications).

function getPagination(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.per_page) || 20));
  const offset = (page - 1) * perPage;
  return { page, perPage, offset };
}

module.exports = { getPagination };
