// Requires real Postgres/PostgREST/Redis. Direct sessions and observed lock waits
// exercise ordinary writers, not only duplicate Redis approvals. No schema is
// deployed by this suite. Temporary trigger fixtures run inside rollback-only
// transactions.
const { Pool } = require('pg');
const { supabaseAdmin } = require('../../../src/config/supabase');
const disputes = require('../../../src/services/dispute.service');
const { seedWorkspaceWithAdmin, seedAdditionalMember, seedContainerWithParticipants, seedLedgerEntry, cleanupWorkspace } = require('../../helpers/dbHelper');
const { REASON } = require('../../helpers/agent-dispute-raise');

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:test@localhost:54322/kith_test',
  max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
const attempt = (operation) => operation.then((value) => ({ value }), (error) => ({ error }));
async function session() {
  const client = await pool.connect();
  await client.query("SET statement_timeout = '10s'; SET lock_timeout = '8s'");
  return client;
}
async function release(client) {
  await client.query('ROLLBACK').catch(() => {});
  client.release();
}
async function waitForBlock(waiter, blocker) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query('SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked',
      [waiter.processID, blocker.processID]);
    if (rows[0].blocked) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('Expected PostgreSQL writer lock wait was not observed');
}
const reviewedRpc = (client, tenant, expected = tenant.expected) => client.query(
  'SELECT public.raise_dispute_reviewed_atomic($1::uuid, $2::uuid, $3::uuid, $4::text, $5::jsonb) AS result',
  [tenant.workspace.id, tenant.owner.user.id, tenant.owner.member.id, REASON, JSON.stringify(expected)],
).then(({ rows }) => rows[0].result);
const ordinaryRpc = (client, tenant) => client.query(
  'SELECT public.raise_dispute_atomic($1::uuid, $2::uuid, $3::uuid, $4::text) AS result',
  [tenant.workspace.id, tenant.entry.id, tenant.owner.member.id, REASON],
).then(({ rows }) => rows[0].result);
async function states(tenant) {
  const { rows } = await pool.query(`SELECT e.status AS entry_status,
    (SELECT count(*)::int FROM public.disputes d WHERE d.ledger_entry_id = e.id) AS disputes
    FROM public.ledger_entries e WHERE e.id = $1`, [tenant.entry.id]);
  return rows[0];
}
const untouched = { entry_status: 'confirmed', disputes: 0 };
// Rollback-only fixture: suppresses the confirmed -> disputed ledger transition.
const SUPPRESS_TRANSITION = `CREATE FUNCTION public.zz_suppress_dispute_transition() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN IF NEW.status = 'disputed' THEN RETURN NULL; END IF; RETURN NEW; END $f$;
  CREATE TRIGGER aa_zz_suppress BEFORE UPDATE ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.zz_suppress_dispute_transition()`;

