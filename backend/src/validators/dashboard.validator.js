const { z } = require('zod');

const dashboardWorkspaceSchema = z.object({
  workspaceId: z.string().uuid(),
});

module.exports = { dashboardWorkspaceSchema };
