// Exercises the real service; live PostgreSQL atomicity and eligibility races need integration coverage.
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
const {
  CONTAINER_ID, ENTRY_ID, DISPUTE_ID, CONTRIBUTOR_ID, PROPOSAL_ID, SESSION_ID, CONVERSATION_ID,
  EXECUTION_TIME, RESOLUTION_NOTE, adminContext, adminMember, contributorRow, workspaceRow, containerRow,
  entrySnapshot, entryRow, disputeSnapshot, disputeRow, resolveContext, resolvedDispute, resolvedEntry,
} = require('../../helpers/agent-dispute-resolve');
const db = require('../../../src/config/supabase').__mockInstance;
const actor = adminContext();
const UNRELATED_ID = '99999999-9999-4999-8999-999999999999';
const actorCtx = { workspaceId: actor.workspace.id, actorUserId: actor.userId,
  actorMemberId: actor.member.id, ipAddress: '127.0.0.1', userAgent: 'dispute-resolve-boundary-test' };
const unavailable = { code: 'DISPUTE_RESOLVE_UNAVAILABLE', statusCode: 503,
  message: 'Dispute resolution is unavailable. Please try again.' };
const caller = (overrides = {}) => ({ workspaceId: actor.workspace.id, disputeId: DISPUTE_ID,
  callerId: actor.member.id, userId: actor.userId, isAdmin: true, ...overrides });
const reviewed = (overrides = {}) => ({ userId: actor.userId, isAdmin: true, proposalId: PROPOSAL_ID,
  trace: { sessionId: SESSION_ID, conversationId: CONVERSATION_ID }, expected: resolveContext(), ...overrides });
const parameters = (overrides = {}) => ({ workspaceId: actor.workspace.id, disputeId: DISPUTE_ID,
  resolutionNote: RESOLUTION_NOTE, resolvedByMemberId: actor.member.id, isAdmin: true,
  actorCtx, reviewedResolution: reviewed(), ...overrides });
const response = (data) => ({ data, error: null });
const fixtures = { workspace: workspaceRow, actor: adminMember, dispute: disputeRow,
  entry: entryRow, container: containerRow, contributor: contributorRow };
