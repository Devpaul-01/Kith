// tests/integration/workers/invite_cleanup.test.js
//
// Doc 3 Section 5.5 — invite_cleanup.service.js (runInviteCleanup).

const { runInviteCleanup } = require('../../../src/services/invite_cleanup.service');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { seedWorkspaceWithAdmin, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildInviteLink, buildExpiredInviteLink, buildUsedInviteLink } = require('../../fixtures/factories');

describe('invite_cleanup.service.js — runInviteCleanup', () => {
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

  it('expired + unused invites are deleted', async () => {
    const { workspace, member } = await seedTenant();
    const invite = buildExpiredInviteLink({ workspace_id: workspace.id, created_by: member.id });
    await supabaseAdmin.from('invite_links').insert(invite);

    await runInviteCleanup();

    const { data } = await supabaseAdmin.from('invite_links').select('id').eq('id', invite.id).maybeSingle();
    expect(data).toBeNull();
  });

  it('expired + USED invites are NOT deleted (kept as historical record)', async () => {
    const { workspace, member } = await seedTenant();
    // Both expired AND used — the cleanup query filters on
    // .is('used_at', null), so a used invite must survive even though
    // it's also expired.
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const invite = buildInviteLink({
      workspace_id: workspace.id, created_by: member.id,
      expires_at: past, used_at: past, used_by_user_id: member.user_id || null,
    });
    await supabaseAdmin.from('invite_links').insert(invite);

    await runInviteCleanup();

    const { data } = await supabaseAdmin.from('invite_links').select('id').eq('id', invite.id).maybeSingle();
    expect(data).not.toBeNull(); // survives cleanup
  });

  it('non-expired invites are untouched regardless of used status', async () => {
    const { workspace, member } = await seedTenant();
    const activeUnused = buildInviteLink({ workspace_id: workspace.id, created_by: member.id });
    const activeUsed = buildUsedInviteLink({ workspace_id: workspace.id, created_by: member.id });
    await supabaseAdmin.from('invite_links').insert([activeUnused, activeUsed]);

    await runInviteCleanup();

    const { data } = await supabaseAdmin.from('invite_links').select('id').in('id', [activeUnused.id, activeUsed.id]);
    expect(data.length).toBe(2);
  });
});
