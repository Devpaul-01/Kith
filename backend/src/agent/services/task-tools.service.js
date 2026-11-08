const { ForbiddenError, ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { listTasksArgsSchema, getTaskArgsSchema, MAX_TASK_PAGE } = require('../validators/task-tools.validator');

function taskResult(task) {
  // Keep proof files, storage paths, and internal/admin fields out of chat.
  return {
    id: task.id,
    container_id: task.container_id,
    title: task.title,
    description: task.description,
    assigned_to: task.assigned_to,
    assigned_to_name: task.assigned_to_name,
    due_date: task.due_date,
    status: task.status,
    completed_at: task.completed_at,
    completion_note: task.completion_note,
    admin_confirmed_at: task.admin_confirmed_at,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

async function listTasks({ context, args }) {
  assertAgentContext(context);
  const parsed = listTasksArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid task arguments', null, parsed.error.issues);
  const workspaceId = context.workspace.id;
  const callerId = context.member.id;
  const isAdmin = context.member.role === 'admin';
  if (!isAdmin && parsed.data.assigned_to && parsed.data.assigned_to !== callerId) {
    throw new ForbiddenError('You can only view tasks assigned to you');
  }

  const { page, perPage, offset } = getPagination(parsed.data);
  const taskService = require('../../services/task.service');
  const { tasks, count } = await taskService.listTasks({
    workspaceId, callerId, isAdmin,
    containerId: parsed.data.container_id,
    assignedFilter: parsed.data.assigned_to,
    statusFilter: parsed.data.status,
    pagination: { page, perPage, offset },
  });
  const pagination = getPaginationMeta({ total: count, page, perPage });

  return {
    tasks: tasks.map(taskResult),
    pagination: {
      ...pagination,
      next_page: page < pagination.total_pages && page < MAX_TASK_PAGE ? page + 1 : null,
    },
  };
}

async function getTask({ context, args }) {
  assertAgentContext(context);
  const parsed = getTaskArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid task arguments', null, parsed.error.issues);
  const parameters = {
    workspaceId: context.workspace.id,
    callerId: context.member.id,
    isAdmin: context.member.role === 'admin',
    containerId: parsed.data.container_id,
    taskId: parsed.data.task_id,
  };
  const taskService = require('../../services/task.service');
  const task = await taskService.getTask(parameters);
  return { task: taskResult(task) };
}

module.exports = { listTasks, getTask };
