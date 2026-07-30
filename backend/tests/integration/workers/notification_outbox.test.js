// tests/integration/workers/notification_outbox.test.js
//
// Doc 3 Section 5.7 — notification_outbox.service.js
// (runNotificationOutboxScan).

const { runNotificationOutboxScan } = require('../../../src/services/notification_outbox.service');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getQueue } = require('../../../src/queues');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildNotification, buildNotificationDelivery } = require('../../fixtures/factories');

describe('notification_outbox.service.js — runNotificationOutboxScan', () => {
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

  async function seedStaleDelivery({ workspace, member, channel = 'push', status = 'pending', ageMinutes = 10 }) {
    const notif = buildNotification({ recipient_id: member.id, workspace_id: workspace.id });
    await supabaseAdmin.from('notifications').insert(notif);

    const createdAt = new Date(Date.now() - ageMinutes * 60 * 1000).toISOString();
    const delivery = buildNotificationDelivery({ notification_id: notif.id, channel, status, created_at: createdAt });
    await supabaseAdmin.from('notification_deliveries').insert(delivery);

    return { notif, delivery };
  }

  it('pending/failed for >5 minutes, non-in_app -> re-enqueued, status reset to pending', async () => {
    const { workspace, member } = await seedTenant();
    const { delivery } = await seedStaleDelivery({ workspace, member, status: 'failed', ageMinutes: 10 });

    const queue = getQueue('notification-queue');
    const addSpy = jest.spyOn(queue, 'add');

    await runNotificationOutboxScan();

    expect(addSpy).toHaveBeenCalledWith(
      expect.stringContaining('deliver-'),
      expect.objectContaining({ delivery_id: delivery.id }),
      expect.any(Object)
    );

    const { data: updatedDelivery } = await supabaseAdmin.from('notification_deliveries').select('status').eq('id', delivery.id).single();
    expect(updatedDelivery.status).toBe('pending');

    addSpy.mockRestore();
  });

  it('younger than 5 minutes is NOT picked up (boundary)', async () => {
    const { workspace, member } = await seedTenant();
    const { delivery } = await seedStaleDelivery({ workspace, member, status: 'pending', ageMinutes: 2 });

    const queue = getQueue('notification-queue');
    const addSpy = jest.spyOn(queue, 'add');

    await runNotificationOutboxScan();

    const wasReEnqueued = addSpy.mock.calls.some(([, payload]) => payload?.delivery_id === delivery.id);
    expect(wasReEnqueued).toBe(false);

    addSpy.mockRestore();
  });

  it('in_app deliveries are never selected regardless of age/status', async () => {
    const { workspace, member } = await seedTenant();
    const { delivery } = await seedStaleDelivery({ workspace, member, channel: 'in_app', status: 'pending', ageMinutes: 30 });

    const queue = getQueue('notification-queue');
    const addSpy = jest.spyOn(queue, 'add');

    await runNotificationOutboxScan();

    const wasReEnqueued = addSpy.mock.calls.some(([, payload]) => payload?.delivery_id === delivery.id);
    expect(wasReEnqueued).toBe(false);

    addSpy.mockRestore();
  });

  it('proxy-member recipient is not re-enqueued', async () => {
    const { workspace } = await seedTenant();
    const { member: proxy } = await seedAdditionalMember(supabaseAdmin, workspace.id, {
      member: { is_proxy: true, user_id: null, invite_status: null },
    });

    const { delivery } = await seedStaleDelivery({ workspace, member: proxy, status: 'pending', ageMinutes: 10 });

    const queue = getQueue('notification-queue');
    const addSpy = jest.spyOn(queue, 'add');

    await runNotificationOutboxScan();

    const wasReEnqueued = addSpy.mock.calls.some(([, payload]) => payload?.delivery_id === delivery.id);
    expect(wasReEnqueued).toBe(false);

    addSpy.mockRestore();
  });

  it('re-enqueue failure for one stale delivery is caught per-item; other stale deliveries in the batch are still processed', async () => {
    const { workspace, member } = await seedTenant();
    const { member: member2 } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});

    const { delivery: delivery1 } = await seedStaleDelivery({ workspace, member, status: 'pending', ageMinutes: 10 });
    const { delivery: delivery2 } = await seedStaleDelivery({ workspace, member: member2, status: 'pending', ageMinutes: 10 });

    const queue = getQueue('notification-queue');
    let callCount = 0;
    const addSpy = jest.spyOn(queue, 'add').mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return Promise.reject(new Error('simulated enqueue failure'));
      return Promise.resolve({ id: 'mock-job-id' });
    });

    await expect(runNotificationOutboxScan()).resolves.not.toThrow();
    expect(callCount).toBe(2); // both deliveries were attempted despite the first failing

    // The delivery whose re-enqueue succeeded should now be 'pending'.
    const { data: rows } = await supabaseAdmin
      .from('notification_deliveries').select('id, status').in('id', [delivery1.id, delivery2.id]);
    expect(rows.some((r) => r.status === 'pending')).toBe(true);

    addSpy.mockRestore();
  });
});
