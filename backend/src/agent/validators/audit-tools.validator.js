const { z } = require('zod');
const { AUDIT_ACTIONS } = require('../../constants/audit-actions');

const MAX_AUDIT_PAGE = 10000;
const getAuditLogArgsSchema = z.object({
  action: z.enum(Object.values(AUDIT_ACTIONS)).optional(),
  actor_member_id: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.number().int().min(1).max(MAX_AUDIT_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
}).strict().refine((args) => !args.from || !args.to || Date.parse(args.from) <= Date.parse(args.to), {
  message: 'from must be at or before to', path: ['to'],
});

module.exports = { getAuditLogArgsSchema, MAX_AUDIT_PAGE };
