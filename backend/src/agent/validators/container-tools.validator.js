const { z } = require('zod');

const MAX_CONTAINER_PAGE = 10000;
const listContainersArgsSchema = z.object({
  type: z.enum(['event', 'recurring']).optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
  sort: z.enum(['created_at', '-created_at', 'name', '-name', 'event_date', '-event_date']).default('created_at'),
  page: z.number().int().min(1).max(MAX_CONTAINER_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
}).strict();
const getContainerArgsSchema = z.object({ container_id: z.string().uuid() }).strict();

module.exports = { listContainersArgsSchema, getContainerArgsSchema, MAX_CONTAINER_PAGE };
