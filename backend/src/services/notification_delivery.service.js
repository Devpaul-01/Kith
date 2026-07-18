// src/services/notification_delivery.service.js
//
// Extracted from workers/notification.worker.js as part of the
// service-layer refactor. This is a distinct concern from
// services/notification.service.js (which decides *what* to send and
// enqueues the delivery job) and from
// services/notification_inbox.service.js (which lets a recipient read
// their own inbox) — this module is "actually deliver one job's payload
// via push or email," including idempotency, retry bookkeeping, and
// token-rotation checks, exactly as in the original worker.

const { supabaseAdmin } = require('../config/supabase');
const { getMessaging }  = require('../config/firebase');
const { getResend }     = require('../config/resend');
const logger            = require('../utils/logger');

// Issue M12 fix: title/body ultimately originate from user-controlled
// strings (container names, task titles, admin announcement text — see
// notification.service.js's renderTemplate) and must be escaped before
// interpolation into HTML email bodies.
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function deliverNotification(jobData) {
  const {
    notification_id, delivery_id, channel,
    recipient_user_id, push_token, push_token_platform, push_enabled,
    email, title, body, reference_type, reference_id, workspace_id,
  } = jobData;

  // Idempotency check
  const { data: deliveryCheck } = await supabaseAdmin
    .from('notification_deliveries').select('status').eq('id', delivery_id).maybeSingle();

  if (deliveryCheck?.status === 'delivered') {
    logger.info('Notification already delivered, skipping', { delivery_id });
    return;
  }

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
}

module.exports = { deliverNotification };
