// tests/fixtures/factories/dispute.factory.js
// Mirrors public.disputes from schema.txt.

const crypto = require('crypto');

function buildDispute(overrides = {}) {
  if (!overrides.workspace_id) throw new Error('buildDispute requires an explicit workspace_id override');
  if (!overrides.ledger_entry_id) throw new Error('buildDispute requires an explicit ledger_entry_id override');
  if (!overrides.raised_by) throw new Error('buildDispute requires an explicit raised_by override');

  return {
    id: overrides.id || crypto.randomUUID(),
    workspace_id: overrides.workspace_id,
    ledger_entry_id: overrides.ledger_entry_id,
    raised_by: overrides.raised_by,
    reason: 'This contribution amount looks incorrect.',
    status: 'open',
    resolution_note: null,
    resolved_by: null,
    raised_at: new Date().toISOString(),
    resolved_at: null,
    notes: [],
    ...overrides,
  };
}

module.exports = { buildDispute };
