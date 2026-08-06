// tests/unit/services/task.service.test.js
jest.mock('../../../src/config/supabase', () => {
  const { mockSupabase: createMock } = require('../../mocks/supabase.mock');
  const instance = createMock();
  return {
    supabaseAdmin: instance.client,
    supabase: instance.client,
    supabaseAuth: instance.client,
    __mockInstance: instance,
  };
});
jest.mock('../../../src/config/redis', () => require('../../mocks/redis.mock'));
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../src/services/notification.service');
jest.mock('../../../src/services/audit.service');
jest.mock('../../../src/services/storage.service');
jest.mock('../../../src/services/export.service');

const taskService = require('../../../src/services/task.service');
const notification = require('../../../src/services/notification.service');
const audit = require('../../../src/services/audit.service');
const exportService = require('../../../src/services/export.service');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';
const CONTAINER_ID = 'container-1';
const TASK_ID = 'task-1';
const ACTOR_CTX = { workspaceId: WORKSPACE_ID, actorUserId: 'user-1', actorMemberId: 'admin-1' };

describe('services/task.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    notification.send.mockResolvedValue();
    audit.log.mockResolvedValue();
  });

  describe('updateTask — two-layer authorization (schema allows more than service does)', () => {
    it('non-admin, non-assignee -> ForbiddenError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, assigned_to: 'someone-else', status: 'pending', title: 'X' }, error: null });

      await expect(
        taskService.updateTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, data: { status: 'completed' }, isAdmin: false, callerId: 'caller-1', actorDisplayName: 'Bob', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('non-admin attempting a disallowed field -> ForbiddenError naming the field', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, assigned_to: 'caller-1', status: 'pending', title: 'X' }, error: null });

      await expect(
        taskService.updateTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, data: { title: 'Hacked' }, isAdmin: false, callerId: 'caller-1', actorDisplayName: 'Bob', actorCtx: ACTOR_CTX })
      ).rejects.toThrow("Field 'title' can only be edited by admins");
    });

    it("REGRESSION: non-admin status:'cancelled' (schema-valid, service-rejected) -> ForbiddenError", async () => {
      // updateTaskSchema (Zod) accepts 'cancelled' as a valid enum value
      // for ANY caller, but task.service.js#updateTask further restricts
      // non-admins to only 'in_progress'/'completed' — this is the
      // explicit two-layer validation Doc 2 flags for cross-referencing.
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, assigned_to: 'caller-1', status: 'pending', title: 'X' }, error: null });

      await expect(
        taskService.updateTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, data: { status: 'cancelled' }, isAdmin: false, callerId: 'caller-1', actorDisplayName: 'Bob', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("non-admin CAN set status to 'in_progress' or 'completed'", async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, assigned_to: 'caller-1', status: 'pending', title: 'X' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, status: 'in_progress' }, error: null }); // update

      await expect(
        taskService.updateTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, data: { status: 'in_progress' }, isAdmin: false, callerId: 'caller-1', actorDisplayName: 'Bob', actorCtx: ACTOR_CTX })
      ).resolves.toEqual({ id: TASK_ID, status: 'in_progress' });
    });

    it('status: completed -> sets completed_at/completed_by, notifies admins, writes audit log', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, assigned_to: 'caller-1', status: 'in_progress', title: 'X' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, status: 'completed' }, error: null }); // update
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-1' }], error: null }); // admins lookup

      await taskService.updateTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, data: { status: 'completed' }, isAdmin: false, callerId: 'caller-1', actorDisplayName: 'Bob', actorCtx: ACTOR_CTX });

      const updateCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'update');
      expect(updateCall.args[0]).toHaveProperty('completed_at');
      expect(updateCall.args[0].completed_by).toBe('caller-1');
      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_completed' }));
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.completed' }));
    });

    it('admin reassigning to a new assignee -> notifies the new assignee', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, assigned_to: 'old-assignee', status: 'pending', title: 'X' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, assigned_to: 'new-assignee' }, error: null });

      await taskService.updateTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, data: { assigned_to: 'new-assignee' }, isAdmin: true, callerId: 'admin-1', actorDisplayName: 'Admin', actorCtx: ACTOR_CTX });

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_assigned', recipientIds: ['new-assignee'] }));
    });

    it('task not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        taskService.updateTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: 'missing', data: {}, isAdmin: true, callerId: 'admin-1', actorDisplayName: 'Admin', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('reassignTask — reassign-lock', () => {
    it('assigned_to must be a participant', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // participant check fails

      await expect(
        taskService.reassignTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, assignedTo: 'not-a-participant', actorDisplayName: 'Admin' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('cannot reassign a task already in_progress', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'p1' }, error: null }); // participant check
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, status: 'in_progress', title: 'X' }, error: null });

      await expect(
        taskService.reassignTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, assignedTo: 'm2', actorDisplayName: 'Admin' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('cannot reassign a task already completed', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'p1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, status: 'completed', title: 'X' }, error: null });

      await expect(
        taskService.reassignTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, assignedTo: 'm2', actorDisplayName: 'Admin' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('succeeds when task is pending, notifies new assignee', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'p1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, status: 'pending', title: 'X' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, assigned_to: 'm2' }, error: null });

      await taskService.reassignTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, assignedTo: 'm2', actorDisplayName: 'Admin' });

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ recipientIds: ['m2'] }));
    });
  });

  describe('overrideTaskStatus — admin-only hard override, bypasses reassign-lock', () => {
    it('sets completed_at/completed_by when overriding to completed', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, status: 'completed' }, error: null });

      await taskService.overrideTaskStatus({ containerId: CONTAINER_ID, taskId: TASK_ID, status: 'completed', note: 'done', actorMemberId: 'admin-1' });

      const updateCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'update');
      expect(updateCall.args[0]).toHaveProperty('completed_at');
      expect(updateCall.args[0].completion_note).toBe('done');
    });

    it('task not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        taskService.overrideTaskStatus({ containerId: CONTAINER_ID, taskId: 'missing', status: 'cancelled', actorMemberId: 'admin-1' })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('adminConfirmTask', () => {
    it('only completed tasks can be confirmed', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, status: 'pending', admin_confirmed_at: null }, error: null });

      await expect(
        taskService.adminConfirmTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, note: 'x', actorMemberId: 'admin-1', actorDisplayName: 'Admin', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('cannot confirm a task twice', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, status: 'completed', admin_confirmed_at: '2026-01-01' }, error: null });

      await expect(
        taskService.adminConfirmTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, note: 'x', actorMemberId: 'admin-1', actorDisplayName: 'Admin', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('success: notifies the assignee and audits', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, status: 'completed', admin_confirmed_at: null, assigned_to: 'm1', title: 'X' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, admin_confirmed_at: '2026-01-01' }, error: null });

      await taskService.adminConfirmTask({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, taskId: TASK_ID, note: 'nice work', actorMemberId: 'admin-1', actorDisplayName: 'Admin', actorCtx: ACTOR_CTX });

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_confirmed', recipientIds: ['m1'] }));
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.confirmed' }));
    });
  });

  describe('bulkCreateTasks — partial failure isolation', () => {
    it('3 valid + 1 invalid assigned_to -> 3 created, 1 in failed array', async () => {
      // Task 0: valid, no assignee
      mockSupabaseInstance.mockNextResponse({ data: { id: 't0' }, error: null });
      // Task 1: valid, no assignee
      mockSupabaseInstance.mockNextResponse({ data: { id: 't1' }, error: null });
      // Task 2: has assigned_to, participant check fails
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      // Task 3: valid, no assignee
      mockSupabaseInstance.mockNextResponse({ data: { id: 't3' }, error: null });

      const result = await taskService.bulkCreateTasks({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        tasks: [
          { title: 'A' },
          { title: 'B' },
          { title: 'C', assigned_to: 'invalid-member' },
          { title: 'D' },
        ],
        actorMemberId: 'admin-1', actorDisplayName: 'Admin',
      });

      expect(result.created).toHaveLength(3);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].index).toBe(2);
    });

    it('assigns sort_order matching array index', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 't0' }, error: null });

      await taskService.bulkCreateTasks({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, tasks: [{ title: 'A' }], actorMemberId: 'admin-1', actorDisplayName: 'Admin' });

      const insertCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'insert');
      expect(insertCall.args[0].sort_order).toBe(0);
    });
  });

  describe('exportTasks — shares exportTasksCSV with the admin path', () => {
    it('admin gets all tasks (assignedTo: null)', async () => {
      exportService.exportTasksCSV.mockResolvedValueOnce('csv-data');

      const result = await taskService.exportTasks({ containerId: CONTAINER_ID, isAdmin: true, callerId: 'admin-1' });

      expect(exportService.exportTasksCSV).toHaveBeenCalledWith({ containerId: CONTAINER_ID, assignedTo: null });
      expect(result.filename).toMatch(/^tasks-export-/);
    });

    it('non-admin gets only their own tasks', async () => {
      exportService.exportTasksCSV.mockResolvedValueOnce('csv-data');

      const result = await taskService.exportTasks({ containerId: CONTAINER_ID, isAdmin: false, callerId: 'caller-1' });

      expect(exportService.exportTasksCSV).toHaveBeenCalledWith({ containerId: CONTAINER_ID, assignedTo: 'caller-1' });
      expect(result.filename).toMatch(/^my-tasks-/);
    });
  });

  describe('deleteTaskProof', () => {
    it('rejects a negative proofIndex', async () => {
      await expect(
        taskService.deleteTaskProof({ containerId: CONTAINER_ID, taskId: TASK_ID, proofIndex: -1, isAdmin: true, callerId: 'admin-1' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('out-of-range proofIndex -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: TASK_ID, assigned_to: 'admin-1', proofs: [{ url: 'x' }] }, error: null });

      await expect(
        taskService.deleteTaskProof({ containerId: CONTAINER_ID, taskId: TASK_ID, proofIndex: 5, isAdmin: true, callerId: 'admin-1' })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
