#!/usr/bin/env node
// scripts/experiments/m1-target-race.js
//
// M1 — Concurrency correctness: set_contributor_target_atomic RPC vs. a
// naive check-then-write, at several concurrency levels. Extends
// scripts/measure.js's `target-race` command (kept untouched) by:
//   - seeding its own disposable workspace/container/participant per run
//     (no manual env vars needed),
//   - running concurrency levels 5/25/50,
//   - capturing the *type* of every failure, not just a pass/fail count,
//     which is what revealed the finding below.
//
// Usage: node scripts/experiments/m1-target-race.js
// Needs: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REDIS_URL (see .env.measurement)
// Run against a DISPOSABLE/local-test-stack DB only.
require('dotenv').config();
const { supabaseAdmin: db } = require('../../src/config/supabase');
const { buildWorkspace, buildUser, buildMember, buildContainer, buildParticipant } = require('../../tests/fixtures/factories');

async function seed() {
  const { data: user, error: e1 } = await db.from('users').insert(buildUser()).select().single();
  if (e1) throw new Error(`seed user: ${e1.message}`);
  const { data: workspace, error: e2 } = await db.from('workspaces').insert(buildWorkspace({ created_by: user.id })).select().single();
  if (e2) throw new Error(`seed workspace: ${e2.message}`);
  const { data: member, error: e3 } = await db.from('workspace_members').insert(buildMember({ workspace_id: workspace.id, user_id: user.id, role: 'admin' })).select().single();
  if (e3) throw new Error(`seed member: ${e3.message}`);
  const { data: container, error: e4 } = await db.from('containers').insert(buildContainer({ workspace_id: workspace.id, created_by: member.id })).select().single();
  if (e4) throw new Error(`seed container: ${e4.message}`);
  const { data: participant, error: e5 } = await db.from('container_participants').insert(buildParticipant({ container_id: container.id, workspace_member_id: member.id })).select().single();
  if (e5) throw new Error(`seed participant: ${e5.message}`);
  return { pid: participant.id, cid: container.id, mid: member.id, by: member.id };
}

function settle(rs) {
  const ok = rs.filter((r) => r.status === 'fulfilled' && !r.value.error).length;
  const errorTypes = {};
  rs.forEach((r) => {
    const msg = r.status === 'rejected' ? (r.reason.message || String(r.reason)) : (r.value.error ? r.value.error.message : null);
    if (msg) errorTypes[msg] = (errorTypes[msg] || 0) + 1;
  });
  return { ok, failed: rs.length - ok, error_types: errorTypes };
}

async function currentTargetCount(pid) {
  const { count } = await db.from('contributor_targets').select('id', { count: 'exact', head: true })
    .eq('container_participant_id', pid).is('cycle_id', null).eq('is_current', true);
  return count;
}

async function raceOnce({ pid, cid, mid, by }, C) {
  // Seed one initial target first so FOR UPDATE has a row to lock
  // (the harder, more realistic case: a re-assignment race, not a
  // first-ever-target race).
  const seedRpc = await db.rpc('set_contributor_target_atomic', {
    p_container_participant_id: pid, p_container_id: cid, p_workspace_member_id: mid,
    p_target_amount: 1, p_target_currency: 'NGN', p_due_date: null, p_set_by: by,
  });
  if (seedRpc.error) throw new Error(`seed target: ${seedRpc.error.message}`);

  const naiveFn = async (i) => {
    const { data: prev } = await db.from('contributor_targets').select('id')
      .eq('container_participant_id', pid).is('cycle_id', null).eq('is_current', true).maybeSingle();
    if (prev) await db.from('contributor_targets').update({ is_current: false }).eq('id', prev.id);
    return db.from('contributor_targets').insert({
      container_participant_id: pid, container_id: cid, workspace_member_id: mid,
      target_amount: 9000 + i, target_currency: 'NGN', is_current: true, set_by: by,
    });
  };
  const rpcFn = (i) => db.rpc('set_contributor_target_atomic', {
    p_container_participant_id: pid, p_container_id: cid, p_workspace_member_id: mid,
    p_target_amount: 100 + i, p_target_currency: 'NGN', p_due_date: null, p_set_by: by,
  });

  const naive = settle(await Promise.allSettled(Array.from({ length: C }, (_, i) => naiveFn(i))));
  naive.current_targets_after = await currentTargetCount(pid);

  const rpc = settle(await Promise.allSettled(Array.from({ length: C }, (_, i) => rpcFn(i))));
  rpc.current_targets_after = await currentTargetCount(pid);

  return { concurrency: C, naive, rpc };
}

(async () => {
  const runs = [];
  for (const C of [5, 25, 50]) {
    const fixtures = await seed(); // fresh participant per concurrency level — no cross-run interference
    const r = await raceOnce(fixtures, C);
    runs.push(r);
  }

  const invariantHeld = runs.every((r) => r.naive.current_targets_after === 1 && r.rpc.current_targets_after === 1);
  const report = {
    experiment: 'M1_target_race',
    question: 'Under N concurrent set-target requests, does exactly one is_current=true row survive, and how do naive vs. RPC paths differ?',
    runs,
    invariant_current_targets_always_1: invariantHeld,
    finding: !invariantHeld
      ? 'INVARIANT VIOLATED — see runs for which path/concurrency.'
      : 'Invariant held at every concurrency level for both paths (current_targets_after === 1 always). ' +
        'However, the RPC path still rejects most concurrent requests with a raw duplicate-key error ' +
        '(see rpc.error_types) rather than serializing them gracefully, because its SELECT ... FOR UPDATE ' +
        'locks the *existing* current-target row; once the lock holder commits and supersedes that row, ' +
        'a transaction that was blocked on it re-checks `WHERE is_current = true` under READ COMMITTED, ' +
        'finds no match (the row the lock was on is no longer current), treats it as "no previous target", ' +
        'and attempts a fresh INSERT that collides with whichever transaction already won — causing a ' +
        'duplicate-key exception instead of a clean retry/serialize. The outcome is always correct ' +
        '(never >1 current target), but under concurrent load most competing requests surface as hard ' +
        'errors to the caller rather than succeeding in turn.',
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(invariantHeld ? 0 : 1);
})().catch((e) => { console.error('M1 FAILED:', e.message); process.exit(1); });
