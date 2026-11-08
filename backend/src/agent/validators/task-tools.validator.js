const { z } = require('zod');

const MAX_TASK_PAGE = 10000;

const listTasksArgsSchema = z.object({
  container_id: z.string().uuid(),
  assigned_to: z.string().uuid().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'overdue', 'cancelled']).optional(),
  page: z.number().int().min(1).max(MAX_TASK_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
}).strict();

const getTaskArgsSchema = z.object({
  container_id: z.string().uuid(),
  task_id: z.string().uuid(),
}).strict();

module.exports = { listTasksArgsSchema, getTaskArgsSchema, MAX_TASK_PAGE };
