// Requires real Postgres/PostgREST/Redis. Direct sessions with observed lock waits
// prove concurrent notes are preserved, which the former service-side
// read-modify-write of the whole array could not guarantee.
const { Pool } = require('pg');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { seedWorkspaceWithAdmin, seedAdditionalMember, seedContainerWithParticipants, seedLedgerEntry, cleanupWorkspace } = require('../../helpers/dbHelper');

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
const addNote = (client, t, { author = t.owner.member.id, note = 'Receipt attached', requireOpen = false, dispute = t.dispute } = {}) => client.query(
  'SELECT public.add_dispute_note_atomic($1::uuid, $2::uuid, $3::uuid, $4::text, $5::boolean) AS result',
  [t.workspace.id, dispute, author, note, requireOpen]).then(({ rows }) => rows[0].result);
const notesOf = async (t) => (await pool.query('SELECT notes FROM public.disputes WHERE id = $1', [t.dispute])).rows[0].notes;

describe('atomic dispute note append', () => {
  const workspaceIds = [];
  async function tenant({ status = 'open' } = {}) {
    const admin = await seedWorkspaceWithAdmin(supabaseAdmin, { workspace: { base_currency: 'NGN' } });
    workspaceIds.push(admin.workspace.id);
    const owner = await seedAdditionalMember(supabaseAdmin, admin.workspace.id);
    const stranger = await seedAdditionalMember(supabaseAdmin, admin.workspace.id);
    const { container } = await seedContainerWithParticipants(supabaseAdmin, { workspaceId: admin.workspace.id,
      createdBy: admin.member.id, participants: [{ workspace_member_id: owner.member.id, money_enabled: true }] });
    const entry = await seedLedgerEntry(supabaseAdmin, { workspace_id: admin.workspace.id, container_id: container.id,
      contributor_id: owner.member.id, recorded_by: owner.member.id, status: 'disputed',
      original_amount: '5000.00', original_currency: 'NGN', base_amount: '5000.00',
      confirmed_at: '2026-11-15T12:02:00.000Z', confirmed_by: admin.member.id });
    const { rows } = await pool.query(`INSERT INTO public.disputes (workspace_id, ledger_entry_id, raised_by, reason, status)
      VALUES ($1, $2, $3, 'The amount is wrong', 'open') RETURNING id`, [admin.workspace.id, entry.id, owner.member.id]);
    if (status !== 'open') {
      await pool.query(`UPDATE public.disputes SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = 'Resolved after review'
        WHERE id = $1`, [rows[0].id, status, admin.member.id]);
    }
    return { workspace: admin.workspace, admin, owner, stranger, container, entry, dispute: rows[0].id };
  }
  afterAll(async () => {
    for (const id of workspaceIds.reverse()) await cleanupWorkspace(supabaseAdmin, id);
    await pool.end();
  });

  it('appends one note with author and timestamp and returns the updated dispute', async () => {
    const t = await tenant();
    const result = await addNote(pool, t);
    expect(result).toMatchObject({ id: t.dispute, status: 'open' });
    expect(result.notes).toEqual([{ author_id: t.owner.member.id, note: 'Receipt attached',
      added_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) }]);
    expect(await notesOf(t)).toEqual(result.notes);
  });

  it('preserves earlier notes in order', async () => {
    const t = await tenant();
    await addNote(pool, t, { note: 'first' });
    await addNote(pool, t, { author: t.admin.member.id, note: 'second' });
    expect((await notesOf(t)).map((n) => n.note)).toEqual(['first', 'second']);
  });

  it('preserves both notes when two authors append concurrently', async () => {
    const t = await tenant(); const [a, b] = [await session(), await session()];
    try {
      await a.query('BEGIN');
      await addNote(a, t, { note: 'from raiser' });
      const second = attempt(addNote(b, t, { author: t.admin.member.id, note: 'from admin' }));
      await waitForBlock(b, a);
      await a.query('COMMIT');
      expect((await second).error).toBeUndefined();
      expect((await notesOf(t)).map((n) => n.note)).toEqual(['from raiser', 'from admin']);
    } finally { await release(a); await release(b); }
  });

  it.each([
    ['an unrelated member', (t) => ({ author: t.stranger.member.id })],
  ])('denies %s', async (_label, pick) => {
    const t = await tenant();
    expect((await attempt(addNote(pool, t, pick(t)))).error?.message).toMatch(/DISPUTE_ACCESS_DENIED/);
    expect(await notesOf(t)).toEqual([]);
  });

  it.each([
    ['deactivated', 'UPDATE public.workspace_members SET is_active = false WHERE id = $1'],
    ['a proxy', 'UPDATE public.workspace_members SET is_proxy = true, user_id = NULL WHERE id = $1'],
    ['deleted', 'UPDATE public.workspace_members SET deleted_at = now() WHERE id = $1'],
  ])('denies an author who became %s', async (_label, sql) => {
    const t = await tenant();
    await pool.query(sql, [t.owner.member.id]);
    expect((await attempt(addNote(pool, t))).error?.message).toMatch(/DISPUTE_ACCESS_DENIED/);
    expect(await notesOf(t)).toEqual([]);
  });

  it('treats a missing, foreign-workspace or deleted-workspace dispute as not found', async () => {
    const t = await tenant(); const other = await tenant();
    expect((await attempt(addNote(pool, t, { dispute: '00000000-0000-4000-8000-000000000000' }))).error?.message).toMatch(/DISPUTE_NOT_FOUND/);
    expect((await attempt(addNote(pool, t, { dispute: other.dispute }))).error?.message).toMatch(/DISPUTE_NOT_FOUND/);
    await pool.query('UPDATE public.workspaces SET deleted_at = now() WHERE id = $1', [t.workspace.id]);
    expect((await attempt(addNote(pool, t))).error?.message).toMatch(/DISPUTE_NOT_FOUND/);
  });

  it('allows notes on a resolved dispute unless the reviewed path requires it to be open', async () => {
    const t = await tenant({ status: 'resolved' });
    expect((await attempt(addNote(pool, t, { requireOpen: true }))).error?.message).toMatch(/DISPUTE_NOT_OPEN/);
    expect(await notesOf(t)).toEqual([]);
    await addNote(pool, t, { note: 'legacy resolved note' });
    expect((await notesOf(t)).map((n) => n.note)).toEqual(['legacy resolved note']);
  });

  it.each([['empty', ''], ['too long', 'x'.repeat(1001)]])('rejects an %s note', async (_label, note) => {
    const t = await tenant();
    expect((await attempt(addNote(pool, t, { note }))).error?.message).toMatch(/INVALID_DISPUTE_NOTE/);
    expect(await notesOf(t)).toEqual([]);
  });

  it('requires a pre-trimmed note on the reviewed path', async () => {
    const t = await tenant();
    expect((await attempt(addNote(pool, t, { note: ' padded ', requireOpen: true }))).error?.message).toMatch(/INVALID_DISPUTE_NOTE/);
    await addNote(pool, t, { note: ' padded ' });
    expect((await notesOf(t))[0].note).toBe(' padded ');
  });

  it('pins the search path and withholds PUBLIC execution', async () => {
    const { rows } = await pool.query(`SELECT proconfig, proacl::text AS acl FROM pg_proc WHERE proname = 'add_dispute_note_atomic'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].proconfig).toEqual(['search_path=pg_catalog, public']);
    expect(rows[0].acl === null || !/(^|[{,])=X/.test(rows[0].acl)).toBe(true);
  });
});
