const { z } = require('zod');

const MAX_DISPUTE_PAGE = 10000;
const paging = {
  page: z.number().int().min(1).max(MAX_DISPUTE_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
};
const listDisputesArgsSchema = z.object({ status: z.enum(['open', 'resolved']).optional(), ...paging }).strict();
const getDisputeArgsSchema = z.object({ dispute_id: z.string().uuid(), ...paging }).strict();

module.exports = { listDisputesArgsSchema, getDisputeArgsSchema, MAX_DISPUTE_PAGE };
