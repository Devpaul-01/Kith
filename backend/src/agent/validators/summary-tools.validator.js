const { z } = require('zod');

const containerSummaryArgsSchema = z.object({
  container_id: z.string().uuid(),
}).strict();

const memberSummaryArgsSchema = z.object({
  member_id: z.string().uuid(),
}).strict();

const memberEngagementArgsSchema = z.object({}).strict();

module.exports = { containerSummaryArgsSchema, memberSummaryArgsSchema, memberEngagementArgsSchema };
