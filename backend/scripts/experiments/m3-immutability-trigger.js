#!/usr/bin/env node
// scripts/experiments/m3-immutability-trigger.js
//
// M3 — Does enforce_ledger_entry_immutability (migration 002) actually
// reject a direct mutation of a confirmed ledger entry's amount, issued
// as raw SQL that bypasses ledger.service.js entirely? Also checks that
// an *allowed* transition (confirmed -> disputed) still succeeds, so the
// trigger isn't simply rejecting all writes.
//
// Usage: node scripts/experiments/m3-immutability-trigger.js
// Needs: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (PostgREST is used here
// only to seed through the normal path; the mutation attempts themselves
// go through a raw pg connection to genuinely bypass the app layer).
require('dotenv').config();
const { Client } = require('pg');
const { supabaseAdmin: db } = require('../../src/config/supabase');
const { buildWorkspace, buildUser, buildMember, buildContainer, buildParticipant, buildConfirmedLedgerEntry } = require('../../tests/fixtures/factories');

const PG_CONN = process.env.RAW_PG_URL || 'postgres://postgres:test@localhost:5432/kith_test';

async function seedConfirmedEntry() {
  const { data: user } = await db.from('users').insert(buildUser()).select().single();
  const { data: workspace } = await db.from('workspaces').insert(buildWorkspace({ created_by: user.id })).select().single();
  const { data: member } = await db.from('workspace_members').insert(buildMember({ workspace_id: workspace.id, user_id: user.id, role: 'admin' })).select().single();
  const { data: container } = await db.from('containers').insert(buildContainer({ workspace_id: workspace.id, created_by: member.id })).select().single();
  await db.from('container_participants').insert(buildParticipant({ container_id: container.id, workspace_member_id: member.id })).select().single();
  const { data: entry, error } = await db.from('ledger_entries').insert(buildConfirmedLedgerEntry({
    workspace_id: workspace.id, container_id: container.id, contributor_id: member.id,
    recorded_by: member.id, confirmed_by: member.id,
  })).select().single();
  if (error) throw new Error(`seed ledger entry: ${error.message}`);
  return entry;
}

(async () => {
  const entry = await seedConfirmedEntry();
  const pg = new Client({ connectionString: PG_CONN });
  await pg.connect();

  const results = {};

  // Attempt 1: directly mutate the amount of a confirmed entry via raw SQL.
  try {
    await pg.query('UPDATE ledger_entries SET original_amount = original_amount + 1 WHERE id = $1', [entry.id]);
    results.disallowed_amount_mutation = { blocked: false, note: 'UPDATE SUCCEEDED — trigger did NOT block it' };
  } catch (e) {
    results.disallowed_amount_mutation = { blocked: true, error_code: e.code, error_message: e.message };
  }

  // Confirm the row is actually unchanged
  const check = await pg.query('SELECT original_amount FROM ledger_entries WHERE id = $1', [entry.id]);
  // node-pg returns numeric columns as strings to avoid float precision loss; compare numerically.
  results.amount_unchanged = Number(check.rows[0].original_amount) === Number(entry.original_amount);

  // Attempt 2: an allowed transition (confirmed -> disputed) should still work.
  try {
    await pg.query("UPDATE ledger_entries SET status = 'disputed' WHERE id = $1", [entry.id]);
    const check2 = await pg.query('SELECT status FROM ledger_entries WHERE id = $1', [entry.id]);
    results.allowed_status_transition = { blocked: false, resulting_status: check2.rows[0].status };
  } catch (e) {
    results.allowed_status_transition = { blocked: true, error_code: e.code, error_message: e.message, note: 'Unexpected — this transition should be allowed' };
  }

  await pg.end();

  const report = {
    experiment: 'M3_immutability_trigger',
    question: 'Does enforce_ledger_entry_immutability reject a direct SQL mutation of a confirmed ledger entry, while still allowing legitimate status transitions?',
    seeded_entry_id: entry.id,
    results,
    conclusion: results.disallowed_amount_mutation.blocked && results.amount_unchanged
      ? 'PASS — direct amount mutation on a confirmed entry was rejected at the database level, independent of application code.'
      : 'FAIL — the trigger did not block a direct mutation; investigate before relying on this as a correctness guarantee.',
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(results.disallowed_amount_mutation.blocked && results.amount_unchanged ? 0 : 1);
})().catch((e) => { console.error('M3 FAILED:', e.message); process.exit(1); });
