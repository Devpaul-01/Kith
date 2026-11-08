const { z } = require('zod');

const MAX_CYCLE_PAGE = 10000;

const listCyclesArgsSchema = z.object({
  container_id: z.string().uuid(),
  status: z.enum(['upcoming', 'open', 'closed', 'skipped']).optional(),
  page: z.number().int().min(1).max(MAX_CYCLE_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
}).strict();

module.exports = { listCyclesArgsSchema, MAX_CYCLE_PAGE };
