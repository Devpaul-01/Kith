// Requires real Postgres/PostgREST/Redis. Direct sessions and observed lock waits
// exercise ordinary writers, not only duplicate Redis approvals. No schema is
// deployed by this suite. Temporary trigger/role fixtures run inside rollback-
// only transactions; ACL fixtures execute the consolidated source's ACL block.
const { readFileSync } = require('fs');
const { resolve } = require('path');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { supabaseAdmin } = require('../../../src/config/supabase');
const disputes = require('../../../src/services/dispute.service');
const { seedWorkspaceWithAdmin, seedAdditionalMember, seedContainerWithParticipants, seedLedgerEntry, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildDispute } = require('../../fixtures/factories');
const { RESOLUTION_NOTE } = require('../../helpers/agent-dispute-resolve');

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:test@localhost:54322/kith_test',
  max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
const resolvedAt = '2026-11-18T12:03:00.123Z';
async function session() {
  const client = await pool.connect();
  await client.query("SET statement_timeout = '10s'; SET lock_timeout = '8s'");
  return client;
}
async function release(client) {
  await client.query('ROLLBACK').catch(() => {});
  client.release();
}
const attempt = (operation) => operation.then((value) => ({ value }), (error) => ({ error }));
async function waitForBlock(observer, waiter, blocker) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query('SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked',
      [waiter.processID, blocker.processID]);
    if (rows[0].blocked) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('Expected PostgreSQL writer lock wait was not observed');
}
async function reviewedRpc(client, tenant) {
  const { rows } = await client.query(`SELECT public.resolve_dispute_reviewed_atomic(
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::timestamptz, $7::jsonb) AS result`,
  [tenant.workspace.id, tenant.dispute.id, tenant.admin.user.id, tenant.admin.member.id,
    RESOLUTION_NOTE, resolvedAt, JSON.stringify(tenant.expected)]);
  return rows[0].result;
}
async function ordinaryRpc(client, tenant) {
  const { rows } = await client.query('SELECT public.resolve_dispute_atomic($1::uuid, $2::text, $3::uuid, $4::timestamptz) AS result',
    [tenant.dispute.id, RESOLUTION_NOTE, tenant.admin.member.id, resolvedAt]);
  return rows[0].result;
}
async function states(client, tenant) {
  const { rows } = await client.query(`SELECT d.status AS dispute_status, e.status AS entry_status,
    d.resolution_note, d.resolved_by, d.resolved_at
    FROM public.disputes d JOIN public.ledger_entries e ON e.id = d.ledger_entry_id WHERE d.id = $1`, [tenant.dispute.id]);
  return rows[0];
}
const expectOpen = (row) => expect(row).toMatchObject({ dispute_status: 'open', entry_status: 'disputed',
  resolution_note: null, resolved_by: null, resolved_at: null });

