const { z } = require('zod');

const MAX_LEDGER_PAGE = 10000;
const listLedgerEntriesArgsSchema = z.object({
  container_id: z.string().uuid(),
  contributor_id: z.string().uuid().optional(),
  status: z.enum(['pending', 'proof_uploaded', 'confirmed', 'disputed', 'resolved', 'reversed']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.number().int().min(1).max(MAX_LEDGER_PAGE).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
}).strict().refine((args) => !args.from || !args.to || Date.parse(args.from) <= Date.parse(args.to), {
  message: 'from must be at or before to', path: ['to'],
});

const getLedgerEntryArgsSchema = z.object({
  container_id: z.string().uuid(),
  entry_id: z.string().uuid(),
}).strict();

module.exports = { listLedgerEntriesArgsSchema, getLedgerEntryArgsSchema, MAX_LEDGER_PAGE };
