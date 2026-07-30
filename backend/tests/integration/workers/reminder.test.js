// tests/integration/workers/reminder.test.js
//
// Doc 3 Section 5.1 — reminder.service.js (runReminderScan).

const { runReminderScan } = require('../../../src/services/reminder.service');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildContainer, buildRecurringContainer } = require('../../fixtures/factories');
const { freezeTime, unfreezeTime } = require('../../helpers/timeHelper');

describe('reminder.service.js — runReminderScan', () => {
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  afterEach(() => unfreezeTime());

  async function seedTenant() {
    const { workspace, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    return { workspace, member };
  }

  describe('sendUpcomingPaymentReminders', () => {
    it('target due in exactly 7 days is included', async () => {
      freezeTime('2026-01-01T00:00:00Z');
      const { workspace, member } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_money: true, status: 'active' });
      await supabaseAdmin.from('containers').insert(container);
      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();

      await supabaseAdmin.from('contributor_targets').insert({
        container_participant_id: participant.id, container_id: container.id, workspace_member_id: member.id,
        cycle_id: null, target_amount: 50, target_currency: 'USD', due_date: '2026-01-08', is_current: true, set_by: member.id,
      });

      await runReminderScan();

      const { data: notifs } = await supabaseAdmin.from('notifications').select('*').eq('type', 'payment_reminder').eq('recipient_id', member.id);
      expect(notifs.length).toBe(1); // exactly-7-days target included
    });

    it('running the scan twice on the same simulated date produces zero new notification rows (dedup)', async () => {
      freezeTime('2026-01-01T00:00:00Z');
      const { workspace, member } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_money: true, status: 'active' });
      await supabaseAdmin.from('containers').insert(container);
      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();
      await supabaseAdmin.from('contributor_targets').insert({
        container_participant_id: participant.id, container_id: container.id, workspace_member_id: member.id, cycle_id: null,
        target_amount: 50, target_currency: 'USD', due_date: '2026-01-05', is_current: true, set_by: member.id,
      });

      await runReminderScan();
      const { count: countAfterFirst } = await supabaseAdmin.from('notifications').select('*', { count: 'exact', head: true }).eq('type', 'payment_reminder').eq('recipient_id', member.id);

      await runReminderScan();
      const { count: countAfterSecond } = await supabaseAdmin.from('notifications').select('*', { count: 'exact', head: true }).eq('type', 'payment_reminder').eq('recipient_id', member.id);

      expect(countAfterSecond).toBe(countAfterFirst);
    });

    it('container not active is skipped entirely', async () => {
      freezeTime('2026-01-01T00:00:00Z');
      const { workspace, member } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_money: true, status: 'archived' });
      await supabaseAdmin.from('containers').insert(container);
      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();
      await supabaseAdmin.from('contributor_targets').insert({
        container_participant_id: participant.id, container_id: container.id, workspace_member_id: member.id, cycle_id: null,
        target_amount: 50, target_currency: 'USD', due_date: '2026-01-04', is_current: true, set_by: member.id,
      });

      await runReminderScan();

      const { count } = await supabaseAdmin.from('notifications').select('*', { count: 'exact', head: true }).eq('type', 'payment_reminder').eq('recipient_id', member.id);
      expect(count).toBe(0);
    });
  });

  describe('sendOverdueReminders', () => {
    it('target due exactly today is NOT overdue yet (strictly-less-than boundary)', async () => {
      freezeTime('2026-01-10T00:00:00Z');
      const { workspace, member } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_money: true, status: 'active' });
      await supabaseAdmin.from('containers').insert(container);
      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();
      await supabaseAdmin.from('contributor_targets').insert({
        container_participant_id: participant.id, container_id: container.id, workspace_member_id: member.id, cycle_id: null,
        target_amount: 50, target_currency: 'USD', due_date: '2026-01-10', is_current: true, set_by: member.id,
      });

      await runReminderScan();

      const { count } = await supabaseAdmin.from('notifications').select('*', { count: 'exact', head: true }).eq('type', 'overdue_reminder').eq('recipient_id', member.id);
      expect(count).toBe(0);
    });
  });

  describe('sendAdminOverdueSummaries', () => {
    it('groups by container — one summary per container, not per target', async () => {
      freezeTime('2026-01-15T00:00:00Z');
      const { workspace, member } = await seedTenant();
      const { member: member2 } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});

      const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_money: true, status: 'active' });
      await supabaseAdmin.from('containers').insert(container);
      const { data: p1 } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();
      const { data: p2 } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member2.id, money_enabled: true,
      }).select().single();

      // Two overdue targets in the SAME container.
      await supabaseAdmin.from('contributor_targets').insert([
        { container_participant_id: p1.id, container_id: container.id, workspace_member_id: member.id, cycle_id: null, target_amount: 50, target_currency: 'USD', due_date: '2026-01-01', is_current: true, set_by: member.id },
        { container_participant_id: p2.id, container_id: container.id, workspace_member_id: member2.id, cycle_id: null, target_amount: 50, target_currency: 'USD', due_date: '2026-01-01', is_current: true, set_by: member.id },
      ]);

      await runReminderScan();

      const { data: summaries } = await supabaseAdmin
        .from('notifications').select('*').eq('type', 'overdue_summary_admin').eq('reference_id', container.id);
      expect(summaries.length).toBe(1); // one summary, not two (per-target)
      expect(summaries[0].body).toContain('2'); // count of 2 overdue contributors
    });
  });

  describe('sendCycleClosingSoonReminders', () => {
    it('fully-paid participant (outstanding <= 0) is not notified even though the cycle is closing soon', async () => {
      freezeTime('2026-01-01T00:00:00Z');
      const { workspace, member } = await seedTenant();
      const container = buildRecurringContainer({ workspace_id: workspace.id, created_by: member.id, status: 'active' });
      await supabaseAdmin.from('containers').insert(container);
      const { data: cycle } = await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 1, cycle_start: '2025-12-01', cycle_end: '2026-01-04', status: 'open',
      }).select().single();
      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();
      await supabaseAdmin.from('contributor_targets').insert({
        container_participant_id: participant.id, container_id: container.id, workspace_member_id: member.id,
        cycle_id: cycle.id, target_amount: 100, target_currency: 'USD', is_current: true, set_by: member.id,
      });
      // Already fully paid — no reminder expected.
      await supabaseAdmin.from('ledger_entries').insert({
        workspace_id: workspace.id, container_id: container.id, cycle_id: cycle.id, entry_type: 'contribution',
        contributor_id: member.id, original_amount: 100, original_currency: 'USD', base_amount: 100,
        status: 'confirmed', recorded_by: member.id, confirmed_by: member.id, confirmed_at: new Date().toISOString(),
      });

      await runReminderScan();

      const { count } = await supabaseAdmin.from('notifications').select('*', { count: 'exact', head: true }).eq('type', 'cycle_closing_soon').eq('recipient_id', member.id);
      expect(count).toBe(0);
    });
  });

  describe('per-item failure isolation', () => {
    it('one target failing to notify does not prevent other targets in the same scan from being processed', async () => {
      freezeTime('2026-01-01T00:00:00Z');
      const { workspace, member } = await seedTenant();
      const { member: member2 } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});

      const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_money: true, status: 'active' });
      await supabaseAdmin.from('containers').insert(container);
      const { data: p1 } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();
      const { data: p2 } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member2.id, money_enabled: true,
      }).select().single();

      await supabaseAdmin.from('contributor_targets').insert([
        { container_participant_id: p1.id, container_id: container.id, workspace_member_id: member.id, cycle_id: null, target_amount: 50, target_currency: 'USD', due_date: '2026-01-08', is_current: true, set_by: member.id },
        { container_participant_id: p2.id, container_id: container.id, workspace_member_id: member2.id, cycle_id: null, target_amount: 50, target_currency: 'USD', due_date: '2026-01-08', is_current: true, set_by: member.id },
      ]);

      // Force the FIRST notification.send() call to reject (simulating a
      // mid-loop failure); reminder.service.js wraps each send() in its
      // own try/catch specifically so this doesn't abort the whole scan.
      const notification = require('../../../src/services/notification.service');
      const realSend = notification.send;
      let callCount = 0;
      const sendSpy = jest.spyOn(notification, 'send').mockImplementation((...args) => {
        callCount += 1;
        if (callCount === 1) return Promise.reject(new Error('simulated notification failure'));
        return realSend(...args);
      });

      await expect(runReminderScan()).resolves.not.toThrow();
      expect(callCount).toBeGreaterThanOrEqual(2); // both targets were attempted

      sendSpy.mockRestore();
    });
  });
});
