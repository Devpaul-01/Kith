// Exercise the actual domain service. Database uniqueness and concurrent
// eligibility changes still need live Postgres/Redis integration coverage.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));
jest.mock('../../../src/services/membership-cache.service', () => ({ invalidateMembership: jest.fn() }));
jest.mock('../../../src/services/engagement.service', () => ({ computeEngagement: jest.fn() }));

const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const notification = require('../../../src/services/notification.service');
const { invalidateMembership } = require('../../../src/services/membership-cache.service');
const { ConflictError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const {
  memberCreationDataSchema, memberCreationStateSchema, buildMemberCreationState,
} = require('../../../src/validators/member-creation.validator');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');

const actor = { ...context(), member: { ...context().member, role: 'admin' } };
const MEMBER_ID = '77777777-7777-4777-8777-777777777777';
const CREATED_AT = '2026-11-15T12:02:00.000Z';
const REVIEWED_AT = '2026-11-15T12:00:00.000Z';
const actorCtx = {
  workspaceId: actor.workspace.id, actorUserId: actor.userId, actorMemberId: actor.member.id,
  ipAddress: '127.0.0.1', userAgent: 'member-boundary-test',
};

const creationContext = (overrides = {}) => ({
  workspace_id: actor.workspace.id, workspace_name: 'Family', workspace_updated_at: REVIEWED_AT,
  actor_member_id: actor.member.id, member_role: 'admin', ...overrides,
});
const workspaceRow = (overrides = {}) => ({
  id: actor.workspace.id, name: 'Family', updated_at: REVIEWED_AT, deleted_at: null, ...overrides,
});
const adminRow = (overrides = {}) => ({
  ...member(), role: 'admin', is_proxy: false, deleted_at: null, ...overrides,
});
const approvedData = (overrides = {}) => ({
  display_name: 'Chidi Okafor', is_proxy: false, relationship_to_head: 'Cousin',
  relationship_category: 'blood', date_of_birth: '2000-02-29', admin_notes: 'Prefers calls.', ...overrides,
});
// Independent schema fixture: do not manufacture expected database defaults
// by calling the production state builder under test.
const storedMember = (overrides = {}) => ({
  id: MEMBER_ID, workspace_id: actor.workspace.id, user_id: null, role: 'member',
  display_name: 'Chidi Okafor', relationship_to_head: 'Cousin', relationship_category: 'blood',
  date_of_birth: '2000-02-29', is_proxy: false, proxy_managed_by: null,
  admin_notes: 'Prefers calls.', invite_status: null, invited_at: null,
  joined_at: CREATED_AT, last_active_at: null, contribution_streak_months: 0,
  last_contribution_date: null, is_active: true, created_at: CREATED_AT,
  updated_at: CREATED_AT, deleted_at: null, ...overrides,
});
const callerParameters = (overrides = {}) => ({
  workspaceId: actor.workspace.id, callerId: actor.member.id, userId: actor.userId,
  isAdmin: true, ...overrides,
});
const parameters = (overrides = {}) => ({
  workspaceId: actor.workspace.id, data: approvedData(), actorCtx,
  reviewedCreation: { userId: actor.userId, isAdmin: true,
    expected: creationContext(), memberId: MEMBER_ID }, ...overrides,
});
const reviewedOptions = (overrides = {}) => ({ ...parameters().reviewedCreation, ...overrides });

const db = require('../../../src/config/supabase').__mockInstance;
function scriptContext({ workspace = {}, admin = {} } = {}) {
  db.mockResponses({ data: workspaceRow(workspace), error: null }, { data: adminRow(admin), error: null });
}
function scriptInsert(response = { data: storedMember(), error: null }) {
  scriptContext();
  db.mockNextResponse(response);
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
  expect(notification.send).not.toHaveBeenCalled();
  expect(invalidateMembership).not.toHaveBeenCalled();
  expect(db.builder.update).not.toHaveBeenCalled();
  expect(db.builder.delete).not.toHaveBeenCalled();
  expect(db.client.rpc).not.toHaveBeenCalled();
}
function expectNoWrite() {
  expect(db.builder.insert).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
  expectNoOtherEffects();
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date(CREATED_AT));
  db.reset();
  jest.clearAllMocks();
  audit.log.mockResolvedValue();
  notification.send.mockResolvedValue();
});
afterEach(() => jest.useRealTimers());

