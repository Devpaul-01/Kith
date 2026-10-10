#!/usr/bin/env node
// Measurement harness for resume metrics. Run against a DISPOSABLE/staging DB.
//   node scripts/measure.js delivery
//   WORKSPACE_ID=.. USER_ID=.. node scripts/measure.js cache [N=300]
//   PARTICIPANT_ID=.. CONTAINER_ID=.. MEMBER_ID=.. SET_BY=.. node scripts/measure.js target-race [C=25]
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REDIS_URL in .env. Report methodology with any number.
require('dotenv').config();
const { supabaseAdmin: db } = require('../src/config/supabase');
const { getRedis } = require('../src/config/redis');
const { membershipKey } = require('../src/config/redis-keys');

const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const stats = (a) => ({ n: a.length, mean_ms: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2), p50_ms: +pct(a, 0.5).toFixed(2), p95_ms: +pct(a, 0.95).toFixed(2) });
const time = async (fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

async function delivery() {
  const { data, error } = await db.from('notification_deliveries').select('channel,status,retry_count').neq('channel', 'in_app');
  if (error) throw error;
  const by = {}; data.forEach((d) => { by[d.status] = (by[d.status] || 0) + 1; });
  const total = data.length, ok = by.delivered || 0, skipped = by.skipped || 0, attempted = total - skipped;
  console.log({ external_deliveries: total, by_status: by,
    delivered_of_attempted_pct: attempted ? +(100 * ok / attempted).toFixed(2) : null,
    note: 'skipped = no token / prefs off / proxy; excluded from the rate. Small n is not a claim.' });
}

async function cache() {
  const { WORKSPACE_ID: ws, USER_ID: uid } = process.env; const N = +process.argv[3] || 300;
  if (!ws || !uid) throw new Error('WORKSPACE_ID and USER_ID required');
  const redis = getRedis();
  const uncached = () => Promise.all([
    db.from('workspace_members').select('id, role, display_name, is_proxy, is_active, workspace_id').eq('workspace_id', ws).eq('user_id', uid).eq('is_active', true).is('deleted_at', null).maybeSingle(),
    db.from('workspaces').select('id, name, base_currency, visibility').eq('id', ws).is('deleted_at', null).maybeSingle(),
  ]);
  const [m, w] = await uncached();
  if (!m.data || !w.data) throw new Error('membership not found for those ids');
  await redis.set(membershipKey(ws, uid), JSON.stringify({ member: m.data, workspace: w.data }), 'EX', 600);
  const cached = () => redis.get(membershipKey(ws, uid)).then(JSON.parse);
  await uncached(); await cached(); // warm-up
  const u = [], c = [];
  for (let i = 0; i < N; i++) { u.push(await time(uncached)); c.push(await time(cached)); }
  const su = stats(u), sc = stats(c);
  console.log({ uncached_two_queries: su, redis_cache_hit: sc, p50_speedup_x: +(su.p50_ms / sc.p50_ms).toFixed(1),
    note: 'Measures the membership lookup only, from this machine. Say "membership lookup", not "API latency".' });
}

async function targetRace() {
  const { PARTICIPANT_ID: pid, CONTAINER_ID: cid, MEMBER_ID: mid, SET_BY: by } = process.env; const C = +process.argv[3] || 25;
  if (!pid || !cid || !mid || !by) throw new Error('PARTICIPANT_ID, CONTAINER_ID, MEMBER_ID, SET_BY required');
  const current = async () => (await db.from('contributor_targets').select('id', { count: 'exact', head: true }).eq('container_participant_id', pid).is('cycle_id', null).eq('is_current', true)).count;
  const settle = (rs) => ({ ok: rs.filter((r) => r.status === 'fulfilled' && !r.value.error).length, failed: rs.filter((r) => r.status === 'rejected' || r.value.error).length });

  const rpc = (i) => db.rpc('set_contributor_target_atomic', { p_container_participant_id: pid, p_container_id: cid, p_workspace_member_id: mid, p_target_amount: 100 + i, p_target_currency: 'NGN', p_due_date: null, p_set_by: by });
  const naive = async (i) => {   // check-then-write, no lock: what the RPC replaces
    const { data: prev } = await db.from('contributor_targets').select('id').eq('container_participant_id', pid).is('cycle_id', null).eq('is_current', true).maybeSingle();
    if (prev) await db.from('contributor_targets').update({ is_current: false }).eq('id', prev.id);
    return db.from('contributor_targets').insert({ container_participant_id: pid, container_id: cid, workspace_member_id: mid, target_amount: 100 + i, target_currency: 'NGN', is_current: true, set_by: by });
  };
  const run = async (name, fn) => {
    const rs = await Promise.allSettled(Array.from({ length: C }, (_, i) => fn(i)));
    console.log(name, { concurrent_requests: C, ...settle(rs), current_targets_after: await current() });
  };
  await run('naive check-then-write', naive);
  await run('set_contributor_target_atomic RPC', rpc);
  console.log('Invariant: exactly 1 current target. Rows from this run stay in the table; use a throwaway participant.');
}

const cmds = { delivery, cache, 'target-race': targetRace };
const cmd = cmds[process.argv[2]];
if (!cmd) { console.log('usage: node scripts/measure.js <delivery|cache|target-race>'); process.exit(1); }
cmd().catch((e) => { console.error(e.message || e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 200));
