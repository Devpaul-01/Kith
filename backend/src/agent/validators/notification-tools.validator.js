const { z } = require('zod');

const MAX_NOTIFICATION_PAGE = 10000;
const listNotificationsArgsSchema = z.object({
  is_read: z.boolean().optional(),
  page: z.number().int().min(1).max(MAX_NOTIFICATION_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
}).strict();
const unreadCountArgsSchema = z.object({}).strict();

module.exports = { listNotificationsArgsSchema, unreadCountArgsSchema, MAX_NOTIFICATION_PAGE };
