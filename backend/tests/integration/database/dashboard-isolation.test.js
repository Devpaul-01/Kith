// Requires the real Postgres/PostgREST/Redis test stack. Fluent query mocks
// cannot verify that embedded-relation filters exclude top-level rows.
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getDashboardData, getOverdueSummaryData } = require('../../../src/services/dashboard.service');
const { invalidateDashboard } = require('../../../src/services/dashboard-cache.service');
const {
  seedWorkspaceWithAdmin, seedAdditionalMember, seedContainerWithParticipants,
  seedLedgerEntry, cleanupWorkspace,
} = require('../../helpers/dbHelper');
const { buildContributorTarget } = require('../../fixtures/factories');

describe('dashboard workspace isolation with PostgREST', () => {
  const workspaceIds = [];

  async function seedWorkspace(name) {
    const tenant = await seedWorkspaceWithAdmin(supabaseAdmin, {
      workspace: { name, base_currency: 'USD' },
      member: { display_name: `${name} admin` },
    });
    workspaceIds.push(tenant.workspace.id);
    return tenant;
  }

  async function seedTarget(tenant, {
    name, amount = 100, dueDate, containerOverrides = {}, participantOverrides = {},
  }) {
    const { container, participants } = await seedContainerWithParticipants(supabaseAdmin, {
      workspaceId: tenant.workspace.id,
      createdBy: tenant.member.id,
      containerOverrides: { name, ...containerOverrides },
      participants: [{ workspace_member_id: tenant.member.id, ...participantOverrides }],
    });
    const { error } = await supabaseAdmin.from('contributor_targets').insert(buildContributorTarget({
      container_participant_id: participants[0].id,
      container_id: container.id,
      workspace_member_id: tenant.member.id,
      set_by: tenant.member.id,
      target_amount: amount,
      due_date: dueDate,
    }));
    if (error) throw error;
    return container;
  }

  afterEach(async () => {
    while (workspaceIds.length) {
      const workspaceId = workspaceIds.pop();
      await invalidateDashboard(workspaceId);
      await cleanupWorkspace(supabaseAdmin, workspaceId);
    }
  });

  it.each([false, true])('returns only this workspace\'s upcoming deadlines (isAdmin=%s)', async (isAdmin) => {
    const first = await seedWorkspace('First family');
    const second = await seedWorkspace('Second family');
    const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
    await seedTarget(first, { name: 'First rent', dueDate });
    await seedTarget(second, { name: 'Private second rent', amount: 700, dueDate });
    await seedTarget(first, {
      name: 'Deleted first rent', dueDate,
      containerOverrides: { deleted_at: new Date().toISOString() },
    });
    const viewer = isAdmin
      ? first.member
      : (await seedAdditionalMember(supabaseAdmin, first.workspace.id)).member;

    const result = await getDashboardData({ workspaceId: first.workspace.id, isAdmin, memberId: viewer.id });

    expect(result.upcoming_deadlines).toEqual([expect.objectContaining({
      member_name: first.member.display_name,
      container_name: 'First rent',
      title: '100 USD',
      due_date: dueDate,
    })]);
    if (!isAdmin) expect(result.pending_confirmations).toEqual([]);

    const other = await getDashboardData({ workspaceId: second.workspace.id, isAdmin: true, memberId: second.member.id });
    expect(other.upcoming_deadlines).toEqual([expect.objectContaining({
      member_name: second.member.display_name, container_name: 'Private second rent', title: '700 USD',
    })]);
  });

  it('returns only eligible overdue participants in this workspace and preserves payment deductions', async () => {
    const first = await seedWorkspace('First family');
    const second = await seedWorkspace('Second family');
    const dueDate = '2020-01-01';
    const container = await seedTarget(first, { name: 'First rent', dueDate });
    await seedTarget(second, { name: 'Private second rent', amount: 700, dueDate });
    await seedTarget(first, { name: 'Archived rent', dueDate, containerOverrides: { status: 'archived' } });
    await seedTarget(first, { name: 'Disabled rent', dueDate, containerOverrides: { enable_money: false } });
    await seedTarget(first, { name: 'Disabled participant', dueDate, participantOverrides: { money_enabled: false } });
    await seedTarget(first, {
      name: 'Deleted rent', dueDate, containerOverrides: { deleted_at: new Date().toISOString() },
    });
    await seedLedgerEntry(supabaseAdmin, {
      workspace_id: first.workspace.id,
      container_id: container.id,
      contributor_id: first.member.id,
      recorded_by: first.member.id,
      original_amount: 40,
      base_amount: 40,
      status: 'confirmed',
      confirmed_by: first.member.id,
      confirmed_at: new Date().toISOString(),
    });

    const result = await getOverdueSummaryData({ workspaceId: first.workspace.id });

    expect(result).toEqual({
      overdue_count: 1,
      overdue: [{
        member_id: first.member.id,
        display_name: first.member.display_name,
        total_outstanding: 60,
        containers: [{
          container_id: container.id, container_name: 'First rent', outstanding: 60,
          currency: 'USD', due_date: dueDate,
        }],
      }],
    });
    const other = await getOverdueSummaryData({ workspaceId: second.workspace.id });
    expect(other.overdue).toEqual([expect.objectContaining({ member_id: second.member.id, total_outstanding: 700 })]);
  });

  it('returns empty summaries for a workspace with no targets even when another workspace has targets', async () => {
    const empty = await seedWorkspace('Empty family');
    const other = await seedWorkspace('Other family');
    await seedTarget(other, { name: 'Other overdue rent', dueDate: '2020-01-01' });
    await seedTarget(other, {
      name: 'Other upcoming rent', dueDate: new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0],
    });

    const dashboard = await getDashboardData({ workspaceId: empty.workspace.id, isAdmin: true, memberId: empty.member.id });
    expect(dashboard.upcoming_deadlines).toEqual([]);
    expect(await getOverdueSummaryData({ workspaceId: empty.workspace.id })).toEqual({ overdue_count: 0, overdue: [] });
  });
});
