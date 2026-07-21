// src/services/task_overdue.service.js
const { supabaseAdmin } = require('../config/supabase');
const notification      = require('./notification.service');
const logger             = require('../utils/logger');

async function runTaskOverdueCheck() {
  const today = new Date().toISOString().split('T')[0];
  logger.info('Running task overdue check', { today });

  const { data: tasks } = await supabaseAdmin
    .from('container_tasks')
    .update({ status: 'overdue' })
    .eq('status', 'pending')
    .lt('due_date', today)
    .is('deleted_at', null)
    .select('id, container_id, title, assigned_to');

  for (const task of (tasks || [])) {
    const { data: container } = await supabaseAdmin
      .from('containers')
      .select('workspace_id')
      .eq('id', task.container_id)
      .maybeSingle();

    if (!container) continue;

    const recipients = task.assigned_to ? [task.assigned_to] : [];

    const { data: admins } = await supabaseAdmin
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', container.workspace_id)
      .eq('role', 'admin')
      .eq('is_active', true);

    for (const a of (admins || [])) {
      if (!recipients.includes(a.id)) recipients.push(a.id);
    }

    try {
      await notification.send({
        type:          'task_overdue',
        workspaceId:   container.workspace_id,
        recipientIds:  recipients,
        referenceType: 'task',
        referenceId:   task.id,
        variables:     { task_title: task.title, due_date: task.due_date || 'N/A' },
        dedupKey:      `task-overdue:${task.id}:${today}`,
      });
    } catch (err) {
      logger.error('Task overdue check: failed to send notification', { taskId: task.id, error: err.message });
    }
  }

  logger.info('Task overdue check complete', { marked: (tasks || []).length });
}

module.exports = { runTaskOverdueCheck };
