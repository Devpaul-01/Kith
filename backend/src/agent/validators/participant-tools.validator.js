const { z } = require('zod');

const MAX_PARTICIPANT_PAGE = 10000;
const paging = {
  page: z.number().int().min(1).max(MAX_PARTICIPANT_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
};
const listParticipantsArgsSchema = z.object({ container_id: z.string().uuid(), ...paging }).strict();
const targetReadArgsSchema = z.object({ container_id: z.string().uuid(), participant_id: z.string().uuid(), ...paging }).strict();

module.exports = { listParticipantsArgsSchema, targetReadArgsSchema, MAX_PARTICIPANT_PAGE };
