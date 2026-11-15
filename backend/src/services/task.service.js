// src/services/task.service.js
//
// fetchTask/shapeTask preserved as internal helpers.

const { supabaseAdmin }      = require('../config/supabase');
const { AppError, NotFoundError, BusinessRuleError, ForbiddenError, ConflictError, ValidationError } = require('../utils/errors');
const {
  taskConfirmationStateSchema, taskConfirmationSnapshotSchema, taskConfirmationContextSchema,
  taskConfirmationCallerSchema, reviewedTaskConfirmationSchema, taskConfirmationState,
} = require('../validators/task-confirmation.validator');
const {
  taskCreationDataSchema, taskCreationAssigneeSchema, taskCreationContextSchema,
  taskCreationResultSchema, taskCreationCallerSchema, reviewedTaskCreationSchema,
  buildTaskCreationState, taskCreationState,
} = require('../validators/task-creation.validator');
const { generateUploadUrl, verifyUploadedFile, assertUploadPath } = require('./storage.service');
const notification           = require('./notification.service');
const { exportTasksCSV }     = require('./export.service');
const audit                  = require('./audit.service');
const { AUDIT_ACTIONS }      = require('../constants/audit-actions');
const { getSort }            = require('../utils/sorting');
const logger                 = require('../utils/logger');

