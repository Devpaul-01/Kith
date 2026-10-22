#!/usr/bin/env node
// scripts/experiments/m2-idempotency-race.js
//
// M2 — If N concurrent requests submit a ledger entry with the SAME
// idempotency key, does createEntry() produce exactly one row, with the
// other N-1 correctly recognized as idempotent replays? Exercises the
// real service function (src/services/ledger.service.js createEntry),
// not a reimplementation, so this tests the actual code path, including
// its explicit handling of the Postgres 23505 unique-violation race.
//
// Usage: node scripts/experiments/m2-idempotency-race.js
// Needs: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REDIS_URL
require('dotenv').config();
const { supabaseAdmin: db } = require('../../src/config/supabase');
const { buildWorkspace, buildUser, buildMember, buildContainer, buildParticipant } = require('../../tests/fixtures/factories');
const ledgerService = require('../../src/services/ledger.service');

async function seed() {
  const { data: user } = await db.from('users').insert(buildUser()).select().single();
  const { data: workspace } = await db.from('workspaces').insert(buildWorkspace({ created_by: user.id })).select().single();
  const { data: member } = await db.from('workspace_members').insert(buildMember({ workspace_id: workspace.id, user_id: user.id, role: 'admin' })).select().single();
  const { data: container } = await db.from('containers').insert(buildContainer({ workspace_id: workspace.id, created_by: member.id })).select().single();
  const { data: participant } = await db.from('container_participants').insert(buildParticipant({ container_id: container.id, workspace_member_id: member.id })).select().single();
  return { workspaceId: workspace.id, containerId: container.id, memberId: member.id, participant };
}

async function runLevel(fixtures, N) {
  const idempotencyKey = `m2-race-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const callArgs = {
    workspaceId: fixtures.workspaceId,
    containerId: fixtures.containerId,
    isAdmin: true, // admin recording their own contribution -> status goes straight to 'confirmed', skipping notification fan-out noise
    callerId: fixtures.memberId,
    idempotencyKey,
    actorDisplayName: 'M2 Race Test',
    actorCtx: { workspaceId: fixtures.workspaceId, actorMemberId: fixtures.memberId },
    data: {
      contributor_id: fixtures.memberId,
      entry_type: 'contribution',
      original_amount: 42,
      original_currency: 'NGN',
      base_amount: 42,
      payment_method: 'bank_transfer',
    },
  };

  const calls = Array.from({ length: N }, () => ledgerService.createEntry(callArgs));
  const settled = await Promise.allSettled(calls);

  const ok = settled.filter((r) => r.status === 'fulfilled');
  const failed = settled.filter((r) => r.status === 'rejected');
  const idempotentReplays = ok.filter((r) => r.value && r.value.idempotent === true).length;
  const freshCreates = ok.filter((r) => r.value && r.value.idempotent !== true).length;

  const { count: rowCount } = await db.from('ledger_entries').select('id', { count: 'exact', head: true }).eq('idempotency_key', idempotencyKey);

  return {
    concurrency: N,
    fulfilled: ok.length,
    rejected: failed.length,
    rejection_reasons: [...new Set(failed.map((r) => r.reason.message))],
    fresh_creates_reported: freshCreates,
    idempotent_replays_reported: idempotentReplays,
    actual_row_count_for_key: rowCount,
    invariant_exactly_one_row: rowCount === 1,
  };
}

(async () => {
  const runs = [];
  for (const N of [5, 15, 30]) {
    for (let rep = 0; rep < 3; rep++) {
      const fixtures = await seed(); // fresh participant/key per repetition
      const r = await runLevel(fixtures, N);
      r.repetition = rep + 1;
      runs.push(r);
    }
  }

  const violations = runs.filter((r) => !r.invariant_exactly_one_row);
  const report = {
    experiment: 'M2_idempotency_race',
    question: 'Do N concurrent createEntry() calls sharing one idempotency key produce exactly one ledger row?',
    runs,
    total_runs: runs.length,
    violations: violations.length,
    conclusion: violations.length === 0
      ? 'PASS — exactly one row per idempotency key in all 9 runs (concurrency 5/15/30, x3 repetitions each). The explicit 23505-unique-violation handling in createEntry() correctly collapses concurrent duplicate submissions.'
      : `FAIL — ${violations.length} of ${runs.length} runs produced other than 1 row for the shared key. See "runs" for details.`,
  };
  console.log(JSON.stringify(report, null, 2));
  // ledger.service.js transitively opens a BullMQ/Redis connection (via
  // the notification queue) that keeps the event loop alive; force exit
  // once results are printed rather than hang indefinitely.
  process.exit(violations.length > 0 ? 1 : 0);
})().catch((e) => { console.error('M2 FAILED:', e.message, e.stack); process.exit(1); });
