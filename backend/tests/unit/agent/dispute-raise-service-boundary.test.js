// The actual service is exercised; PostgreSQL atomicity and live races remain integration coverage.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));

const disputes = require('../../../src/services/dispute.service');
const audit = require('../../../src/services/audit.service');
const notification = require('../../../src/services/notification.service');
const logger = require('../../../src/utils/logger');
const { ConflictError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const { OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, ENTRY_ID, DISPUTE_ID, PROPOSAL_ID, SESSION_ID, CONVERSATION_ID, EXECUTION_TIME, REASON,
  context, member, workspaceRow, containerRow, entrySnapshot, entryRow, raiseContext, disputeRow, plannedDispute, raiseResult,
} = require('../../helpers/agent-dispute-raise');
const db = require('../../../src/config/supabase').__mockInstance;
const actor = context();
const actorCtx = { workspaceId: actor.workspace.id, actorUserId: actor.userId,
  actorMemberId: actor.member.id, ipAddress: '127.0.0.1', userAgent: 'dispute-raise-boundary-test' };
const unavailable = { code: 'DISPUTE_RAISE_UNAVAILABLE', statusCode: 503,
  message: 'Dispute creation is unavailable. Please try again.' };
const caller = (changes = {}) => ({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
  entryId: ENTRY_ID, callerId: actor.member.id, userId: actor.userId, isAdmin: false, ...changes });
const reviewed = (changes = {}) => ({ userId: actor.userId, isAdmin: false, proposalId: PROPOSAL_ID,
  trace: { sessionId: SESSION_ID, conversationId: CONVERSATION_ID }, expected: raiseContext(), ...changes });
const parameters = (changes = {}) => ({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
  entryId: ENTRY_ID, callerId: actor.member.id, isAdmin: false, reason: REASON,
  actorDisplayName: actor.member.displayName, actorCtx, reviewedRaise: reviewed(), ...changes });
const response = (data) => ({ data, error: null });
function contextResponses(changes = {}) {
  return Object.entries({ workspace: workspaceRow, actor: member, container: containerRow, entry: entryRow,
    open: () => null }).map(([name, fixture]) => response(changes[name] === null ? null
    : name === 'open' ? changes.open ?? null : fixture(changes[name])));
}
const executed = (entry = {}) => ({ dispute: disputeRow(), entry: entryRow({ status: 'disputed', ...entry }) });
function scriptRaise({ changes = {}, rpc = response(raiseResult()), admins = response([{ id: OTHER_ID }]) } = {}) {
  db.mockResponses(...contextResponses(changes), admins);
  db.mockNextRpcResponse(rpc);
}
function queries(table) {
  const calls = db.getCalls();
  return calls.flatMap((call, start) => {
    if (call.method !== 'from' || call.args[0] !== table) return [];
    const end = calls.findIndex((next, index) => index > start && next.method === 'from');
    return [calls.slice(start, end < 0 ? undefined : end)];
  });
}
function expectNoDirectMutation() {
  for (const method of ['insert', 'update', 'delete', 'upsert']) expect(db.builder[method]).not.toHaveBeenCalled();
  expect(db.client.storage.from).not.toHaveBeenCalled();
  expect(db.client.from).not.toHaveBeenCalledWith('container_participants');
}
function expectNoEffects() {
  expect(audit.log).not.toHaveBeenCalled();
  expect(notification.send).not.toHaveBeenCalled();
  expectNoDirectMutation();
}
function expectNoWrite() {
  expect(db.client.rpc).not.toHaveBeenCalled();
  expectNoEffects();
}
beforeEach(() => {
  db.reset();
  jest.useFakeTimers().setSystemTime(new Date(EXECUTION_TIME));
  audit.log.mockResolvedValue();
  notification.send.mockResolvedValue();
});
afterEach(() => jest.useRealTimers());

it('returns the exact own-entry projection with scoped parents and no proof, idempotency or participant access', async () => {
  db.mockResponses(...contextResponses({ workspace: { private_settings: 'PRIVATE' }, actor: { admin_notes: 'PRIVATE' },
    entry: { proofs: [{ url: 'PRIVATE_UPLOAD', token: 'PRIVATE_TOKEN' }], idempotency_key: 'PRIVATE_KEY' } }));
  await expect(disputes.getRaiseDisputeContext(caller())).resolves.toEqual(raiseContext());
  expect(db.client.from.mock.calls).toEqual([
    ['workspaces'], ['workspace_members'], ['containers'], ['ledger_entries'], ['disputes'],
  ]);
  const scopes = [
    ['workspaces', [['eq', 'id', actor.workspace.id], ['is', 'deleted_at', null]]],
    ['workspace_members', [['eq', 'id', actor.member.id], ['eq', 'workspace_id', actor.workspace.id],
      ['eq', 'user_id', actor.userId], ['eq', 'is_active', true], ['eq', 'is_proxy', false], ['is', 'deleted_at', null]]],
    ['containers', [['eq', 'id', CONTAINER_ID], ['eq', 'workspace_id', actor.workspace.id], ['is', 'deleted_at', null]]],
    ['ledger_entries', [['eq', 'id', ENTRY_ID], ['eq', 'workspace_id', actor.workspace.id], ['eq', 'container_id', CONTAINER_ID]]],
    ['disputes', [['eq', 'workspace_id', actor.workspace.id], ['eq', 'ledger_entry_id', ENTRY_ID], ['eq', 'status', 'open']]],
  ];
  for (const [table, predicates] of scopes) expect(queries(table)[0]).toEqual(expect.arrayContaining(
    predicates.map(([method, ...args]) => ({ method, args })),
  ));
  const selectedColumns = db.builder.select.mock.calls.map(([columns]) => columns).join(' ');
  expect(selectedColumns).not.toMatch(/\*|proofs|proof_files|idempotency_key/);
  expect(selectedColumns).toContain('original_amount::text');
  expect(selectedColumns).toContain('base_amount::text');
  expectNoWrite();
});
it.each(['workspaceId', 'containerId', 'entryId', 'callerId', 'userId', 'isAdmin'])('rejects malformed caller %s before reading', async (field) => {
  await expect(disputes.getRaiseDisputeContext(caller({ [field]: 'invalid' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoWrite();
});
it.each([{ role: 'admin' }, { is_active: false }, { is_proxy: true }, { deleted_at: EXECUTION_TIME },
  { id: OTHER_ID }, { workspace_id: OTHER_ID }, { user_id: OTHER_ID }, { user_id: null }])('denies an ineligible or mismatched member %j', async (change) => {
  db.mockResponses(...contextResponses({ actor: change }));
  await expect(disputes.getRaiseDisputeContext(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members']]);
  expectNoWrite();
});
it.each([false, true])('denies another contributor even when isAdmin=%s', async (isAdmin) => {
  db.mockResponses(...contextResponses({ actor: { role: isAdmin ? 'admin' : 'member' }, entry: { contributor_id: OTHER_ID } }));
  await expect(disputes.getRaiseDisputeContext(caller({ isAdmin }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from).not.toHaveBeenCalledWith('disputes');
  expectNoWrite();
});
it.each([
  [{ workspace: null }, 'NOT_FOUND'], [{ actor: null }, 'FORBIDDEN'], [{ container: null }, 'NOT_FOUND'], [{ entry: null }, 'NOT_FOUND'],
  [{ workspace: { id: OTHER_ID } }, unavailable.code], [{ workspace: { deleted_at: EXECUTION_TIME } }, unavailable.code],
  [{ container: { id: OTHER_ID } }, unavailable.code], [{ container: { workspace_id: OTHER_ID } }, unavailable.code],
  [{ container: { deleted_at: EXECUTION_TIME } }, unavailable.code], [{ entry: { id: OTHER_ID } }, unavailable.code],
  [{ entry: { workspace_id: OTHER_ID } }, unavailable.code], [{ entry: { container_id: OTHER_ID } }, unavailable.code],
  [{ container: { status: 'archived' } }, 'BUSINESS_RULE_VIOLATION'],
  [{ container: { enable_money: false } }, 'BUSINESS_RULE_VIOLATION'], [{ container: { container_type: 'recurring' } }, 'BUSINESS_RULE_VIOLATION'],
  [{ open: disputeRow() }, 'BUSINESS_RULE_VIOLATION'], [{ open: disputeRow({ workspace_id: OTHER_ID }) }, unavailable.code],
  [{ workspace: { updated_at: undefined } }, unavailable.code], [{ actor: { updated_at: undefined } }, unavailable.code],
])('fails closed on missing, unscoped or ineligible context %j', async (changes, code) => {
  db.mockResponses(...contextResponses(changes));
  await expect(disputes.getRaiseDisputeContext(caller())).rejects.toMatchObject({ code });
  expectNoWrite();
});
it.each([
  { status: 'pending' }, { status: 'disputed' }, { entry_type: 'expense' }, { original_currency: 'USD' },
  { base_amount: '4999.00' }, { cycle_id: OTHER_ID }, { corrects_entry_id: OTHER_ID }, { is_crypto: true },
  { original_amount: '0.00', base_amount: '0.00' }, { original_amount: '-1.00', base_amount: '-1.00' },
])('denies a confirmed but unsupported contribution snapshot %j', async (entry) => {
  db.mockResponses(...contextResponses({ entry }));
  await expect(disputes.getRaiseDisputeContext(caller())).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  expectNoWrite();
});
it.each([
  { original_amount: 5000 }, { base_amount: 5000 }, { original_amount: 'NaN' }, { confirmed_at: undefined },
  { confirmed_by: 'invalid' }, { recorded_at: 'not-a-time' }, { payment_method: 'invalid' }, { note: {} },
])('keeps malformed monetary or ledger responses unavailable %j', async (entry) => {
  db.mockResponses(...contextResponses({ entry }));
  await expect(disputes.getRaiseDisputeContext(caller())).rejects.toMatchObject(unavailable);
  expectNoWrite();
});
it.each([0, 1, 2, 3, 4].flatMap((index) => [
  [index, { error: null }], [index, { data: [], error: null }], [index, { data: contextResponses()[index].data }],
  [index, { data: contextResponses()[index].data, error: { message: 'PRIVATE_READ_ERROR' } }],
]))('normalizes malformed or failed read %s without exposing details', async (index, result) => {
  db.mockResponses(...contextResponses().slice(0, index), result);
  await expect(disputes.getRaiseDisputeContext(caller())).rejects.toMatchObject(unavailable);
  expectNoWrite();
});
it('keeps read transport uncertainty unavailable before any RPC', async () => {
  db.builder.maybeSingle.mockRejectedValueOnce(new ConflictError('PRIVATE_READ_CONFLICT'));
  await expect(disputes.raiseDispute(parameters())).rejects.toMatchObject(unavailable);
  expectNoWrite();
});
it.each([
  { workspace: { base_currency: undefined } }, { workspace: { name: undefined } },
  { workspace: { updated_at: 'not-a-time' } }, { workspace: { deleted_at: undefined } },
  { actor: { is_active: undefined } }, { actor: { is_proxy: 'false' } }, { actor: { user_id: undefined } },
  { actor: { role: undefined } }, { actor: { display_name: undefined } }, { actor: { updated_at: 'not-a-time' } },
  { container: { enable_money: undefined } }, { container: { status: undefined } }, { container: { container_type: undefined } },
  { container: { name: undefined } }, { container: { updated_at: 'not-a-time' } }, { container: { deleted_at: undefined } },
  { open: {} }, { open: { id: DISPUTE_ID, workspace_id: actor.workspace.id, ledger_entry_id: ENTRY_ID } },
  { open: { id: 'invalid', workspace_id: actor.workspace.id, ledger_entry_id: ENTRY_ID, status: 'open' } },
])('keeps malformed parent rows unavailable rather than marking approval stale %j', async (changes) => {
  scriptRaise({ changes });
  await expect(disputes.raiseDispute(parameters())).rejects.toMatchObject(unavailable);
  expectNoWrite();
});

it.each([undefined, '', '    ', 'four', 'x'.repeat(1001), {}, 'Reason\u0000text', 'Reason\uD800text', 'Reason\uDC00text'])(
  'rejects invalid reasons before reading or raising (%j)', async (reason) => {
    await expect(disputes.raiseDispute(parameters({ reason }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });
it.each([{ proposalId: 'invalid' }, { userId: undefined }, { trace: undefined },
  { trace: { sessionId: SESSION_ID } }, { trace: { sessionId: 'invalid', conversationId: null } },
  { trace: { sessionId: SESSION_ID, conversationId: 'invalid' } }, { expected: undefined }, { force: true },
  { expected: raiseContext({ entry: entrySnapshot({ proofs: [] }) }) },
  { expected: raiseContext({ entry: entrySnapshot({ idempotency_key: 'PRIVATE' }) }) },
])('rejects malformed reviews and private projection overrides %j', async (change) => {
  await expect(disputes.raiseDispute(parameters({ reviewedRaise: reviewed(change) }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoWrite();
});
it.each([
  { workspace_id: OTHER_ID }, { container_id: OTHER_ID }, { actor_member_id: OTHER_ID }, { member_role: 'admin' },
  ...['entry_id', 'workspace_id', 'container_id', 'contributor_id'].map((field) => ({ entry: entrySnapshot({ [field]: OTHER_ID }) })),
])('binds reviewed ownership, role and scope %j', async (change) => {
  await expect(disputes.raiseDispute(parameters({ reviewedRaise: reviewed({ expected: raiseContext(change) }) })))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoWrite();
});
it('binds the reviewed admin flag to the actual caller flag', async () => {
  await expect(disputes.raiseDispute(parameters({ reviewedRaise: reviewed({ isAdmin: true }) })))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expectNoWrite();
});
it.each([
  { workspace: { name: 'Renamed family' } }, { workspace: { updated_at: EXECUTION_TIME } },
  { actor: { display_name: 'Renamed member' } }, { actor: { updated_at: EXECUTION_TIME } }, { actor: { is_active: false } },
  { container: { name: 'Renamed event' } }, { container: { updated_at: EXECUTION_TIME } }, { container: { status: 'archived' } },
  { entry: { original_amount: '6000.00', base_amount: '6000.00' } }, { entry: { note: 'Changed note' } },
  { entry: { confirmed_by: actor.member.id } }, { entry: { contributor_id: OTHER_ID } }, { entry: { status: 'disputed' } },
  { open: disputeRow() }, { entry: null },
])('rejects stale approval context before RPC %j', async (changes) => {
  scriptRaise({ changes });
  await expect(disputes.raiseDispute(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
  expectNoWrite();
});

it.each([['member', false, null], ['admin', true, CONVERSATION_ID]])(
  'raises the own contribution as %s with exact RPC, canonical defaults, required sensitive audit and deduplicated notice',
  async (role, isAdmin, conversationId) => {
    scriptRaise({ changes: { actor: { role }, entry: { proofs: ['PRIVATE_MUTABLE_PROOF'], idempotency_key: 'PRIVATE' } } });
    const spoofed = { ...actorCtx, workspaceId: OTHER_ID, actorUserId: OTHER_ID, actorMemberId: OTHER_ID };
    await expect(disputes.raiseDispute(parameters({ isAdmin, reason: `  ${REASON}  `, actorCtx: spoofed,
      reviewedRaise: reviewed({ isAdmin, trace: { sessionId: SESSION_ID, conversationId }, expected: raiseContext({ member_role: role }) }),
    }))).resolves.toEqual(executed());
    expect(db.getRpcCalls()).toEqual([{ fnName: 'raise_dispute_reviewed_atomic', params: {
      p_workspace_id: actor.workspace.id, p_user_id: actor.userId, p_raised_by: actor.member.id, p_reason: REASON,
      p_expected: raiseContext({ member_role: role }),
    } }]);
    expect(audit.log).toHaveBeenCalledWith({ ...actorCtx, required: true, action: AUDIT_ACTIONS.DISPUTE_RAISED,
      targetType: 'dispute', targetId: DISPUTE_ID, metadata: { agent_initiated: true, proposal_id: PROPOSAL_ID,
        session_id: SESSION_ID, conversation_id: conversationId, sensitive_action: true, secondary_confirmation: true } });
    expect(notification.send).toHaveBeenCalledWith({ type: 'contribution_disputed', workspaceId: actor.workspace.id,
      recipientIds: [OTHER_ID], referenceType: 'dispute', referenceId: DISPUTE_ID,
      variables: { actor: 'Adaeze', amount: '5000.00 NGN', container: 'Family groceries' },
      dedupKey: `contribution_disputed:${DISPUTE_ID}` });
    // The mutation's own projections are returned: there is no later ledger re-read.
    expect(queries('ledger_entries')).toHaveLength(1);
    expect(queries('workspace_members')[1]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['workspace_id', actor.workspace.id] }, { method: 'eq', args: ['role', 'admin'] },
      { method: 'eq', args: ['is_active', true] }, { method: 'is', args: ['deleted_at', null] },
    ]));
    expectNoDirectMutation();
  });
it('accepts the actual RPC-assigned ID/time and preserves a valid emoji reason', async () => {
  const reason = 'My contribution needs review 😀';
  const raised_at = '2026-11-16T12:03:00.125+00:00';
  scriptRaise({ rpc: response(raiseResult({ dispute: { ...plannedDispute({ reason }), dispute_id: OTHER_ID, raised_at } })) });
  await expect(disputes.raiseDispute(parameters({ reason: `  ${reason}  ` })))
    .resolves.toMatchObject({ dispute: { id: OTHER_ID, reason, raised_at } });
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ targetId: OTHER_ID }));
  expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ referenceId: OTHER_ID,
    dedupKey: `contribution_disputed:${OTHER_ID}` }));
});
it('supports confirmed legacy audit columns that are explicitly null without inventing values', async () => {
  const nullable = { recorded_by: null, confirmed_by: null, confirmed_at: null };
  const changed = entryRow({ ...nullable, status: 'disputed' });
  scriptRaise({ changes: { entry: nullable }, rpc: response(raiseResult({ entry: entrySnapshot({ ...nullable, status: 'disputed' }) })) });
  await expect(disputes.raiseDispute(parameters({ reviewedRaise: reviewed({
    expected: raiseContext({ entry: entrySnapshot(nullable) }),
  }) }))).resolves.toEqual({ dispute: disputeRow(), entry: changed });
  expect(audit.log).toHaveBeenCalledTimes(1);
  expect(notification.send).toHaveBeenCalledTimes(1);
});
it('awaits the native required audit before notifying admins', async () => {
  scriptRaise();
  let finishAudit;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  audit.log.mockImplementationOnce(() => {
    signalStarted();
    return new Promise((resolve) => { finishAudit = resolve; });
  });
  const execution = disputes.raiseDispute(parameters());
  await started;
  expect(notification.send).not.toHaveBeenCalled();
  finishAudit();
  await expect(execution).resolves.toEqual(executed());
  expect(queries('ledger_entries')).toHaveLength(1);
  expect(notification.send).toHaveBeenCalledTimes(1);
});

it.each([
  { code: '23505', message: 'PRIVATE_UNIQUE_REJECTION' },
  { code: 'P0001', message: 'REVIEWED_DISPUTE_STALE' },
])('reports only explicit null-data PostgreSQL rejection as definite conflict %j', async (error) => {
  scriptRaise({ rpc: { data: null, error } });
  await expect(disputes.raiseDispute(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expect(queries('ledger_entries')).toHaveLength(1);
  expectNoEffects();
});
it.each([
  response(null), response([]), response(raiseResult().dispute), response([raiseResult()]), { error: null }, { data: raiseResult() },
  response({ ...raiseResult(), proofs: [] }), { error: { code: '23505', message: 'PRIVATE_ERROR' } },
  { data: null, error: { code: 'P0001', message: 'REVIEWED_DISPUTE_STALE extra text' } },
  { data: null, error: { code: 'OTHER', message: 'REVIEWED_DISPUTE_STALE' } },
  // Only the reviewed RPC's typed rejection proves no mutation; ordinary/input errors stay uncertain.
  ...['ENTRY_NOT_DISPUTABLE', 'DISPUTE_ALREADY_OPEN', 'INVALID_REVIEWED_DISPUTE_INPUT']
    .map((message) => ({ data: null, error: { code: 'P0001', message } })),
  { data: raiseResult(), error: { code: '23505', message: 'PRIVATE_PARTIAL_ERROR' } },
  { data: raiseResult(), error: { code: 'P0001', message: 'REVIEWED_DISPUTE_STALE' } },
])('keeps malformed or partial RPC outcome uncertain %j', async (rpc) => {
  scriptRaise({ rpc });
  await expect(disputes.raiseDispute(parameters())).rejects.toMatchObject(unavailable);
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expect(queries('ledger_entries')).toHaveLength(1);
  expectNoEffects();
});
it.each([
  ...Object.keys(raiseResult().dispute).map((field) => [field, undefined]), ['dispute_id', 'invalid'], ['raised_at', 'invalid'],
  ['workspace_id', OTHER_ID], ['ledger_entry_id', OTHER_ID], ['raised_by', OTHER_ID], ['reason', 'Unreviewed reason'],
  ['status', 'resolved'], ['resolution_note', 'Resolved'], ['resolved_by', OTHER_ID], ['resolved_at', EXECUTION_TIME], ['notes', [{}]],
])('requires a full canonical new dispute after RPC (%s=%s)', async (field, value) => {
  scriptRaise({ rpc: response(raiseResult({ dispute: { ...raiseResult().dispute, [field]: value } })) });
  await expect(disputes.raiseDispute(parameters())).rejects.toMatchObject(unavailable);
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expectNoEffects();
});
it.each([new Error('PRIVATE_RPC_ERROR'), new ConflictError('PRIVATE_RPC_CONFLICT')])('normalizes thrown RPC uncertainty %s', async (error) => {
  db.mockResponses(...contextResponses());
  db.client.rpc.mockRejectedValueOnce(error);
  await expect(disputes.raiseDispute(parameters())).rejects.toMatchObject(unavailable);
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expectNoEffects();
});
it.each([new Error('PRIVATE_AUDIT_ERROR'), new ConflictError('PRIVATE_AUDIT_CONFLICT')])('keeps a native audit failure uncertain %s', async (error) => {
  scriptRaise();
  audit.log.mockRejectedValueOnce(error);
  await expect(disputes.raiseDispute(parameters())).rejects.toMatchObject(unavailable);
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expect(audit.log).toHaveBeenCalledTimes(1);
  expect(queries('ledger_entries')).toHaveLength(1);
  expect(notification.send).not.toHaveBeenCalled();
  expectNoDirectMutation();
});
it.each([
  ...Object.keys(entrySnapshot()).map((field) => [field, undefined]),
  ['entry_id', OTHER_ID], ['workspace_id', OTHER_ID], ['container_id', OTHER_ID], ['contributor_id', OTHER_ID],
  ['original_amount', '6000.00'], ['base_amount', '6000.00'], ['original_amount', 5000], ['base_amount', 5000],
  ['payment_method', 'cash'], ['note', 'Changed after RPC'], ['recorded_by', OTHER_ID],
  ['recorded_at', EXECUTION_TIME], ['confirmed_by', actor.member.id], ['confirmed_at', EXECUTION_TIME], ['status', 'confirmed'],
])('verifies all approved ledger fields except the required disputed status (%s=%s)', async (field, value) => {
  scriptRaise({ rpc: response(raiseResult({ entry: entrySnapshot({ status: 'disputed', [field]: value }) })) });
  await expect(disputes.raiseDispute(parameters())).rejects.toMatchObject(unavailable);
  // Verification precedes the required audit: an unverifiable result is never audited as raised.
  expectNoEffects();
});

it.each([response(null), { error: null }, { data: [] }, response([null]), response([{ id: null }]),
  { data: [{ id: OTHER_ID }], error: { message: 'PRIVATE_ADMINS_ERROR' } }])('treats admin notification lookup failure as best effort %j', async (admins) => {
  scriptRaise({ admins });
  await expect(disputes.raiseDispute(parameters())).resolves.toEqual(executed());
  expect(notification.send).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expectNoDirectMutation();
});
it('returns the verified dispute when notification throws and logs only structured identifiers', async () => {
  scriptRaise();
  notification.send.mockRejectedValueOnce(new ConflictError('PRIVATE_NOTIFICATION_ERROR'));
  await expect(disputes.raiseDispute(parameters())).resolves.toEqual(executed());
  expect(notification.send).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith('Dispute creation notification unavailable', {
    workspaceId: actor.workspace.id, entryId: ENTRY_ID, disputeId: DISPUTE_ID, errorCode: 'CONFLICT',
  });
  expectNoDirectMutation();
});
it('preserves ordinary admin HTTP behavior for another member and pending entries without a reviewed claim', async () => {
  const legacyEntry = entryRow({ contributor_id: OTHER_ID, status: 'pending', original_amount: 5000 });
  db.mockResponses(response(legacyEntry), response([{ id: OTHER_ID }]));
  db.mockNextRpcResponse(response(disputeRow()));
  await expect(disputes.raiseDispute(parameters({ isAdmin: true, reviewedRaise: undefined })))
    .resolves.toEqual({ dispute: disputeRow(), entry: { ...legacyEntry, status: 'disputed' } });
  expect(db.client.from.mock.calls).toEqual([['ledger_entries'], ['workspace_members']]);
  expect(audit.log).toHaveBeenCalledWith({ ...actorCtx, action: AUDIT_ACTIONS.DISPUTE_RAISED,
    targetType: 'dispute', targetId: DISPUTE_ID });
  expect(notification.send).toHaveBeenCalledWith(expect.not.objectContaining({ dedupKey: expect.anything() }));
  expectNoDirectMutation();
});