async function assertWorkspaceContainer({ workspaceId, containerId }) {
  // Tasks have no workspace_id. Verify their parent before reading them.
  const { data: container, error } = await supabaseAdmin
    .from('containers')
    .select('id')
    .eq('id', containerId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new AppError('Tasks are unavailable. Please try again.', 503, 'TASKS_UNAVAILABLE');
  if (!container) throw new NotFoundError('Container not found');
}

async function fetchTask(containerId, taskId) {
  const { data: task, error } = await supabaseAdmin
    .from('container_tasks')
    .select(
      '*, assigned_to_member:workspace_members!assigned_to(display_name), created_by_member:workspace_members!created_by(display_name)'
    )
    .eq('id', taskId)
    .eq('container_id', containerId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new AppError('Tasks are unavailable. Please try again.', 503, 'TASKS_UNAVAILABLE');
  return task || null;
}

function shapeTask(t) {
  return {
    ...t,
    assigned_to_name:   t.assigned_to_member?.display_name ?? null,
    created_by_name:    t.created_by_member?.display_name  ?? null,
    assigned_to_member: undefined,
    created_by_member:  undefined,
  };
}

async function listTasks({ workspaceId, containerId, isAdmin, callerId, assignedFilter, statusFilter, sortQuery = {}, pagination }) {
  await assertWorkspaceContainer({ workspaceId, containerId });
  const { field: safeSort, ascending } = getSort(sortQuery, { allowed: ['sort_order', 'due_date', 'created_at', 'status'], defaultField: 'sort_order' });

  let query = supabaseAdmin
    .from('container_tasks')
    .select(
      '*, assigned_to_member:workspace_members!assigned_to(display_name), created_by_member:workspace_members!created_by(display_name)',
      pagination ? { count: 'exact' } : undefined
    )
    .eq('container_id', containerId)
    .is('deleted_at', null)
    .order(safeSort, { ascending });

  if (!isAdmin) {
    query = query.eq('assigned_to', callerId);
  } else {
    if (assignedFilter) query = query.eq('assigned_to', assignedFilter);
  }

  if (statusFilter) query = query.eq('status', statusFilter);

  if (pagination) {
    query = query.order('id', { ascending: true })
      .range(pagination.offset, pagination.offset + pagination.perPage - 1);
  }

  const { data, error, count } = await query;
  if (error || !Array.isArray(data)
      || (pagination && (!Number.isSafeInteger(count) || count < 0))) {
    throw new AppError('Tasks are unavailable. Please try again.', 503, 'TASKS_UNAVAILABLE');
  }

  const tasks = data.map(shapeTask);
  // Existing HTTP callers retain their unpaginated task-array response.
  return pagination ? { tasks, count } : tasks;
}

async function getTask({ workspaceId, containerId, taskId, isAdmin, callerId }) {
  await assertWorkspaceContainer({ workspaceId, containerId });
  const task = await fetchTask(containerId, taskId);
  if (!task) throw new NotFoundError('Task not found');
  if (!isAdmin && task.assigned_to !== callerId) throw new ForbiddenError('You can only view tasks assigned to you');

  return shapeTask(task);
}

const taskCreationUnavailable = () => new AppError('Task creation is unavailable. Please try again.', 503, 'TASK_CREATION_UNAVAILABLE');

async function taskCreationOperation(operation) {
  try {
    const response = await operation();
    if (!response || response.error !== null || !Object.hasOwn(response, 'data')
        || (response.data !== null && (typeof response.data !== 'object' || Array.isArray(response.data)))) {
      throw taskCreationUnavailable();
    }
    return response.data;
  } catch { throw taskCreationUnavailable(); }
}

/** Fresh eligibility for the explicitly selected task container and optional assignee. */
async function getTaskCreationContext({ workspaceId, containerId, assigneeId = null, callerId, userId, isAdmin }) {
  if (!taskCreationCallerSchema.safeParse({ workspaceId, containerId, assigneeId, callerId, userId, isAdmin }).success) {
    throw new ValidationError('Invalid task creation context');
  }
  if (!isAdmin) throw new ForbiddenError('Only workspace admins can create tasks');
  const workspace = await taskCreationOperation(() => supabaseAdmin.from('workspaces')
    .select('id, name, updated_at, deleted_at').eq('id', workspaceId).is('deleted_at', null).maybeSingle());
  if (workspace === null) throw new NotFoundError('Workspace not found');
  if (workspace.id !== workspaceId || workspace.deleted_at !== null) throw taskCreationUnavailable();
  const actor = await taskCreationOperation(() => supabaseAdmin.from('workspace_members')
    .select('id, workspace_id, user_id, role, is_active, is_proxy, deleted_at')
    .eq('id', callerId).eq('workspace_id', workspaceId).eq('user_id', userId)
    .eq('role', 'admin').eq('is_active', true).eq('is_proxy', false).is('deleted_at', null).maybeSingle());
  if (!actor || actor.id !== callerId || actor.workspace_id !== workspaceId || actor.user_id !== userId
      || actor.role !== 'admin' || actor.is_active !== true || actor.is_proxy !== false || actor.deleted_at !== null) {
    throw new ForbiddenError('Active workspace admin membership required');
  }
  const container = await taskCreationOperation(() => supabaseAdmin.from('containers')
    .select('id, workspace_id, name, container_type, status, enable_tasks, updated_at, deleted_at')
    .eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle());
  if (container === null) throw new NotFoundError('Container not found');
  if (container.id !== containerId || container.workspace_id !== workspaceId || container.deleted_at !== null) {
    throw taskCreationUnavailable();
  }
  if (container.status !== 'active' || container.enable_tasks !== true || !['event', 'recurring'].includes(container.container_type)) {
    throw new BusinessRuleError('Task creation requires an active event or recurring container with task tracking enabled');
  }
  let assignee = null;
  if (assigneeId !== null) {
    const member = await taskCreationOperation(() => supabaseAdmin.from('workspace_members')
      .select('id, workspace_id, display_name, role, is_active, is_proxy, updated_at, deleted_at')
      .eq('id', assigneeId).eq('workspace_id', workspaceId).eq('is_active', true)
      .eq('is_proxy', false).is('deleted_at', null).maybeSingle());
    if (member === null) throw new NotFoundError('Assigned member not found');
    if (member.id !== assigneeId || member.workspace_id !== workspaceId || member.deleted_at !== null) throw taskCreationUnavailable();
    if (member.is_active !== true || member.is_proxy !== false || !['member', 'admin'].includes(member.role)) {
      throw new BusinessRuleError('Task assignment requires an active non-proxy workspace member');
    }
    const participant = await taskCreationOperation(() => supabaseAdmin.from('container_participants')
      .select('id, container_id, workspace_member_id, tasks_enabled, added_at')
      .eq('container_id', containerId).eq('workspace_member_id', assigneeId).maybeSingle());
    if (participant === null) throw new BusinessRuleError('The assigned member must participate in the selected container');
    if (participant.container_id !== containerId || participant.workspace_member_id !== assigneeId) throw taskCreationUnavailable();
    if (participant.tasks_enabled !== true) throw new BusinessRuleError('Task tracking must be enabled for the assigned participant');
    const selected = taskCreationAssigneeSchema.safeParse({
      member_id: member.id, display_name: member.display_name, member_role: member.role,
      is_active: member.is_active, is_proxy: member.is_proxy, member_updated_at: member.updated_at,
      participant_id: participant.id, participant_added_at: participant.added_at, tasks_enabled: participant.tasks_enabled,
    });
    if (!selected.success) throw taskCreationUnavailable();
    assignee = selected.data;
  }
  const context = taskCreationContextSchema.safeParse({
    workspace_id: workspaceId, workspace_name: workspace.name, workspace_updated_at: workspace.updated_at,
    actor_member_id: callerId, member_role: actor.role,
    container_id: containerId, container_name: container.name, container_type: container.container_type,
    container_status: container.status, enable_tasks: container.enable_tasks, container_updated_at: container.updated_at,
    assignee, task: null,
  });
  if (!context.success) throw taskCreationUnavailable();
  return context.data;
}

async function createReviewedTask({ workspaceId, containerId, data, actorMemberId, actorDisplayName, actorCtx, reviewedCreation }) {
  const reviewed = reviewedTaskCreationSchema.safeParse(reviewedCreation);
  const requested = taskCreationDataSchema.safeParse(data);
  if (!reviewed.success || !requested.success) throw new ValidationError('Valid reviewed task details are required');
  if (!reviewed.data.isAdmin) throw new ForbiddenError('Only workspace admins can create tasks');
  const expected = reviewed.data.expected;
  if (expected.workspace_id !== workspaceId || expected.container_id !== containerId
      || expected.actor_member_id !== actorMemberId || (expected.assignee?.member_id ?? null) !== requested.data.assigned_to) {
    throw new ForbiddenError('Task creation must use the reviewed workspace, container, assignee and admin');
  }
  let current;
  try {
    current = await getTaskCreationContext({ workspaceId, containerId, assigneeId: requested.data.assigned_to,
      callerId: actorMemberId, userId: reviewed.data.userId, isAdmin: reviewed.data.isAdmin });
  } catch (err) {
    if (['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION'].includes(err.code)) {
      throw new ConflictError('The reviewed task creation is no longer available');
    }
    throw err;
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new ConflictError('Task creation eligibility changed since review');
  const planned = buildTaskCreationState({ data: requested.data, containerId,
    taskId: reviewed.data.taskId, actorMemberId });
  const { task_id: id, ...values } = planned;
  const createdAt = new Date().toISOString();
  const row = await taskCreationOperation(() => supabaseAdmin.from('container_tasks')
    .insert({ id, ...values, created_at: createdAt, updated_at: createdAt }).select().single());
  // INSERT uncertainty, including a primary-key conflict, must retain the execution claim.
  const result = taskCreationResultSchema.safeParse(taskCreationState(row));
  if (!result.success || Date.parse(result.data.created_at) !== Date.parse(createdAt)
      || Object.keys(planned).some((field) => JSON.stringify(result.data[field]) !== JSON.stringify(planned[field]))) {
    throw taskCreationUnavailable();
  }
  try {
    await audit.log({ ...actorCtx, workspaceId, actorUserId: reviewed.data.userId, actorMemberId,
      action: AUDIT_ACTIONS.TASK_CREATED, targetType: 'task', targetId: id,
      metadata: { title: planned.title, agent_initiated: true, proposal_id: id }, required: true });
  } catch { throw taskCreationUnavailable(); }
  if (planned.assigned_to !== null) {
    try {
      await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [planned.assigned_to],
        referenceType: 'task', referenceId: id, variables: { actor: actorDisplayName, task_title: planned.title },
        dedupKey: `task_assigned:${id}` });
    } catch (err) {
      logger.warn('Task creation assignment notification unavailable', { workspaceId, taskId: id, errorCode: err?.code });
    }
  }
  return row;
}

async function createTask({ workspaceId, containerId, data, actorMemberId, actorDisplayName, actorCtx, reviewedCreation }) {
  if (reviewedCreation !== undefined) {
    return createReviewedTask({ workspaceId, containerId, data, actorMemberId, actorDisplayName, actorCtx, reviewedCreation });
  }
  // Ordinary HTTP callers retain the existing creation and assignment behavior.
  if (data.assigned_to) {
    const { data: check } = await supabaseAdmin
      .from('container_participants').select('id')
      .eq('container_id', containerId).eq('workspace_member_id', data.assigned_to).maybeSingle();
    if (!check) throw new BusinessRuleError('assigned_to must be a participant in this container');
  }

  const { data: task, error } = await supabaseAdmin
    .from('container_tasks')
    .insert({ container_id: containerId, title: data.title, description: data.description || null, assigned_to: data.assigned_to || null, due_date: data.due_date || null, created_by: actorMemberId })
    .select().single();

  if (error) throw new Error(error.message);

  if (data.assigned_to) {
    await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [data.assigned_to], referenceType: 'task', referenceId: task.id, variables: { actor: actorDisplayName, task_title: data.title } });
  }

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.TASK_CREATED, targetType: 'task', targetId: task.id, metadata: { title: task.title } });

  return task;
}

async function updateTask({ workspaceId, containerId, taskId, data, isAdmin, callerId, actorDisplayName, actorCtx, expectedTask }) {
  // Proposal callers bind a reviewed snapshot. Keep existing HTTP callers on
  // their original path when no snapshot is supplied.
  if (expectedTask !== undefined) {
    try { await assertWorkspaceContainer({ workspaceId, containerId }); } catch (err) {
      if (err.code === 'NOT_FOUND') throw new ConflictError('The reviewed task is no longer available');
      throw err;
    }
  }
  const task = await fetchTask(containerId, taskId);
  if (!task) {
    if (expectedTask !== undefined) throw new ConflictError('The reviewed task is no longer available');
    throw new NotFoundError('Task not found');
  }

  const snapshotFields = ['title', 'assigned_to', 'status', 'completion_note', 'completed_at', 'completed_by', 'admin_confirmed_at', 'updated_at'];
  if (expectedTask !== undefined && (!expectedTask
      || expectedTask.id !== taskId || expectedTask.container_id !== containerId
      || expectedTask.assigned_to !== callerId || expectedTask.admin_confirmed_at !== null
      || !['pending', 'in_progress', 'overdue'].includes(expectedTask.status)
      || snapshotFields.some((field) => !Object.hasOwn(expectedTask, field) || !Object.is(task[field], expectedTask[field])))) {
    throw new ConflictError('The task changed since it was reviewed');
  }

  const isAssigned = task.assigned_to === callerId;
  if (!isAdmin && !isAssigned) throw new ForbiddenError('You can only update tasks assigned to you');

  if (!isAdmin) {
    const memberAllowed = ['status', 'completion_note'];
    for (const key of Object.keys(data)) {
      if (data[key] !== undefined && !memberAllowed.includes(key)) throw new ForbiddenError(`Field '${key}' can only be edited by admins`);
    }
    if (data.status && !['in_progress', 'completed'].includes(data.status)) throw new ForbiddenError('Members can only set status to in_progress or completed');
  }

  const allowedFields = isAdmin
    ? ['title', 'description', 'assigned_to', 'due_date', 'status', 'sort_order', 'completion_note']
    : ['status', 'completion_note'];

  const updates = {};
  for (const field of allowedFields) {
    if (data[field] !== undefined) updates[field] = data[field];
  }

  if (updates.status === 'completed') {
    updates.completed_at = new Date().toISOString();
    updates.completed_by = callerId;
  }

  if (!Object.keys(updates).length) return shapeTask(task);
  updates.updated_at = new Date().toISOString();

  let updateQuery = supabaseAdmin
    .from('container_tasks').update(updates).eq('id', taskId).eq('container_id', containerId);
  if (expectedTask !== undefined) {
    updateQuery = updateQuery.is('deleted_at', null);
    for (const field of snapshotFields) {
      updateQuery = expectedTask[field] === null
        ? updateQuery.is(field, null) : updateQuery.eq(field, expectedTask[field]);
    }
  }
  const { data: updated, error } = await (expectedTask !== undefined
    ? updateQuery.select().maybeSingle() : updateQuery.select().single());
  if (error) throw new AppError('Tasks are unavailable. Please try again.', 503, 'TASKS_UNAVAILABLE');
  if (!updated && expectedTask !== undefined) throw new ConflictError('The task changed since it was reviewed');

  if (updates.status === 'completed') {
    const { data: admins } = await supabaseAdmin.from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true);
    await notification.send({ type: 'task_completed', workspaceId, recipientIds: (admins || []).map((a) => a.id), referenceType: 'task', referenceId: taskId, variables: { actor: actorDisplayName, task_title: task.title } });
    await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.TASK_COMPLETED, targetType: 'task', targetId: taskId, metadata: { title: task.title } });
  }

  if (isAdmin && data.assigned_to && data.assigned_to !== task.assigned_to) {
    await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [data.assigned_to], referenceType: 'task', referenceId: taskId, variables: { actor: actorDisplayName, task_title: task.title } });
  }

  return updated;
}

async function reassignTask({ workspaceId, containerId, taskId, assignedTo, actorDisplayName }) {
  if (assignedTo) {
    const { data: check } = await supabaseAdmin
      .from('container_participants').select('id').eq('container_id', containerId).eq('workspace_member_id', assignedTo).maybeSingle();
    if (!check) throw new BusinessRuleError('assigned_to must be a participant in this container');
  }

  const prev = await fetchTask(containerId, taskId);
  if (!prev) throw new NotFoundError('Task not found');
  if (['in_progress', 'completed'].includes(prev.status)) {
    throw new BusinessRuleError(`Cannot reassign a task that is already '${prev.status}'. Override the status first if needed.`);
  }

  const { data: task, error } = await supabaseAdmin
    .from('container_tasks').update({ assigned_to: assignedTo, updated_at: new Date().toISOString() }).eq('id', taskId).select().single();
  if (error) throw new Error(error.message);

  if (assignedTo) {
    await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [assignedTo], referenceType: 'task', referenceId: taskId, variables: { actor: actorDisplayName, task_title: prev.title } });
  }

  return task;
}

// overrideTaskStatus is an admin-only hard override; enforced via
// requireAdmin at the route level.
async function overrideTaskStatus({ containerId, taskId, status, note, actorMemberId }) {
  const updates = { status, updated_at: new Date().toISOString() };
  if (status === 'completed') { updates.completed_at = new Date().toISOString(); updates.completed_by = actorMemberId; }
  if (note) updates.completion_note = note;

  const { data: task, error } = await supabaseAdmin
    .from('container_tasks').update(updates).eq('id', taskId).eq('container_id', containerId).is('deleted_at', null).select().maybeSingle();

  if (error) throw new Error(error.message);
  if (!task) throw new NotFoundError('Task not found');

  return task;
}

const confirmationUnavailable = () => new AppError('Task confirmation is unavailable. Please try again.', 503, 'TASK_CONFIRMATION_UNAVAILABLE');

async function confirmationOperation(operation) {
  try {
    const response = await operation();
    if (!response || response.error !== null || !Object.hasOwn(response, 'data')
        || (response.data !== null && (typeof response.data !== 'object' || Array.isArray(response.data)))) {
      throw confirmationUnavailable();
    }
    return response.data;
  } catch { throw confirmationUnavailable(); }
}

/** Tasks have no workspace_id: check the real admin and scoped parent first. */
async function getTaskConfirmationContext({ workspaceId, containerId, taskId, callerId, userId, isAdmin }) {
  if (!taskConfirmationCallerSchema.safeParse({ workspaceId, containerId, taskId, callerId, userId, isAdmin }).success) {
    throw new ValidationError('Invalid task confirmation context');
  }
  if (!isAdmin) throw new ForbiddenError('Only workspace admins can confirm tasks');

  const workspace = await confirmationOperation(() => supabaseAdmin.from('workspaces')
    .select('id, deleted_at').eq('id', workspaceId).is('deleted_at', null).maybeSingle());
  if (workspace === null) throw new NotFoundError('Workspace not found');
  if (workspace.id !== workspaceId || workspace.deleted_at !== null) throw confirmationUnavailable();

  const actor = await confirmationOperation(() => supabaseAdmin.from('workspace_members')
    .select('id, workspace_id, user_id, role, is_active, is_proxy, deleted_at')
    .eq('id', callerId).eq('workspace_id', workspaceId).eq('user_id', userId)
    .eq('role', 'admin').eq('is_active', true).eq('is_proxy', false).is('deleted_at', null).maybeSingle());
  if (!actor || actor.id !== callerId || actor.workspace_id !== workspaceId || actor.user_id !== userId
      || actor.role !== 'admin' || actor.is_active !== true || actor.is_proxy !== false || actor.deleted_at !== null) {
    throw new ForbiddenError('Active workspace admin membership required');
  }

  const container = await confirmationOperation(() => supabaseAdmin.from('containers')
    .select('id, workspace_id, name, status, enable_tasks, updated_at, deleted_at')
    .eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle());
  if (container === null) throw new NotFoundError('Container not found');
  if (container.id !== containerId || container.workspace_id !== workspaceId || container.deleted_at !== null) {
    throw confirmationUnavailable();
  }
  if (container.status !== 'active' || container.enable_tasks !== true) {
    throw new BusinessRuleError('Task confirmation requires an active container with task tracking enabled');
  }

  const task = await confirmationOperation(() => supabaseAdmin.from('container_tasks')
    .select('*').eq('id', taskId).eq('container_id', containerId).is('deleted_at', null).maybeSingle());
  if (task === null) throw new NotFoundError('Task not found');
  if (task.id !== taskId || task.container_id !== containerId || task.deleted_at !== null) throw confirmationUnavailable();
  if (task.status !== 'completed' || task.admin_confirmed_at !== null || task.admin_confirmed_by !== null) {
    throw new BusinessRuleError('Only completed tasks without admin confirmation can be confirmed');
  }
  const snapshot = taskConfirmationContextSchema.safeParse({
    ...taskConfirmationState(task), workspace_id: workspaceId, actor_member_id: callerId, member_role: actor.role,
    container_name: container.name, container_status: container.status, enable_tasks: container.enable_tasks,
    container_updated_at: container.updated_at,
  });
  if (!snapshot.success) throw confirmationUnavailable();
  // Existing assignment writers can leave an ID from another workspace.
  // Notifications trust their recipient IDs, so validate the recipient here.
  if (snapshot.data.assigned_to !== null) {
    const assignee = await confirmationOperation(() => supabaseAdmin.from('workspace_members')
      .select('id, workspace_id').eq('id', snapshot.data.assigned_to)
      .eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle());
    if (assignee === null) throw new BusinessRuleError('The assigned member is no longer available in this workspace');
    if (assignee.id !== snapshot.data.assigned_to || assignee.workspace_id !== workspaceId) throw confirmationUnavailable();
  }
  return snapshot.data;
}

