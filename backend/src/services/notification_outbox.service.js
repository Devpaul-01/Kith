// src/services/notification_outbox.service.js
//
// Safety net for the notification pipeline: scans for delivery records
// stuck in 'pending' or 'failed' (external channels only) for more than
// 5 minutes and re-enqueues them, closing the gap where a queue.add
// failure would otherwise silently drop a notification.

const { supabaseAdmin } = require('../config/supabase');
const { getQueue }      = require('../queues');
const logger             = require('../utils/logger');

async function runNotificationOutboxScan() {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: stale } = await supabaseAdmin
    .from('notification_deliveries')
    .select(`
      id, channel,
      notification_id,
      notifications(
        id, title, body, workspace_id, reference_type, reference_id,
        recipient_id,
        workspace_members!recipient_id(
          is_proxy,
          users:user_id(id, push_token, push_token_platform, push_enabled, email, email_digest_enabled)
        )
      )
    `)
    .in('status', ['pending', 'failed'])
    .neq('channel', 'in_app')
    .lt('created_at', staleThreshold)
    .limit(50);

  if (!(stale || []).length) return;

  const notificationQueue = getQueue('notification-queue');

  for (const delivery of stale) {
    try {
      const notif = delivery.notifications;
      if (!notif) continue;

      const recipient = notif.workspace_members;
      if (recipient?.is_proxy) continue; // proxy members never get external channels

      const rawUser = recipient?.users;
      const user    = Array.isArray(rawUser) ? rawUser[0] : rawUser;

      await notificationQueue.add(
        `deliver-${delivery.channel}`,
        {
          notification_id:      delivery.notification_id,
          delivery_id:          delivery.id,
          channel:              delivery.channel,
          recipient_user_id:    user?.id,
          push_token:           user?.push_token,
          push_token_platform:  user?.push_token_platform,
          push_enabled:         user?.push_enabled,
          email:                user?.email,
          email_digest_enabled: user?.email_digest_enabled,
          title:                notif.title,
          body:                 notif.body,
          reference_type:       notif.reference_type,
          reference_id:         notif.reference_id,
          workspace_id:         notif.workspace_id,
        },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
      );

      // Reset status to pending so the delivery worker can update it to delivered
      await supabaseAdmin
        .from('notification_deliveries')
        .update({ status: 'pending' })
        .eq('id', delivery.id);

      logger.info('Re-enqueued stale notification delivery', { deliveryId: delivery.id, channel: delivery.channel });
    } catch (err) {
      logger.error('Failed to re-enqueue stale delivery', { deliveryId: delivery.id, error: err.message });
    }
  }
}

module.exports = { runNotificationOutboxScan };