describe('reviewed dispute resolution transaction boundaries', () => {
  const workspaceIds = [];
  async function tenant() {
    const admin = await seedWorkspaceWithAdmin(supabaseAdmin, { workspace: { base_currency: 'NGN' } });
    workspaceIds.push(admin.workspace.id);
    const owner = await seedAdditionalMember(supabaseAdmin, admin.workspace.id);
    const { container } = await seedContainerWithParticipants(supabaseAdmin, { workspaceId: admin.workspace.id,
      createdBy: admin.member.id, participants: [{ workspace_member_id: owner.member.id, money_enabled: true }] });
    const entry = await seedLedgerEntry(supabaseAdmin, { workspace_id: admin.workspace.id, container_id: container.id,
      contributor_id: owner.member.id, recorded_by: owner.member.id, status: 'disputed',
      original_amount: '5000.25', original_currency: 'NGN', base_amount: '5000.25',
      recorded_at: '2026-11-15T12:01:00.123Z', confirmed_at: '2026-11-15T12:02:00.456Z', confirmed_by: admin.member.id });
    const inserted = await supabaseAdmin.from('disputes').insert(buildDispute({ workspace_id: admin.workspace.id,
      ledger_entry_id: entry.id, raised_by: owner.member.id })).select().single();
    if (inserted.error) throw inserted.error;
    const expected = await disputes.getResolveDisputeContext({ workspaceId: admin.workspace.id, disputeId: inserted.data.id,
      callerId: admin.member.id, userId: admin.user.id, isAdmin: true });
    return { workspace: admin.workspace, admin, owner, container, entry, dispute: inserted.data, expected };
  }
  afterAll(async () => {
    for (const id of workspaceIds.reverse()) await cleanupWorkspace(supabaseAdmin, id);
    await pool.end();
  });

  it('returns exact dual projections and preserves unrelated notes/proofs from the same transaction', async () => {
    const current = await tenant(); const client = await session();
    try {
      await client.query('UPDATE public.disputes SET notes = $2::jsonb WHERE id = $1', [current.dispute.id, JSON.stringify([{ note: 'Private added context' }])]);
      await client.query('UPDATE public.ledger_entries SET proofs = $2::jsonb WHERE id = $1', [current.entry.id, JSON.stringify([{ name: 'Private proof metadata' }])]);
      const result = await reviewedRpc(client, current);
      expect(result.entry).toEqual({ ...current.expected.entry, status: 'resolved' });
      expect(result.dispute).toEqual({ ...current.expected.dispute, status: 'resolved', resolution_note: RESOLUTION_NOTE,
        resolved_by: current.admin.member.id, resolved_at: expect.any(String) });
      expect(Date.parse(result.dispute.resolved_at)).toBe(Date.parse(resolvedAt));
      const { rows } = await client.query('SELECT e.proofs, d.notes FROM public.ledger_entries e JOIN public.disputes d ON d.ledger_entry_id = e.id WHERE d.id = $1', [current.dispute.id]);
      expect(rows[0]).toEqual({ proofs: [{ name: 'Private proof metadata' }], notes: [{ note: 'Private added context' }] });
      expect(JSON.stringify(result)).not.toMatch(/Private|proofs|"notes"|idempotency_key/);
    } finally { await release(client); }
  });

  it.each(['ordinary', 'reviewed'])('rejects %s resolution when the expected ledger transition is no longer applicable', async (kind) => {
    const current = await tenant(); const client = await session();
    try {
      await client.query("UPDATE public.ledger_entries SET status = 'resolved' WHERE id = $1", [current.entry.id]);
      const outcome = await attempt(kind === 'ordinary' ? ordinaryRpc(client, current) : reviewedRpc(client, current));
      expect(outcome.error).toMatchObject({ code: 'P0001' });
      if (kind === 'reviewed') expect(outcome.error.message).toBe('REVIEWED_DISPUTE_STALE');
      expect(await states(client, current)).toMatchObject({ dispute_status: 'open', entry_status: 'resolved', resolution_note: null });
    } finally { await release(client); }
  });

  it.each(['ordinary', 'reviewed'].flatMap((kind) => ['ledger_entries', 'disputes'].map((table) => [kind, table])))(
    'rolls back both %s transitions when a %s trigger suppresses a required update', async (kind, table) => {
      const current = await tenant(); const client = await session();
      const suffix = randomUUID().replaceAll('-', '');
      try {
        await client.query('BEGIN');
        const id = table === 'ledger_entries' ? current.entry.id : current.dispute.id;
        // IDs/table names here are fixed fixture values, not caller input. DDL
        // and the trigger itself are rolled back after this one isolated case.
        await client.query(`CREATE FUNCTION public.test_suppress_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF OLD.id = '${id}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END; $$;
          CREATE TRIGGER test_suppress_${suffix} BEFORE UPDATE ON public.${table}
          FOR EACH ROW EXECUTE FUNCTION public.test_suppress_${suffix}()`);
        await client.query('SAVEPOINT mutation');
        const outcome = await attempt(kind === 'ordinary' ? ordinaryRpc(client, current) : reviewedRpc(client, current));
        expect(outcome.error).toMatchObject({ code: 'P0001' });
        await client.query('ROLLBACK TO SAVEPOINT mutation');
        expectOpen(await states(client, current));
      } finally { await release(client); }
    });

  it.each([
    ['workspaces', 'workspace', 'base_currency', 'USD'], ['workspaces', 'workspace', 'deleted_at', resolvedAt],
    ['workspace_members', 'admin', 'role', 'member'], ['workspace_members', 'admin', 'is_active', false],
    ['workspace_members', 'owner', 'is_active', false], ['workspace_members', 'owner', 'is_proxy', true],
    ['containers', 'container', 'status', 'archived'], ['containers', 'container', 'enable_money', false],
    ['disputes', 'dispute', 'reason', 'Changed by an ordinary writer during execution.'],
  ])('rejects a committed competing %s.%s eligibility edit after observing its lock wait', async (table, target, field, value) => {
    const current = await tenant(); const writer = await session(); const executor = await session(); const observer = await session();
    let pending;
    try {
      const id = ['admin', 'owner'].includes(target) ? current[target].member.id : current[target].id;
      await writer.query('BEGIN');
      // workspace_members_check only allows is_proxy = true with no linked user.
      const assignment = field === 'is_proxy' ? 'is_proxy = $2, user_id = NULL' : `${field} = $2`;
      await writer.query(`UPDATE public.${table} SET ${assignment} WHERE id = $1`, [id, value]);
      pending = attempt(reviewedRpc(executor, current));
      await waitForBlock(observer, executor, writer);
      await writer.query('COMMIT');
      const outcome = await pending;
      expect(outcome.error).toMatchObject({ code: 'P0001', message: 'REVIEWED_DISPUTE_STALE' });
      expectOpen(await states(observer, current));
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      if (pending) await pending;
      await Promise.all([release(writer), release(executor), release(observer)]);
    }
  });

  it('blocks an ordinary owner update until the reviewed transaction commits, without canceling the later edit', async () => {
    const current = await tenant(); const executor = await session(); const writer = await session(); const observer = await session();
    let pending;
    try {
      await executor.query('BEGIN');
      const result = await reviewedRpc(executor, current);
      pending = attempt(writer.query('UPDATE public.workspace_members SET is_active = false WHERE id = $1', [current.owner.member.id]));
      await waitForBlock(observer, writer, executor);
      await executor.query('COMMIT');
      expect((await pending).error).toBeUndefined();
      expect(result.entry.status).toBe('resolved');
      expect(await states(observer, current)).toMatchObject({ entry_status: 'resolved', dispute_status: 'resolved' });
    } finally {
      await executor.query('ROLLBACK').catch(() => {});
      if (pending) await pending;
      await Promise.all([release(executor), release(writer), release(observer)]);
    }
  });

  it.each(['ordinary', 'reviewed'])('serializes a competing resolver when the %s RPC wins first', async (winner) => {
    const current = await tenant(); const first = await session(); const second = await session(); const observer = await session();
    let pending;
    try {
      await first.query('BEGIN');
      await (winner === 'ordinary' ? ordinaryRpc(first, current) : reviewedRpc(first, current));
      pending = attempt(winner === 'ordinary' ? reviewedRpc(second, current) : ordinaryRpc(second, current));
      await waitForBlock(observer, second, first);
      await first.query('COMMIT');
      expect((await pending).error).toMatchObject({ code: 'P0001' });
      expect(await states(observer, current)).toMatchObject({ entry_status: 'resolved', dispute_status: 'resolved',
        resolution_note: RESOLUTION_NOTE, resolved_by: current.admin.member.id });
    } finally {
      await first.query('ROLLBACK').catch(() => {});
      if (pending) await pending;
      await Promise.all([release(first), release(second), release(observer)]);
    }
  });

  it('denies anonymous/authenticated execution and allows a service-role call in rollback-only ACL fixtures', async () => {
    const current = await tenant(); const client = await session();
    try {
      await client.query('BEGIN');
      // Plain test Postgres has no Supabase roles. Create missing fixtures and
      // execute the exact consolidated ACL block within this rollback-only txn.
      await client.query(`DO $$ DECLARE r text; BEGIN
        FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
          END IF;
        END LOOP;
      END; $$`);
      const source = readFileSync(resolve(__dirname, '../../../../migrations/001_schema.sql'), 'utf8');
      const start = source.indexOf('REVOKE ALL ON FUNCTION public.resolve_dispute_atomic(');
      const end = source.indexOf('CREATE FUNCTION public.replace_user_contacts_atomic', start);
      if (start < 0 || end < start) throw new Error('Resolution ACL source block was not found');
      await client.query(source.slice(start, end));
      for (const role of ['anon', 'authenticated', 'service_role']) {
        await client.query('SAVEPOINT role_call');
        await client.query(`SET LOCAL ROLE ${role}`);
        const outcome = await attempt(reviewedRpc(client, current));
        if (role === 'service_role') expect(outcome.value.entry.status).toBe('resolved');
        else expect(outcome.error).toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT role_call');
      }
      expectOpen(await states(client, current));
    } finally { await release(client); }
  });
});
