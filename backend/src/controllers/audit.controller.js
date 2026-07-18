// src/controllers/audit.controller.js
//
// Service-layer refactor: query-building (applyAuditLogFilters) and CSV
// generation now live in services/audit_log.service.js. This file only
// parses the request, calls the service, and shapes the HTTP response
// (pagination envelope vs. CSV attachment headers).

const { paginate } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const auditLogService = require('../services/audit_log.service');

async function getAuditLog(req, res, next) {
  try {
    const { workspaceId }           = req.params;
    const { page, perPage, offset } = getPagination(req.query);

    const { entries, count } = await auditLogService.getAuditLog({
      workspaceId,
      filters: req.query,
      page, perPage, offset,
    });

    paginate(res, { entries }, count, page, perPage);
  } catch (err) { next(err); }
}

async function exportAuditLog(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const { limit = 1000 } = req.query;

    const csv = await auditLogService.exportAuditLogCsv({
      workspaceId,
      filters: req.query,
      limit,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${Date.now()}.csv"`);
    res.status(200).send(csv);
  } catch (err) { next(err); }
}

module.exports = {
  getAuditLog,
  exportAuditLog,
};
