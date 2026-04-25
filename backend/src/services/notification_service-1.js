// src/services/notification.service.js
const { supabaseAdmin } = require('../config/supabase');
const { getQueue }      = require('../queues');
const logger            = require('../utils/logger');

// ── Template Registry ─────────────────────────────────────────────

const TEMPLATES = {
  contribution_submitted:  { title: 'New contribution pending',         body: '{actor} submitted {amount} for {container}',                     channels: ['in_app','push'] },
  contribution_confirmed:  { title: 'Your contribution confirmed',      body: 'Your {amount} for {container} was confirmed',                    channels: ['in_app','push'] },
  contribution_disputed:   { title: 'Contribution disputed',            body: '{actor} disputed a {amount} entry in {container}',               channels: ['in_app','push','email'], urgent: true },
  dispute_resolved:        { title: 'Dispute resolved',                 body: 'Dispute in {container} has been resolved',                       channels: ['in_app','push'] },
  task_assigned:           { title: 'New task assigned',                body: '{actor} assigned you: {task_title}',                             channels: ['in_app','push'] },
  task_completed:          { title: 'Task completed',                   body: '{actor} completed: {task_title}',                                channels: ['in_app'] },
  task_overdue:            { title: 'Task overdue',                     body: '{task_title} was due {due_date}',                                channels: ['in_app','push'] },
  invite_accepted:         { title: 'New family member joined',         body: '{actor} joined {workspace}',                                     channels: ['in_app'] },
  payment_reminder:        { title: 'Contribution reminder',            body: 'Reminder: {amount} for {container} due {due_date}',              channels: ['in_app','push'] },
  overdue_reminder:        { title: 'Overdue contribution',             body: 'Your contribution for {container} is now overdue',               channels: ['in_app','push'] },
  cycle_started:           { title: 'New cycle started',                body: '{container} — your contribution: {amount}',                      channels: ['in_app'] },
  cycle_closing_soon:      { title: 'Pool cycle ending soon',           body: '{container} cycle ends {due_date}. {outstanding} remaining.',    channels: ['in_app','push'] },
  container_completed:     { title: 'Event completed',                  body: '{container} has been completed',                                 channels: ['in_app','push'] },
  admin_announcement:      { title: '{title}',                          body: '{body}',                                                         channels: ['in_app','push','email'], urgent: true },
  overdue_summary_admin:   { title: 'Overdue contributions',            body: '{count} contributors overdue in {container}',                    channels: ['in_app'] },
  member_removed:          { title: 'Removed from workspace',           body: 'You have been removed from {workspace}',                         channels: ['in_app','push'] },
};

function renderTemplate(template, variables) {
  let text = template;
  for (const [key, value] of Object.entries(variables)) {
    text = text.replaceAll(`{${key}}`, String(value ?? ''));
  }
  return text;
}

function buildDedupKey(type, variables) {
  const parts = [type];
  if (variables.participant_id) parts.push(variables.participant_id);
  if (variables.container_id)   parts.push(variables.container_id);
  if (variables.due_date)       parts.push(variables.due_date);
  if (variables.days)           parts.push(variables.days + 'd');
  if (variables.cycle_id)       parts.push(variables.cycle_id);
  return parts.join(':') || null;
}

/**
 * Central notification sender. All notifications MUST go through here.
 */
async function send({ type, workspaceId, recipientIds, referenceType = null, referenceId = null, variables = {}, dedupKey = null }) {
  const template = TEMPLATES[type];
  if (!template) { logger.warn('Unknown notification type', { type }); return; }

  const title         = renderTemplate(template.title, variables);
  const body          = renderTemplate(template.body,  variables);
  const finalDedupKey = dedupKey || buildDedupKey(type, variables) || null;

  for (const recipientId of recipientIds) {
    try {
      await _sendToRecipient({ type, workspaceId, recipientId, title, body, referenceType, referenceId, channels: template.channels, dedupKey: finalDedupKey ? `${finalDedupKey}:${recipientId}` : null });
    } catch (err) {
      logger.error('Failed to send notification to recipient', { type, recipientId, error: err.message });
    }
  }
}

async function _sendToRecipient({ type, workspaceId, recipientId, title, body, referenceType, referenceId, channels, dedupKey }) {
  // Resolve recipient info
  const { data: recipient, error: recErr } = await supabaseAdmin
    .from('workspace_members')
    .select(`
      id, is_proxy,
      users:user_id (
        id, push_token, push_token_platform, push_enabled,
        email, email_digest_enabled
      )
    `)
    .eq('id', recipientId)
    .maybeSingle();

  if (recErr || !recipient) return;

  const user = Array.isArray(recipient.users) ? recipient.users[0] : recipient.users;

  // Insert notification with dedup
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('notifications')
    .upsert(
      { workspace_id: workspaceId, recipient_id: recipientId, type, title, body, reference_type: referenceType, reference_id: referenceId, dedup_key: dedupKey },
      { onConflict: 'dedup_key', ignoreDuplicates: true }
    )
    .select('id')
    .maybeSingle();

  if (insErr) { logger.error('Failed to insert notification', { error: insErr.message }); return; }
  if (!inserted) return; // dedup hit

  const notificationId    = inserted.id;
  const notificationQueue = getQueue('notification-queue');

  for (const channel of channels) {
    if (recipient.is_proxy && channel !== 'in_app') continue;
    if (!user?.id           && channel !== 'in_app') continue;

    const { data: delivery, error: delErr } = await supabaseAdmin
      .from('notification_deliveries')
      .insert({ notification_id: notificationId, channel, status: 'pending' })
      .select('id')
      .single();

    if (delErr) continue;
    const deliveryId = delivery.id;

    // in_app deliveries are immediately satisfied — no queue needed
    if (channel === 'in_app') {
      await supabaseAdmin
        .from('notification_deliveries')
        .update({ status: 'delivered', delivered_at: new Date().toISOString() })
        .eq('id', deliveryId);
      continue;
    }

    // External channels: enqueue the delivery job.
    // If the enqueue fails the delivery record stays as 'pending' so the
    // outbox worker (notification-outbox-queue) can pick it up and retry.
    try {
      await notificationQueue.add(
        `deliver-${channel}`,
        {
          notification_id:      notificationId,
          delivery_id:          deliveryId,
          channel,
          recipient_user_id:    user?.id,
          push_token:           user?.push_token,
          push_token_platform:  user?.push_token_platform,
          push_enabled:         user?.push_enabled,
          email:                user?.email,
          email_digest_enabled: user?.email_digest_enabled,
          title, body,
          reference_type:       referenceType,
          reference_id:         referenceId,
          workspace_id:         workspaceId,
        },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 86400 }, removeOnFail: false }
      );
    } catch (queueErr) {
      // Mark delivery as failed so the outbox worker can recover it.
      logger.error('Failed to enqueue notification delivery — will be retried by outbox worker', {
        deliveryId,
        channel,
        error: queueErr.message,
      });
      await supabaseAdmin
        .from('notification_deliveries')
        .update({ status: 'failed' })
        .eq('id', deliveryId);
    }
  }
}

module.exports = { send, renderTemplate };
