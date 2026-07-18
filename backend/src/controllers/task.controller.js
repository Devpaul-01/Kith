// src/controllers/task.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../utils/errors');
const {
  createTaskSchema,
  bulkCreateTasksSchema,
  updateTaskSchema,
  reassignTaskSchema,
  overrideTaskStatusSchema,
  uploadFileSchema,
  confirmProofSchema,
} = require('../validators/ledger.validator');
const { generateUploadUrl, verifyUploadedFile } = require('../services/storage.service');
const notification           = require('../services/notification.service');
const { exportTasksCSV }     = require('../services/export.service');
const audit                  = require('../services/audit.service');
const { AUDIT_ACTIONS }      = require('../constants/audit-actions');
const { getSort }            = require('../utils/sorting');

// ── Shared helper ─────────────────────────────────────────────────

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

// ── List tasks ────────────────────────────────────────────────────

async function listTasks(req, res, next) {
  try {
    const { containerId }  = req.params;
    const isAdmin          = req.member.role === 'admin';
    const assignedFilter   = req.query['filter[assigned_to]'];
    const statusFilter     = req.query['filter[status]'];

    // Audit 6.2: shared sort helper (utils/sorting.js) instead of an ad
    // hoc copy of the same whitelist logic.
    const { field: safeSort, ascending } = getSort(req.query, { allowed: ['sort_order', 'due_date', 'created_at', 'status'], defaultField: 'sort_order' });

    let query = supabaseAdmin
      .from('container_tasks')
      .select(
        '*, assigned_to_member:workspace_members!assigned_to(display_name), created_by_member:workspace_members!created_by(display_name)'
      )
      .eq('container_id', containerId)
      .is('deleted_at', null)
      .order(safeSort, { ascending });

    if (!isAdmin) {
      query = query.eq('assigned_to', req.member.id);
    } else {
      if (assignedFilter) query = query.eq('assigned_to', assignedFilter);
    }

    if (statusFilter) query = query.eq('status', statusFilter);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    success(res, { tasks: (data || []).map(shapeTask) });
  } catch (err) { next(err); }
}

// ── Get single task ───────────────────────────────────────────────

async function getTask(req, res, next) {
  try {
    const { containerId, taskId } = req.params;
    const isAdmin  = req.member.role === 'admin';
    const callerId = req.member.id;

    const task = await fetchTask(containerId, taskId);
    if (!task) throw new NotFoundError('Task not found');
    if (!isAdmin && task.assigned_to !== callerId) throw new ForbiddenError('You can only view tasks assigned to you');

    success(res, { task: shapeTask(task) });
  } catch (err) { next(err); }
}

// ── Create task ───────────────────────────────────────────────────

async function createTask(req, res, next) {
  try {
    const data                         = createTaskSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

    if (data.assigned_to) {
      const { data: check } = await supabaseAdmin
        .from('container_participants').select('id')
        .eq('container_id', containerId).eq('workspace_member_id', data.assigned_to).maybeSingle();
      if (!check) throw new BusinessRuleError('assigned_to must be a participant in this container');
    }

    const { data: task, error } = await supabaseAdmin
      .from('container_tasks')
      .insert({ container_id: containerId, title: data.title, description: data.description || null, assigned_to: data.assigned_to || null, due_date: data.due_date || null, created_by: req.member.id })
      .select().single();

    if (error) throw new Error(error.message);

    if (data.assigned_to) {
      await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [data.assigned_to], referenceType: 'task', referenceId: task.id, variables: { actor: req.member.displayName, task_title: data.title } });
    }

    // Audit finding 5.1: task.controller.js previously never called
    // audit.log anywhere, despite TASK_CREATED/TASK_COMPLETED/TASK_CONFIRMED
    // all being defined in constants/audit-actions.js.
    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.TASK_CREATED, targetType: 'task', targetId: task.id, metadata: { title: task.title } });

    success(res, { task }, 201);
  } catch (err) { next(err); }
}

// ── Update task ───────────────────────────────────────────────────

async function updateTask(req, res, next) {
  try {
    const data                                = updateTaskSchema.parse(req.body);
    const { workspaceId, containerId, taskId } = req.params;
    const isAdmin  = req.member.role === 'admin';
    const callerId = req.member.id;

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

    if (!Object.keys(updates).length) return success(res, { task: shapeTask(task) });
    updates.updated_at = new Date().toISOString();

    const { data: updated, error } = await supabaseAdmin
      .from('container_tasks').update(updates).eq('id', taskId).eq('container_id', containerId).select().single();
    if (error) throw new Error(error.message);

    if (updates.status === 'completed') {
      const { data: admins } = await supabaseAdmin.from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true);
      await notification.send({ type: 'task_completed', workspaceId, recipientIds: (admins || []).map((a) => a.id), referenceType: 'task', referenceId: taskId, variables: { actor: req.member.displayName, task_title: task.title } });
      await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.TASK_COMPLETED, targetType: 'task', targetId: taskId, metadata: { title: task.title } });
    }

    if (isAdmin && data.assigned_to && data.assigned_to !== task.assigned_to) {
      await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [data.assigned_to], referenceType: 'task', referenceId: taskId, variables: { actor: req.member.displayName, task_title: task.title } });
    }

    success(res, { task: updated });
  } catch (err) { next(err); }
}

// ── Reassign task ─────────────────────────────────────────────────

async function reassignTask(req, res, next) {
  try {
    const data                                = reassignTaskSchema.parse(req.body);
    const { workspaceId, containerId, taskId } = req.params;

    if (data.assigned_to) {
      const { data: check } = await supabaseAdmin
        .from('container_participants').select('id').eq('container_id', containerId).eq('workspace_member_id', data.assigned_to).maybeSingle();
      if (!check) throw new BusinessRuleError('assigned_to must be a participant in this container');
    }

    const prev = await fetchTask(containerId, taskId);
    if (!prev) throw new NotFoundError('Task not found');
    if (['in_progress', 'completed'].includes(prev.status)) {
      throw new BusinessRuleError(`Cannot reassign a task that is already '${prev.status}'. Override the status first if needed.`);
    }

    const { data: task, error } = await supabaseAdmin
      .from('container_tasks').update({ assigned_to: data.assigned_to, updated_at: new Date().toISOString() }).eq('id', taskId).select().single();
    if (error) throw new Error(error.message);

    if (data.assigned_to) {
      await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [data.assigned_to], referenceType: 'task', referenceId: taskId, variables: { actor: req.member.displayName, task_title: prev.title } });
    }

    success(res, { task });
  } catch (err) { next(err); }
}

// ── Override task status ──────────────────────────────────────────
// overrideTaskStatus is an admin-only hard override; enforced via
// requireAdmin at the route level in workspace.routes.js.

async function overrideTaskStatus(req, res, next) {
  try {
    const data                    = overrideTaskStatusSchema.parse(req.body);
    const { containerId, taskId } = req.params;

    const updates = { status: data.status, updated_at: new Date().toISOString() };
    if (data.status === 'completed') { updates.completed_at = new Date().toISOString(); updates.completed_by = req.member.id; }
    if (data.note) updates.completion_note = data.note;

    const { data: task, error } = await supabaseAdmin
      .from('container_tasks').update(updates).eq('id', taskId).eq('container_id', containerId).is('deleted_at', null).select().maybeSingle();

    if (error) throw new Error(error.message);
    if (!task) throw new NotFoundError('Task not found');

    success(res, { task });
  } catch (err) { next(err); }
}

// ── Admin confirm task ────────────────────────────────────────────

async function adminConfirmTask(req, res, next) {
  try {
    const { workspaceId, containerId, taskId } = req.params;
    const note = req.body.note || null;

    const task = await fetchTask(containerId, taskId);
    if (!task) throw new NotFoundError('Task not found');
    if (task.status !== 'completed') throw new BusinessRuleError('Only tasks with status "completed" can be confirmed');
    if (task.admin_confirmed_at)     throw new BusinessRuleError('Task has already been confirmed');

    const { data: updated, error } = await supabaseAdmin
      .from('container_tasks')
      .update({ admin_confirmed_at: new Date().toISOString(), admin_confirmed_by: req.member.id, admin_note: note, updated_at: new Date().toISOString() })
      .eq('id', taskId).eq('container_id', containerId).select().single();

    if (error) throw new Error(error.message);

    if (task.assigned_to) {
      await notification.send({ type: 'task_confirmed', workspaceId, recipientIds: [task.assigned_to], referenceType: 'task', referenceId: taskId, variables: { actor: req.member.displayName, task_title: task.title } });
    }

    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.TASK_CONFIRMED, targetType: 'task', targetId: taskId, metadata: { title: task.title } });

    success(res, { task: updated });
  } catch (err) { next(err); }
}

// ── Bulk create tasks ─────────────────────────────────────────────

async function bulkCreateTasks(req, res, next) {
  try {
    const data                         = bulkCreateTasksSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;
    const created = [];
    const failed  = [];

    for (let index = 0; index < data.tasks.length; index++) {
      const t = data.tasks[index];
      try {
        if (t.assigned_to) {
          const { data: check } = await supabaseAdmin.from('container_participants').select('id').eq('container_id', containerId).eq('workspace_member_id', t.assigned_to).maybeSingle();
          if (!check) throw new Error('assigned_to is not a participant');
        }
        const { data: task, error } = await supabaseAdmin.from('container_tasks')
          .insert({ container_id: containerId, title: t.title, description: t.description || null, assigned_to: t.assigned_to || null, due_date: t.due_date || null, created_by: req.member.id, sort_order: index })
          .select().single();
        if (error) throw new Error(error.message);
        created.push(task);
        if (t.assigned_to) {
          await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [t.assigned_to], referenceType: 'task', referenceId: task.id, variables: { actor: req.member.displayName, task_title: t.title } });
        }
      } catch (err) {
        failed.push({ index, error: err.message });
      }
    }

    success(res, { created, failed }, 201);
  } catch (err) { next(err); }
}

// ── Export tasks ──────────────────────────────────────────────────

async function exportTasks(req, res, next) {
  try {
    const { containerId } = req.params;
    const isAdmin = req.member.role === 'admin';

    // Issue L6 fix: the member-scoped path previously reimplemented its
    // own escape()/headers/row-building instead of reusing
    // exportTasksCSV — now both paths call the same shared builder, with
    // `assignedTo` scoping the member path to just their own tasks.
    // (Minor, low-risk output change: the member CSV now includes the
    // same "Task ID" / "Assigned To" columns as the admin export, instead
    // of a narrower ad hoc column set.)
    const csv = await exportTasksCSV({
      containerId,
      assignedTo: isAdmin ? null : req.member.id,
    });

    const filename = isAdmin ? `tasks-export-${Date.now()}.csv` : `my-tasks-${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) { next(err); }
}

// ── Get proof upload URL ──────────────────────────────────────────

async function getTaskProofUploadUrl(req, res, next) {
  try {
    const data                                = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId, taskId } = req.params;
    const isAdmin = req.member.role === 'admin';

    const task = await fetchTask(containerId, taskId);
    if (!task) throw new NotFoundError('Task not found');
    if (!isAdmin && task.assigned_to !== req.member.id) throw new ForbiddenError('Access denied');

    const result = await generateUploadUrl({ workspaceId, folder: `task-proofs/${taskId}`, filename: data.filename, contentType: data.content_type, fileSize: data.file_size, fileType: 'task_proof' });
    success(res, result);
  } catch (err) { next(err); }
}

// ── Confirm task proof ────────────────────────────────────────────

async function confirmTaskProof(req, res, next) {
  try {
    const data                    = confirmProofSchema.parse(req.body);
    const { containerId, taskId } = req.params;
    const isAdmin = req.member.role === 'admin';

    const task = await fetchTask(containerId, taskId);
    if (!task) throw new NotFoundError('Task not found');
    if (!isAdmin && task.assigned_to !== req.member.id) throw new ForbiddenError('Access denied');

    // Issue M13 fix: verify the uploaded file's actual bytes match its
    // declared content type before trusting it as proof.
    await verifyUploadedFile(data.file_path, data.mime_type);

    const fileObject    = { url: data.file_path, name: data.name, size: data.size, mime_type: data.mime_type, uploaded_by: req.member.id, uploaded_at: new Date().toISOString() };
    const currentProofs = Array.isArray(task.proofs) ? task.proofs : [];

    const { data: updated, error } = await supabaseAdmin
      .from('container_tasks').update({ proofs: [...currentProofs, fileObject], updated_at: new Date().toISOString() }).eq('id', taskId).select().single();

    if (error) throw new Error(error.message);
    success(res, { task: updated });
  } catch (err) { next(err); }
}

// ── Delete task proof by index ─────────────────────────────────────
//
// Removes a specific proof from a task's proofs array by its 0-based
// index. Admin can remove any proof; a member can only remove from tasks
// assigned to them.

async function deleteTaskProof(req, res, next) {
  try {
    const { containerId, taskId } = req.params;
    const proofIndex = parseInt(req.params.proofIndex, 10);
    const isAdmin    = req.member.role === 'admin';

    if (isNaN(proofIndex) || proofIndex < 0) {
      throw new BusinessRuleError('Invalid proof index');
    }

    const task = await fetchTask(containerId, taskId);
    if (!task) throw new NotFoundError('Task not found');
    if (!isAdmin && task.assigned_to !== req.member.id) throw new ForbiddenError('Access denied');

    const proofs = Array.isArray(task.proofs) ? task.proofs : [];
    if (proofIndex >= proofs.length) throw new NotFoundError(`No proof file at index ${proofIndex}`);

    const updatedProofs = proofs.filter((_, i) => i !== proofIndex);

    const { data: updated, error } = await supabaseAdmin
      .from('container_tasks').update({ proofs: updatedProofs, updated_at: new Date().toISOString() }).eq('id', taskId).select().single();

    if (error) throw new Error(error.message);
    success(res, { task: updated });
  } catch (err) { next(err); }
}

// ── Delete task (soft) ────────────────────────────────────────────

async function deleteTask(req, res, next) {
  try {
    const { containerId, taskId } = req.params;

    const task = await fetchTask(containerId, taskId);
    if (!task) throw new NotFoundError('Task not found');

    const { error } = await supabaseAdmin
      .from('container_tasks').update({ deleted_at: new Date().toISOString() }).eq('id', taskId).eq('container_id', containerId);

    if (error) throw new Error(error.message);
    noContent(res);
  } catch (err) { next(err); }
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
