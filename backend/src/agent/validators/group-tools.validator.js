const { z } = require('zod');
const { entitySearchSchema } = require('../../validators/search.validator');

const MAX_GROUP_PAGE = 10000;
const paging = {
  page: z.number().int().min(1).max(MAX_GROUP_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
};
const listGroupsArgsSchema = z.object({ search: entitySearchSchema.shape.query.optional(), ...paging }).strict();
const getGroupArgsSchema = z.object({ group_id: z.string().uuid(), ...paging }).strict();

module.exports = { listGroupsArgsSchema, getGroupArgsSchema, MAX_GROUP_PAGE };