async function confirmReviewedTask({ workspaceId, containerId, taskId, note, actorMemberId, actorDisplayName, actorCtx, reviewedConfirmation }) {
  const reviewed = reviewedTaskConfirmationSchema.safeParse(reviewedConfirmation);
  if (!reviewed.success || !taskConfirmationCallerSchema.safeParse({
    workspaceId, containerId, taskId, callerId: actorMemberId,
    userId: reviewed.data?.userId, isAdmin: reviewed.data?.isAdmin,
  }).success) throw new ValidationError('Invalid reviewed task confirmation');
  if (!reviewed.data.isAdmin) throw new ForbiddenError('Only workspace admins can confirm tasks');
  const expected = reviewed.data.expected;
  if (expected.workspace_id !== workspaceId || expected.container_id !== containerId
      || expected.task_id !== taskId || expected.actor_member_id !== actorMemberId) {
    throw new ForbiddenError('Task confirmation must use the reviewed workspace, task and admin');
  }
  if (note !== undefined && note !== expected.admin_note) throw new ValidationError('Task confirmation must preserve the reviewed admin note');

  let current;
  try {
    current = await getTaskConfirmationContext({ workspaceId, containerId, taskId,
      callerId: actorMemberId, userId: reviewed.data.userId, isAdmin: reviewed.data.isAdmin });
  } catch (err) {
    if (['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION'].includes(err.code)) {
      throw new ConflictError('The reviewed task confirmation is no longer available');
    }
    throw err;
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new ConflictError('The task or confirmation eligibility changed since review');
  }

  const snapshot = taskConfirmationSnapshotSchema.parse(Object.fromEntries(
    Object.keys(taskConfirmationSnapshotSchema.shape).map((field) => [field, expected[field]]),
  ));
  const confirmedAt = new Date().toISOString();
  // Include every reviewed field in the UPDATE, especially proofs and deletion.
  // JSONB equality ignores object-key order but preserves attachment array order.
  const row = await confirmationOperation(() => {
    let query = supabaseAdmin.from('container_tasks').update({
      admin_confirmed_at: confirmedAt, admin_confirmed_by: actorMemberId, updated_at: confirmedAt,
    });
    for (const [field, value] of Object.entries(snapshot)) {
      const column = field === 'task_id' ? 'id' : field;
      query = value === null ? query.is(column, null)
        : query.eq(column, field === 'proofs' ? JSON.stringify(value) : value);
    }
    return query.select().maybeSingle();
  });
  // Only an explicit successful zero-row response proves no mutation occurred.
  if (row === null) throw new ConflictError('The task changed since it was reviewed');
  const updated = taskConfirmationStateSchema.safeParse(taskConfirmationState(row));
  const unchanged = updated.success && Object.keys(snapshot)
    .filter((field) => !['admin_confirmed_at', 'admin_confirmed_by', 'updated_at'].includes(field))
    .every((field) => JSON.stringify(updated.data[field]) === JSON.stringify(snapshot[field]));
  if (!unchanged || updated.data.admin_confirmed_by !== actorMemberId
      || Date.parse(updated.data.admin_confirmed_at) !== Date.parse(confirmedAt)) throw confirmationUnavailable();

  try {
    if (snapshot.assigned_to) {
      await notification.send({ type: 'task_confirmed', workspaceId, recipientIds: [snapshot.assigned_to],
        referenceType: 'task', referenceId: taskId,
        variables: { actor: actorDisplayName, task_title: snapshot.title } });
    }
    await audit.log({
      ...actorCtx, workspaceId, actorUserId: reviewed.data.userId, actorMemberId,
      action: AUDIT_ACTIONS.TASK_CONFIRMED, targetType: 'task', targetId: taskId,
      metadata: { title: snapshot.title }, required: true,
    });
  } catch { throw confirmationUnavailable(); }
  return row;
}

