const { z } = require('zod');

const MAX_INVITE_PAGE = 10000;
const listInvitesArgsSchema = z.object({
  status: z.enum(['available', 'used', 'expired']).optional(),
  page: z.number().int().min(1).max(MAX_INVITE_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
}).strict();

module.exports = { listInvitesArgsSchema, MAX_INVITE_PAGE };