function contextResponses(changes = {}) {
  return Object.entries(fixtures).map(([name, fixture]) => response(changes[name] === null ? null : fixture(changes[name])));
}
function scriptResolution({ changes = {}, rpc = response(resolvedDispute()), reread = response(resolvedEntry()) } = {}) {
  db.mockResponses(...contextResponses(changes), reread);
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

it('returns the exact scoped projection without reading proofs, appended notes, private keys or current participation', async () => {
  const privateEntry = { proofs: [{ path: 'PRIVATE_PROOF', token: 'PRIVATE_TOKEN' }], idempotency_key: 'PRIVATE_KEY' };
  const privateDispute = { notes: [{ note: 'PRIVATE_NOTE', author_id: CONTRIBUTOR_ID }] };
  db.mockResponses(...contextResponses({ workspace: { private_settings: 'PRIVATE' }, actor: { admin_notes: 'PRIVATE' },
    entry: privateEntry, dispute: privateDispute, contributor: { admin_notes: 'PRIVATE' } }));
  await expect(disputes.getResolveDisputeContext(caller())).resolves.toEqual(resolveContext());
  expect(db.client.from.mock.calls).toEqual([
    ['workspaces'], ['workspace_members'], ['disputes'], ['ledger_entries'], ['containers'], ['workspace_members'],
  ]);
  const scopes = [
    [queries('workspaces')[0], [['eq', 'id', actor.workspace.id], ['is', 'deleted_at', null]]],
    [queries('workspace_members')[0], [['eq', 'id', actor.member.id], ['eq', 'workspace_id', actor.workspace.id],
      ['eq', 'user_id', actor.userId], ['eq', 'role', 'admin'], ['eq', 'is_active', true], ['eq', 'is_proxy', false], ['is', 'deleted_at', null]]],
    [queries('disputes')[0], [['eq', 'id', DISPUTE_ID], ['eq', 'workspace_id', actor.workspace.id]]],
    [queries('ledger_entries')[0], [['eq', 'id', ENTRY_ID], ['eq', 'workspace_id', actor.workspace.id]]],
    [queries('containers')[0], [['eq', 'id', CONTAINER_ID], ['eq', 'workspace_id', actor.workspace.id], ['is', 'deleted_at', null]]],
    [queries('workspace_members')[1], [['eq', 'id', CONTRIBUTOR_ID], ['eq', 'workspace_id', actor.workspace.id],
      ['eq', 'is_active', true], ['eq', 'is_proxy', false], ['is', 'deleted_at', null]]],
  ];
  for (const [query, predicates] of scopes) expect(query).toEqual(expect.arrayContaining(
    predicates.map(([method, ...args]) => ({ method, args })),
  ));
  const columns = db.builder.select.mock.calls.map(([selected]) => selected).join(' ');
  expect(columns).not.toMatch(/\*|proofs|proof_files|idempotency_key|\bnotes\b/);
  expect(columns).toContain('original_amount::text');
  expect(columns).toContain('base_amount::text');
  expectNoWrite();
});
it('requires admin authority before any service-role read', async () => {
  await expect(disputes.getResolveDisputeContext(caller({ isAdmin: false }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoWrite();
});
it.each(['workspaceId', 'disputeId', 'callerId', 'userId', 'isAdmin'])('rejects malformed caller %s before reading', async (field) => {
  await expect(disputes.getResolveDisputeContext(caller({ [field]: 'invalid' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoWrite();
});
it.each([{ role: 'member' }, { is_active: false }, { is_proxy: true }, { deleted_at: EXECUTION_TIME },
  { id: UNRELATED_ID }, { workspace_id: UNRELATED_ID }, { user_id: UNRELATED_ID }, { user_id: null }])(
  'denies inactive, proxy or incorrectly linked admins %j', async (change) => {
    db.mockResponses(...contextResponses({ actor: change }));
    await expect(disputes.getResolveDisputeContext(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members']]);
    expectNoWrite();
  });
it.each([
  [{ workspace: null }, 'NOT_FOUND'], [{ actor: null }, 'FORBIDDEN'], [{ dispute: null }, 'NOT_FOUND'],
  [{ entry: null }, 'NOT_FOUND'], [{ container: null }, 'NOT_FOUND'], [{ contributor: null }, 'BUSINESS_RULE_VIOLATION'],
  [{ workspace: { id: UNRELATED_ID } }, unavailable.code], [{ workspace: { deleted_at: EXECUTION_TIME } }, unavailable.code],
  [{ dispute: { id: UNRELATED_ID } }, unavailable.code], [{ dispute: { workspace_id: UNRELATED_ID } }, unavailable.code],
  [{ entry: { id: UNRELATED_ID } }, unavailable.code], [{ entry: { workspace_id: UNRELATED_ID } }, unavailable.code],
  [{ container: { id: UNRELATED_ID } }, unavailable.code], [{ container: { workspace_id: UNRELATED_ID } }, unavailable.code],
  [{ container: { deleted_at: EXECUTION_TIME } }, unavailable.code],
  [{ dispute: { status: 'resolved' } }, 'BUSINESS_RULE_VIOLATION'],
  [{ dispute: { raised_by: actor.member.id } }, 'BUSINESS_RULE_VIOLATION'],
  [{ container: { status: 'archived' } }, 'BUSINESS_RULE_VIOLATION'],
  [{ container: { status: 'completed' } }, 'BUSINESS_RULE_VIOLATION'],
  [{ container: { enable_money: false } }, 'BUSINESS_RULE_VIOLATION'],
  [{ container: { container_type: 'recurring' } }, 'BUSINESS_RULE_VIOLATION'],
  ...[{ id: UNRELATED_ID }, { workspace_id: UNRELATED_ID }, { is_active: false }, { is_proxy: true },
    { deleted_at: EXECUTION_TIME }].map((contributor) => [{ contributor }, 'BUSINESS_RULE_VIOLATION']),
])('fails closed for missing, unscoped or unsupported context %j', async (changes, code) => {
  db.mockResponses(...contextResponses(changes));
  await expect(disputes.getResolveDisputeContext(caller())).rejects.toMatchObject({ code });
  expectNoWrite();
});
it.each([
  { status: 'pending' }, { status: 'confirmed' }, { status: 'resolved' }, { entry_type: 'expense' },
  { original_currency: 'USD' }, { base_amount: '4999.00' }, { cycle_id: UNRELATED_ID },
  { corrects_entry_id: UNRELATED_ID }, { is_crypto: true }, { payment_method: 'crypto' },
  { original_amount: '0.00', base_amount: '0.00' }, { original_amount: '-1.00', base_amount: '-1.00' },
  { confirmed_at: null }, { confirmed_by: null },
])('excludes unsupported financial states and missing confirmation metadata %j', async (entry) => {
  db.mockResponses(...contextResponses({ entry }));
  await expect(disputes.getResolveDisputeContext(caller())).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  expectNoWrite();
});
it.each(['member', 'admin'])('supports an active unlinked %s owner and explicit null recording metadata', async (role) => {
  db.mockResponses(...contextResponses({ contributor: { role }, entry: { recorded_by: null } }));
  await expect(disputes.getResolveDisputeContext(caller())).resolves.toEqual(resolveContext({
    contributor_role: role, entry: entrySnapshot({ recorded_by: null }),
  }));
  expectNoWrite();
});
it('supports an admin resolving their own eligible dispute', async () => {
  db.mockResponses(...contextResponses({ contributor: adminMember(), entry: { contributor_id: actor.member.id },
    dispute: { raised_by: actor.member.id } }));
  await expect(disputes.getResolveDisputeContext(caller())).resolves.toEqual(resolveContext({
    contributor_display_name: 'Adaeze', contributor_role: 'admin',
    entry: entrySnapshot({ contributor_id: actor.member.id }), dispute: disputeSnapshot({ raised_by: actor.member.id }),
  }));
  expectNoWrite();
});
it.each([
  { workspace: { name: undefined } }, { workspace: { base_currency: undefined } }, { workspace: { updated_at: 'not-a-time' } },
  { actor: { is_active: undefined } }, { actor: { is_proxy: 'false' } }, { actor: { user_id: undefined } },
  { actor: { role: undefined } }, { actor: { display_name: undefined } }, { actor: { updated_at: undefined } },
  { dispute: { raised_at: undefined } }, { dispute: { reason: undefined } }, { dispute: { status: 'invalid' } },
  { dispute: { resolution_note: 'Unexpected open resolution' } }, { dispute: { resolved_by: actor.member.id } },
  { dispute: { resolved_at: EXECUTION_TIME } }, { dispute: { ledger_entry_id: 'invalid' } },
  { entry: { original_amount: 5000 } }, { entry: { base_amount: 5000 } }, { entry: { original_amount: 'NaN' } },
  { entry: { confirmed_at: undefined } }, { entry: { confirmed_by: 'invalid' } }, { entry: { recorded_at: 'not-a-time' } },
  { entry: { payment_method: 'invalid' } }, { entry: { note: {} } },
  { container: { status: undefined } }, { container: { container_type: undefined } }, { container: { name: undefined } },
  { container: { updated_at: 'not-a-time' } }, { container: { deleted_at: undefined } },
  { contributor: { role: 'invalid' } }, { contributor: { updated_at: undefined } }, { contributor: { user_id: undefined } },
])('keeps malformed or inconsistent rows unavailable rather than stale %j', async (changes) => {
  scriptResolution({ changes });
  await expect(disputes.resolveDispute(parameters())).rejects.toMatchObject(unavailable);
  expectNoWrite();
});
it.each([0, 1, 2, 3, 4, 5].flatMap((index) => [
  [index, { error: null }], [index, { data: [], error: null }], [index, { data: 1, error: null }],
  [index, { data: contextResponses()[index].data }],
  [index, { data: contextResponses()[index].data, error: { message: 'PRIVATE_READ_ERROR' } }],
]))('normalizes failed read %s without exposing private details', async (index, result) => {
  db.mockResponses(...contextResponses().slice(0, index), result);
  await expect(disputes.getResolveDisputeContext(caller())).rejects.toMatchObject(unavailable);
  expectNoWrite();
});
it('keeps thrown read uncertainty retryable before RPC', async () => {
  db.builder.maybeSingle.mockRejectedValueOnce(new ConflictError('PRIVATE_READ_CONFLICT'));
  await expect(disputes.resolveDispute(parameters())).rejects.toMatchObject(unavailable);
  expectNoWrite();
});

it.each([undefined, '', '    ', 'too short', 'x'.repeat(1001), {}, 'Resolution\u0000note', 'Resolution\uD800note', 'Resolution\uDC00note'])(
  'rejects invalid resolution notes before reading (%j)', async (resolutionNote) => {
    await expect(disputes.resolveDispute(parameters({ resolutionNote }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });
it.each([{ proposalId: 'invalid' }, { userId: undefined }, { isAdmin: false }, { trace: undefined },
  { trace: { sessionId: SESSION_ID } }, { trace: { sessionId: 'invalid', conversationId: null } },
  { trace: { sessionId: SESSION_ID, conversationId: 'invalid' } }, { expected: undefined }, { force: true },
  { expected: resolveContext({ member_role: 'member' }) },
  { expected: resolveContext({ dispute: disputeSnapshot({ notes: [] }) }) },
  { expected: resolveContext({ entry: entrySnapshot({ proofs: [] }) }) },
  { expected: resolveContext({ entry: entrySnapshot({ idempotency_key: 'PRIVATE' }) }) },
])('rejects invalid reviewed claims or private-field overrides %j', async (change) => {
  await expect(disputes.resolveDispute(parameters({ reviewedResolution: reviewed(change) })))
    .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoWrite();
});
it('cannot invoke the reviewed branch with a non-admin caller flag', async () => {
  await expect(disputes.resolveDispute(parameters({ isAdmin: false }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoWrite();
});
it.each([
  { workspace_id: UNRELATED_ID }, { container_id: UNRELATED_ID }, { actor_member_id: UNRELATED_ID },
  ...['entry_id', 'workspace_id', 'container_id', 'contributor_id'].map((field) => ({ entry: entrySnapshot({ [field]: UNRELATED_ID }) })),
  ...['dispute_id', 'workspace_id', 'ledger_entry_id', 'raised_by'].map((field) => ({ dispute: disputeSnapshot({ [field]: UNRELATED_ID }) })),
])('binds every reviewed identity and ownership link before reading %j', async (change) => {
  await expect(disputes.resolveDispute(parameters({ reviewedResolution: reviewed({ expected: resolveContext(change) }) })))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoWrite();
});
it.each([
  { workspace: { name: 'Renamed family' } }, { workspace: { updated_at: EXECUTION_TIME } }, { workspace: null },
  { actor: { display_name: 'Renamed admin' } }, { actor: { updated_at: EXECUTION_TIME } }, { actor: { is_active: false } },
  { actor: { role: 'member' } }, { actor: { user_id: null } },
  { dispute: { reason: 'The reviewed reason changed.' } }, { dispute: { raised_at: EXECUTION_TIME } },
  { dispute: { status: 'resolved' } }, { dispute: { raised_by: actor.member.id } }, { dispute: null },
  { entry: { original_amount: '6000.00', base_amount: '6000.00' } }, { entry: { note: 'Changed note' } },
  { entry: { confirmed_by: CONTRIBUTOR_ID } }, { entry: { confirmed_at: null } }, { entry: { status: 'resolved' } }, { entry: null },
  { container: { name: 'Renamed event' } }, { container: { updated_at: EXECUTION_TIME } }, { container: { status: 'archived' } },
  { contributor: { display_name: 'Renamed owner' } }, { contributor: { role: 'admin' } },
  { contributor: { updated_at: EXECUTION_TIME } }, { contributor: { is_active: false } }, { contributor: { is_proxy: true } },
])('rejects stale or newly ineligible reviewed context before RPC %j', async (changes) => {
  scriptResolution({ changes });
  await expect(disputes.resolveDispute(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
  expectNoWrite();
});

it.each([null, CONVERSATION_ID])('resolves both records with exact parameters, required traced audit and deduplicated notice (%s)', async (conversationId) => {
  scriptResolution();
  const spoofed = { ...actorCtx, workspaceId: UNRELATED_ID, actorUserId: UNRELATED_ID, actorMemberId: UNRELATED_ID };
  await expect(disputes.resolveDispute(parameters({ resolutionNote: `  ${RESOLUTION_NOTE}  `, actorCtx: spoofed,
    reviewedResolution: reviewed({ trace: { sessionId: SESSION_ID, conversationId } }),
  }))).resolves.toEqual({ dispute: resolvedDispute(), entry: resolvedEntry() });
  expect(db.getRpcCalls()).toEqual([{ fnName: 'resolve_dispute_atomic', params: {
    p_dispute_id: DISPUTE_ID, p_resolution_note: RESOLUTION_NOTE,
    p_resolved_by: actor.member.id, p_resolved_at: EXECUTION_TIME,
  } }]);
  expect(audit.log).toHaveBeenCalledWith({ ...actorCtx, required: true, action: AUDIT_ACTIONS.DISPUTE_RESOLVED,
    targetType: 'dispute', targetId: DISPUTE_ID, metadata: { agent_initiated: true, proposal_id: PROPOSAL_ID,
      session_id: SESSION_ID, conversation_id: conversationId, sensitive_action: true, secondary_confirmation: true } });
  expect(notification.send).toHaveBeenCalledWith({ type: 'dispute_resolved', workspaceId: actor.workspace.id,
    recipientIds: [CONTRIBUTOR_ID], referenceType: 'dispute', referenceId: DISPUTE_ID,
    variables: { container: 'Family groceries' }, dedupKey: `dispute_resolved:${DISPUTE_ID}` });
  expect(queries('ledger_entries')[1]).toEqual(expect.arrayContaining([
    { method: 'eq', args: ['id', ENTRY_ID] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
    { method: 'eq', args: ['container_id', CONTAINER_ID] },
  ]));
  expectNoDirectMutation();
});
it('preserves null recorded_by without inventing recording or confirmation metadata', async () => {
  scriptResolution({ changes: { entry: { recorded_by: null } }, reread: response(resolvedEntry({ recorded_by: null })) });
  await expect(disputes.resolveDispute(parameters({ reviewedResolution: reviewed({
    expected: resolveContext({ entry: entrySnapshot({ recorded_by: null }) }),
  }) }))).resolves.toEqual({ dispute: resolvedDispute(), entry: resolvedEntry({ recorded_by: null }) });
  expect(audit.log).toHaveBeenCalledTimes(1);
  expectNoDirectMutation();
});
it('allows concurrent mutable notes/proofs outside the reviewed projection without auditing their contents', async () => {
  const notes = [{ author_id: CONTRIBUTOR_ID, note: 'PRIVATE_NEW_NOTE', added_at: EXECUTION_TIME }];
  const actualDispute = resolvedDispute({ notes });
  const actualEntry = resolvedEntry({ proofs: ['PRIVATE_CHANGED_PROOF'], idempotency_key: 'PRIVATE_KEY' });
  scriptResolution({ changes: { dispute: { notes: [{ note: 'PRIVATE_PREVIOUS_NOTE' }] }, entry: { proofs: [] } },
    rpc: response(actualDispute), reread: response(actualEntry) });
  await expect(disputes.resolveDispute(parameters())).resolves.toEqual({ dispute: actualDispute, entry: actualEntry });
  expect(JSON.stringify(audit.log.mock.calls)).not.toMatch(/PRIVATE_/);
  expectNoDirectMutation();
});
it.each(['2026-11-17T12:03:00+00:00', '2026-11-17T13:03:00.000000+01:00', '2026-11-17T12:03:00.000000Z'])(
  'verifies and preserves equivalent PostgreSQL timestamp formatting %s', async (resolved_at) => {
    const actual = resolvedDispute({ resolved_at, resolution_note: 'The payment was checked successfully 😀' });
    scriptResolution({ rpc: response(actual) });
    await expect(disputes.resolveDispute(parameters({ resolutionNote: '  The payment was checked successfully 😀  ' })))
      .resolves.toEqual({ dispute: actual, entry: resolvedEntry() });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expectNoDirectMutation();
  });
it('requires native auditing to finish before rereading the entry or notifying the owner', async () => {
  scriptResolution();
  let finishAudit;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  audit.log.mockImplementationOnce(() => {
    signalStarted();
    return new Promise((resolve) => { finishAudit = resolve; });
  });
  const execution = disputes.resolveDispute(parameters());
  await started;
  expect(queries('ledger_entries')).toHaveLength(1);
  expect(notification.send).not.toHaveBeenCalled();
  finishAudit();
  await expect(execution).resolves.toEqual({ dispute: resolvedDispute(), entry: resolvedEntry() });
  expect(queries('ledger_entries')).toHaveLength(2);
  expect(notification.send).toHaveBeenCalledTimes(1);
});

const noLongerOpen = `Failed to resolve dispute: Dispute ${DISPUTE_ID} not found or already resolved`;
it('classifies only the exact null-data typed PostgreSQL rejection as a definite no-write conflict', async () => {
  scriptResolution({ rpc: { data: null, error: { code: 'P0001', message: noLongerOpen } } });
  await expect(disputes.resolveDispute(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expect(queries('ledger_entries')).toHaveLength(1);
  expectNoEffects();
});
it.each([
  response(null), response([]), response([resolvedDispute()]), { error: null }, { data: resolvedDispute() },
  { error: { code: 'P0001', message: noLongerOpen } },
  { data: null, error: { code: '23505', message: noLongerOpen } },
  { data: null, error: { code: 'OTHER', message: noLongerOpen } },
  { data: null, error: { code: 'P0001', message: `${noLongerOpen} extra text` } },
  { data: null, error: { code: 'P0001', message: noLongerOpen.replace(DISPUTE_ID, UNRELATED_ID) } },
  { data: null, error: { code: 'P0001', message: 'Failed to resolve dispute: PRIVATE_DATABASE_ERROR' } },
  { data: resolvedDispute(), error: { code: 'P0001', message: noLongerOpen } },
])('keeps partial, malformed or unrelated RPC failures uncertain %j', async (rpc) => {
  scriptResolution({ rpc });
  await expect(disputes.resolveDispute(parameters())).rejects.toMatchObject(unavailable);
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expect(queries('ledger_entries')).toHaveLength(1);
  expectNoEffects();
});
it.each([
  ...Object.keys(disputeSnapshot()).map((field) => [field === 'dispute_id' ? 'id' : field, undefined]),
  ['id', UNRELATED_ID], ['workspace_id', UNRELATED_ID], ['ledger_entry_id', UNRELATED_ID], ['raised_by', UNRELATED_ID],
  ['reason', 'An unreviewed reason was returned.'], ['status', 'open'], ['resolution_note', 'A different resolution was recorded.'],
  ['resolution_note', `  ${RESOLUTION_NOTE}  `], ['resolved_by', CONTRIBUTOR_ID], ['raised_at', EXECUTION_TIME],
  ['resolved_at', 'invalid'], ['resolved_at', '2026-11-17T12:03:01.000Z'], ['resolved_at', '2026-11-17T12:03:00.000001Z'],
])('verifies every stable resolved dispute field and exact resolution time (%s=%s)', async (field, value) => {
  scriptResolution({ rpc: response(resolvedDispute({ [field]: value })) });
  await expect(disputes.resolveDispute(parameters())).rejects.toMatchObject(unavailable);
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expectNoEffects();
});
it.each([new Error('PRIVATE_RPC_ERROR'), new ConflictError('PRIVATE_RPC_CONFLICT')])('normalizes thrown RPC uncertainty %s', async (error) => {
  db.mockResponses(...contextResponses());
  db.client.rpc.mockRejectedValueOnce(error);
  await expect(disputes.resolveDispute(parameters())).rejects.toMatchObject(unavailable);
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expectNoEffects();
});
it.each([new Error('PRIVATE_AUDIT_ERROR'), new ConflictError('PRIVATE_AUDIT_CONFLICT')])('retains uncertainty after a required native audit failure %s', async (error) => {
  scriptResolution();
  audit.log.mockRejectedValueOnce(error);
  await expect(disputes.resolveDispute(parameters())).rejects.toMatchObject(unavailable);
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expect(audit.log).toHaveBeenCalledTimes(1);
  expect(queries('ledger_entries')).toHaveLength(1);
  expect(notification.send).not.toHaveBeenCalled();
  expectNoDirectMutation();
});
it.each([response(null), response([]), { error: null }, { data: resolvedEntry() },
  { data: resolvedEntry(), error: { message: 'PRIVATE_REREAD_ERROR' } }])('keeps missing or failed post-audit rereads uncertain %j', async (reread) => {
  scriptResolution({ reread });
  await expect(disputes.resolveDispute(parameters())).rejects.toMatchObject(unavailable);
  expect(audit.log).toHaveBeenCalledTimes(1);
  expect(notification.send).not.toHaveBeenCalled();
  expectNoDirectMutation();
});
it.each([
  ...Object.keys(entrySnapshot()).map((field) => [field === 'entry_id' ? 'id' : field, undefined]),
  ['id', UNRELATED_ID], ['workspace_id', UNRELATED_ID], ['container_id', UNRELATED_ID], ['contributor_id', UNRELATED_ID],
  ['original_amount', '6000.00'], ['base_amount', '6000.00'], ['original_amount', 5000], ['base_amount', 5000],
  ['payment_method', 'cash'], ['note', 'Changed after RPC'], ['recorded_by', actor.member.id], ['recorded_at', EXECUTION_TIME],
  ['confirmed_by', CONTRIBUTOR_ID], ['confirmed_at', EXECUTION_TIME], ['status', 'disputed'], ['status', 'confirmed'],
])('requires the unchanged ledger projection with resolved status (%s=%s)', async (field, value) => {
  scriptResolution({ reread: response(resolvedEntry({ [field]: value })) });
  await expect(disputes.resolveDispute(parameters())).rejects.toMatchObject(unavailable);
  expect(audit.log).toHaveBeenCalledTimes(1);
  expect(notification.send).not.toHaveBeenCalled();
  expectNoDirectMutation();
});
it('returns verified resolution despite notification failure and logs only structured identifiers', async () => {
  scriptResolution();
  notification.send.mockRejectedValueOnce(new ConflictError('PRIVATE_NOTIFICATION_ERROR'));
  await expect(disputes.resolveDispute(parameters())).resolves.toEqual({ dispute: resolvedDispute(), entry: resolvedEntry() });
  expect(notification.send).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith('Dispute resolution notification unavailable', {
    workspaceId: actor.workspace.id, disputeId: DISPUTE_ID, errorCode: 'CONFLICT',
  });
  expect(db.client.rpc).toHaveBeenCalledTimes(1);
  expectNoDirectMutation();
});
it('preserves the ordinary HTTP branch without applying the new reviewed eligibility contract', async () => {
  const original = { id: DISPUTE_ID, status: 'open', raised_by: CONTRIBUTOR_ID,
    ledger_entries: { container_id: CONTAINER_ID, containers: { name: 'Ordinary event' } } };
  const actual = { id: DISPUTE_ID, status: 'resolved' };
  db.mockResponses(response(original));
  db.mockNextRpcResponse(response(actual));
  await expect(disputes.resolveDispute(parameters({ isAdmin: undefined, reviewedResolution: undefined }))).resolves.toEqual(actual);
  expect(db.client.from.mock.calls).toEqual([['disputes']]);
  expect(notification.send).toHaveBeenCalledWith({ type: 'dispute_resolved', workspaceId: actor.workspace.id,
    recipientIds: [CONTRIBUTOR_ID], referenceType: 'dispute', referenceId: DISPUTE_ID,
    variables: { container: 'Ordinary event' } });
  expect(audit.log).toHaveBeenCalledWith({ ...actorCtx, action: AUDIT_ACTIONS.DISPUTE_RESOLVED,
    targetType: 'dispute', targetId: DISPUTE_ID });
  expectNoDirectMutation();
});
