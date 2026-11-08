const { z } = require('zod');

const containerSummaryArgsSchema = z.object({
  container_id: z.string().uuid(),
}).strict();

const memberSummaryArgsSchema = z.object({
  member_id: z.string().uuid(),
}).strict();

module.exports = { containerSummaryArgsSchema, memberSummaryArgsSchema };
