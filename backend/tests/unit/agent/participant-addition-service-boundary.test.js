// Real service boundary; database uniqueness and concurrent eligibility changes need live integration coverage.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));

const participants = require('../../../src/services/participant.service');
const audit = require('../../../src/services/audit.service');
const notification = require('../../../src/services/notification.service');
const { ConflictError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const { OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, MEMBER_ID, PARTICIPANT_ID, EXECUTION_TIME, adminContext, adminMember,
  workspaceRow, containerRow, selectedMemberRow, additionContext, additionData, participantRow,
} = require('../../helpers/agent-participant-addition');
const db = require('../../../src/config/supabase').__mockInstance;
const actor = adminContext();
const actorCtx = { workspaceId: actor.workspace.id, actorUserId: actor.userId,
  actorMemberId: actor.member.id, ipAddress: '127.0.0.1', userAgent: 'participant-boundary-test' };
const caller = (changes = {}) => ({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
  memberId: MEMBER_ID, callerId: actor.member.id, userId: actor.userId, isAdmin: true, ...changes });
const reviewed = (changes = {}) => ({ userId: actor.userId, isAdmin: true,
  participantId: PARTICIPANT_ID, expected: additionContext(), ...changes });
const parameters = (changes = {}) => ({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
  participants: [additionData()], actorMemberId: actor.member.id, actorCtx, reviewedAddition: reviewed(), ...changes });
const response = (data) => ({ data, error: null });
const contextRows = (changes = {}) => [workspaceRow(changes.workspace), adminMember(changes.admin),
  containerRow(changes.container), selectedMemberRow(changes.member), changes.participant ?? null];
const scriptContext = (changes = {}) => db.mockResponses(...contextRows(changes).map(response));
function scriptInsert(result = response([participantRow()]), changes = {}) {
  scriptContext(changes);
  db.mockNextResponse(result);
}
function queries(table) {
  const calls = db.getCalls();
  return calls.flatMap((call, start) => {
    if (call.method !== 'from' || call.args[0] !== table) return [];
    const end = calls.findIndex((next, index) => index > start && next.method === 'from');
    return [calls.slice(start, end < 0 ? undefined : end)];
  });
}
function expectNoOtherEffects() {
  for (const method of ['insert', 'update', 'delete']) expect(db.builder[method]).not.toHaveBeenCalled();
  expect(db.client.rpc).not.toHaveBeenCalled();
  expect(db.client.from).not.toHaveBeenCalledWith('contributor_targets');
  expect(notification.send).not.toHaveBeenCalled();
}
function expectNoWrite() {
  expect(db.builder.upsert).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
  expectNoOtherEffects();
}
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date(EXECUTION_TIME));
  db.reset();
  audit.log.mockResolvedValue();
});
afterEach(() => jest.useRealTimers());

