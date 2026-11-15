// Exercise the real service; concurrent eligibility and database uniqueness need live integration coverage.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));
jest.mock('../../../src/services/storage.service', () => ({}));
jest.mock('../../../src/services/export.service', () => ({}));

const tasks = require('../../../src/services/task.service');
const audit = require('../../../src/services/audit.service');
const notification = require('../../../src/services/notification.service');
const logger = require('../../../src/utils/logger');
const { ConflictError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const { OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, ASSIGNEE_ID, TASK_ID, EXECUTION_TIME, adminContext, adminMember,
  workspaceRow, containerRow, assigneeRow, participantRow, creationAssignee,
  creationContext, creationData, createdTask,
} = require('../../helpers/agent-task-creation');
const db = require('../../../src/config/supabase').__mockInstance;
const actor = adminContext();
const actorCtx = { workspaceId: actor.workspace.id, actorUserId: actor.userId,
  actorMemberId: actor.member.id, ipAddress: '127.0.0.1', userAgent: 'task-creation-boundary-test' };
const unavailable = { code: 'TASK_CREATION_UNAVAILABLE', statusCode: 503,
  message: 'Task creation is unavailable. Please try again.' };
const caller = (changes = {}) => ({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
  assigneeId: null, callerId: actor.member.id, userId: actor.userId, isAdmin: true, ...changes });
const reviewed = (changes = {}) => ({ userId: actor.userId, isAdmin: true,
  taskId: TASK_ID, expected: creationContext(), ...changes });
const parameters = (changes = {}) => ({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
  data: creationData(), actorMemberId: actor.member.id, actorDisplayName: actor.member.displayName,
  actorCtx, reviewedCreation: reviewed(), ...changes });
const assignedParameters = (changes = {}) => parameters({ data: creationData({ assigned_to: ASSIGNEE_ID }),
  reviewedCreation: reviewed({ expected: creationContext({ assignee: creationAssignee() }) }), ...changes });
const response = (data) => ({ data, error: null });
function contextResponses(changes = {}, assigned = false) {
  return Object.entries({ workspace: workspaceRow, admin: adminMember, container: containerRow,
    ...(assigned ? { assignee: assigneeRow, participant: participantRow } : {}) })
    .map(([name, fixture]) => response(changes[name] === null ? null : fixture(changes[name])));
}
function scriptCreation({ changes = {}, assigned = false, result } = {}) {
  db.mockResponses(...contextResponses(changes, assigned), result ?? response(createdTask({
    assigned_to: assigned ? ASSIGNEE_ID : null,
  })));
}
function queryCalls(table, occurrence = 0) {
  const calls = db.getCalls();
  const start = calls.flatMap((call, index) => call.method === 'from' && call.args[0] === table ? [index] : [])[occurrence];
  const end = calls.findIndex((call, index) => index > start && call.method === 'from');
  return calls.slice(start, end < 0 ? undefined : end);
}
function expectNoOtherWrites() {
  for (const method of ['update', 'delete', 'upsert']) expect(db.builder[method]).not.toHaveBeenCalled();
  expect(db.client.rpc).not.toHaveBeenCalled();
}
function expectNoEffects() {
  expect(audit.log).not.toHaveBeenCalled();
  expect(notification.send).not.toHaveBeenCalled();
}
function expectNoMutation() {
  expect(db.builder.insert).not.toHaveBeenCalled();
  expectNoOtherWrites();
  expectNoEffects();
}
beforeEach(() => {
  db.reset();
  jest.useFakeTimers().setSystemTime(new Date(EXECUTION_TIME));
  audit.log.mockResolvedValue();
  notification.send.mockResolvedValue();
});
afterEach(() => jest.useRealTimers());

it('reads only real admin and container scope for an unassigned task, trimming private context', async () => {
  db.mockResponses(...contextResponses({ workspace: { private_settings: 'PRIVATE' }, container: { public_token: 'PRIVATE' } }));
  await expect(tasks.getTaskCreationContext(caller())).resolves.toEqual(creationContext());
  expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members'], ['containers']]);
  const scopes = [
    ['workspaces', [['eq', 'id', actor.workspace.id], ['is', 'deleted_at', null]]],
    ['workspace_members', [['eq', 'id', actor.member.id], ['eq', 'workspace_id', actor.workspace.id],
      ['eq', 'user_id', actor.userId], ['eq', 'role', 'admin'], ['eq', 'is_active', true],
      ['eq', 'is_proxy', false], ['is', 'deleted_at', null]]],
    ['containers', [['eq', 'id', CONTAINER_ID], ['eq', 'workspace_id', actor.workspace.id], ['is', 'deleted_at', null]]],
  ];
  for (const [table, predicates] of scopes) expect(queryCalls(table)).toEqual(expect.arrayContaining(
    predicates.map(([method, ...args]) => ({ method, args })),
  ));
  expectNoMutation();
});

it('scopes an explicit unlinked assignee and task-enabled participation without exposing their private data', async () => {
  db.mockResponses(...contextResponses({ assignee: { admin_notes: 'PRIVATE' }, participant: { money_enabled: true } }, true));
  await expect(tasks.getTaskCreationContext(caller({ assigneeId: ASSIGNEE_ID })))
    .resolves.toEqual(creationContext({ assignee: creationAssignee() }));
  expect(queryCalls('workspace_members', 1)).toEqual(expect.arrayContaining([
    ...[['id', ASSIGNEE_ID], ['workspace_id', actor.workspace.id], ['is_active', true], ['is_proxy', false]]
      .map((args) => ({ method: 'eq', args })), { method: 'is', args: ['deleted_at', null] },
  ]));
  expect(queryCalls('workspace_members', 1).some(({ args }) => args[0] === 'user_id')).toBe(false);
  expect(queryCalls('container_participants')).toEqual(expect.arrayContaining([
    { method: 'eq', args: ['container_id', CONTAINER_ID] }, { method: 'eq', args: ['workspace_member_id', ASSIGNEE_ID] },
  ]));
  expectNoMutation();
});

it('denies non-admin context and approval flags before access', async () => {
  await expect(tasks.getTaskCreationContext(caller({ isAdmin: false }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(tasks.createTask(parameters({ reviewedCreation: reviewed({ isAdmin: false }) })))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoMutation();
});
it.each(['workspaceId', 'containerId', 'assigneeId', 'callerId', 'userId', 'isAdmin'])('rejects malformed caller %s', async (field) => {
  await expect(tasks.getTaskCreationContext(caller({ [field]: 'invalid' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoMutation();
});
it.each([{ role: 'member' }, { is_active: false }, { is_proxy: true }, { deleted_at: EXECUTION_TIME },
  { id: OTHER_ID }, { user_id: OTHER_ID }, { user_id: null }, { workspace_id: OTHER_ID }])('denies an actual ineligible admin %j', async (admin) => {
  db.mockResponses(...contextResponses({ admin }));
  await expect(tasks.getTaskCreationContext(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members']]);
  expectNoMutation();
});
it.each([
  [{ workspace: null }, 'NOT_FOUND'], [{ admin: null }, 'FORBIDDEN'], [{ container: null }, 'NOT_FOUND'],
  [{ workspace: { id: OTHER_ID } }, unavailable.code], [{ workspace: { deleted_at: EXECUTION_TIME } }, unavailable.code],
  [{ container: { id: OTHER_ID } }, unavailable.code], [{ container: { workspace_id: OTHER_ID } }, unavailable.code],
  [{ container: { deleted_at: EXECUTION_TIME } }, unavailable.code],
  [{ container: { status: 'archived' } }, 'BUSINESS_RULE_VIOLATION'],
  [{ container: { enable_tasks: false } }, 'BUSINESS_RULE_VIOLATION'],
  [{ container: { container_type: 'unknown' } }, 'BUSINESS_RULE_VIOLATION'],
  [{ assignee: null }, 'NOT_FOUND'], [{ assignee: { id: OTHER_ID } }, unavailable.code],
  [{ assignee: { workspace_id: OTHER_ID } }, unavailable.code], [{ assignee: { deleted_at: EXECUTION_TIME } }, unavailable.code],
  [{ assignee: { is_active: false } }, 'BUSINESS_RULE_VIOLATION'], [{ assignee: { is_proxy: true } }, 'BUSINESS_RULE_VIOLATION'],
  [{ assignee: { role: 'owner' } }, 'BUSINESS_RULE_VIOLATION'], [{ participant: null }, 'BUSINESS_RULE_VIOLATION'],
  [{ participant: { container_id: OTHER_ID } }, unavailable.code], [{ participant: { workspace_member_id: OTHER_ID } }, unavailable.code],
  [{ participant: { tasks_enabled: false } }, 'BUSINESS_RULE_VIOLATION'],
  [{ participant: { id: 'invalid' } }, unavailable.code], [{ participant: { added_at: undefined } }, unavailable.code],
  [{ assignee: { updated_at: undefined } }, unavailable.code], [{ container: { updated_at: undefined } }, unavailable.code],
])('fails closed on missing, unscoped or ineligible context %j', async (changes, code) => {
  db.mockResponses(...contextResponses(changes, true));
  await expect(tasks.getTaskCreationContext(caller({ assigneeId: ASSIGNEE_ID }))).rejects.toMatchObject({ code });
  expectNoMutation();
});
it.each([0, 1, 2, 3, 4].flatMap((index) => [
  [index, { error: null }], [index, { data: [], error: null }], [index, { data: contextResponses({}, true)[index].data }],
  [index, { data: contextResponses({}, true)[index].data, error: { message: 'PRIVATE_READ_ERROR' } }],
]))('rejects malformed or failed scoped read %s', async (index, result) => {
  db.mockResponses(...contextResponses({}, true).slice(0, index), result);
  await expect(tasks.getTaskCreationContext(caller({ assigneeId: ASSIGNEE_ID }))).rejects.toMatchObject(unavailable);
  expect(db.client.from).toHaveBeenCalledTimes(index + 1);
  expectNoMutation();
});
it('keeps fresh-read transport failures unavailable before inserting', async () => {
  db.builder.maybeSingle.mockRejectedValueOnce(new ConflictError('PRIVATE_TRANSPORT_CONFLICT'));
  await expect(tasks.createTask(parameters())).rejects.toMatchObject(unavailable);
  expectNoMutation();
});

it.each([
  { title: '   ' }, { title: 'x'.repeat(201) }, { description: 'x'.repeat(2001) }, { description: 1 },
  { assigned_to: 'invalid' }, { assigned_to: [ASSIGNEE_ID] }, { due_date: 'tomorrow' }, { due_date: EXECUTION_TIME },
  { due_date: '2026-02-29' }, { due_date: '2026-11-31' }, { due_date: '2026-1-1' },
  { id: OTHER_ID }, { container_id: OTHER_ID }, { workspace_id: OTHER_ID }, { created_by: OTHER_ID },
  { status: 'completed' }, { proofs: [] }, { sort_order: 1 }, { completion_note: 'Done' }, { admin_note: 'Confirmed' },
  { assigned_to_members: [ASSIGNEE_ID] }, { force: true },
])('rejects unsupported task details %j before access', async (changes) => {
  await expect(tasks.createTask(parameters({ data: creationData(changes) }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoMutation();
});
it.each(['title', 'description'].flatMap((field) => ['\u0000', '\uD800', '\uDC00'].map((value) => [field, value])))(
  'rejects unsupported text in %s', async (field, value) => {
    await expect(tasks.createTask(parameters({ data: creationData({ [field]: `Task${value}text` }) })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoMutation();
  });
it.each([{ taskId: 'invalid' }, { userId: undefined }, { expected: undefined }, { force: true },
  { expected: creationContext({ member_role: 'member' }) }, { expected: creationContext({ task: {} }) }])(
  'rejects malformed review %j before access', async (changes) => {
    await expect(tasks.createTask(parameters({ reviewedCreation: reviewed(changes) }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoMutation();
  });
it.each(['workspace_id', 'container_id', 'actor_member_id'])('binds reviewed %s to the caller', async (field) => {
  await expect(tasks.createTask(parameters({ reviewedCreation: reviewed({ expected: creationContext({ [field]: OTHER_ID }) }) })))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoMutation();
});
it.each([null, creationAssignee({ member_id: OTHER_ID })])('binds the exact reviewed assignee %j', async (assignee) => {
  await expect(tasks.createTask(assignedParameters({ reviewedCreation: reviewed({ expected: creationContext({ assignee }) }) })))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoMutation();
});
it.each([
  { workspace: { updated_at: EXECUTION_TIME } }, { workspace: { name: 'Renamed family' } },
  { container: { updated_at: EXECUTION_TIME } }, { container: { container_type: 'recurring' } },
  { container: { status: 'completed' } }, { container: { enable_tasks: false } }, { admin: { role: 'member' } },
  { assignee: { updated_at: EXECUTION_TIME } }, { assignee: { display_name: 'Renamed member' } },
  { assignee: { role: 'admin' } }, { assignee: { is_active: false } }, { assignee: null },
  { participant: { id: OTHER_ID } }, { participant: { added_at: EXECUTION_TIME } },
  { participant: { tasks_enabled: false } }, { participant: null },
])('invalidates confirmed eligibility changes before INSERT %j', async (changes) => {
  scriptCreation({ changes, assigned: true });
  await expect(tasks.createTask(assignedParameters())).rejects.toMatchObject({ code: 'CONFLICT' });
  expectNoMutation();
});

it.each(['event', 'recurring'])('creates one unassigned %s task with exact nullable defaults and an authenticated required audit', async (type) => {
  scriptCreation({ changes: { container: { container_type: type } } });
  const spoofed = { ...actorCtx, workspaceId: OTHER_ID, actorUserId: OTHER_ID, actorMemberId: OTHER_ID };
  await expect(tasks.createTask(parameters({ data: { title: '  Buy groceries  ', description: '  ' }, actorCtx: spoofed,
    reviewedCreation: reviewed({ expected: creationContext({ container_type: type }) }),
  }))).resolves.toEqual(createdTask());
  expect(db.builder.insert).toHaveBeenCalledTimes(1);
  expect(db.builder.insert).toHaveBeenCalledWith(createdTask());
  expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members'], ['containers'], ['container_tasks']]);
  expect(audit.log).toHaveBeenCalledWith({ ...actorCtx, required: true, action: AUDIT_ACTIONS.TASK_CREATED,
    targetType: 'task', targetId: TASK_ID,
    metadata: { title: 'Buy groceries', agent_initiated: true, proposal_id: TASK_ID } });
  expect(notification.send).not.toHaveBeenCalled();
  expectNoOtherWrites();
});
it('keeps valid emoji, trimmed description and an explicit leap date verbatim', async () => {
  const canonical = { title: 'Buy groceries 😀', description: 'For dinner 🍲', due_date: '2028-02-29' };
  scriptCreation({ result: response(createdTask(canonical)) });
  await expect(tasks.createTask(parameters({ data: creationData({
    title: '  Buy groceries 😀  ', description: '  For dinner 🍲  ', due_date: '2028-02-29',
  }) }))).resolves.toEqual(createdTask(canonical));
  expect(db.builder.insert).toHaveBeenCalledWith(createdTask(canonical));
});
it.each(['event', 'recurring'].flatMap((type) => ['member', 'admin'].map((role) => [type, role])))(
  'assigns one unlinked %s container participant with existing role %s and a deduplicated notification', async (type, role) => {
    scriptCreation({ assigned: true, changes: { container: { container_type: type }, assignee: { role } } });
    await expect(tasks.createTask(assignedParameters({ reviewedCreation: reviewed({ expected: creationContext({
      container_type: type, assignee: creationAssignee({ member_role: role }),
    }) }) }))).resolves.toEqual(createdTask({ assigned_to: ASSIGNEE_ID }));
    expect(db.builder.insert).toHaveBeenCalledWith(createdTask({ assigned_to: ASSIGNEE_ID }));
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledWith({ type: 'task_assigned', workspaceId: actor.workspace.id,
      recipientIds: [ASSIGNEE_ID], referenceType: 'task', referenceId: TASK_ID,
      variables: { actor: actor.member.displayName, task_title: 'Buy groceries' }, dedupKey: `task_assigned:${TASK_ID}` });
    expect(audit.log.mock.invocationCallOrder[0]).toBeLessThan(notification.send.mock.invocationCallOrder[0]);
    expectNoOtherWrites();
  });
it('waits for required audit completion before notifying an assignee', async () => {
  scriptCreation({ assigned: true });
  let finishAudit;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  audit.log.mockImplementationOnce(() => {
    signalStarted();
    return new Promise((resolve) => { finishAudit = resolve; });
  });
  const execution = tasks.createTask(assignedParameters());
  await started;
  expect(notification.send).not.toHaveBeenCalled();
  finishAudit();
  await expect(execution).resolves.toEqual(createdTask({ assigned_to: ASSIGNEE_ID }));
  expect(notification.send).toHaveBeenCalledTimes(1);
});
it('returns the verified task and logs an unexpected notification failure without retry', async () => {
  scriptCreation({ assigned: true });
  notification.send.mockRejectedValueOnce(new ConflictError('PRIVATE_NOTIFICATION_FAILURE'));
  await expect(tasks.createTask(assignedParameters())).resolves.toEqual(createdTask({ assigned_to: ASSIGNEE_ID }));
  expect(notification.send).toHaveBeenCalledTimes(1);
  expect(audit.log).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith('Task creation assignment notification unavailable', {
    workspaceId: actor.workspace.id, taskId: TASK_ID, errorCode: 'CONFLICT',
  });
  expectNoOtherWrites();
});
it('accepts equivalent stored timestamp offsets for the actual execution time', async () => {
  const offset = '2026-11-15T12:03:00.000+00:00';
  scriptCreation({ result: response(createdTask({ created_at: offset, updated_at: offset })) });
  await expect(tasks.createTask(parameters())).resolves.toEqual(createdTask({ created_at: offset, updated_at: offset }));
});

it.each([
  response(null), response([]), response([createdTask()]), { error: null }, { data: createdTask() },
  { data: createdTask(), error: { message: 'PRIVATE_PARTIAL_ERROR' } },
  { data: null, error: { code: '23505', message: 'PRIVATE_PRIMARY_KEY_CONFLICT' } },
])('keeps every malformed or failed INSERT result uncertain %j', async (result) => {
  scriptCreation({ result });
  await expect(tasks.createTask(parameters())).rejects.toMatchObject(unavailable);
  expect(db.builder.insert).toHaveBeenCalledTimes(1);
  expectNoEffects();
  expectNoOtherWrites();
});
it.each([
  ...Object.keys(createdTask()).map((field) => [field, undefined]),
  ['id', OTHER_ID], ['container_id', OTHER_ID], ['title', 'Changed task'], ['title', 'Buy groceries '],
  ['description', 'Unexpected'], ['assigned_to', OTHER_ID], ['due_date', '2026-11-20'], ['status', 'completed'],
  ['completed_at', EXECUTION_TIME], ['completed_by', OTHER_ID], ['completion_note', 'Done'], ['proofs', [{}]],
  ['sort_order', 1], ['created_by', OTHER_ID], ['deleted_at', EXECUTION_TIME], ['admin_confirmed_at', EXECUTION_TIME],
  ['admin_confirmed_by', OTHER_ID], ['admin_note', 'Confirmed'], ['created_at', creationContext().container_updated_at],
  ['updated_at', '2026-11-15T12:03:00.001Z'],
])('requires every exact returned task column (%s=%s) without restoring defaults', async (field, value) => {
  scriptCreation({ result: response(createdTask({ [field]: value })) });
  await expect(tasks.createTask(parameters())).rejects.toMatchObject(unavailable);
  expect(db.builder.insert).toHaveBeenCalledTimes(1);
  expectNoEffects();
  expectNoOtherWrites();
});
it.each([new Error('PRIVATE_TRANSPORT_ERROR'), new ConflictError('PRIVATE_INSERT_CONFLICT')])(
  'normalizes a thrown attempted-INSERT failure %s', async (error) => {
    db.mockResponses(...contextResponses());
    db.builder.single.mockRejectedValueOnce(error);
    await expect(tasks.createTask(parameters())).rejects.toMatchObject(unavailable);
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expectNoEffects();
    expectNoOtherWrites();
  });
it.each([new Error('PRIVATE_AUDIT_ERROR'), new ConflictError('PRIVATE_AUDIT_CONFLICT')])(
  'keeps post-insert audit failure %s uncertain and sends no notification', async (error) => {
    scriptCreation({ assigned: true });
    audit.log.mockRejectedValueOnce(error);
    await expect(tasks.createTask(assignedParameters())).rejects.toMatchObject(unavailable);
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(notification.send).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });
