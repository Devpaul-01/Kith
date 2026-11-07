const { z } = require('zod');

// At least two choices can be displayed when the query is ambiguous.
const entitySearchSchema = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(2).max(20).optional().default(10),
}).strict();

const entitySearchRequestSchema = entitySearchSchema.extend({
  workspaceId: z.string().uuid(),
});

module.exports = { entitySearchSchema, entitySearchRequestSchema };
