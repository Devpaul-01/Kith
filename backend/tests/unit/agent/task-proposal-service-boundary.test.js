// Use the real task service to check the database boundary of an approved
// snapshot. Scripted queries supplement, rather than replace, DB integration.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/storage.service', () => ({}));
jest.mock('../../../src/services/export.service', () => ({}));

const taskService = require('../../../src/services/task.service');
const notification = require('../../../src/services/notification.service');
const audit = require('../../../src/services/audit.service');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const { context, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, TASK_ID, taskSnapshot, taskRow, updatedTask,
} = require('../../helpers/agent-task-proposal');
const db = require('../../../src/config/supabase').__mockInstance;
const NOW = '2026-11-13T12:01:00.000Z';
const actor = context();
const actorCtx = {
  workspaceId: actor.workspace.id,
  actorUserId: actor.userId,
  actorMemberId: actor.member.id,
  ipAddress: '127.0.0.1',
  userAgent: 'unit-test',
};

function parameters(overrides = {}) {
  return {
    workspaceId: actor.workspace.id,
    containerId: CONTAINER_ID,
    taskId: TASK_ID,
    data: { status: 'in_progress' },
    isAdmin: false,
    callerId: actor.member.id,
    actorDisplayName: actor.member.displayName,
    actorCtx,
    expectedTask: taskSnapshot(),
    ...overrides,
  };
}

function queries(table) {
  const calls = db.getCalls();
  const starts = calls.flatMap((call, index) => (
    call.method === 'from' && call.args[0] === table ? [index] : []
  ));
  return starts.map((start) => {
    const end = calls.findIndex((call, index) => index > start && call.method === 'from');
    return calls.slice(start, end < 0 ? undefined : end);
  });
}

function expectNoEffects() {
  expect(notification.send).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
}

function expectNoWrite() {
  expect(db.builder.update).not.toHaveBeenCalled();
  expectNoEffects();
}