describe('reviewed member creation validation', () => {
  it('normalizes optional text and sets explicit unattached member defaults', () => {
    const data = memberCreationDataSchema.parse({
      display_name: '  Chidi Okafor  ', relationship_to_head: '  ', admin_notes: '',
    });
    expect(data).toEqual({
      display_name: 'Chidi Okafor', is_proxy: false, relationship_to_head: null,
      relationship_category: 'other', date_of_birth: null, admin_notes: null,
    });
    expect(buildMemberCreationState({ data, workspaceId: actor.workspace.id,
      memberId: MEMBER_ID, actorMemberId: actor.member.id })).toEqual({
      ...data, member_id: MEMBER_ID, workspace_id: actor.workspace.id,
      user_id: null, role: 'member', proxy_managed_by: null, invite_status: null,
      invited_at: null, last_active_at: null, contribution_streak_months: 0,
      last_contribution_date: null, is_active: true, deleted_at: null,
    });
  });

  it.each([
    ['blank name', { display_name: '   ' }], ['short trimmed name', { display_name: ' a ' }],
    ['long name', { display_name: 'x'.repeat(81) }], ['long relationship', { relationship_to_head: 'x'.repeat(101) }],
    ['long notes', { admin_notes: 'x'.repeat(1001) }], ['invalid date', { date_of_birth: '2026-02-29' }],
    ['relative date', { date_of_birth: 'yesterday' }], ['timestamp date', { date_of_birth: CREATED_AT }],
    ['invalid category', { relationship_category: 'admin' }], ['text proxy flag', { is_proxy: 'true' }],
    ['admin role', { role: 'admin' }], ['member role override', { role: 'member' }],
    ['account linking', { user_id: OTHER_ID }], ['proxy manager', { proxy_managed_by: OTHER_ID }],
    ['workspace override', { workspace_id: OTHER_ID }], ['record ID', { id: MEMBER_ID }],
    ['inactive record', { is_active: false }], ['invite status', { invite_status: 'accepted' }],
    ['invitation email', { email: 'chidi@example.com' }], ['force', { force: true }],
  ])('rejects %s before any database access', async (_label, changes) => {
    await expect(members.createMember(parameters({ data: approvedData(changes) })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each(['display_name', 'relationship_to_head', 'admin_notes'].flatMap((field) => [
    [field, 'NUL', 'Chidi\u0000Okafor'],
    [field, 'unpaired surrogate', 'Chidi\uD800Okafor'],
  ]))('rejects %s containing %s before access', async (field, _label, value) => {
    await expect(members.createMember(parameters({ data: approvedData({ [field]: value }) })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it('preserves valid emoji and trims requested text before insertion', async () => {
    const canonical = { display_name: 'Chidi 😀 Okafor', relationship_to_head: 'Cousin 💛', admin_notes: 'Calls 📞' };
    scriptInsert({ data: storedMember(canonical), error: null });
    await expect(members.createMember(parameters({ data: approvedData({
      display_name: '  Chidi 😀 Okafor  ', relationship_to_head: '  Cousin 💛  ', admin_notes: '  Calls 📞  ',
    }) }))).resolves.toEqual(storedMember(canonical));
    expect(db.builder.insert).toHaveBeenCalledWith(storedMember(canonical));
  });

  it('requires database state fields instead of supplying response defaults', () => {
    const { id, joined_at, created_at, updated_at, ...fields } = storedMember();
    const state = { member_id: id, ...fields };
    expect(memberCreationStateSchema.safeParse(state).success).toBe(true);
    for (const field of ['role', 'user_id', 'is_proxy', 'proxy_managed_by', 'invite_status', 'contribution_streak_months']) {
      const incomplete = { ...state };
      delete incomplete[field];
      expect(memberCreationStateSchema.safeParse(incomplete).success).toBe(false);
    }
  });
});

describe('member creation workspace/admin service boundary', () => {
  it('reads the real workspace and admin while excluding unrelated profile data', async () => {
    scriptContext({ workspace: { private_settings: 'PRIVATE_WORKSPACE_DATA' }, admin: { admin_notes: 'PRIVATE_PROFILE_DATA' } });
    await expect(members.getMemberCreationContext(callerParameters())).resolves.toEqual(creationContext());
    expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members']]);
    expect(queries('workspaces')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', actor.workspace.id] }, { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('workspace_members')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', actor.member.id] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['user_id', actor.userId] }, { method: 'eq', args: ['role', 'admin'] },
      { method: 'eq', args: ['is_active', true] }, { method: 'eq', args: ['is_proxy', false] },
      { method: 'is', args: ['deleted_at', null] },
    ]));
    expectNoWrite();
  });

  it('denies a member before accessing the database', async () => {
    await expect(members.getMemberCreationContext(callerParameters({ isAdmin: false })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([
    ['workspace', { workspaceId: 'invalid' }], ['caller', { callerId: 'invalid' }],
    ['user', { userId: 'invalid' }], ['role', { isAdmin: undefined }],
  ])('rejects invalid %s context before accessing the database', async (_label, changes) => {
    await expect(members.getMemberCreationContext(callerParameters(changes)))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([['workspace', 0, 'NOT_FOUND'], ['admin', 1, 'FORBIDDEN']])(
    'rejects a missing %s', async (_label, index, code) => {
      if (index) db.mockNextResponse({ data: workspaceRow(), error: null });
      db.mockNextResponse({ data: null, error: null });
      await expect(members.getMemberCreationContext(callerParameters())).rejects.toMatchObject({ code });
      expect(db.client.from).toHaveBeenCalledTimes(index + 1);
      expectNoWrite();
    },
  );

  it.each([0, 1])('fails closed on partial/error context response %s', async (index) => {
    if (index) db.mockNextResponse({ data: workspaceRow(), error: null });
    db.mockNextResponse({ data: index ? adminRow() : workspaceRow(), error: { message: 'PRIVATE_QUERY_ERROR' } });
    await expect(members.getMemberCreationContext(callerParameters())).rejects.toMatchObject({
      code: 'MEMBER_CREATION_UNAVAILABLE', statusCode: 503, message: 'Member creation is unavailable. Please try again.',
    });
    expectNoWrite();
  });

  it.each([0, 1])('fails closed on malformed context response %s', async (index) => {
    if (index) db.mockNextResponse({ data: workspaceRow(), error: null });
    db.mockNextResponse({ data: { id: actor.workspace.id }, error: null });
    await expect(members.getMemberCreationContext(callerParameters()))
      .rejects.toMatchObject({ code: 'MEMBER_CREATION_UNAVAILABLE' });
    expectNoWrite();
  });

  it.each([
    ['deleted workspace', { deleted_at: CREATED_AT }, 'NOT_FOUND'],
    ['different workspace', { id: OTHER_ID }, 'MEMBER_CREATION_UNAVAILABLE'],
  ])('rejects a %s before reading membership', async (_label, changes, code) => {
    db.mockNextResponse({ data: workspaceRow(changes), error: null });
    await expect(members.getMemberCreationContext(callerParameters())).rejects.toMatchObject({ code });
    expect(db.client.from.mock.calls).toEqual([['workspaces']]);
    expectNoWrite();
  });

  it.each([
    ['changed role', { role: 'member' }], ['inactive membership', { is_active: false }],
    ['proxy membership', { is_proxy: true }], ['deleted membership', { deleted_at: CREATED_AT }],
    ['different user', { user_id: OTHER_ID }], ['different workspace', { workspace_id: OTHER_ID }],
    ['different member', { id: OTHER_ID }],
  ])('rejects %s before creation', async (_label, admin) => {
    scriptContext({ admin });
    await expect(members.getMemberCreationContext(callerParameters())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expectNoWrite();
  });

  it('normalizes thrown read failures without exposing transport details', async () => {
    db.builder.maybeSingle.mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT_ERROR'));
    await expect(members.getMemberCreationContext(callerParameters())).rejects.toMatchObject({
      code: 'MEMBER_CREATION_UNAVAILABLE', message: 'Member creation is unavailable. Please try again.',
    });
    expectNoWrite();
  });
});

describe('reviewed member creation insertion', () => {
  it.each([
    ['missing user', { userId: undefined }], ['missing generated ID', { memberId: undefined }],
    ['invalid generated ID', { memberId: 'invalid' }], ['missing snapshot', { expected: undefined }],
    ['non-admin snapshot', { expected: creationContext({ member_role: 'member' }) }],
    ['unexpected reviewed option', { force: true }],
  ])('rejects %s before access', async (_label, changes) => {
    await expect(members.createMember(parameters({ reviewedCreation: reviewedOptions(changes) })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it('requires the authenticated actor member ID', async () => {
    await expect(members.createMember(parameters({ actorCtx: { ...actorCtx, actorMemberId: undefined } })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it('denies a real non-admin role before any access', async () => {
    await expect(members.createMember(parameters({ reviewedCreation: reviewedOptions({ isAdmin: false }) })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([
    ['workspace', { workspace_id: OTHER_ID }], ['actor', { actor_member_id: OTHER_ID }],
  ])('rejects an inconsistent reviewed %s', async (_label, changes) => {
    await expect(members.createMember(parameters({
      reviewedCreation: reviewedOptions({ expected: creationContext(changes) }),
    }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([
    ['workspace name', { workspace: { name: 'Renamed family' } }],
    ['workspace version', { workspace: { updated_at: CREATED_AT } }],
    ['workspace deletion', { workspace: { deleted_at: CREATED_AT } }],
    ['admin role', { admin: { role: 'member' } }],
    ['proxy manager eligibility', { admin: { is_active: false } }],
  ])('rejects changed %s before insertion', async (_label, changes) => {
    scriptContext(changes);
    await expect(members.createMember(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
    expectNoWrite();
  });

  it('inserts the exact reviewed member defaults and authenticates the audit actor', async () => {
    scriptInsert();
    const spoofedActor = { ...actorCtx, workspaceId: OTHER_ID, actorUserId: OTHER_ID };
    await expect(members.createMember(parameters({ actorCtx: spoofedActor }))).resolves.toEqual(storedMember());
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(db.builder.insert).toHaveBeenCalledWith(storedMember());
    expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members'], ['workspace_members']]);
    expect(audit.log).toHaveBeenCalledWith({
      ...actorCtx, required: true, action: AUDIT_ACTIONS.MEMBER_CREATED,
      targetType: 'workspace_member', targetId: MEMBER_ID,
      metadata: { display_name: 'Chidi Okafor', is_proxy: false },
    });
    expectNoOtherEffects();
  });

  it('creates a proxy managed only by the requesting admin and records its proxy action', async () => {
    const proxy = { is_proxy: true, proxy_managed_by: actor.member.id };
    scriptInsert({ data: storedMember(proxy), error: null });
    db.mockNextResponse({ data: { id: MEMBER_ID }, error: null });
    await expect(members.createMember(parameters({ data: approvedData({ is_proxy: true }) })))
      .resolves.toEqual(storedMember(proxy));
    expect(db.builder.insert.mock.calls).toEqual([
      [storedMember(proxy)],
      [{
        id: MEMBER_ID, workspace_id: actor.workspace.id, proxy_member_id: MEMBER_ID,
        managed_by_id: actor.member.id, action_type: AUDIT_ACTIONS.MEMBER_CREATED, target_id: MEMBER_ID,
        action_details: { display_name: 'Chidi Okafor', agent_initiated: true, proposal_id: MEMBER_ID },
        created_at: CREATED_AT,
      }],
    ]);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      required: true, action: AUDIT_ACTIONS.MEMBER_CREATED, metadata: { display_name: 'Chidi Okafor', is_proxy: true },
    }));
    expectNoOtherEffects();
  });

  it('inserts nullable reviewed defaults when optional details were omitted', async () => {
    const defaults = { relationship_to_head: null, relationship_category: 'other', date_of_birth: null, admin_notes: null };
    scriptInsert({ data: storedMember(defaults), error: null });
    await expect(members.createMember(parameters({ data: { display_name: 'Chidi Okafor' } })))
      .resolves.toEqual(storedMember(defaults));
    expect(db.builder.insert).toHaveBeenCalledWith(storedMember(defaults));
  });

  it('accepts equivalent database timestamp offsets for all creation timestamps', async () => {
    const offset = '2026-11-15T12:02:00.000+00:00';
    scriptInsert({ data: storedMember({ joined_at: offset, created_at: offset, updated_at: offset }), error: null });
    await expect(members.createMember(parameters()))
      .resolves.toEqual(storedMember({ joined_at: offset, created_at: offset, updated_at: offset }));
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary route-gated HTTP member creation', async () => {
    const legacy = { id: 'legacy-member', display_name: 'Legacy member', is_proxy: false };
    db.mockNextResponse({ data: legacy, error: null });
    await expect(members.createMember({
      workspaceId: 'legacy-workspace',
      data: { display_name: 'Legacy member', role: 'admin', is_proxy: false, relationship_category: 'other' },
      actorCtx: {},
    })).resolves.toEqual(legacy);
    expect(db.client.from.mock.calls).toEqual([['workspace_members']]);
    expect(db.builder.insert).toHaveBeenCalledWith({
      workspace_id: 'legacy-workspace', display_name: 'Legacy member', is_proxy: false,
      proxy_managed_by: null, role: 'admin', relationship_to_head: null,
      relationship_category: 'other', date_of_birth: null, admin_notes: null,
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: AUDIT_ACTIONS.MEMBER_CREATED, targetId: 'legacy-member',
    }));
    expectNoOtherEffects();
  });
});

describe('member creation uncertain outcomes', () => {
  it.each([
    ['ID', { id: OTHER_ID }], ['workspace', { workspace_id: OTHER_ID }], ['linked account', { user_id: OTHER_ID }],
    ['admin role', { role: 'admin' }], ['name', { display_name: 'Other member' }],
    ['padded name', { display_name: 'Chidi Okafor ' }], ['relationship', { relationship_to_head: null }],
    ['category', { relationship_category: 'other' }], ['birthday', { date_of_birth: null }],
    ['proxy flag', { is_proxy: true }], ['proxy manager', { proxy_managed_by: OTHER_ID }],
    ['notes', { admin_notes: 'Unreviewed notes' }], ['invitation', { invite_status: 'pending' }],
    ['invitation time', { invited_at: CREATED_AT }], ['activity', { last_active_at: CREATED_AT }],
    ['contribution count', { contribution_streak_months: 1 }], ['contribution date', { last_contribution_date: '2026-11-15' }],
    ['inactive member', { is_active: false }], ['deletion', { deleted_at: CREATED_AT }],
    ['missing field', { user_id: undefined }], ['joined timestamp', { joined_at: REVIEWED_AT }],
    ['creation timestamp', { created_at: REVIEWED_AT }], ['update timestamp', { updated_at: REVIEWED_AT }],
    ['missing timestamp', { joined_at: undefined }],
  ])('keeps a mismatched %s after insert uncertain without repair', async (_label, changes) => {
    scriptInsert({ data: storedMember(changes), error: null });
    await expect(members.createMember(parameters())).rejects.toMatchObject({
      code: 'MEMBER_CREATION_UNAVAILABLE', statusCode: 503,
    });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members'], ['workspace_members']]);
    expect(audit.log).not.toHaveBeenCalled();
    expectNoOtherEffects();
  });

  it('rejects a different proxy manager returned after creation without changing it', async () => {
    scriptInsert({ data: storedMember({ is_proxy: true, proxy_managed_by: OTHER_ID }), error: null });
    await expect(members.createMember(parameters({ data: approvedData({ is_proxy: true }) })))
      .rejects.toMatchObject({ code: 'MEMBER_CREATION_UNAVAILABLE' });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
    expectNoOtherEffects();
  });

  it.each([
    ['null result', { data: null, error: null }], ['array result', { data: [storedMember()], error: null }],
    ['missing data', { error: null }], ['missing error', { data: storedMember() }],
    ['partial error', { data: storedMember(), error: { message: 'PRIVATE_INSERT_ERROR' } }],
    ['primary key collision', { data: null, error: { code: '23505', message: 'PRIVATE_DUPLICATE_ERROR' } }],
  ])('does not retry an insert with %s', async (_label, response) => {
    scriptInsert(response);
    await expect(members.createMember(parameters())).rejects.toMatchObject({
      code: 'MEMBER_CREATION_UNAVAILABLE', message: 'Member creation is unavailable. Please try again.',
    });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
    expectNoOtherEffects();
  });

  it('normalizes an insert transport failure without a second attempt', async () => {
    scriptContext();
    db.builder.single.mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT_ERROR'));
    await expect(members.createMember(parameters())).rejects.toMatchObject({ code: 'MEMBER_CREATION_UNAVAILABLE' });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
    expectNoOtherEffects();
  });

  it('never reports a post-insert audit conflict as proof no member was created', async () => {
    scriptInsert({ data: storedMember({ is_proxy: true, proxy_managed_by: actor.member.id }), error: null });
    audit.log.mockRejectedValueOnce(new ConflictError('PRIVATE_AUDIT_FAILURE'));
    await expect(members.createMember(parameters({ data: approvedData({ is_proxy: true }) })))
      .rejects.toMatchObject({ code: 'MEMBER_CREATION_UNAVAILABLE' });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(db.client.from).not.toHaveBeenCalledWith('proxy_actions');
    expectNoOtherEffects();
  });

  it.each([
    ['missing proxy action', { data: null, error: null }],
    ['wrong proxy action', { data: { id: OTHER_ID }, error: null }],
    ['proxy audit error', { data: { id: MEMBER_ID }, error: { message: 'PRIVATE_PROXY_ERROR' } }],
    ['missing proxy result error', { data: { id: MEMBER_ID } }],
  ])('keeps %s uncertain after the member was inserted', async (_label, response) => {
    scriptInsert({ data: storedMember({ is_proxy: true, proxy_managed_by: actor.member.id }), error: null });
    db.mockNextResponse(response);
    await expect(members.createMember(parameters({ data: approvedData({ is_proxy: true }) })))
      .rejects.toMatchObject({ code: 'MEMBER_CREATION_UNAVAILABLE' });
    expect(db.builder.insert).toHaveBeenCalledTimes(2);
    expect(queries('workspace_members').filter((query) => query.some((call) => call.method === 'insert'))).toHaveLength(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expectNoOtherEffects();
  });

  it('does not expose a thrown proxy-audit conflict as a retryable creation conflict', async () => {
    scriptContext();
    db.builder.single
      .mockResolvedValueOnce({ data: storedMember({ is_proxy: true, proxy_managed_by: actor.member.id }), error: null })
      .mockRejectedValueOnce(new ConflictError('PRIVATE_PROXY_TRANSPORT_ERROR'));
    await expect(members.createMember(parameters({ data: approvedData({ is_proxy: true }) })))
      .rejects.toMatchObject({ code: 'MEMBER_CREATION_UNAVAILABLE' });
    expect(db.builder.insert).toHaveBeenCalledTimes(2);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expectNoOtherEffects();
  });
});
