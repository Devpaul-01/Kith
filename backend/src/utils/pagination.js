// src/utils/pagination.js
//
// Issue M2 fix: this file previously wasn't imported anywhere — every
// controller reimplemented the same page/per_page/offset math inline
// instead. getPagination() is now the single implementation, wired into
// every paginated list endpoint (see ledger.controller.js#listEntries,
// dispute.controller.js#listDisputes, container.controller.js#listCycles,
// workspace.controller.js#getAuditLog, notification.controller.js#listNotifications).
//
// `buildOrderBy`, which previously also lived here unused, has been
// removed rather than wired in: it returns a raw SQL "field DIRECTION"
// string, but every query in this codebase goes through the supabase-js
// query builder's `.order(field, { ascending })` — the two shapes aren't
// interchangeable, and there's no actual raw-SQL call site anywhere in the
// app that could use it. Keeping a second, incompatible pagination helper
// around alongside the one that's actually used would just recreate the
// exact "dead utility nobody wired in" problem this fix is closing.

function getPagination(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.per_page) || 20));
  const offset = (page - 1) * perPage;
  return { page, perPage, offset };
}

module.exports = { getPagination };
