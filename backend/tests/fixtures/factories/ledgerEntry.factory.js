// tests/fixtures/factories/ledgerEntry.factory.js
// Mirrors public.ledger_entries from schema.txt. Highest business/
// financial risk entity in the app (Doc 4 Section 5, P0 #3) — kept
// strict about required relationship overrides.

const crypto = require('crypto');

function buildLedgerEntry(overrides = {}) {
  for (const required of ['workspace_id', 'container_id', 'recorded_by']) {
    if (!overrides[required]) throw new Error(`buildLedgerEntry requires an explicit ${required} override`);
  }

  const now = new Date().toISOString();

  return {
    id: overrides.id || crypto.randomUUID(),
    workspace_id: overrides.workspace_id,
    container_id: overrides.container_id,
    cycle_id: overrides.cycle_id !== undefined ? overrides.cycle_id : null,
    entry_type: 'contribution',
    contributor_id: overrides.contributor_id !== undefined ? overrides.contributor_id : crypto.randomUUID(),
    original_amount: 50,
    original_currency: 'USD',
    is_crypto: false,
    base_amount: 50,
    payment_method: 'bank_transfer',
    proofs: [],
    status: 'pending',
    corrects_entry_id: null,
    note: null,
    recorded_by: overrides.recorded_by,
    recorded_at: now,
    confirmed_at: null,
    confirmed_by: null,
    idempotency_key: null,
    ...overrides,
  };
}

/** Convenience: a confirmed entry, since corrections/deletion-guards key off this status. */
function buildConfirmedLedgerEntry(overrides = {}) {
  const now = new Date().toISOString();
  return buildLedgerEntry({
    status: 'confirmed',
    confirmed_at: now,
    confirmed_by: overrides.confirmed_by || overrides.recorded_by,
    ...overrides,
  });
}

module.exports = { buildLedgerEntry, buildConfirmedLedgerEntry };