describe('participant addition eligibility', () => {
  it('reads the actual scopes and supports an unlinked ordinary membership without exposing private fields', async () => {
    scriptContext({ workspace: { private_settings: 'PRIVATE_DATA' }, member: { admin_notes: 'PRIVATE_NOTES' } });
    await expect(participants.getParticipantAdditionContext(caller())).resolves.toEqual(additionContext());
    expect(db.client.from.mock.calls).toEqual([
      ['workspaces'], ['workspace_members'], ['containers'], ['workspace_members'], ['container_participants'],
    ]);
    expect(queries('workspaces')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', actor.workspace.id] }, { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('workspace_members')[0]).toEqual(expect.arrayContaining([
      ...[['id', actor.member.id], ['workspace_id', actor.workspace.id], ['user_id', actor.userId],
        ['role', 'admin'], ['is_active', true], ['is_proxy', false]].map((args) => ({ method: 'eq', args })),
      { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('containers')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', CONTAINER_ID] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('workspace_members')[1]).toEqual(expect.arrayContaining([
      ...[['id', MEMBER_ID], ['workspace_id', actor.workspace.id], ['is_active', true], ['is_proxy', false]]
        .map((args) => ({ method: 'eq', args })), { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('workspace_members')[1].some(({ args }) => args[0] === 'user_id')).toBe(false);
    expect(queries('container_participants')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['container_id', CONTAINER_ID] }, { method: 'eq', args: ['workspace_member_id', MEMBER_ID] },
    ]));
    expectNoWrite();
  });
  it('denies a non-admin flag before reading', async () => {
    await expect(participants.getParticipantAdditionContext(caller({ isAdmin: false })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });
  it.each(['workspaceId', 'containerId', 'memberId', 'callerId', 'userId'])('rejects invalid %s before access', async (field) => {
    await expect(participants.getParticipantAdditionContext(caller({ [field]: 'invalid' })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });
  it.each([
    ['role', { role: 'member' }], ['inactive admin', { is_active: false }], ['proxy admin', { is_proxy: true }],
    ['deleted admin', { deleted_at: EXECUTION_TIME }], ['user', { user_id: OTHER_ID }],
    ['workspace', { workspace_id: OTHER_ID }], ['member ID', { id: OTHER_ID }],
  ])('denies an actual admin with changed %s', async (_label, admin) => {
    scriptContext({ admin });
    await expect(participants.getParticipantAdditionContext(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expectNoWrite();
  });
  it.each([
    ['wrong workspace', { workspace: { id: OTHER_ID } }, 'PARTICIPANT_ADDITION_UNAVAILABLE'],
    ['deleted workspace', { workspace: { deleted_at: EXECUTION_TIME } }, 'PARTICIPANT_ADDITION_UNAVAILABLE'],
    ['wrong container', { container: { id: OTHER_ID } }, 'PARTICIPANT_ADDITION_UNAVAILABLE'],
    ['container workspace', { container: { workspace_id: OTHER_ID } }, 'PARTICIPANT_ADDITION_UNAVAILABLE'],
    ['deleted container', { container: { deleted_at: EXECUTION_TIME } }, 'PARTICIPANT_ADDITION_UNAVAILABLE'],
    ['archived event', { container: { status: 'archived' } }, 'BUSINESS_RULE_VIOLATION'],
    ['recurring container', { container: { container_type: 'recurring' } }, 'BUSINESS_RULE_VIOLATION'],
    ['wrong selected member', { member: { id: OTHER_ID } }, 'PARTICIPANT_ADDITION_UNAVAILABLE'],
    ['member workspace', { member: { workspace_id: OTHER_ID } }, 'PARTICIPANT_ADDITION_UNAVAILABLE'],
    ['deleted member', { member: { deleted_at: EXECUTION_TIME } }, 'PARTICIPANT_ADDITION_UNAVAILABLE'],
    ['inactive member', { member: { is_active: false } }, 'BUSINESS_RULE_VIOLATION'],
    ['proxy member', { member: { is_proxy: true } }, 'BUSINESS_RULE_VIOLATION'],
    ['unsupported role', { member: { role: 'owner' } }, 'BUSINESS_RULE_VIOLATION'],
    ['existing pair', { participant: participantRow() }, 'BUSINESS_RULE_VIOLATION'],
    ['unrelated pair', { participant: participantRow({ workspace_member_id: OTHER_ID }) }, 'PARTICIPANT_ADDITION_UNAVAILABLE'],
  ])('denies %s without mutation', async (_label, changes, code) => {
    scriptContext(changes);
    await expect(participants.getParticipantAdditionContext(caller())).rejects.toMatchObject({ code });
    expectNoWrite();
  });
  it.each([[0, 'NOT_FOUND'], [1, 'FORBIDDEN'], [2, 'NOT_FOUND'], [3, 'NOT_FOUND']])(
    'stops on missing scoped row %s', async (index, code) => {
      db.mockResponses(...contextRows().slice(0, index).map(response), response(null));
      await expect(participants.getParticipantAdditionContext(caller())).rejects.toMatchObject({ code });
      expect(db.client.from).toHaveBeenCalledTimes(index + 1);
      expectNoWrite();
    });
  it.each([0, 1, 2, 3, 4].flatMap((index) => [
    [index, { error: null }], [index, { data: [] , error: null }],
    [index, { data: contextRows()[index], error: { message: 'PRIVATE_READ_ERROR' } }],
  ]))('fails closed on malformed or failed read %s', async (index, result) => {
    db.mockResponses(...contextRows().slice(0, index).map(response), result);
    await expect(participants.getParticipantAdditionContext(caller()))
      .rejects.toMatchObject({ code: 'PARTICIPANT_ADDITION_UNAVAILABLE', statusCode: 503 });
    expectNoWrite();
  });
});

describe('reviewed participant addition guards', () => {
  it.each([
    { role: 'admin' }, { notes: 'Unreviewed' }, { target: { amount: 100, currency: 'NGN' } },
    { user_id: OTHER_ID }, { workspace_id: OTHER_ID }, { container_id: OTHER_ID }, { id: OTHER_ID },
    { added_by: OTHER_ID }, { exclude_from_public: true }, { is_proxy: true },
    { money_enabled: 'true' }, { tasks_enabled: null },
  ])('rejects participant overrides %j before access', async (changes) => {
    await expect(participants.addParticipants(parameters({ participants: [additionData(changes)] })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });
  it.each([[], [additionData(), additionData()], [additionData({ workspace_member_id: 'invalid' })]].map((batch) => [batch]))(
    'requires exactly one explicit valid member (%j)', async (requested) => {
      await expect(participants.addParticipants(parameters({ participants: requested })))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(db.client.from).not.toHaveBeenCalled();
      expectNoWrite();
    });
  it.each([{ participantId: 'invalid' }, { expected: undefined }, { force: true }])(
    'rejects malformed review %j', async (changes) => {
      await expect(participants.addParticipants(parameters({ reviewedAddition: reviewed(changes) })))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(db.client.from).not.toHaveBeenCalled();
      expectNoWrite();
    });
  it('denies a non-admin approval before access', async () => {
    await expect(participants.addParticipants(parameters({ reviewedAddition: reviewed({ isAdmin: false }) })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });
  it.each(['workspace_id', 'container_id', 'workspace_member_id', 'actor_member_id'])('binds the reviewed %s', async (field) => {
    await expect(participants.addParticipants(parameters({
      reviewedAddition: reviewed({ expected: additionContext({ [field]: OTHER_ID }) }),
    }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });
  it.each([['money_enabled', 'enable_money'], ['tasks_enabled', 'enable_tasks']])('denies disabled %s', async (flag, enabled) => {
    await expect(participants.addParticipants(parameters({ participants: [additionData({ [flag]: true })],
      reviewedAddition: reviewed({ expected: additionContext({ [enabled]: false }) }),
    }))).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expectNoWrite();
  });
  it.each([
    { workspace: { updated_at: EXECUTION_TIME } }, { container: { updated_at: EXECUTION_TIME } },
    { member: { updated_at: EXECUTION_TIME } }, { admin: { role: 'member' } },
    { container: { status: 'archived' } }, { member: { is_active: false } }, { participant: participantRow() },
  ])('invalidates stale eligibility %j before upsert', async (changes) => {
    scriptContext(changes);
    await expect(participants.addParticipants(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
    expectNoWrite();
  });
});

describe('reviewed participant insertion and uncertain outcomes', () => {
  it.each(['member', 'admin'])('adds an existing %s with fixed defaults and a required authentic audit', async (role) => {
    scriptInsert(response([participantRow()]), { member: { role } });
    const spoofed = { ...actorCtx, workspaceId: OTHER_ID, actorUserId: OTHER_ID, actorMemberId: OTHER_ID };
    await expect(participants.addParticipants(parameters({ participants: [{ workspace_member_id: MEMBER_ID }],
      actorCtx: spoofed, reviewedAddition: reviewed({ expected: additionContext({ selected_member_role: role }) }),
    }))).resolves.toEqual({ added: [participantRow()], skipped_already_present: 0, skipped_invalid_member: 0 });
    expect(db.builder.upsert).toHaveBeenCalledTimes(1);
    expect(db.builder.upsert).toHaveBeenCalledWith([participantRow()], {
      onConflict: 'container_id,workspace_member_id', ignoreDuplicates: true,
    });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith({ ...actorCtx, required: true,
      action: AUDIT_ACTIONS.CONTAINER_PARTICIPANTS_ADDED, targetType: 'container', targetId: CONTAINER_ID,
      metadata: { added_count: 1, skipped_already_present: 0, skipped_invalid_member: 0 } });
    expectNoOtherEffects();
  });
  it.each(['money_enabled', 'tasks_enabled'])('preserves explicitly requested %s without target writes', async (flag) => {
    scriptInsert(response([participantRow({ [flag]: true })]));
    await participants.addParticipants(parameters({ participants: [additionData({ [flag]: true })] }));
    expect(db.builder.upsert.mock.calls[0][0]).toEqual([participantRow({ [flag]: true })]);
    expectNoOtherEffects();
  });
  it('reports only the explicit successful empty upsert as a duplicate race conflict', async () => {
    scriptInsert(response([]));
    await expect(participants.addParticipants(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.builder.upsert).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
    expectNoOtherEffects();
  });
  it.each([
    { data: null, error: null }, { error: null }, { data: [participantRow()] }, { data: [], error: undefined },
    { data: participantRow(), error: null }, response([participantRow(), participantRow()]),
    { data: [], error: { code: '23505', message: 'PRIVATE_INSERT_ERROR' } },
    { data: [participantRow()], error: { code: 'CONFLICT', message: 'PRIVATE_MUTATION_ERROR' } },
  ])('keeps mutation response %j uncertain without retry or repair', async (result) => {
    scriptInsert(result);
    await expect(participants.addParticipants(parameters())).rejects.toMatchObject({
      code: 'PARTICIPANT_ADDITION_UNAVAILABLE', statusCode: 503,
      message: 'Participant addition is unavailable. Please try again.',
    });
    expect(db.builder.upsert).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
    expectNoOtherEffects();
  });
  it.each([
    ...Object.keys(participantRow()).map((field) => [field, undefined]),
    ['id', OTHER_ID], ['container_id', OTHER_ID], ['workspace_member_id', OTHER_ID], ['added_by', OTHER_ID],
    ['money_enabled', true], ['tasks_enabled', true], ['role', 'admin'], ['notes', 'Unexpected'],
    ['exclude_from_public', true], ['added_at', additionContext().container_updated_at],
  ])('requires the full matching stored participant (%s=%s)', async (field, value) => {
    scriptInsert(response([participantRow({ [field]: value })]));
    await expect(participants.addParticipants(parameters())).rejects.toMatchObject({ code: 'PARTICIPANT_ADDITION_UNAVAILABLE' });
    expect(db.builder.upsert).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
    expectNoOtherEffects();
  });
  it.each([new Error('PRIVATE_TRANSPORT_ERROR'), new ConflictError('PRIVATE_TRANSPORT_CONFLICT')])(
    'normalizes transport failures after attempting upsert (%s)', async (error) => {
      scriptContext();
      db.builder.upsert.mockImplementationOnce(() => { throw error; });
      await expect(participants.addParticipants(parameters())).rejects.toMatchObject({ code: 'PARTICIPANT_ADDITION_UNAVAILABLE' });
      expect(db.builder.upsert).toHaveBeenCalledTimes(1);
      expect(audit.log).not.toHaveBeenCalled();
      expectNoOtherEffects();
    });
  it.each([new Error('PRIVATE_AUDIT_ERROR'), new ConflictError('PRIVATE_AUDIT_CONFLICT')])(
    'keeps a post-insert audit failure uncertain (%s)', async (error) => {
      scriptInsert();
      audit.log.mockRejectedValueOnce(error);
      await expect(participants.addParticipants(parameters())).rejects.toMatchObject({ code: 'PARTICIPANT_ADDITION_UNAVAILABLE' });
      expect(db.builder.upsert).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledTimes(1);
      expectNoOtherEffects();
    });
});
