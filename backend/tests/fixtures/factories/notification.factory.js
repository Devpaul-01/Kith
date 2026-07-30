// tests/fixtures/factories/notification.factory.js
// Mirrors public.notifications and public.notification_deliveries.

const crypto = require('crypto');

function buildNotification(overrides = {}) {
  if (!overrides.recipient_id) throw new Error('buildNotification requires an explicit recipient_id override');

  return {
    id: overrides.id || crypto.randomUUID(),
    workspace_id: overrides.workspace_id || null,
    recipient_id: overrides.recipient_id,
    type: 'contribution_submitted',
    title: 'Test notification',
    body: 'This is a test notification body.',
    reference_type: null,
    reference_id: null,
    is_read: false,
    read_at: null,
    created_at: new Date().toISOString(),
    dedup_key: null,
    ...overrides,
  };
}

function buildNotificationDelivery(overrides = {}) {
  if (!overrides.notification_id) throw new Error('buildNotificationDelivery requires an explicit notification_id override');

  return {
    id: overrides.id || crypto.randomUUID(),
    notification_id: overrides.notification_id,
    channel: 'push',
    status: 'pending',
    retry_count: 0,
    last_attempt_at: null,
    delivered_at: null,
    error_message: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

module.exports = { buildNotification, buildNotificationDelivery };
