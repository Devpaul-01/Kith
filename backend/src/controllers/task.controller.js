// src/controllers/task.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../utils/errors');
const { createTaskSchema, bulkCreateTasksSchema, updateTaskSchema, reassignTaskSchema, overrideTaskStatusSchema, uploadFileSchema, confirmProofSchema } = require('../validators/ledger.validator');
const { generateUploadUrl }  = require('../services/storage.service');
const notification           = require('../services/notification.service');
const { exportTasksCSV }     = require('../services/export.service');

async function listTasks(req, res, next) {
  try {
    const { containerId }  = req.params;
    const assignedFilter   = req.query['filter[assigned_to]'];
    const statusFilter     = req.query['filter[status]'];
    const sort             = req.query.sort || 'sort_order';

    const ascending = !sort.startsWith('-');
    const sortField = sort.replace('-', '');
    const safeSort  = ['sort_order','due_date','created_at','status'].includes(sortField) ? sortField : 'sort_order';

    let query = supabaseAdmin
      .from('container_tasks')
      .select('*, assigned_to_member:workspace_members!assigned_to(display_name), created_by_member:workspace_members!created_by(display_name)')
      .eq('container_id', containerId)
      .is('deleted_at', null)
      .order(safeSort, { ascending });

    if (assignedFilter) query = query.eq('assigned_to', assignedFilter);
    if (statusFilter)   query = query.eq('status', statusFilter);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const tasks = (data || []).map((t) => ({
      ...t,
      assigned_to_name:  t.assigned_to_member?.display_name,
      created_by_name:   t.created_by_member?.display_name,
      assigned_to_member: undefined, created_by_member: undefined,
    }));

    success(res, { tasks });
  } catch (err) { next(err); }
}

async function createTask(req, res, next) {
  try {
    const data                          = createTaskSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;

    if (data.assigned_to) {
      const { data: check } = await supabaseAdmin.from('container_participants').select('id').eq('container_id', containerId).eq('workspace_member_id', data.assigned_to).maybeSingle();
      if (!check) throw new BusinessRuleError('assigned_to must be a participant in this container');
    }

    const { data: task, error } = await supabaseAdmin
      .from('container_tasks')
      .insert({ container_id: containerId, title: data.title, description: data.description || null, assigned_to: data.assigned_to || null, due_date: data.due_date || null, created_by: req.member.id })
      .select()
      .single();

    if (error) throw new Error(error.message);

    if (data.assigned_to) {
      await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [data.assigned_to], referenceType: 'task', referenceId: task.id, variables: { actor: req.member.displayName, task_title: data.title } });
    }

    success(res, { task }, 201);
  } catch (err) { next(err); }
}

async function updateTask(req, res, next) {
  try {
    const data                               = updateTaskSchema.parse(req.body);
    const { workspaceId, containerId, taskId } = req.params;
    const isAdmin  = req.member.role === 'admin';
    const callerId = req.member.id;

    const { data: task } = await supabaseAdmin.from('container_tasks').select('*').eq('id', taskId).eq('container_id', containerId).is('deleted_at', null).maybeSingle();
    if (!task) throw new NotFoundError('Task not found');

    const isAssigned = task.assigned_to === callerId;
    if (!isAdmin && !isAssigned) throw new ForbiddenError('You can only update tasks assigned to you');

    if (!isAdmin) {
      const allowedForMember = ['status','completion_note'];
      for (const key of Object.keys(data)) {
        if (data[key] !== undefined && !allowedForMember.includes(key)) throw new ForbiddenError(`Field '${key}' can only be edited by admins`);
      }
      if (data.status && !['in_progress','completed'].includes(data.status)) throw new ForbiddenError('Members can only set status to in_progress or completed');
      if (data.status === 'cancelled') throw new ForbiddenError('Only admins can cancel tasks');
    }

    const allowedFields = isAdmin
      ? ['title','description','assigned_to','due_date','status','sort_order','completion_note']
      : ['status','completion_note'];

    const updates = {};
    for (const field of allowedFields) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    if (data.status === 'completed') {
      updates.completed_at = new Date().toISOString();
      updates.completed_by = callerId;
    }

    if (!Object.keys(updates).length) return success(res, { task });

    updates.updated_at = new Date().toISOString();

    const { data: updated, error } = await supabaseAdmin
      .from('container_tasks').update(updates).eq('id', taskId).eq('container_id', containerId).select().single();

    if (error) throw new Error(error.message);

    if (data.status === 'completed') {
      const { data: admins } = await supabaseAdmin.from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true);
      await notification.send({ type: 'task_completed', workspaceId, recipientIds: (admins || []).map((a) => a.id), referenceType: 'task', referenceId: taskId, variables: { actor: req.member.displayName, task_title: task.title } });
    }

    if (isAdmin && data.assigned_to && data.assigned_to !== task.assigned_to) {
      await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [data.assigned_to], referenceType: 'task', referenceId: taskId, variables: { actor: req.member.displayName, task_title: task.title } });
    }

    success(res, { task: updated });
  } catch (err) { next(err); }
}

