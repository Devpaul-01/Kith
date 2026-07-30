// tests/integration/workers/notification_delivery.test.js
//
// Doc 3 Section 5.9 — notification_delivery.service.js
// (deliverNotification). Firebase and Resend are both mocked per Doc 3
// Section 1's "mock external SaaS always" rule.

const { deliverNotification } = require('../../../src/services/notification_delivery.service');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getMessaging } = require('../../../src/config/firebase');
const { getResend } = require('../../../src/config/resend');
const { seedWorkspaceWithAdmin, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildNotification, buildNotificationDelivery } = require('../../fixtures/factories');

describe('notification_delivery.service.js — deliverNotification', () => {
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  async function seedTenant() {
    const { workspace, user, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    return { workspace, user, member };
  }

  async function seedNotificationAndDelivery({ member, channel }) {
    const notif = buildNotification({ recipient_id: member.id, title: 'Test Title', body: 'Test body content' });
    await supabaseAdmin.from('notifications').insert(notif);
    const delivery = buildNotificationDelivery({ notification_id: notif.id, channel, status: 'pending' });
    await supabaseAdmin.from('notification_deliveries').insert(delivery);
    return { notif, delivery };
  }

  it('already-delivered (idempotency) skips entirely, zero client calls', async () => {
    const { member } = await seedTenant();
    const { delivery } = await seedNotificationAndDelivery({ member, channel: 'push' });
    await supabaseAdmin.from('notification_deliveries').update({ status: 'delivered' }).eq('id', delivery.id);

    const messagingSpy = jest.spyOn(getMessaging(), 'send');

    await deliverNotification({ delivery_id: delivery.id, channel: 'push', recipient_user_id: null, push_token: 'tok', push_enabled: true, title: 'x', body: 'y' });

    expect(messagingSpy).not.toHaveBeenCalled();
    messagingSpy.mockRestore();
  });

  it('push, disabled/missing token/Firebase unconfigured -> skipped, not failed', async () => {
    const { member } = await seedTenant();
    const { delivery } = await seedNotificationAndDelivery({ member, channel: 'push' });

    await deliverNotification({ delivery_id: delivery.id, channel: 'push', recipient_user_id: null, push_token: null, push_enabled: true, title: 'x', body: 'y' });

    const { data: row } = await supabaseAdmin.from('notification_deliveries').select('status').eq('id', delivery.id).single();
    expect(row.status).toBe('skipped');
  });

  it('push token rotation: job\'s push_token does not match user\'s current token -> skipped, no push sent to stale token', async () => {
    const { user, member } = await seedTenant();
    const { delivery } = await seedNotificationAndDelivery({ member, channel: 'push' });

    await supabaseAdmin.from('users').update({ push_token: 'current-token' }).eq('id', user.id);

    const messagingSpy = jest.spyOn(getMessaging(), 'send');

    await deliverNotification({
      delivery_id: delivery.id, channel: 'push', recipient_user_id: user.id,
      push_token: 'STALE-token', push_enabled: true, title: 'x', body: 'y',
    });

    expect(messagingSpy).not.toHaveBeenCalled();
    const { data: row } = await supabaseAdmin.from('notification_deliveries').select('status').eq('id', delivery.id).single();
    expect(row.status).toBe('skipped');

    messagingSpy.mockRestore();
  });

  it('email, unconfigured/no email -> skipped', async () => {
    const { member } = await seedTenant();
    const { delivery } = await seedNotificationAndDelivery({ member, channel: 'email' });

    await deliverNotification({ delivery_id: delivery.id, channel: 'email', email: null, email_digest_enabled: true, title: 'x', body: 'y' });

    const { data: row } = await supabaseAdmin.from('notification_deliveries').select('status').eq('id', delivery.id).single();
    expect(row.status).toBe('skipped');
  });

  it('successful send -> delivered, delivered_at set', async () => {
    const { member } = await seedTenant();
    const { delivery } = await seedNotificationAndDelivery({ member, channel: 'email' });

    await deliverNotification({ delivery_id: delivery.id, channel: 'email', email: 'someone@example.test', email_digest_enabled: true, title: 'Hello', body: 'World' });

    const { data: row } = await supabaseAdmin.from('notification_deliveries').select('status, delivered_at').eq('id', delivery.id).single();
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
  });

  it('send throws -> failed with truncated error, AND re-throws (triggers BullMQ retry)', async () => {
    const { member } = await seedTenant();
    const { delivery } = await seedNotificationAndDelivery({ member, channel: 'email' });

    const resend = getResend();
    resend.emails.send.mockRejectedValueOnce(new Error('simulated send failure'));

    await expect(
      deliverNotification({ delivery_id: delivery.id, channel: 'email', email: 'someone@example.test', email_digest_enabled: true, title: 'Hello', body: 'World' })
    ).rejects.toThrow();

    const { data: row } = await supabaseAdmin.from('notification_deliveries').select('status, error_message').eq('id', delivery.id).single();
    expect(row.status).toBe('failed');
    expect(row.error_message).toContain('simulated send failure');
  });

  it('HTML-escaping: title/body with <script>/&/" are escaped in the email HTML sent to the mocked Resend client (adversarial XSS test)', async () => {
    const { member } = await seedTenant();
    const { delivery } = await seedNotificationAndDelivery({ member, channel: 'email' });

    const resend = getResend();
    const sendSpy = jest.spyOn(resend.emails, 'send');

    const maliciousTitle = '<script>alert(1)</script>';
    const maliciousBody = 'Tom & "Jerry" <b>bold</b>';

    await deliverNotification({
      delivery_id: delivery.id, channel: 'email', email: 'someone@example.test', email_digest_enabled: true,
      title: maliciousTitle, body: maliciousBody,
    });

    const call = sendSpy.mock.calls[sendSpy.mock.calls.length - 1][0];
    expect(call.html).not.toContain('<script>');
    expect(call.html).toContain('&lt;script&gt;');
    expect(call.html).toContain('&amp;');
    expect(call.html).toContain('&quot;');

    sendSpy.mockRestore();
  });
});