async function adminConfirmTask({ workspaceId, containerId, taskId, note, actorMemberId, actorDisplayName, actorCtx, reviewedConfirmation }) {
  if (reviewedConfirmation !== undefined) {
    return confirmReviewedTask({ workspaceId, containerId, taskId, note, actorMemberId, actorDisplayName, actorCtx, reviewedConfirmation });
  }
  // Ordinary HTTP callers retain their existing route-gated behavior.
  const task = await fetchTask(containerId, taskId);
  if (!task) throw new NotFoundError('Task not found');
  if (task.status !== 'completed') throw new BusinessRuleError('Only tasks with status "completed" can be confirmed');
  if (task.admin_confirmed_at)     throw new BusinessRuleError('Task has already been confirmed');

  const { data: updated, error } = await supabaseAdmin
    .from('container_tasks')
    .update({ admin_confirmed_at: new Date().toISOString(), admin_confirmed_by: actorMemberId, admin_note: note, updated_at: new Date().toISOString() })
    .eq('id', taskId).eq('container_id', containerId).select().single();

  if (error) throw new Error(error.message);

  if (task.assigned_to) {
    await notification.send({ type: 'task_confirmed', workspaceId, recipientIds: [task.assigned_to], referenceType: 'task', referenceId: taskId, variables: { actor: actorDisplayName, task_title: task.title } });
  }

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.TASK_CONFIRMED, targetType: 'task', targetId: taskId, metadata: { title: task.title } });

  return updated;
}

async function bulkCreateTasks({ workspaceId, containerId, tasks, actorMemberId, actorDisplayName }) {
  const created = [];
  const failed  = [];

  for (let index = 0; index < tasks.length; index++) {
    const t = tasks[index];
    try {
      if (t.assigned_to) {
        const { data: check } = await supabaseAdmin.from('container_participants').select('id').eq('container_id', containerId).eq('workspace_member_id', t.assigned_to).maybeSingle();
        if (!check) throw new Error('assigned_to is not a participant');
      }
      const { data: task, error } = await supabaseAdmin.from('container_tasks')
        .insert({ container_id: containerId, title: t.title, description: t.description || null, assigned_to: t.assigned_to || null, due_date: t.due_date || null, created_by: actorMemberId, sort_order: index })
        .select().single();
      if (error) throw new Error(error.message);
      created.push(task);
      if (t.assigned_to) {
        await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [t.assigned_to], referenceType: 'task', referenceId: task.id, variables: { actor: actorDisplayName, task_title: t.title } });
      }
    } catch (err) {
      failed.push({ index, error: err.message });
    }
  }

  return { created, failed };
}

