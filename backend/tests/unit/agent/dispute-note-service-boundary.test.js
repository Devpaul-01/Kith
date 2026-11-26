// The actual service is exercised; PostgreSQL atomicity and live races remain integration coverage.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));

const disputes = require('../../../src/services/dispute.service');
const { ConflictError } = require('../../../src/utils/errors');
const { context, member, workspaceRow, DISPUTE_ID, ENTRY_ID } = require('../../helpers/agent-dispute-raise');
const { OTHER_ID } = require('../../helpers/agent-proposal');
const db = require('../../../src/config/supabase').__mockInstance;

const actor = context();
const NOTE = 'I attached the receipt to the group chat.';
const RAISED_AT = '2026-11-16T12:03:00.000Z';
const unavailable = { code: 'DISPUTE_NOTE_UNAVAILABLE', statusCode: 503 };
const caller = (changes = {}) => ({ workspaceId: actor.workspace.id, disputeId: DISPUTE_ID,
  callerId: actor.member.id, userId: actor.userId, ...changes });
const disputeRow = (changes = {}) => ({ id: DISPUTE_ID, workspace_id: actor.workspace.id, ledger_entry_id: ENTRY_ID,
  raised_by: actor.member.id, reason: 'The recorded amount does not match my contribution.', status: 'open',
  raised_at: RAISED_AT, notes: [{ ignored: 'never selected' }], ...changes });
const response = (data) => ({ data, error: null });
function script({ workspace = workspaceRow(), actorRow = member(), dispute = disputeRow() } = {}) {
  db.mockResponses(response(workspace), response(actorRow), response(dispute));
}
const expectedContext = (changes = {}) => ({ workspace_id: actor.workspace.id, actor_member_id: actor.member.id,
  member_role: 'member', dispute: { dispute_id: DISPUTE_ID, ledger_entry_id: ENTRY_ID, raised_by: actor.member.id,
    reason: 'The recorded amount does not match my contribution.', status: 'open', raised_at: RAISED_AT }, ...changes });
const appendedRow = (changes = {}) => ({ id: DISPUTE_ID, workspace_id: actor.workspace.id, status: 'open',
  notes: [{ author_id: OTHER_ID, note: 'earlier', added_at: '2026-11-26T09:00:00.000Z' },
    { author_id: actor.member.id, note: NOTE, added_at: '2026-11-26T10:00:00.123Z' }], ...changes });
const append = (changes = {}) => disputes.addReviewedDisputeNote({ workspaceId: actor.workspace.id, disputeId: DISPUTE_ID,
  note: NOTE, authorMemberId: actor.member.id, ...changes });

beforeEach(() => db.reset());

