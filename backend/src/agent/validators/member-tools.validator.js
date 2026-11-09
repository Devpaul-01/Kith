const { z } = require('zod');
const { entitySearchSchema } = require('../../validators/search.validator');

const MAX_MEMBER_PAGE = 10000;
const listMembersArgsSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  is_proxy: z.boolean().optional(),
  is_active: z.boolean().optional(),
  search: entitySearchSchema.shape.query.optional(),
  sort: z.enum(['display_name', '-display_name', 'joined_at', '-joined_at']).default('display_name'),
  page: z.number().int().min(1).max(MAX_MEMBER_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
}).strict();
const getMemberArgsSchema = z.object({ member_id: z.string().uuid() }).strict();

module.exports = { listMembersArgsSchema, getMemberArgsSchema, MAX_MEMBER_PAGE };