describe('approved task progress service boundary', () => {
  beforeEach(() => {
    db.reset();
    notification.send.mockResolvedValue();
    audit.log.mockResolvedValue();
    jest.useFakeTimers().setSystemTime(new Date(NOW));
  });

  afterEach(() => jest.useRealTimers());

  it('stops before task access when the workspace-scoped parent is absent', async () => {
    db.mockNextResponse({ data: null, error: null });

    await expect(taskService.updateTask(parameters())).rejects.toMatchObject({
      code: 'CONFLICT', statusCode: 409,
    });
    expect(db.client.from.mock.calls).toEqual([['containers']]);
    expect(queries('containers')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['id', CONTAINER_ID] },
      { method: 'is', args: ['deleted_at', null] },
    ]));
    expectNoWrite();
  });

  it('fails safely before task access when the parent read errors with partial data', async () => {
    db.mockNextResponse({
      data: { id: CONTAINER_ID }, error: { message: 'PRIVATE_PARENT_DATABASE_ERROR' },
    });

    await expect(taskService.updateTask(parameters())).rejects.toMatchObject({
      code: 'TASKS_UNAVAILABLE', statusCode: 503,
      message: 'Tasks are unavailable. Please try again.',
    });
    expect(db.client.from.mock.calls).toEqual([['containers']]);
    expectNoWrite();
  });

  it('treats a deleted or missing reviewed task as a conflict before mutation', async () => {
    db.mockResponses(
      { data: { id: CONTAINER_ID }, error: null },
      { data: null, error: null },
    );

    await expect(taskService.updateTask(parameters())).rejects.toMatchObject({
      code: 'CONFLICT', statusCode: 409,
    });
    expect(queries('container_tasks')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', TASK_ID] },
      { method: 'eq', args: ['container_id', CONTAINER_ID] },
      { method: 'is', args: ['deleted_at', null] },
    ]));
    expectNoWrite();
  });

  it('does not mutate after a failed task read even when a row accompanies the error', async () => {
    db.mockResponses(
      { data: { id: CONTAINER_ID }, error: null },
      { data: taskRow(), error: { message: 'PRIVATE_TASK_DATABASE_ERROR' } },
    );

    await expect(taskService.updateTask(parameters())).rejects.toMatchObject({
      code: 'TASKS_UNAVAILABLE', statusCode: 503,
      message: 'Tasks are unavailable. Please try again.',
    });
    expectNoWrite();
  });

  it.each([
    ['title', 'A different task title'],
    ['assigned_to', OTHER_ID],
    ['status', 'in_progress'],
    ['completion_note', 'Someone changed the note'],
    ['completed_at', NOW],
    ['completed_by', OTHER_ID],
    ['admin_confirmed_at', NOW],
    ['updated_at', NOW],
  ])('rejects a changed %s before mutation', async (field, value) => {
    db.mockResponses(
      { data: { id: CONTAINER_ID }, error: null },
      { data: taskRow({ [field]: value }), error: null },
    );

    await expect(taskService.updateTask(parameters())).rejects.toMatchObject({
      code: 'CONFLICT', statusCode: 409,
    });
    expectNoWrite();
  });

  it.each([false, true])('cannot approve another assignee\'s task with isAdmin=%s', async (isAdmin) => {
    const reviewed = { ...taskSnapshot(), assigned_to: OTHER_ID };
    db.mockResponses(
      { data: { id: CONTAINER_ID }, error: null },
      { data: taskRow({ assigned_to: OTHER_ID }), error: null },
    );

    await expect(taskService.updateTask(parameters({ expectedTask: reviewed, isAdmin })))
      .rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expectNoWrite();
  });

  it.each([
    { status: 'completed' },
    { status: 'cancelled' },
    { admin_confirmed_at: NOW },
  ])('rejects a reviewed terminal or confirmed task: %j', async (overrides) => {
    const reviewed = { ...taskSnapshot(), ...overrides };
    db.mockResponses(
      { data: { id: CONTAINER_ID }, error: null },
      { data: taskRow(overrides), error: null },
    );

    await expect(taskService.updateTask(parameters({ expectedTask: reviewed, isAdmin: true })))
      .rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expectNoWrite();
  });

  it('binds the conditional write to the exact reviewed values and SQL NULLs', async () => {
    const updated = updatedTask({ status: 'in_progress' });
    db.mockResponses(
      { data: { id: CONTAINER_ID }, error: null },
      { data: taskRow(), error: null },
      { data: updated, error: null },
    );

    await expect(taskService.updateTask(parameters())).resolves.toEqual(updated);
    const write = queries('container_tasks')[1];
    expect(write.filter((call) => ['eq', 'is'].includes(call.method))).toEqual([
      { method: 'eq', args: ['id', TASK_ID] },
      { method: 'eq', args: ['container_id', CONTAINER_ID] },
      { method: 'is', args: ['deleted_at', null] },
      { method: 'eq', args: ['title', 'Buy groceries'] },
      { method: 'eq', args: ['assigned_to', actor.member.id] },
      { method: 'eq', args: ['status', 'pending'] },
      { method: 'is', args: ['completion_note', null] },
      { method: 'is', args: ['completed_at', null] },
      { method: 'is', args: ['completed_by', null] },
      { method: 'is', args: ['admin_confirmed_at', null] },
      { method: 'eq', args: ['updated_at', taskSnapshot().updated_at] },
    ]);
    expect(db.builder.update).toHaveBeenCalledWith({ status: 'in_progress', updated_at: NOW });
    expect(db.builder.single).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it('uses exact predicates for non-null note and completion metadata', async () => {
    const reviewed = {
      ...taskSnapshot(), status: 'in_progress', completion_note: 'Started',
      completed_at: '2026-11-12T09:00:00.000Z', completed_by: actor.member.id,
    };
    const updated = taskRow({ ...reviewed, completion_note: 'Almost done', updated_at: NOW });
    db.mockResponses(
      { data: { id: CONTAINER_ID }, error: null },
      { data: taskRow(reviewed), error: null },
      { data: updated, error: null },
    );

    await expect(taskService.updateTask(parameters({
      expectedTask: reviewed, data: { completion_note: 'Almost done' },
    }))).resolves.toEqual(updated);
    const write = queries('container_tasks')[1];
    expect(write).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['completion_note', reviewed.completion_note] },
      { method: 'eq', args: ['completed_at', reviewed.completed_at] },
      { method: 'eq', args: ['completed_by', reviewed.completed_by] },
      { method: 'eq', args: ['status', reviewed.status] },
      { method: 'is', args: ['admin_confirmed_at', null] },
    ]));
    expectNoEffects();
  });

  it('does not notify or audit when a concurrent change makes the conditional update miss', async () => {
    db.mockResponses(
      { data: { id: CONTAINER_ID }, error: null },
      { data: taskRow(), error: null },
      { data: null, error: null },
    );

    await expect(taskService.updateTask(parameters({ data: { status: 'completed' } })))
      .rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expect(db.client.from.mock.calls).toEqual([
      ['containers'], ['container_tasks'], ['container_tasks'],
    ]);
    expectNoEffects();
  });

  it.each([null, updatedTask()])('returns a safe typed failure after a DB update error with data=%j', async (data) => {
    db.mockResponses(
      { data: { id: CONTAINER_ID }, error: null },
      { data: taskRow(), error: null },
      { data, error: { message: 'PRIVATE_WRITE_DATABASE_ERROR', code: 'XX000' } },
    );

    await expect(taskService.updateTask(parameters({ data: { status: 'completed' } })))
      .rejects.toMatchObject({
        code: 'TASKS_UNAVAILABLE', statusCode: 503,
        message: 'Tasks are unavailable. Please try again.',
      });
    expectNoEffects();
  });

  it.each([false, true])('completes the caller\'s own reviewed task with isAdmin=%s and preserves domain effects', async (isAdmin) => {
    const updated = updatedTask();
    const adminIds = [OTHER_ID, actor.member.id];
    db.mockResponses(
      { data: { id: CONTAINER_ID }, error: null },
      { data: taskRow(), error: null },
      { data: updated, error: null },
      { data: adminIds.map((id) => ({ id })), error: null },
    );

    await expect(taskService.updateTask(parameters({
      data: { status: 'completed', completion_note: 'Done' }, isAdmin,
    }))).resolves.toEqual(updated);
    expect(db.builder.update).toHaveBeenCalledWith({
      status: 'completed', completion_note: 'Done',
      completed_at: NOW, completed_by: actor.member.id, updated_at: NOW,
    });
    expect(queries('workspace_members')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['role', 'admin'] },
      { method: 'eq', args: ['is_active', true] },
    ]));
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledWith({
      type: 'task_completed', workspaceId: actor.workspace.id, recipientIds: adminIds,
      referenceType: 'task', referenceId: TASK_ID,
      variables: { actor: actor.member.displayName, task_title: taskSnapshot().title },
    });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith({
      ...actorCtx, action: AUDIT_ACTIONS.TASK_COMPLETED, targetType: 'task', targetId: TASK_ID,
      metadata: { title: taskSnapshot().title },
    });
  });
});
