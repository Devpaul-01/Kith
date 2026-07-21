// src/services/task.service.js
//
// fetchTask/shapeTask preserved as internal helpers.

const { supabaseAdmin }      = require('../config/supabase');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../utils/errors');
const { generateUploadUrl, verifyUploadedFile } = require('./storage.service');
const notification           = require('./notification.service');
const { exportTasksCSV }     = require('./export.service');
const audit                  = require('./audit.service');
const { AUDIT_ACTIONS }      = require('../constants/audit-actions');
const { getSort }            = require('../utils/sorting');

async function fetchTask(containerId, taskId) {
  const { data: task } = await supabaseAdmin
    .from('container_tasks')
    .select(
      '*, assigned_to_member:workspace_members!assigned_to(display_name), created_by_member:workspace_members!created_by(display_name)'
    )
    .eq('id', taskId)
    .eq('container_id', containerId)
    .is('deleted_at', null)
    .maybeSingle();
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

async function listTasks({ containerId, isAdmin, callerId, assignedFilter, statusFilter, sortQuery }) {
  const { field: safeSort, ascending } = getSort(sortQuery, { allowed: ['sort_order', 'due_date', 'created_at', 'status'], defaultField: 'sort_order' });

  let query = supabaseAdmin
    .from('container_tasks')
    .select(
      '*, assigned_to_member:workspace_members!assigned_to(display_name), created_by_member:workspace_members!created_by(display_name)'
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

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data || []).map(shapeTask);
}

async function getTask({ containerId, taskId, isAdmin, callerId }) {
  const task = await fetchTask(containerId, taskId);
  if (!task) throw new NotFoundError('Task not found');
  if (!isAdmin && task.assigned_to !== callerId) throw new ForbiddenError('You can only view tasks assigned to you');

  return shapeTask(task);
}

async function createTask({ workspaceId, containerId, data, actorMemberId, actorDisplayName, actorCtx }) {
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

async function updateTask({ workspaceId, containerId, taskId, data, isAdmin, callerId, actorDisplayName, actorCtx }) {
  const task = await fetchTask(containerId, taskId);
  if (!task) throw new NotFoundError('Task not found');

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

  const { data: updated, error } = await supabaseAdmin
    .from('container_tasks').update(updates).eq('id', taskId).eq('container_id', containerId).select().single();
  if (error) throw new Error(error.message);

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

async function adminConfirmTask({ workspaceId, containerId, taskId, note, actorMemberId, actorDisplayName, actorCtx }) {
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

async function confirmTaskProof({ containerId, taskId, isAdmin, callerId, filePayload }) {
  const task = await fetchTask(containerId, taskId);
  if (!task) throw new NotFoundError('Task not found');
  if (!isAdmin && task.assigned_to !== callerId) throw new ForbiddenError('Access denied');

  // Verify the uploaded file's actual bytes match its declared content
  // type before trusting it as proof.
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
  updateTask,
  reassignTask,
  overrideTaskStatus,
  adminConfirmTask,
  bulkCreateTasks,
  exportTasks,
  getTaskProofUploadUrl,
  confirmTaskProof,
  deleteTaskProof,
  deleteTask,
};