describe('getDisputeNoteContext', () => {
  it('returns only the immutable dispute identity, scoped to the workspace, with no notes or private columns', async () => {
    script();
    await expect(disputes.getDisputeNoteContext(caller())).resolves.toEqual(expectedContext());
    expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members'], ['disputes']]);
    const columns = db.builder.select.mock.calls.map(([value]) => value).join(' ');
    expect(columns).not.toMatch(/\*|notes|resolution_note/);
    expect(db.getCalls()).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', DISPUTE_ID] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['user_id', actor.userId] }, { method: 'eq', args: ['is_proxy', false] },
    ]));
    for (const method of ['insert', 'update', 'delete', 'upsert']) expect(db.builder[method]).not.toHaveBeenCalled();
    expect(db.client.rpc).not.toHaveBeenCalled();
  });

  it('lets an admin who did not raise the dispute select it', async () => {
    script({ actorRow: member({ role: 'admin' }), dispute: disputeRow({ raised_by: OTHER_ID }) });
    await expect(disputes.getDisputeNoteContext(caller())).resolves.toMatchObject({
      member_role: 'admin', dispute: { raised_by: OTHER_ID } });
  });

  it.each(['workspaceId', 'disputeId', 'callerId', 'userId'])('rejects malformed %s before reading', async (field) => {
    await expect(disputes.getDisputeNoteContext(caller({ [field]: 'invalid' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
  });

  it('denies a member who is neither admin nor raiser, even when the dispute is resolved', async () => {
    script({ dispute: disputeRow({ raised_by: OTHER_ID }) });
    await expect(disputes.getDisputeNoteContext(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    script({ dispute: disputeRow({ raised_by: OTHER_ID, status: 'resolved' }) });
    await expect(disputes.getDisputeNoteContext(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a resolved dispute for an authorized caller', async () => {
    script({ dispute: disputeRow({ status: 'resolved' }) });
    await expect(disputes.getDisputeNoteContext(caller())).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it.each([
    [{ workspace: null }, 'NOT_FOUND'], [{ actorRow: null }, 'FORBIDDEN'], [{ dispute: null }, 'NOT_FOUND'],
    [{ actorRow: member({ id: OTHER_ID }) }, 'FORBIDDEN'], [{ actorRow: member({ user_id: OTHER_ID }) }, 'FORBIDDEN'],
    [{ actorRow: member({ is_active: false }) }, 'FORBIDDEN'], [{ actorRow: member({ is_proxy: true }) }, 'FORBIDDEN'],
  ])('fails closed on missing or ineligible rows %j', async (changes, code) => {
    script(changes);
    await expect(disputes.getDisputeNoteContext(caller())).rejects.toMatchObject({ code });
  });

  it.each([
    [{ workspace: workspaceRow({ id: OTHER_ID }) }], [{ workspace: workspaceRow({ deleted_at: RAISED_AT }) }],
    [{ dispute: disputeRow({ id: OTHER_ID }) }], [{ dispute: disputeRow({ workspace_id: OTHER_ID }) }],
    [{ dispute: disputeRow({ reason: undefined }) }], [{ dispute: disputeRow({ raised_at: 'not-a-time' }) }],
    [{ dispute: disputeRow({ status: 'cancelled' }) }], [{ actorRow: member({ role: 'owner' }) }],
  ])('keeps malformed or unscoped rows unavailable %j', async (changes) => {
    script(changes);
    await expect(disputes.getDisputeNoteContext(caller())).rejects.toMatchObject(unavailable);
  });

  it.each([{ error: null }, { data: [], error: null }, { data: disputeRow(), error: { message: 'PRIVATE_READ_ERROR' } }])(
    'normalizes a failed or malformed read without exposing details %j', async (result) => {
      db.mockResponses(result);
      await expect(disputes.getDisputeNoteContext(caller())).rejects.toMatchObject(unavailable);
    });
});

describe('addReviewedDisputeNote', () => {
  it('calls the atomic RPC requiring an open dispute and returns the verified appended note', async () => {
    db.mockNextRpcResponse(response(appendedRow()));
    await expect(append()).resolves.toEqual({ dispute_id: DISPUTE_ID,
      note: { author_id: actor.member.id, note: NOTE, added_at: '2026-11-26T10:00:00.123Z' } });
    expect(db.getRpcCalls()).toEqual([{ fnName: 'add_dispute_note_atomic', params: {
      p_workspace_id: actor.workspace.id, p_dispute_id: DISPUTE_ID, p_author_id: actor.member.id,
      p_note: NOTE, p_require_open: true } }]);
    expect(db.client.from).not.toHaveBeenCalled();
  });

  it('trims the note and rejects unusable input before calling the database', async () => {
    db.mockNextRpcResponse(response(appendedRow()));
    await append({ note: `  ${NOTE}  ` });
    expect(db.getRpcCalls()[0].params.p_note).toBe(NOTE);
    db.reset();
    for (const bad of [{ note: '   ' }, { note: 'x'.repeat(1001) }, { note: 'a\u0000b' }, { disputeId: 'invalid' }, { authorMemberId: 'invalid' }]) {
      await expect(append(bad)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(db.client.rpc).not.toHaveBeenCalled();
  });

  it.each(['DISPUTE_NOT_FOUND', 'DISPUTE_ACCESS_DENIED', 'DISPUTE_NOT_OPEN'])(
    'reports only the typed rejection %s as a definite conflict', async (message) => {
      db.mockNextRpcResponse({ data: null, error: { code: 'P0001', message } });
      await expect(append()).rejects.toBeInstanceOf(ConflictError);
    });

  it.each([
    { data: null, error: { code: 'P0001', message: 'DISPUTE_NOT_OPEN extra' } },
    { data: null, error: { code: 'OTHER', message: 'DISPUTE_NOT_OPEN' } },
    { data: null, error: { code: 'P0001', message: 'INVALID_DISPUTE_NOTE' } },
    { data: null, error: { code: '40001', message: 'serialization' } },
    { data: appendedRow(), error: { code: 'P0001', message: 'DISPUTE_NOT_OPEN' } },
    { error: null }, response(null), response([]), response({}),
  ])('keeps malformed or partial outcome uncertain %j', async (result) => {
    db.mockNextRpcResponse(result);
    await expect(append()).rejects.toMatchObject(unavailable);
  });

  it.each([
    ['a different dispute', { id: OTHER_ID }], ['another workspace', { workspace_id: OTHER_ID }],
    ['a closed dispute', { status: 'resolved' }], ['no notes', { notes: [] }],
    ['a different last author', { notes: [{ author_id: OTHER_ID, note: NOTE, added_at: '2026-11-26T10:00:00.123Z' }] }],
    ['a different last note', { notes: [{ author_id: actor.member.id, note: 'Other text', added_at: '2026-11-26T10:00:00.123Z' }] }],
    ['a malformed last note', { notes: [{ author_id: actor.member.id, note: NOTE }] }],
  ])('keeps a result with %s uncertain', async (_label, changes) => {
    db.mockNextRpcResponse(response(appendedRow(changes)));
    await expect(append()).rejects.toMatchObject(unavailable);
  });

  it('normalizes a thrown RPC failure as uncertain', async () => {
    db.client.rpc.mockRejectedValueOnce(new Error('PRIVATE_RPC_ERROR'));
    await expect(append()).rejects.toMatchObject(unavailable);
  });
});