async function reassignTask(req, res, next) {
  try {
    const data                               = reassignTaskSchema.parse(req.body);
    const { workspaceId, containerId, taskId } = req.params;

    if (data.assigned_to) {
      const { data: check } = await supabaseAdmin.from('container_participants').select('id').eq('container_id', containerId).eq('workspace_member_id', data.assigned_to).maybeSingle();
      if (!check) throw new BusinessRuleError('assigned_to must be a participant');
    }

    const { data: prev } = await supabaseAdmin.from('container_tasks').select('assigned_to, title').eq('id', taskId).eq('container_id', containerId).maybeSingle();
    if (!prev) throw new NotFoundError('Task not found');

    const { data: task, error } = await supabaseAdmin
      .from('container_tasks').update({ assigned_to: data.assigned_to, updated_at: new Date().toISOString() }).eq('id', taskId).select().single();

    if (error) throw new Error(error.message);

    if (data.assigned_to) {
      await notification.send({ type: 'task_assigned', workspaceId, recipientIds: [data.assigned_to], referenceType: 'task', referenceId: taskId, variables: { actor: req.member.displayName, task_title: prev.title } });
    }

    success(res, { task });
  } catch (err) { next(err); }
}

async function overrideTaskStatus(req, res, next) {
  try {
    const data                       = overrideTaskStatusSchema.parse(req.body);
    const { containerId, taskId }    = req.params;

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

async function bulkCreateTasks(req, res, next) {
  try {
    const data                          = bulkCreateTasksSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;
    const created = [];
    const failed  = [];

    for (let index = 0; index < data.tasks.length; index++) {
      const t = data.tasks[index];
      try {
        if (t.assigned_to) {
          const { data: check } = await supabaseAdmin.from('container_participants').select('id').eq('container_id', containerId).eq('workspace_member_id', t.assigned_to).maybeSingle();
          if (!check) throw new Error('assigned_to is not a participant');
        }

        const { data: task, error } = await supabaseAdmin
          .from('container_tasks')
          .insert({ container_id: containerId, title: t.title, description: t.description || null, assigned_to: t.assigned_to || null, due_date: t.due_date || null, created_by: req.member.id, sort_order: index })
          .select()
          .single();

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

async function exportTasks(req, res, next) {
  try {
    const { containerId } = req.params;
    const csv = await exportTasksCSV({ containerId });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tasks-export-${Date.now()}.csv"`);
    res.status(200).send(csv);
  } catch (err) { next(err); }
}

async function getTaskProofUploadUrl(req, res, next) {
  try {
    const data                               = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId, taskId } = req.params;
    const isAdmin = req.member.role === 'admin';

    const { data: task } = await supabaseAdmin.from('container_tasks').select('assigned_to').eq('id', taskId).eq('container_id', containerId).is('deleted_at', null).maybeSingle();
    if (!task) throw new NotFoundError('Task not found');
    if (!isAdmin && task.assigned_to !== req.member.id) throw new ForbiddenError('Access denied');

    const result = await generateUploadUrl({ workspaceId, folder: `task-proofs/${taskId}`, filename: data.filename, contentType: data.content_type, fileSize: data.file_size, fileType: 'task_proof' });
    success(res, result);
  } catch (err) { next(err); }
}

async function confirmTaskProof(req, res, next) {
  try {
    const data                       = confirmProofSchema.parse(req.body);
    const { containerId, taskId }    = req.params;
    const isAdmin = req.member.role === 'admin';

    const { data: task } = await supabaseAdmin.from('container_tasks').select('*').eq('id', taskId).eq('container_id', containerId).is('deleted_at', null).maybeSingle();
    if (!task) throw new NotFoundError('Task not found');
    if (!isAdmin && task.assigned_to !== req.member.id) throw new ForbiddenError('Access denied');

    const fileObject    = { url: data.file_path, name: data.name, size: data.size, mime_type: data.mime_type, uploaded_by: req.member.id, uploaded_at: new Date().toISOString() };
    const currentProofs = Array.isArray(task.proofs) ? task.proofs : [];

    const { data: updated, error } = await supabaseAdmin
      .from('container_tasks').update({ proofs: [...currentProofs, fileObject], updated_at: new Date().toISOString() }).eq('id', taskId).select().single();

    if (error) throw new Error(error.message);
    success(res, { task: updated });
  } catch (err) { next(err); }
}

async function deleteTask(req, res, next) {
  try {
    const { containerId, taskId } = req.params;
    await supabaseAdmin.from('container_tasks').update({ deleted_at: new Date().toISOString() }).eq('id', taskId).eq('container_id', containerId);
    noContent(res);
  } catch (err) { next(err); }
}

module.exports = { listTasks, createTask, updateTask, reassignTask, overrideTaskStatus, bulkCreateTasks, exportTasks, getTaskProofUploadUrl, confirmTaskProof, deleteTask };
