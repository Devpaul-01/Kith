// Scripted service-role queries; live Postgres concurrency remains integration work.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/storage.service', () => ({}));
jest.mock('../../../src/services/export.service', () => ({}));

const tasks = require('../../../src/services/task.service');
const notification = require('../../../src/services/notification.service');
const audit = require('../../../src/services/audit.service');
const { ConflictError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const { OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, TASK_ID, EXECUTION_TIME, adminContext, adminMember, assigneeRow, workspaceRow,
  containerRow, proof, taskRow, confirmationSnapshot, confirmationContext, confirmedTask,
} = require('../../helpers/agent-task-confirmation');
const db = require('../../../src/config/supabase').__mockInstance;
const actor = adminContext();
const actorCtx = { workspaceId: actor.workspace.id, actorUserId: actor.userId,
  actorMemberId: actor.member.id, ipAddress: '127.0.0.1', userAgent: 'task-confirmation-test' };
const unavailable = { code: 'TASK_CONFIRMATION_UNAVAILABLE', statusCode: 503 };
const caller = (overrides = {}) => ({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
  taskId: TASK_ID, callerId: actor.member.id, userId: actor.userId, isAdmin: true, ...overrides });
const parameters = (overrides = {}) => ({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
  taskId: TASK_ID, actorMemberId: actor.member.id, actorDisplayName: actor.member.displayName, actorCtx,
  reviewedConfirmation: { userId: actor.userId, isAdmin: true, expected: confirmationContext() }, ...overrides });

function contextResponses(changes = {}) {
  return Object.entries({ workspace: workspaceRow, actor: adminMember, container: containerRow, task: taskRow,
    ...(changes.task?.assigned_to === null ? {} : { assignee: assigneeRow }) })
    .map(([name, fixture]) => ({ data: changes[name] === null ? null : fixture(changes[name]), error: null }));
}
function scriptConfirmation({ changes, response = { data: confirmedTask(), error: null } } = {}) {
  db.mockResponses(...contextResponses(changes), response);
}
function queryCalls(table, occurrence = 0) {
  const calls = db.getCalls();
  const start = calls.flatMap((call, index) => call.method === 'from' && call.args[0] === table ? [index] : [])[occurrence];
  const end = calls.findIndex((call, index) => index > start && call.method === 'from');
  return calls.slice(start, end < 0 ? undefined : end);
}
function expectNoEffects() {
  expect(notification.send).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
}
function expectNoMutation() {
  for (const method of ['update', 'insert', 'delete', 'upsert']) expect(db.builder[method]).not.toHaveBeenCalled();
  expect(db.client.rpc).not.toHaveBeenCalled();
  expectNoEffects();
}

beforeEach(() => {
  db.reset();
  notification.send.mockResolvedValue();
  audit.log.mockResolvedValue();
  jest.useFakeTimers();
  jest.setSystemTime(new Date(EXECUTION_TIME));
});
afterEach(() => jest.useRealTimers());

it('checks the actual admin and scoped parent before returning exact task and proof metadata', async () => {
  db.mockResponses(...contextResponses({ task: { private_field: 'PRIVATE' }, container: { public_token: 'PRIVATE' } }));
  await expect(tasks.getTaskConfirmationContext(caller())).resolves.toEqual(confirmationContext());
  expect(db.client.from.mock.calls).toEqual([
    ['workspaces'], ['workspace_members'], ['containers'], ['container_tasks'], ['workspace_members'],
  ]);
  const scopes = [
    ['workspaces', [['eq', 'id', actor.workspace.id], ['is', 'deleted_at', null]]],
    ['workspace_members', [['eq', 'id', actor.member.id], ['eq', 'workspace_id', actor.workspace.id],
      ['eq', 'user_id', actor.userId], ['eq', 'role', 'admin'], ['eq', 'is_active', true],
      ['eq', 'is_proxy', false], ['is', 'deleted_at', null]]],
    ['containers', [['eq', 'id', CONTAINER_ID], ['eq', 'workspace_id', actor.workspace.id], ['is', 'deleted_at', null]]],
    ['container_tasks', [['eq', 'id', TASK_ID], ['eq', 'container_id', CONTAINER_ID], ['is', 'deleted_at', null]]],
  ];
  for (const [table, predicates] of scopes) expect(queryCalls(table)).toEqual(expect.arrayContaining(
    predicates.map(([method, ...args]) => ({ method, args })),
  ));
  expect(queryCalls('workspace_members', 1)).toEqual(expect.arrayContaining([
    { method: 'eq', args: ['id', OTHER_ID] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
    { method: 'is', args: ['deleted_at', null] },
  ]));
  expectNoMutation();
});

it('rejects non-admin and malformed callers without a database call', async () => {
  await expect(tasks.getTaskConfirmationContext(caller({ isAdmin: false }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(tasks.getTaskConfirmationContext(caller({ taskId: 'not-an-id' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(tasks.adminConfirmTask(parameters({ reviewedConfirmation: {
    userId: actor.userId, isAdmin: false, expected: confirmationContext(),
  } }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoMutation();
});

it.each([{ role: 'member' }, { is_active: false }, { is_proxy: true }, { deleted_at: EXECUTION_TIME },
  { id: OTHER_ID }, { user_id: OTHER_ID }, { workspace_id: OTHER_ID }])('denies stale or mismatched admin %j', async (change) => {
  db.mockResponses(...contextResponses({ actor: change }));
  await expect(tasks.getTaskConfirmationContext(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members']]);
  expectNoMutation();
});

it.each(['workspace_id', 'container_id', 'task_id', 'actor_member_id'])('rejects substituted reviewed %s', async (field) => {
  const expected = confirmationContext({ [field]: OTHER_ID, proofs: [] });
  await expect(tasks.adminConfirmTask(parameters({ reviewedConfirmation: {
    userId: actor.userId, isAdmin: true, expected,
  } }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.client.from).not.toHaveBeenCalled();
  expectNoMutation();
});

it.each([
  [{ workspace: null }, 'NOT_FOUND'], [{ actor: null }, 'FORBIDDEN'],
  [{ container: null }, 'NOT_FOUND'], [{ task: null }, 'NOT_FOUND'],
  [{ workspace: { id: OTHER_ID } }, unavailable.code], [{ container: { workspace_id: OTHER_ID } }, unavailable.code],
  [{ task: { container_id: OTHER_ID } }, unavailable.code], [{ task: { deleted_at: EXECUTION_TIME } }, unavailable.code],
  [{ container: { status: 'archived' } }, 'BUSINESS_RULE_VIOLATION'],
  [{ container: { enable_tasks: false } }, 'BUSINESS_RULE_VIOLATION'],
  [{ task: { status: 'in_progress' } }, 'BUSINESS_RULE_VIOLATION'],
  [{ task: { admin_confirmed_at: EXECUTION_TIME } }, 'BUSINESS_RULE_VIOLATION'],
  [{ task: { admin_confirmed_by: OTHER_ID } }, 'BUSINESS_RULE_VIOLATION'],
  [{ assignee: null }, 'BUSINESS_RULE_VIOLATION'], [{ assignee: { workspace_id: OTHER_ID } }, unavailable.code],
  [{ assignee: { id: actor.member.id } }, unavailable.code],
])('fails closed on unavailable or ineligible context %j', async (changes, code) => {
  db.mockResponses(...contextResponses(changes));
  await expect(tasks.getTaskConfirmationContext(caller())).rejects.toMatchObject({ code });
  expectNoMutation();
});

it.each([0, 1, 2, 3, 4])('does not trust data accompanying an error on read %s', async (index) => {
  const responses = contextResponses();
  responses[index].error = { message: 'PRIVATE_DATABASE_ERROR' };
  db.mockResponses(...responses);
  await expect(tasks.getTaskConfirmationContext(caller())).rejects.toMatchObject(unavailable);
  expect(db.client.from).toHaveBeenCalledTimes(index + 1);
  expectNoMutation();
});

it.each([
  { url: `workspaces/${OTHER_ID}/task-proofs/${TASK_ID}/receipt.jpg` },
  { url: `workspaces/${actor.workspace.id}/task-proofs/${OTHER_ID}/receipt.jpg` },
  { url: `${proof().url}/../another.jpg` }, { url: `${proof().url}?token=private` },
  { url: 'https://files.example/receipt.jpg' }, { private_token: 'PRIVATE' }, { size: -1 },
])('rejects unscoped or malformed uploaded proof metadata %j', async (change) => {
  db.mockResponses(...contextResponses({ task: { proofs: [proof(change)] } }));
  await expect(tasks.getTaskConfirmationContext(caller())).rejects.toMatchObject(unavailable);
  expectNoMutation();
});

it.each([
  { task: { title: 'Changed task' } }, { task: { assigned_to: null } },
  { task: { admin_note: 'Changed note' } }, { task: { proofs: [] } },
  { task: { proofs: [proof({ name: 'Changed receipt' })] } },
  { task: { completed_by: OTHER_ID } }, { container: { updated_at: EXECUTION_TIME } },
  { assignee: null },
])('invalidates changed review data without writing %j', async (changes) => {
  scriptConfirmation({ changes });
  await expect(tasks.adminConfirmTask(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
  expectNoMutation();
});

it('invalidates reordered proof attachments and forbids changing the reviewed admin note', async () => {
  const second = proof({ url: `${proof().url}.second`, name: 'Second receipt' });
  scriptConfirmation({ changes: { task: { proofs: [second, proof()] } } });
  await expect(tasks.adminConfirmTask(parameters({ reviewedConfirmation: {
    userId: actor.userId, isAdmin: true, expected: confirmationContext({ proofs: [proof(), second] }),
  } }))).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(tasks.adminConfirmTask(parameters({ note: 'Overwrite note' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expectNoMutation();
});

it('confirms once with exact predicates, preserved proofs/note, notification and required authenticated audit', async () => {
  const updated = confirmedTask({ updated_at: '2026-11-15T12:03:00.100Z' });
  scriptConfirmation({ response: { data: updated, error: null } });
  await expect(tasks.adminConfirmTask(parameters())).resolves.toEqual(updated);
  expect(db.builder.update).toHaveBeenCalledTimes(1);
  expect(db.builder.update).toHaveBeenCalledWith({ admin_confirmed_at: EXECUTION_TIME,
    admin_confirmed_by: actor.member.id, updated_at: EXECUTION_TIME });
  const filters = Object.entries(confirmationSnapshot()).map(([field, value]) => ({
    method: value === null ? 'is' : 'eq',
    args: [field === 'task_id' ? 'id' : field, field === 'proofs' ? JSON.stringify(value) : value],
  }));
  expect(queryCalls('container_tasks', 1)).toEqual(expect.arrayContaining(filters));
  expect(db.builder.single).not.toHaveBeenCalled();
  expect(notification.send).toHaveBeenCalledWith({ type: 'task_confirmed', workspaceId: actor.workspace.id,
    recipientIds: [OTHER_ID], referenceType: 'task', referenceId: TASK_ID,
    variables: { actor: actor.member.displayName, task_title: taskRow().title } });
  expect(audit.log).toHaveBeenCalledWith({ ...actorCtx, action: AUDIT_ACTIONS.TASK_CONFIRMED,
    targetType: 'task', targetId: TASK_ID, metadata: { title: taskRow().title }, required: true });
});

it('supports an unassigned completed task without inventing a notification recipient', async () => {
  scriptConfirmation({ changes: { task: { assigned_to: null } }, response: { data: confirmedTask({ assigned_to: null }), error: null } });
  await expect(tasks.adminConfirmTask(parameters({ reviewedConfirmation: {
    userId: actor.userId, isAdmin: true, expected: confirmationContext({ assigned_to: null }),
  } }))).resolves.toMatchObject({ assigned_to: null, completed_by: actor.member.id });
  expect(notification.send).not.toHaveBeenCalled();
  expect(audit.log).toHaveBeenCalledTimes(1);
});

it('reports only an explicit error-free zero-row update as a conflict', async () => {
  scriptConfirmation({ response: { data: null, error: null } });
  await expect(tasks.adminConfirmTask(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(db.builder.update).toHaveBeenCalledTimes(1);
  expectNoEffects();
});

it.each([
  { data: null, error: { code: '23505', message: 'CONFLICT' } }, { data: confirmedTask(), error: { message: 'failed' } },
  { data: undefined, error: null }, { data: [], error: null }, { data: confirmedTask() },
])('keeps malformed or error-bearing mutation responses uncertain %j', async (response) => {
  scriptConfirmation({ response });
  await expect(tasks.adminConfirmTask(parameters())).rejects.toMatchObject(unavailable);
  expect(db.builder.update).toHaveBeenCalledTimes(1);
  expectNoEffects();
});

it('normalizes a thrown mutation conflict to uncertainty', async () => {
  db.mockResponses(...contextResponses());
  db.builder.update.mockImplementationOnce(() => { throw new ConflictError('transport failed'); });
  await expect(tasks.adminConfirmTask(parameters())).rejects.toMatchObject(unavailable);
  expectNoEffects();
});

it.each([
  { id: OTHER_ID }, { admin_confirmed_by: OTHER_ID }, { admin_confirmed_at: '2026-11-15T12:05:00.000Z' },
  { updated_at: 'invalid' }, { proofs: [] }, { admin_note: 'Overwritten' }, { completion_note: 'Changed' },
])('does not acknowledge or notify about a mismatched returned task %j', async (change) => {
  scriptConfirmation({ response: { data: confirmedTask(change), error: null } });
  await expect(tasks.adminConfirmTask(parameters())).rejects.toMatchObject(unavailable);
  expect(db.builder.update).toHaveBeenCalledTimes(1);
  expectNoEffects();
});

it.each(['notification', 'audit'])('keeps post-update %s conflicts uncertain', async (stage) => {
  scriptConfirmation();
  (stage === 'notification' ? notification.send : audit.log).mockRejectedValueOnce(new ConflictError('post-write failure'));
  await expect(tasks.adminConfirmTask(parameters())).rejects.toMatchObject(unavailable);
  expect(db.builder.update).toHaveBeenCalledTimes(1);
  if (stage === 'notification') expect(audit.log).not.toHaveBeenCalled();
});

it('preserves the ordinary HTTP confirmation path and its explicit note update', async () => {
  db.mockResponses({ data: taskRow(), error: null }, { data: confirmedTask({ admin_note: 'Approved' }), error: null });
  await expect(tasks.adminConfirmTask(parameters({ reviewedConfirmation: undefined, note: 'Approved' })))
    .resolves.toMatchObject({ admin_note: 'Approved' });
  expect(db.client.from.mock.calls).toEqual([['container_tasks'], ['container_tasks']]);
  expect(db.builder.update).toHaveBeenCalledWith(expect.objectContaining({ admin_note: 'Approved' }));
  expect(db.builder.single).toHaveBeenCalledTimes(1);
  expect(audit.log.mock.calls[0][0]).not.toHaveProperty('required');
});
