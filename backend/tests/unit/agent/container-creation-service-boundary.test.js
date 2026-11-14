// Exercise the actual service boundary. Postgres uniqueness and concurrent
// eligibility changes require separate live integration coverage.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));
jest.mock('../../../src/services/storage.service', () => ({}));
jest.mock('../../../src/queues', () => ({ getQueue: jest.fn() }));

const containers = require('../../../src/services/container.service');
const audit = require('../../../src/services/audit.service');
const notification = require('../../../src/services/notification.service');
const { getQueue } = require('../../../src/queues');
const { ConflictError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const {
  eventContainerCreationDataSchema, eventContainerCreationStateSchema,
  buildEventContainerCreationState,
} = require('../../../src/validators/workspace.validator');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');

const actor = { ...context(), member: { ...context().member, role: 'admin' } };
const CONTAINER_ID = '77777777-7777-4777-8777-777777777777';
const CREATED_AT = '2026-11-14T12:02:00.000Z';
const REVIEWED_AT = '2026-11-14T12:00:00.000Z';
const actorCtx = {
  workspaceId: actor.workspace.id, actorUserId: actor.userId, actorMemberId: actor.member.id,
  ipAddress: '127.0.0.1', userAgent: 'container-boundary-test',
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
  name: 'Family reunion', subtitle: 'December gathering', description: 'Bring a dish.',
  container_type: 'event', enable_money: true, enable_tasks: true,
  event_date: '2026-12-25', event_type: 'Reunion', event_type_category: 'celebration', ...overrides,
});
// Explicit fixture reflects the consolidated schema; it does not use the
// production state builder to manufacture the expected database defaults.
const storedContainer = (overrides = {}) => ({
  id: CONTAINER_ID, workspace_id: actor.workspace.id, name: 'Family reunion',
  subtitle: 'December gathering', description: 'Bring a dish.', container_type: 'event',
  enable_money: true, enable_tasks: true, event_date: '2026-12-25', event_type: 'Reunion',
  event_type_category: 'celebration', recurrence_cadence: null, recurrence_days: null,
  recurrence_start: null, recurrence_end: null, carry_forward_unpaid: false,
  auto_generate_cycles: true, budget_target: null, budget_currency: null,
  public_token: null, public_show_names: true, cover_photos: [], status: 'active',
  outcome_details: null, outcome_files: [], converted_from_id: null,
  completed_at: null, deleted_at: null, created_by: actor.member.id,
  created_at: CREATED_AT, updated_at: CREATED_AT, ...overrides,
});

const callerParameters = (overrides = {}) => ({
  workspaceId: actor.workspace.id, callerId: actor.member.id, userId: actor.userId,
  isAdmin: true, ...overrides,
});
const parameters = (overrides = {}) => ({
  workspaceId: actor.workspace.id, data: approvedData(), actorMemberId: actor.member.id,
  actorCtx, reviewedCreation: { userId: actor.userId, isAdmin: true,
    expected: creationContext(), containerId: CONTAINER_ID }, ...overrides,
});
const reviewedOptions = (overrides = {}) => ({ ...parameters().reviewedCreation, ...overrides });

function scriptContext({ workspace = {}, admin = {} } = {}) {
  db.mockResponses({ data: workspaceRow(workspace), error: null }, { data: adminRow(admin), error: null });
}
function scriptInsert(response = { data: storedContainer(), error: null }) {
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
function expectNoEffects() {
  expect(audit.log).not.toHaveBeenCalled();
  expect(notification.send).not.toHaveBeenCalled();
  expect(getQueue).not.toHaveBeenCalled();
}
function expectNoWrite() {
  expect(db.builder.insert).not.toHaveBeenCalled();
  expect(db.builder.update).not.toHaveBeenCalled();
  expect(db.client.rpc).not.toHaveBeenCalled();
  expectNoEffects();
}

const db = require('../../../src/config/supabase').__mockInstance;
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date(CREATED_AT));
  db.reset();
  jest.clearAllMocks();
  audit.log.mockResolvedValue();
  notification.send.mockResolvedValue();
  getQueue.mockReturnValue({ add: jest.fn().mockResolvedValue({ id: 'job-1' }) });
});
afterEach(() => jest.useRealTimers());

describe('reviewed event creation validation', () => {
  it('normalizes requested text and defaults without enabling extra features', () => {
    const data = eventContainerCreationDataSchema.parse({
      name: '  Family reunion  ', container_type: 'event', subtitle: '  ', description: '', event_type: '\n',
    });
    expect(data).toEqual({ name: 'Family reunion', container_type: 'event', subtitle: null,
      description: null, event_type: null, enable_money: false, enable_tasks: false,
      event_date: null, event_type_category: 'other' });
    const state = buildEventContainerCreationState({ data, workspaceId: actor.workspace.id,
      containerId: CONTAINER_ID, actorMemberId: actor.member.id });
    expect(state).toEqual(expect.objectContaining({
      status: 'active', created_by: actor.member.id, public_token: null,
      public_show_names: true, auto_generate_cycles: true, cover_photos: [], outcome_files: [],
      budget_target: null, budget_currency: null, recurrence_cadence: null, recurrence_days: null,
      recurrence_start: null, recurrence_end: null, carry_forward_unpaid: false,
      converted_from_id: null, completed_at: null, deleted_at: null,
    }));
    expect(eventContainerCreationDataSchema.pick({ name: true }).parse({ name: '  Reunion  ' }))
      .toEqual({ name: 'Reunion' });
  });

  it.each(['name', 'subtitle', 'description', 'event_type'].flatMap((field) => [
    [field, 'NUL', 'Family\u0000reunion'],
    [field, 'unpaired high surrogate', 'Family\uD800reunion'],
    [field, 'unpaired low surrogate', 'Family\uDC00reunion'],
  ]))('rejects %s containing %s before any service read or write', async (field, _label, value) => {
    await expect(containers.createContainer(parameters({ data: approvedData({ [field]: value }) })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it('creates valid emoji text verbatim after canonical whitespace trimming', async () => {
    const canonical = { name: 'Family 😀 reunion', subtitle: 'Cousins 💛',
      description: 'Bring a dish 🍲.', event_type: 'Reunion 🎉' };
    scriptInsert({ data: storedContainer(canonical), error: null });
    await expect(containers.createContainer(parameters({ data: approvedData({
      name: '  Family 😀 reunion  ', subtitle: '  Cousins 💛  ',
      description: '  Bring a dish 🍲.  ', event_type: '  Reunion 🎉  ',
    }) }))).resolves.toEqual(storedContainer(canonical));
    expect(db.builder.insert).toHaveBeenCalledWith(storedContainer(canonical));
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(notification.send).not.toHaveBeenCalled();
    expect(getQueue).not.toHaveBeenCalled();
  });

  it.each([
    ['blank name', { name: '   ' }], ['short trimmed name', { name: ' a ' }],
    ['long name', { name: 'x'.repeat(101) }], ['long subtitle', { subtitle: 'x'.repeat(201) }],
    ['long description', { description: 'x'.repeat(2001) }], ['long event type', { event_type: 'x'.repeat(81) }],
    ['invalid date', { event_date: '2026-02-29' }], ['relative date', { event_date: 'tomorrow' }],
    ['timestamp date', { event_date: CREATED_AT }], ['invalid category', { event_type_category: 'private' }],
    ['numeric money flag', { enable_money: 1 }], ['text task flag', { enable_tasks: 'true' }],
    ['recurring type', { container_type: 'recurring' }], ['budget', { budget_target: 5000 }],
    ['currency', { budget_currency: 'NGN' }], ['recurrence', { recurrence_cadence: 'monthly' }],
    ['carry policy', { carry_forward_unpaid: true }], ['public link', { public_token: 'PRIVATE_TOKEN' }],
    ['files', { cover_photos: [] }], ['participants', { member_ids: [OTHER_ID] }],
    ['status', { status: 'active' }], ['identity', { id: CONTAINER_ID }],
    ['creator', { created_by: OTHER_ID }], ['workspace', { workspace_id: OTHER_ID }],
    ['force', { force: true }],
  ])('rejects %s before reading context or inserting', async (_label, changes) => {
    await expect(containers.createContainer(parameters({ data: approvedData(changes) })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it('accepts a real leap date while retaining the requested flags and nullable fields', () => {
    expect(eventContainerCreationDataSchema.parse(approvedData({
      event_date: '2028-02-29', enable_money: false, enable_tasks: true, subtitle: null,
    }))).toEqual(approvedData({ event_date: '2028-02-29', enable_money: false, subtitle: null }));
  });

  it('requires stored fields instead of restoring absent database values from defaults', () => {
    const { id, created_at, updated_at, ...fields } = storedContainer();
    const state = { container_id: id, ...fields };
    expect(eventContainerCreationStateSchema.safeParse(state).success).toBe(true);
    for (const field of ['enable_money', 'event_type_category', 'subtitle', 'cover_photos', 'public_token']) {
      const incomplete = { ...state };
      delete incomplete[field];
      expect(eventContainerCreationStateSchema.safeParse(incomplete).success).toBe(false);
    }
  });
});

describe('container creation workspace/admin service boundary', () => {
  it('returns only the freshly scoped workspace and real admin context', async () => {
    scriptContext({ workspace: { private_settings: 'PRIVATE_WORKSPACE_DATA' },
      admin: { admin_notes: 'PRIVATE_ADMIN_DATA' } });
    await expect(containers.getContainerCreationContext(callerParameters())).resolves.toEqual(creationContext());
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

  it('rejects a member flag before any database read', async () => {
    await expect(containers.getContainerCreationContext(callerParameters({ isAdmin: false })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([
    ['workspace ID', { workspaceId: 'invalid' }], ['member ID', { callerId: 'invalid' }],
    ['user ID', { userId: 'invalid' }], ['missing role', { isAdmin: undefined }],
  ])('rejects an invalid context %s before reading', async (_label, changes) => {
    await expect(containers.getContainerCreationContext(callerParameters(changes)))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([
    ['workspace', 0, 'NOT_FOUND'], ['admin', 1, 'FORBIDDEN'],
  ])('stops when the scoped %s is missing', async (_label, index, code) => {
    if (index) db.mockNextResponse({ data: workspaceRow(), error: null });
    db.mockNextResponse({ data: null, error: null });
    await expect(containers.getContainerCreationContext(callerParameters())).rejects.toMatchObject({ code });
    expect(db.client.from).toHaveBeenCalledTimes(index + 1);
    expectNoWrite();
  });

  it.each([0, 1])('fails closed on read %s errors with partial data', async (index) => {
    if (index) db.mockNextResponse({ data: workspaceRow(), error: null });
    db.mockNextResponse({ data: index ? adminRow() : workspaceRow(), error: { message: 'PRIVATE_QUERY_ERROR' } });
    await expect(containers.getContainerCreationContext(callerParameters())).rejects.toMatchObject({
      code: 'CONTAINER_CREATION_UNAVAILABLE', statusCode: 503, message: 'Container creation is unavailable. Please try again.',
    });
    expect(db.client.from).toHaveBeenCalledTimes(index + 1);
    expectNoWrite();
  });

  it.each([0, 1])('fails closed on malformed context row %s', async (index) => {
    if (index) db.mockNextResponse({ data: workspaceRow(), error: null });
    db.mockNextResponse({ data: { id: actor.workspace.id }, error: null });
    await expect(containers.getContainerCreationContext(callerParameters()))
      .rejects.toMatchObject({ code: 'CONTAINER_CREATION_UNAVAILABLE' });
    expectNoWrite();
  });

  it.each([
    ['deleted workspace', { deleted_at: CREATED_AT }, 'NOT_FOUND'],
    ['wrong workspace', { id: OTHER_ID }, 'CONTAINER_CREATION_UNAVAILABLE'],
  ])('denies a %s before reading the admin', async (_label, changes, code) => {
    db.mockNextResponse({ data: workspaceRow(changes), error: null });
    await expect(containers.getContainerCreationContext(callerParameters())).rejects.toMatchObject({ code });
    expect(db.client.from.mock.calls).toEqual([['workspaces']]);
    expectNoWrite();
  });

  it.each([
    ['changed role', { role: 'member' }], ['inactive member', { is_active: false }],
    ['proxy member', { is_proxy: true }], ['deleted member', { deleted_at: CREATED_AT }],
    ['different user', { user_id: OTHER_ID }], ['different workspace', { workspace_id: OTHER_ID }],
    ['different member', { id: OTHER_ID }],
  ])('denies a %s before insertion', async (_label, admin) => {
    scriptContext({ admin });
    await expect(containers.getContainerCreationContext(callerParameters())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expectNoWrite();
  });

  it('suppresses thrown transport details during the fresh context read', async () => {
    db.builder.maybeSingle.mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT_ERROR'));
    await expect(containers.getContainerCreationContext(callerParameters())).rejects.toMatchObject({
      code: 'CONTAINER_CREATION_UNAVAILABLE', statusCode: 503,
    });
    expectNoWrite();
  });
});

describe('reviewed event creation guards and insertion', () => {
  it.each([
    ['missing reviewed user', { userId: undefined }], ['invalid reviewed user', { userId: 'invalid' }],
    ['missing generated ID', { containerId: undefined }], ['invalid generated ID', { containerId: 'invalid' }],
    ['missing context', { expected: undefined }], ['non-admin snapshot', { expected: creationContext({ member_role: 'member' }) }],
    ['unexpected option', { force: true }],
  ])('rejects %s without a context read', async (_label, changes) => {
    await expect(containers.createContainer(parameters({ reviewedCreation: reviewedOptions(changes) })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it('rejects a real member role before reading or inserting', async () => {
    await expect(containers.createContainer(parameters({ reviewedCreation: reviewedOptions({ isAdmin: false }) })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([
    ['workspace', { workspace_id: OTHER_ID }], ['admin', { actor_member_id: OTHER_ID }],
  ])('rejects a reviewed %s mismatch before reading', async (_label, changes) => {
    await expect(containers.createContainer(parameters({
      reviewedCreation: reviewedOptions({ expected: creationContext(changes) }),
    }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([
    ['workspace label', { workspace: { name: 'Renamed family' } }],
    ['workspace version', { workspace: { updated_at: '2026-11-14T12:01:00.000Z' } }],
    ['admin eligibility', { admin: { role: 'member' } }],
  ])('invalidates changed %s before INSERT', async (_label, changes) => {
    scriptContext(changes);
    await expect(containers.createContainer(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
    expectNoWrite();
  });

  it('inserts only the approved event state and protects audit identity', async () => {
    scriptInsert();
    const spoofedActor = { ...actorCtx, workspaceId: OTHER_ID, actorUserId: OTHER_ID, actorMemberId: OTHER_ID };
    await expect(containers.createContainer(parameters({ actorCtx: spoofedActor }))).resolves.toEqual(storedContainer());
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(db.builder.insert).toHaveBeenCalledWith(storedContainer());
    expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members'], ['containers']]);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith({
      ...actorCtx, required: true, action: AUDIT_ACTIONS.CONTAINER_CREATED,
      targetType: 'container', targetId: CONTAINER_ID,
      metadata: { name: 'Family reunion', container_type: 'event' },
    });
    expect(notification.send).not.toHaveBeenCalled();
    expect(getQueue).not.toHaveBeenCalled();
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.client.rpc).not.toHaveBeenCalled();
  });

  it('inserts the canonical reviewed defaults when optional fields were omitted', async () => {
    const defaults = { subtitle: null, description: null, enable_money: false, enable_tasks: false,
      event_date: null, event_type: null, event_type_category: 'other' };
    scriptInsert({ data: storedContainer(defaults), error: null });
    await expect(containers.createContainer(parameters({ data: { name: 'Family reunion', container_type: 'event' } })))
      .resolves.toEqual(storedContainer(defaults));
    expect(db.builder.insert).toHaveBeenCalledWith(storedContainer(defaults));
  });

  it('accepts equivalent stored ISO timestamp offsets at the execution instant', async () => {
    const offsetTime = '2026-11-14T12:02:00.000+00:00';
    scriptInsert({ data: storedContainer({ created_at: offsetTime, updated_at: offsetTime }), error: null });
    await expect(containers.createContainer(parameters()))
      .resolves.toEqual(storedContainer({ created_at: offsetTime, updated_at: offsetTime }));
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary HTTP creation and recurring job orchestration unchanged', async () => {
    const legacy = { id: 'legacy-container', name: 'Rent', container_type: 'recurring' };
    db.mockNextResponse({ data: legacy, error: null });
    await expect(containers.createContainer({ workspaceId: 'legacy-workspace',
      data: { name: 'Rent', container_type: 'recurring', recurrence_cadence: 'monthly',
        recurrence_start: '2026-12-01', budget_target: 5000, budget_currency: 'NGN' },
      actorMemberId: 'legacy-member', actorCtx: {},
    })).resolves.toEqual(legacy);
    expect(db.client.from.mock.calls).toEqual([['containers']]);
    expect(db.builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'legacy-workspace', created_by: 'legacy-member', container_type: 'recurring',
      budget_target: 5000, budget_currency: 'NGN', recurrence_cadence: 'monthly',
    }));
    expect(db.builder.insert.mock.calls[0][0]).not.toHaveProperty('id');
    expect(db.builder.insert.mock.calls[0][0]).not.toHaveProperty('created_at');
    expect(getQueue).toHaveBeenCalledWith('cycle-generation-queue');
    expect(getQueue.mock.results[0].value.add).toHaveBeenCalledWith('generate-cycles',
      { container_id: 'legacy-container', generate_months_ahead: 3 }, { attempts: 3 });
  });
});

describe('reviewed event creation uncertain outcomes', () => {
  it.each([
    ['ID', { id: OTHER_ID }], ['workspace', { workspace_id: OTHER_ID }], ['creator', { created_by: OTHER_ID }],
    ['name', { name: 'Changed name' }], ['padded name', { name: 'Family reunion ' }],
    ['subtitle', { subtitle: null }], ['description', { description: 'Unreviewed description' }],
    ['money flag', { enable_money: false }], ['task flag', { enable_tasks: false }],
    ['event date', { event_date: '2026-12-26' }], ['event type', { event_type: null }],
    ['category', { event_type_category: 'other' }], ['recurring type', { container_type: 'recurring' }],
    ['inactive state', { status: 'archived' }], ['budget', { budget_target: 5000 }],
    ['currency', { budget_currency: 'NGN' }], ['cadence', { recurrence_cadence: 'monthly' }],
    ['days', { recurrence_days: 30 }], ['start', { recurrence_start: '2026-12-01' }],
    ['end', { recurrence_end: '2027-12-01' }], ['carry policy', { carry_forward_unpaid: true }],
    ['cycle default', { auto_generate_cycles: false }], ['public token', { public_token: 'PRIVATE_TOKEN' }],
    ['public names default', { public_show_names: false }], ['cover files', { cover_photos: [{ path: 'PRIVATE_FILE' }] }],
    ['outcome files', { outcome_files: [{ path: 'PRIVATE_FILE' }] }], ['outcome', { outcome_details: 'Unexpected outcome' }],
    ['conversion', { converted_from_id: OTHER_ID }], ['completion', { completed_at: CREATED_AT }],
    ['deletion', { deleted_at: CREATED_AT }], ['missing field', { public_token: undefined }],
    ['created timestamp', { created_at: REVIEWED_AT }], ['updated timestamp', { updated_at: REVIEWED_AT }],
    ['missing timestamp', { created_at: undefined }],
    ['oversized timestamp', { created_at: '2026-11-14T12:02:00.000000000000000000000+00:00' }],
  ])('never repairs a mismatched %s after INSERT', async (_label, changes) => {
    scriptInsert({ data: storedContainer(changes), error: null });
    await expect(containers.createContainer(parameters())).rejects.toMatchObject({
      code: 'CONTAINER_CREATION_UNAVAILABLE', statusCode: 503,
    });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members'], ['containers']]);
    expectNoEffects();
  });

  it.each([
    ['null result', { data: null, error: null }], ['array result', { data: [storedContainer()], error: null }],
    ['malformed result', { data: {}, error: null }], ['missing data property', { error: null }],
    ['missing error property', { data: storedContainer() }],
    ['partial error', { data: storedContainer(), error: { code: 'XX000', message: 'PRIVATE_INSERT_ERROR' } }],
    ['primary-key collision', { data: null, error: { code: '23505', message: 'PRIVATE_DUPLICATE_ERROR' } }],
  ])('keeps %s after an attempted INSERT uncertain without a replay', async (_label, response) => {
    scriptInsert(response);
    await expect(containers.createContainer(parameters())).rejects.toMatchObject({
      code: 'CONTAINER_CREATION_UNAVAILABLE', statusCode: 503, message: 'Container creation is unavailable. Please try again.',
    });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(queries('containers')).toHaveLength(1);
    expectNoEffects();
  });

  it('normalizes a thrown INSERT transport failure without retrying', async () => {
    scriptContext();
    db.builder.single.mockRejectedValueOnce(new Error('PRIVATE_INSERT_TRANSPORT_ERROR'));
    await expect(containers.createContainer(parameters())).rejects.toMatchObject({ code: 'CONTAINER_CREATION_UNAVAILABLE' });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });

  it('never labels a post-insert audit conflict as proof no container was created', async () => {
    scriptInsert();
    audit.log.mockRejectedValueOnce(new ConflictError('PRIVATE_AUDIT_FAILURE'));
    await expect(containers.createContainer(parameters())).rejects.toMatchObject({ code: 'CONTAINER_CREATION_UNAVAILABLE' });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(getQueue).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
  });
});
