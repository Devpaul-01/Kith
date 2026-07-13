// src/workers/notification.worker.js
const { Worker }        = require('bullmq');
const { getRedis }      = require('../config/redis');
const { supabaseAdmin } = require('../config/supabase');
const { getMessaging }  = require('../config/firebase');
const { getResend }     = require('../config/resend');
const logger            = require('../utils/logger');

function createNotificationWorker() {
  return new Worker(
    'notification-queue',
    async (job) => {
      const {
        notification_id, delivery_id, channel,
        recipient_user_id, push_token, push_token_platform, push_enabled,
        email, title, body, reference_type, reference_id, workspace_id,
      } = job.data;

      // Idempotency check
      const { data: deliveryCheck } = await supabaseAdmin
        .from('notification_deliveries').select('status').eq('id', delivery_id).maybeSingle();

      if (deliveryCheck?.status === 'delivered') {
        logger.info('Notification already delivered, skipping', { delivery_id });
        return;
      }

      // Issue C5 fix: this used to be preceded by a separate, no-op
      // `update({ retry_count: supabaseAdmin.rpc ? undefined : undefined })`
      // call — a leftover from an aborted refactor that evaluated to
      // `undefined` on both branches of the ternary and therefore never
      // touched retry_count at all. It was pure dead weight: one wasted DB
      // write on every single delivery attempt at this worker's volume
      // (concurrency 10, rate-limited to 50/sec), immediately followed by
      // the real fetch-then-increment below. Removed outright.
      const { data: current } = await supabaseAdmin
        .from('notification_deliveries').select('retry_count').eq('id', delivery_id).single();
      await supabaseAdmin
        .from('notification_deliveries')
        .update({ last_attempt_at: new Date().toISOString(), retry_count: (current?.retry_count || 0) + 1 })
        .eq('id', delivery_id);

      try {
        if (channel === 'push') {
          const messaging = getMessaging();
          if (!messaging || !push_token || !push_enabled) {
            await supabaseAdmin.from('notification_deliveries').update({ status: 'skipped' }).eq('id', delivery_id);
            return;
          }

          // Verify token hasn't rotated since job was queued
          if (recipient_user_id) {
            const { data: user } = await supabaseAdmin.from('users').select('push_token').eq('id', recipient_user_id).single();
            if (user?.push_token !== push_token) {
              await supabaseAdmin.from('notification_deliveries').update({ status: 'skipped' }).eq('id', delivery_id);
              return;
            }
          }

          await messaging.send({
            token: push_token,
            notification: { title, body },
            data: {
              reference_type: reference_type || '',
              reference_id:   reference_id   || '',
              workspace_id:   workspace_id   || '',
              notification_id: String(notification_id),
            },
            ...(push_token_platform === 'web'
              ? { webpush: { notification: { icon: '/icons/icon-192.png' } } }
              : {}),
          });

        } else if (channel === 'email') {
          const resend = getResend();
          if (!resend || !email) {
            await supabaseAdmin.from('notification_deliveries').update({ status: 'skipped' }).eq('id', delivery_id);
            return;
          }

          await resend.emails.send({
            from:    process.env.EMAIL_FROM || 'Kith <noreply@kith.app>',
            to:      email,
            subject: title,
            html: `
              <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
                <h2 style="color:#1a1a1a">${escapeHtml(title)}</h2>
                <p style="color:#444;font-size:16px">${escapeHtml(body)}</p>
                <hr style="border:1px solid #eee;margin:20px 0">
                <p style="color:#888;font-size:12px">Kith — Family Finance Coordinator</p>
              </div>
            `,
          });
        }

        await supabaseAdmin
          .from('notification_deliveries')
          .update({ status: 'delivered', delivered_at: new Date().toISOString() })
          .eq('id', delivery_id);

        logger.info('Notification delivered', { channel, delivery_id, notification_id });

      } catch (err) {
        await supabaseAdmin
          .from('notification_deliveries')
          .update({ status: 'failed', error_message: err.message?.slice(0, 500) })
          .eq('id', delivery_id);

        throw err; // Re-throw so BullMQ retries
      }
    },
    {
      connection:  getRedis(),
      concurrency: 10,
      limiter:     { max: 50, duration: 1000 },
    }
  );
}

// Issue M12 fix: title/body ultimately originate from user-controlled
// strings (container names, task titles, admin announcement text — see
// notification.service.js's renderTemplate) and were previously
// interpolated directly into this HTML email body with no escaping. A
// container named e.g. `<img src=x onerror=...>` would render unescaped in
// a transactional email. Minimal, dependency-free HTML entity escaping.
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

module.exports = { createNotificationWorker };
