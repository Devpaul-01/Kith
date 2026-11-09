const { z } = require('zod');

// At least two choices can be displayed when the query is ambiguous.
const entitySearchSchema = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(2).max(20).optional().default(10),
}).strict();

const entitySearchRequestSchema = entitySearchSchema.extend({
  workspaceId: z.string().uuid(),
});

const containerEntitySearchSchema = entitySearchSchema.extend({ container_id: z.string().uuid().optional() });
const callerEntitySearchRequestSchema = entitySearchRequestSchema.extend({
  callerId: z.string().uuid(), isAdmin: z.boolean(),
});
const callerContainerSearchRequestSchema = callerEntitySearchRequestSchema.extend({ containerId: z.string().uuid().optional() });

module.exports = {
  entitySearchSchema, entitySearchRequestSchema, containerEntitySearchSchema,
  callerEntitySearchRequestSchema, callerContainerSearchRequestSchema,
};