// Member-scoped export reuses the same exportTasksCSV builder as the
// admin path (assignedTo scopes to the caller's own tasks) instead of a
// separate ad hoc implementation.
async function exportTasks({ containerId, isAdmin, callerId }) {
  const csv = await exportTasksCSV({
    containerId,
    assignedTo: isAdmin ? null : callerId,
  });

  const filename = isAdmin ? `tasks-export-${Date.now()}.csv` : `my-tasks-${Date.now()}.csv`;
  return { csv, filename };
}

async function getTaskProofUploadUrl({ workspaceId, containerId, taskId, isAdmin, callerId, filename, contentType, fileSize }) {
  const task = await fetchTask(containerId, taskId);
  if (!task) throw new NotFoundError('Task not found');
  if (!isAdmin && task.assigned_to !== callerId) throw new ForbiddenError('Access denied');

  return generateUploadUrl({ workspaceId, folder: `task-proofs/${taskId}`, filename, contentType, fileSize, fileType: 'task_proof' });
}

async function confirmTaskProof({ workspaceId, containerId, taskId, isAdmin, callerId, filePayload }) {
  const task = await fetchTask(containerId, taskId);
  if (!task) throw new NotFoundError('Task not found');
  if (!isAdmin && task.assigned_to !== callerId) throw new ForbiddenError('Access denied');

  // Verify the uploaded file's actual bytes match its declared content
  // type before trusting it as proof.
  assertUploadPath(filePayload.file_path, `workspaces/${workspaceId}/task-proofs/${taskId}/`);
  await verifyUploadedFile(filePayload.file_path, filePayload.mime_type);

  const fileObject    = { url: filePayload.file_path, name: filePayload.name, size: filePayload.size, mime_type: filePayload.mime_type, uploaded_by: callerId, uploaded_at: new Date().toISOString() };
  const currentProofs = Array.isArray(task.proofs) ? task.proofs : [];

  const { data: updated, error } = await supabaseAdmin
    .from('container_tasks').update({ proofs: [...currentProofs, fileObject], updated_at: new Date().toISOString() }).eq('id', taskId).select().single();

  if (error) throw new Error(error.message);
  return updated;
}

async function deleteTaskProof({ containerId, taskId, proofIndex, isAdmin, callerId }) {
  if (isNaN(proofIndex) || proofIndex < 0) {
    throw new BusinessRuleError('Invalid proof index');
  }

  const task = await fetchTask(containerId, taskId);
  if (!task) throw new NotFoundError('Task not found');
  if (!isAdmin && task.assigned_to !== callerId) throw new ForbiddenError('Access denied');

  const proofs = Array.isArray(task.proofs) ? task.proofs : [];
  if (proofIndex >= proofs.length) throw new NotFoundError(`No proof file at index ${proofIndex}`);

  const updatedProofs = proofs.filter((_, i) => i !== proofIndex);

  const { data: updated, error } = await supabaseAdmin
    .from('container_tasks').update({ proofs: updatedProofs, updated_at: new Date().toISOString() }).eq('id', taskId).select().single();

  if (error) throw new Error(error.message);
  return updated;
}

async function deleteTask({ containerId, taskId }) {
  const task = await fetchTask(containerId, taskId);
  if (!task) throw new NotFoundError('Task not found');

  const { error } = await supabaseAdmin
    .from('container_tasks').update({ deleted_at: new Date().toISOString() }).eq('id', taskId).eq('container_id', containerId);

  if (error) throw new Error(error.message);
}

module.exports = {
  listTasks,
  getTask,
  createTask,
  getTaskCreationContext,
  updateTask,
  reassignTask,
  overrideTaskStatus,
  getTaskConfirmationContext,
  adminConfirmTask,
  bulkCreateTasks,
  exportTasks,
  getTaskProofUploadUrl,
  confirmTaskProof,
  deleteTaskProof,
  deleteTask,
};
