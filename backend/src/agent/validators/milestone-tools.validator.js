const { z } = require('zod');

const timelineCursorSchema = z.object({
  before_container: z.object({ date: z.string().datetime({ offset: true }), id: z.string().uuid() }).strict().nullable(),
  before_milestone: z.object({ date: z.string().date(), id: z.string().uuid() }).strict().nullable(),
}).strict();
const getTimelineArgsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: timelineCursorSchema.nullable().optional(),
}).strict();
const getMilestoneArgsSchema = z.object({ milestone_id: z.string().uuid() }).strict();

module.exports = { getTimelineArgsSchema, getMilestoneArgsSchema };
