// tests/integration/workers/engagement_check.test.js
//
// Doc 3 Section 5.6 — engagement_check.service.js (runEngagementCheck).

const request = require('supertest');
const { runEngagementCheck } = require('../../../src/services/engagement_check.service');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getTestApp } = require('../../helpers/testApp');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildContainer } = require('../../fixtures/factories');

describe('engagement_check.service.js — runEngagementCheck', () => {
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  async function seedTenant() {
    const { workspace, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    return { workspace, member };
  }

  it('proxy members are entirely excluded from the check', async () => {
    const { workspace } = await seedTenant();
    const { member: proxy } = await seedAdditionalMember(supabaseAdmin, workspace.id, {
      member: { is_proxy: true, user_id: null, invite_status: null, last_active_at: null },
    });

    await runEngagementCheck();

    const { data: row } = await supabaseAdmin.from('workspace_members').select('last_active_at').eq('id', proxy.id).single();
    expect(row.last_active_at).toBeNull(); // never touched
  });

  it('last_active_at is only updated when the newly-computed latest is STRICTLY GREATER than the current stored value', async () => {
    const { workspace, member } = await seedTenant();
    const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_money: true });
    await supabaseAdmin.from('containers').insert(container);
    await supabaseAdmin.from('container_participants').insert({ container_id: container.id, workspace_member_id: member.id, money_enabled: true });

    // A confirmed ledger entry from the PAST.
    const pastConfirmedAt = '2025-01-01T00:00:00Z';
    await supabaseAdmin.from('ledger_entries').insert({
      workspace_id: workspace.id, container_id: container.id, entry_type: 'contribution',
      contributor_id: member.id, original_amount: 10, original_currency: 'USD', base_amount: 10,
      status: 'confirmed', recorded_by: member.id, confirmed_by: member.id, confirmed_at: pastConfirmedAt,
    });

    // But the member's own stored last_active_at is ALREADY more recent
    // than that ledger activity.
    const alreadyRecentTimestamp = '2026-06-01T00:00:00Z';
    await supabaseAdmin.from('workspace_members').update({ last_active_at: alreadyRecentTimestamp }).eq('id', member.id);

    await runEngagementCheck();

    const { data: row } = await supabaseAdmin.from('workspace_members').select('last_active_at').eq('id', member.id).single();
    // Must NOT have been overwritten with the OLDER ledger activity date.
    expect(new Date(row.last_active_at).toISOString()).toBe(new Date(alreadyRecentTimestamp).toISOString());
  });

  it('a member whose stored value is null gets updated to the latest found activity', async () => {
    const { workspace, member } = await seedTenant();
    const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_tasks: true });
    await supabaseAdmin.from('containers').insert(container);
    const completedAt = '2026-03-01T00:00:00Z';
    await supabaseAdmin.from('container_tasks').insert({
      container_id: container.id, title: 'Completed task', status: 'completed', completed_at: completedAt,
      assigned_to: member.id, created_by: member.id,
    });
    await supabaseAdmin.from('workspace_members').update({ last_active_at: null }).eq('id', member.id);

    await runEngagementCheck();

    const { data: row } = await supabaseAdmin.from('workspace_members').select('last_active_at').eq('id', member.id).single();
    expect(row.last_active_at).not.toBeNull();
  });

  it('cross-reference: the /engagement endpoint and this worker produce identical engagement_level classifications for the same data', async () => {
    const { workspace, member } = await seedTenant();

    const { data: userRow } = await supabaseAdmin.from('users').select('id, email').eq('id', member.user_id).single();
    const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: userRow.id, email: userRow.email });

    await runEngagementCheck();

    const app = getTestApp();
    const res = await request(app)
      .get(`/v1/workspaces/${workspace.id}/members/engagement`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const memberRow = res.body.data.members.find((m) => m.member_id === member.id);
    expect(['active', 'quiet', 'inactive']).toContain(memberRow.engagement_level);
  });
});