describe('reviewed dispute raise transaction boundaries', () => {
  const workspaceIds = [];
  async function tenant() {
    const admin = await seedWorkspaceWithAdmin(supabaseAdmin, { workspace: { base_currency: 'NGN' } });
    workspaceIds.push(admin.workspace.id);
    const owner = await seedAdditionalMember(supabaseAdmin, admin.workspace.id);
    const { container } = await seedContainerWithParticipants(supabaseAdmin, { workspaceId: admin.workspace.id,
      createdBy: admin.member.id, participants: [{ workspace_member_id: owner.member.id, money_enabled: true }] });
    const entry = await seedLedgerEntry(supabaseAdmin, { workspace_id: admin.workspace.id, container_id: container.id,
      contributor_id: owner.member.id, recorded_by: owner.member.id, status: 'confirmed',
      original_amount: '5000.25', original_currency: 'NGN', base_amount: '5000.25',
      recorded_at: '2026-11-15T12:01:00.123Z', confirmed_at: '2026-11-15T12:02:00.456Z', confirmed_by: admin.member.id });
    const expected = await disputes.getRaiseDisputeContext({ workspaceId: admin.workspace.id, containerId: container.id,
      entryId: entry.id, callerId: owner.member.id, userId: owner.user.id, isAdmin: false });
    return { workspace: admin.workspace, admin, owner, container, entry, expected };
  }
  afterAll(async () => {
    for (const id of workspaceIds.reverse()) await cleanupWorkspace(supabaseAdmin, id);
    await pool.end();
  });

  it('returns exact dual projections from the mutation transaction', async () => {
    const current = await tenant();
    const result = await reviewedRpc(pool, current);
    expect(result.entry).toEqual({ ...current.expected.entry, status: 'disputed' });
    expect(result.dispute).toEqual({ dispute_id: expect.any(String), workspace_id: current.workspace.id,
      ledger_entry_id: current.entry.id, raised_by: current.owner.member.id, reason: REASON, status: 'open',
      resolution_note: null, resolved_by: null, raised_at: expect.any(String), resolved_at: null, notes: [] });
    expect(JSON.stringify(result)).not.toMatch(/proofs|idempotency_key/);
    expect(await states(current)).toEqual({ entry_status: 'disputed', disputes: 1 });
  });

  it.each([
    ['workspace currency changed', (t) => ["UPDATE public.workspaces SET base_currency = 'USD' WHERE id = $1", t.workspace.id]],
    ['workspace deleted', (t) => ['UPDATE public.workspaces SET deleted_at = now() WHERE id = $1', t.workspace.id]],
    ['actor deactivated', (t) => ['UPDATE public.workspace_members SET is_active = false WHERE id = $1', t.owner.member.id]],
    ['actor promoted to admin', (t) => ["UPDATE public.workspace_members SET role = 'admin' WHERE id = $1", t.owner.member.id]],
    ['actor became a proxy', (t) => ['UPDATE public.workspace_members SET is_proxy = true, user_id = NULL WHERE id = $1', t.owner.member.id]],
    ['container archived', (t) => ["UPDATE public.containers SET status = 'archived' WHERE id = $1", t.container.id]],
    ['money disabled', (t) => ['UPDATE public.containers SET enable_money = false WHERE id = $1', t.container.id]],
    ['container deleted', (t) => ['UPDATE public.containers SET deleted_at = now() WHERE id = $1', t.container.id]],
    ['dispute already open', (t) => ["INSERT INTO public.disputes (workspace_id, ledger_entry_id, raised_by, reason, status) VALUES ($1, $2, $3, 'Existing dispute', 'open')",
      t.workspace.id, t.entry.id, t.owner.member.id]],
  ])('treats %s after review as stale with no writes', async (_name, change) => {
    const current = await tenant();
    const [sql, ...params] = change(current);
    await pool.query(sql, params);
    const before = await states(current);
    const result = await attempt(reviewedRpc(pool, current));
    expect(result.error?.message).toMatch(/REVIEWED_DISPUTE_STALE/);
    expect(await states(current)).toEqual(before);
  });

  it('treats a tampered approved snapshot as stale', async () => {
    const current = await tenant();
    const tampered = { ...current.expected, entry: { ...current.expected.entry, note: 'changed' } };
    expect((await attempt(reviewedRpc(pool, current, tampered))).error?.message).toMatch(/REVIEWED_DISPUTE_STALE/);
    expect(await states(current)).toEqual(untouched);
  });

  it.each(['abcd', ` ${REASON}`, 'x'.repeat(1001)])('rejects invalid reason %j before any write', async (reason) => {
    const current = await tenant();
    const result = await attempt(pool.query('SELECT public.raise_dispute_reviewed_atomic($1, $2, $3, $4, $5::jsonb)',
      [current.workspace.id, current.owner.user.id, current.owner.member.id, reason, JSON.stringify(current.expected)]));
    expect(result.error?.message).toMatch(/INVALID_REVIEWED_DISPUTE_INPUT/);
    expect(await states(current)).toEqual(untouched);
  });

  it.each([['reviewed', reviewedRpc, /REVIEWED_DISPUTE_STALE/], ['ordinary', ordinaryRpc, /ENTRY_NOT_DISPUTABLE/]])(
    'rolls back the dispute when the %s ledger transition is suppressed', async (_kind, rpc, message) => {
      const current = await tenant(); const client = await session();
      try {
        await client.query('BEGIN');
        await client.query(SUPPRESS_TRANSITION);
        expect((await attempt(rpc(client, current))).error?.message).toMatch(message);
      } finally { await release(client); }
      expect(await states(current)).toEqual(untouched);
    });

  it('blocks a competing eligibility edit until the reviewed raise commits', async () => {
    const current = await tenant(); const [raiser, editor] = [await session(), await session()];
    try {
      await raiser.query('BEGIN');
      await reviewedRpc(raiser, current);
      const edit = attempt(editor.query('UPDATE public.workspace_members SET is_active = false WHERE id = $1', [current.owner.member.id]));
      await waitForBlock(editor, raiser);
      await raiser.query('COMMIT');
      expect((await edit).error).toBeUndefined();
      expect(await states(current)).toEqual({ entry_status: 'disputed', disputes: 1 });
    } finally { await release(raiser); await release(editor); }
  });

  it('treats an eligibility edit committed while the reviewed raise waits as stale', async () => {
    const current = await tenant(); const [raiser, editor] = [await session(), await session()];
    try {
      await editor.query('BEGIN');
      await editor.query("UPDATE public.containers SET status = 'archived' WHERE id = $1", [current.container.id]);
      const raise = attempt(reviewedRpc(raiser, current));
      await waitForBlock(raiser, editor);
      await editor.query('COMMIT');
      expect((await raise).error?.message).toMatch(/REVIEWED_DISPUTE_STALE/);
      expect(await states(current)).toEqual(untouched);
    } finally { await release(raiser); await release(editor); }
  });

  it.each([['reviewed', 'reviewed'], ['ordinary', 'reviewed']])('lets exactly one of concurrent %s and %s raises win', async (first, second) => {
    const current = await tenant(); const [a, b] = [await session(), await session()];
    const run = (kind, client) => (kind === 'reviewed' ? reviewedRpc(client, current) : ordinaryRpc(client, current));
    try {
      const results = await Promise.all([attempt(run(first, a)), attempt(run(second, b))]);
      expect(results.filter((result) => result.value)).toHaveLength(1);
      expect(await states(current)).toEqual({ entry_status: 'disputed', disputes: 1 });
    } finally { await release(a); await release(b); }
  });

  it('preserves the ordinary raise result shape, accepted entries and legacy errors', async () => {
    const current = await tenant();
    const raised = await ordinaryRpc(pool, current);
    expect(raised).toMatchObject({ id: expect.any(String), ledger_entry_id: current.entry.id,
      raised_by: current.owner.member.id, status: 'open', reason: REASON });
    expect((await attempt(ordinaryRpc(pool, current))).error?.message).toMatch(/ENTRY_NOT_DISPUTABLE/);
    const missing = { ...current, entry: { id: '00000000-0000-4000-8000-000000000000' } };
    expect((await attempt(ordinaryRpc(pool, missing))).error?.message).toMatch(/ENTRY_NOT_FOUND/);
  });

  it('pins the search path and withholds PUBLIC execution on both functions', async () => {
    const { rows } = await pool.query(`SELECT proname, proconfig, proacl::text AS acl FROM pg_proc
      WHERE proname IN ('raise_dispute_atomic', 'raise_dispute_reviewed_atomic') ORDER BY proname`);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.proconfig).toEqual(['search_path=pg_catalog, public']);
      expect(row.acl === null || !/(^|[{,])=X/.test(row.acl)).toBe(true);
    }
  });
});
