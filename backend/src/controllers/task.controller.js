// src/controllers/task.controller.js
//
// Task CRUD/proof/export logic lives in services/task.service.js.

const { noContent, success } = require('../utils/response');
const {
  createTaskSchema,
  bulkCreateTasksSchema,
  updateTaskSchema,
  reassignTaskSchema,
  overrideTaskStatusSchema,
  uploadFileSchema,
  confirmProofSchema,
} = require('../validators/ledger.validator');
const audit = require('../services/audit.service');
const taskService = require('../services/task.service');

async function listTasks(req, res, next) {
  try {
    const { containerId }  = req.params;
    const isAdmin          = req.member.role === 'admin';

    const tasks = await taskService.listTasks({
      containerId,
      isAdmin,
      callerId: req.member.id,
      assignedFilter: req.query['filter[assigned_to]'],
      statusFilter: req.query['filter[status]'],
      sortQuery: req.query,
    });

    success(res, { tasks });
  } catch (err) { next(err); }
}

async function getTask(req, res, next) {
  try {
    const { containerId, taskId } = req.params;
    const task = await taskService.getTask({
      containerId, taskId,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
    });
    success(res, { task });
  } catch (err) { next(err); }
}

async function createTask(req, res, next) {
  try {
    const data                         = createTaskSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

    const task = await taskService.createTask({
      workspaceId, containerId, data,
      actorMemberId: req.member.id,
      actorDisplayName: req.member.displayName,
      actorCtx: audit.fromReq(req),
    });

    success(res, { task }, 201);
  } catch (err) { next(err); }
}

async function updateTask(req, res, next) {
  try {
    const data                                 = updateTaskSchema.parse(req.body);
    const { workspaceId, containerId, taskId } = req.params;

    const task = await taskService.updateTask({
      workspaceId, containerId, taskId, data,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
      actorDisplayName: req.member.displayName,
      actorCtx: audit.fromReq(req),
    });

    success(res, { task });
  } catch (err) { next(err); }
}

async function reassignTask(req, res, next) {
  try {
    const data                                 = reassignTaskSchema.parse(req.body);
    const { workspaceId, containerId, taskId } = req.params;

    const task = await taskService.reassignTask({
      workspaceId, containerId, taskId,
      assignedTo: data.assigned_to,
      actorDisplayName: req.member.displayName,
    });

    success(res, { task });
  } catch (err) { next(err); }
}

async function overrideTaskStatus(req, res, next) {
  try {
    const data                    = overrideTaskStatusSchema.parse(req.body);
    const { containerId, taskId } = req.params;

    const task = await taskService.overrideTaskStatus({
      containerId, taskId,
      status: data.status,
      note: data.note,
      actorMemberId: req.member.id,
    });

    success(res, { task });
  } catch (err) { next(err); }
}

async function adminConfirmTask(req, res, next) {
  try {
    const { workspaceId, containerId, taskId } = req.params;
    const note = req.body.note || null;

    const task = await taskService.adminConfirmTask({
      workspaceId, containerId, taskId, note,
      actorMemberId: req.member.id,
      actorDisplayName: req.member.displayName,
      actorCtx: audit.fromReq(req),
    });

    success(res, { task });
  } catch (err) { next(err); }
}

async function bulkCreateTasks(req, res, next) {
  try {
    const data                         = bulkCreateTasksSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

    const result = await taskService.bulkCreateTasks({
      workspaceId, containerId,
      tasks: data.tasks,
      actorMemberId: req.member.id,
      actorDisplayName: req.member.displayName,
    });

    success(res, result, 201);
  } catch (err) { next(err); }
}

async function exportTasks(req, res, next) {
  try {
    const { containerId } = req.params;
    const isAdmin = req.member.role === 'admin';

    const { csv, filename } = await taskService.exportTasks({ containerId, isAdmin, callerId: req.member.id });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) { next(err); }
}

async function getTaskProofUploadUrl(req, res, next) {
  try {
    const data                                 = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId, taskId } = req.params;

    const result = await taskService.getTaskProofUploadUrl({
      workspaceId, containerId, taskId,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
      filename: data.filename, contentType: data.content_type, fileSize: data.file_size,
    });

    success(res, result);
  } catch (err) { next(err); }
}

async function confirmTaskProof(req, res, next) {
  try {
    const data                    = confirmProofSchema.parse(req.body);
    const { containerId, taskId } = req.params;

    const task = await taskService.confirmTaskProof({
      containerId, taskId,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
      filePayload: data,
    });

    success(res, { task });
  } catch (err) { next(err); }
}

async function deleteTaskProof(req, res, next) {
  try {
    const { containerId, taskId } = req.params;
    const proofIndex = parseInt(req.params.proofIndex, 10);

    const task = await taskService.deleteTaskProof({
      containerId, taskId, proofIndex,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
    });

    success(res, { task });
  } catch (err) { next(err); }
}

async function deleteTask(req, res, next) {
  try {
    const { containerId, taskId } = req.params;
    await taskService.deleteTask({ containerId, taskId });
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
