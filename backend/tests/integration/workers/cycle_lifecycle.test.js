// tests/integration/workers/cycle_lifecycle.test.js
//
// Doc 3 Section 5.3 — cycle_lifecycle.service.js (runCycleLifecycle).
// Business logic exercised directly against the real Postgres/Redis
// stack per Doc 3 Section 5's recommendation (a); Firebase/Resend are
// mocked per Doc 3 Section 1's "mock external SaaS always" rule (see
// tests/setup.integration.js).

const { runCycleLifecycle } = require('../../../src/services/cycle_lifecycle.service');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getQueue } = require('../../../src/queues');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildRecurringContainer } = require('../../fixtures/factories');
const { freezeTime, unfreezeTime } = require('../../helpers/timeHelper');

describe('cycle_lifecycle.service.js — runCycleLifecycle', () => {
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  afterEach(() => unfreezeTime());

  async function seedContainer(overrides = {}) {
    const { workspace, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    const container = buildRecurringContainer({ workspace_id: workspace.id, created_by: member.id, status: 'active', ...overrides });
    await supabaseAdmin.from('containers').insert(container);
    return { workspace, member, container };
  }

  describe('openDueCycles', () => {
    it('upcoming cycles with cycle_start <= today are opened, each participant notified with THEIR OWN target amount', async () => {
      freezeTime('2026-02-01T00:00:00Z');
      const { container, member: admin } = await seedContainer();
      const { member: participant2 } = await seedAdditionalMember(supabaseAdmin, container.workspace_id, {});

      const { data: cycle } = await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 1, cycle_start: '2026-01-25', cycle_end: '2026-02-24', status: 'upcoming',
      }).select().single();

      const { data: p1 } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: admin.id, money_enabled: true,
      }).select().single();
      const { data: p2 } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: participant2.id, money_enabled: true,
      }).select().single();

      // Two DIFFERENT target amounts — this is the documented fix
      // (each participant gets their own amount, not participant #1's).
      await supabaseAdmin.from('contributor_targets').insert([
        { container_participant_id: p1.id, container_id: container.id, workspace_member_id: admin.id, cycle_id: cycle.id, target_amount: 100, target_currency: 'USD', is_current: true, set_by: admin.id },
        { container_participant_id: p2.id, container_id: container.id, workspace_member_id: participant2.id, cycle_id: cycle.id, target_amount: 250, target_currency: 'USD', is_current: true, set_by: admin.id },
      ]);

      await runCycleLifecycle();

      const { data: updatedCycle } = await supabaseAdmin.from('container_cycles').select('status').eq('id', cycle.id).single();
      expect(updatedCycle.status).toBe('open');

      const { data: notifs } = await supabaseAdmin
        .from('notifications').select('*').eq('type', 'cycle_started').in('recipient_id', [admin.id, participant2.id]);

      const adminNotif = notifs.find((n) => n.recipient_id === admin.id);
      const p2Notif = notifs.find((n) => n.recipient_id === participant2.id);
      expect(adminNotif.body).toContain('100');
      expect(p2Notif.body).toContain('250');
      expect(adminNotif.body).not.toContain('250');
    });

    it('no matching target for a participant falls back to amount: TBD', async () => {
      freezeTime('2026-02-01T00:00:00Z');
      const { container, member } = await seedContainer();
      await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 1, cycle_start: '2026-01-25', cycle_end: '2026-02-24', status: 'upcoming',
      });
      await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      });

      await runCycleLifecycle();

      const { data: notif } = await supabaseAdmin
        .from('notifications').select('*').eq('type', 'cycle_started').eq('recipient_id', member.id).single();
      expect(notif.body).toContain('TBD');
    });
  });

  describe('closeDueCycles', () => {
    it('open cycles with cycle_end < today are closed', async () => {
      freezeTime('2026-03-01T00:00:00Z');
      const { container } = await seedContainer({ carry_forward_unpaid: false });
      const { data: cycle } = await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 1, cycle_start: '2026-01-01', cycle_end: '2026-01-31', status: 'open',
      }).select().single();

      await runCycleLifecycle();

      const { data: updated } = await supabaseAdmin.from('container_cycles').select('status, closed_at').eq('id', cycle.id).single();
      expect(updated.status).toBe('closed');
      expect(updated.closed_at).not.toBeNull();
    });

    it('carry_forward_unpaid: true, outstanding balance + a next cycle exists -> carry-forward entry inserted (system-recorded, confirmed)', async () => {
      freezeTime('2026-03-01T00:00:00Z');
      const { container, member } = await seedContainer({ carry_forward_unpaid: true });

      const { data: closingCycle } = await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 1, cycle_start: '2026-01-01', cycle_end: '2026-01-31', status: 'open',
      }).select().single();
      await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 2, cycle_start: '2026-02-01', cycle_end: '2026-02-28', status: 'upcoming',
      });

      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();
      await supabaseAdmin.from('contributor_targets').insert({
        container_participant_id: participant.id, container_id: container.id, workspace_member_id: member.id,
        cycle_id: closingCycle.id, target_amount: 100, target_currency: 'USD', is_current: true, set_by: member.id,
      });
      // Only partially paid — 40 out of 100 -> 60 outstanding.
      await supabaseAdmin.from('ledger_entries').insert({
        workspace_id: container.workspace_id, container_id: container.id, cycle_id: closingCycle.id,
        entry_type: 'contribution', contributor_id: member.id, original_amount: 40, original_currency: 'USD',
        base_amount: 40, status: 'confirmed', recorded_by: member.id, confirmed_by: member.id, confirmed_at: new Date().toISOString(),
      });

      await runCycleLifecycle();

      const { data: carryForwardEntries } = await supabaseAdmin
        .from('ledger_entries').select('*').eq('entry_type', 'carry_forward').eq('contributor_id', member.id);
      expect(carryForwardEntries.length).toBe(1);
      expect(parseFloat(carryForwardEntries[0].base_amount)).toBe(60);
      expect(carryForwardEntries[0].status).toBe('confirmed');
      expect(carryForwardEntries[0].recorded_by).toBeNull();
      expect(carryForwardEntries[0].confirmed_by).toBeNull();
    });

    it('carry_forward_unpaid: true, no next cycle -> no entry created, no error', async () => {
      freezeTime('2026-03-01T00:00:00Z');
      const { container, member } = await seedContainer({ carry_forward_unpaid: true });

      const { data: closingCycle } = await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 1, cycle_start: '2026-01-01', cycle_end: '2026-01-31', status: 'open',
      }).select().single();

      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();
      await supabaseAdmin.from('contributor_targets').insert({
        container_participant_id: participant.id, container_id: container.id, workspace_member_id: member.id,
        cycle_id: closingCycle.id, target_amount: 100, target_currency: 'USD', is_current: true, set_by: member.id,
      });

      await expect(runCycleLifecycle()).resolves.not.toThrow();

      const { count } = await supabaseAdmin.from('ledger_entries').select('*', { count: 'exact', head: true }).eq('entry_type', 'carry_forward').eq('contributor_id', member.id);
      expect(count).toBe(0);
    });

    it('carry_forward_unpaid: false -> no carry-forward logic runs regardless of outstanding balance', async () => {
      freezeTime('2026-03-01T00:00:00Z');
      const { container, member } = await seedContainer({ carry_forward_unpaid: false });

      const { data: closingCycle } = await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 1, cycle_start: '2026-01-01', cycle_end: '2026-01-31', status: 'open',
      }).select().single();
      await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 2, cycle_start: '2026-02-01', cycle_end: '2026-02-28', status: 'upcoming',
      });

      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();
      await supabaseAdmin.from('contributor_targets').insert({
        container_participant_id: participant.id, container_id: container.id, workspace_member_id: member.id,
        cycle_id: closingCycle.id, target_amount: 100, target_currency: 'USD', is_current: true, set_by: member.id,
      });

      await runCycleLifecycle();

      const { count } = await supabaseAdmin.from('ledger_entries').select('*', { count: 'exact', head: true }).eq('entry_type', 'carry_forward').eq('contributor_id', member.id);
      expect(count).toBe(0);
    });

    it('fully-paid participant gets no carry-forward entry', async () => {
      freezeTime('2026-03-01T00:00:00Z');
      const { container, member } = await seedContainer({ carry_forward_unpaid: true });

      const { data: closingCycle } = await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 1, cycle_start: '2026-01-01', cycle_end: '2026-01-31', status: 'open',
      }).select().single();
      await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 2, cycle_start: '2026-02-01', cycle_end: '2026-02-28', status: 'upcoming',
      });

      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      }).select().single();
      await supabaseAdmin.from('contributor_targets').insert({
        container_participant_id: participant.id, container_id: container.id, workspace_member_id: member.id,
        cycle_id: closingCycle.id, target_amount: 100, target_currency: 'USD', is_current: true, set_by: member.id,
      });
      await supabaseAdmin.from('ledger_entries').insert({
        workspace_id: container.workspace_id, container_id: container.id, cycle_id: closingCycle.id,
        entry_type: 'contribution', contributor_id: member.id, original_amount: 100, original_currency: 'USD',
        base_amount: 100, status: 'confirmed', recorded_by: member.id, confirmed_by: member.id, confirmed_at: new Date().toISOString(),
      });

      await runCycleLifecycle();

      const { count } = await supabaseAdmin.from('ledger_entries').select('*', { count: 'exact', head: true }).eq('entry_type', 'carry_forward').eq('contributor_id', member.id);
      expect(count).toBe(0);
    });

    it('re-enqueues generate-cycles exactly once per closed cycle', async () => {
      freezeTime('2026-03-01T00:00:00Z');
      const { container } = await seedContainer();
      await supabaseAdmin.from('container_cycles').insert({
        container_id: container.id, cycle_number: 1, cycle_start: '2026-01-01', cycle_end: '2026-01-31', status: 'open',
      });

      const queue = getQueue('cycle-generation-queue');
      const addSpy = jest.spyOn(queue, 'add');

      await runCycleLifecycle();

      const generateCyclesCalls = addSpy.mock.calls.filter(([jobName]) => jobName === 'generate-cycles');
      expect(generateCyclesCalls.length).toBe(1);

      addSpy.mockRestore();
    });
  });
});
