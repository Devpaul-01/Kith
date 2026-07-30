// tests/integration/routes/group.routes.test.js
//
// Doc 3 Section 3.5 — group.routes.js (mounted
// /v1/workspaces/:workspaceId/groups) and workspace-invites.routes.js
// (mounted /v1/workspaces/:workspaceId/invites, distinct from the legacy
// top-level /v1/invites covered in public.routes.test.js).

const request = require('supertest');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');

describe('group.routes.js + workspace-invites.routes.js', () => {
  const app = getTestApp();
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  async function seedTenant() {
    const { workspace, user, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
    return { workspace, adminMember: member, adminAuthHeader: authHeader };
  }

  async function seedNonAdmin(workspaceId) {
    const { user, member } = await seedAdditionalMember(supabaseAdmin, workspaceId, { member: { role: 'member' } });
    const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
    return { user, member, authHeader };
  }

  // ── POST /groups ────────────────────────────────────────────────
  describe('POST /v1/workspaces/:workspaceId/groups', () => {
    it('initial member_ids with one invalid/foreign ID is silently skipped; valid ones are added', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();
      const { member: validMember } = await seedNonAdmin(workspace.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/groups`)
        .set('Authorization', adminAuthHeader)
        .send({ name: 'The Cousins', member_ids: [validMember.id, require('crypto').randomUUID()] });

      expect(res.status).toBe(201);

      const { data: groupMembers } = await supabaseAdmin
        .from('group_members').select('*').eq('group_id', res.body.data.group.id);
      expect(groupMembers.length).toBe(1);
      expect(groupMembers[0].workspace_member_id).toBe(validMember.id);
    });

    it('non-admin caller is rejected with 403', async () => {
      const { workspace } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/groups`)
        .set('Authorization', authHeader)
        .send({ name: 'Should not be allowed' });

      expect(res.status).toBe(403);
    });
  });

  // ── POST /groups/:id/members ───────────────────────────────────
  describe('POST /v1/workspaces/:workspaceId/groups/:groupId/members', () => {
    it('re-adding an already-present member is counted in already_in_group, no duplicate row', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member } = await seedNonAdmin(workspace.id);

      const { data: group } = await supabaseAdmin.from('groups').insert({
        workspace_id: workspace.id, name: 'Re-add Test Group', created_by: adminMember.id,
      }).select().single();
      await supabaseAdmin.from('group_members').insert({ group_id: group.id, workspace_member_id: member.id, added_by: adminMember.id });

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/groups/${group.id}/members`)
        .set('Authorization', adminAuthHeader)
        .send({ member_ids: [member.id] });

      expect(res.status).toBe(200);
      expect(res.body.data.added_count).toBe(0);
      expect(res.body.data.already_in_group).toBe(1);

      const { count } = await supabaseAdmin
        .from('group_members').select('*', { count: 'exact', head: true }).eq('group_id', group.id).eq('workspace_member_id', member.id);
      expect(count).toBe(1); // no duplicate row
    });
  });

  // ── DELETE /groups/:id/members/:memberId ───────────────────────
  describe('DELETE /v1/workspaces/:workspaceId/groups/:groupId/members/:memberId', () => {
    it('removing a non-member returns 200 with no audit log call (count === 0)', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: neverAdded } = await seedNonAdmin(workspace.id);

      const { data: group } = await supabaseAdmin.from('groups').insert({
        workspace_id: workspace.id, name: 'Empty Group', created_by: adminMember.id,
      }).select().single();

      const { count: auditCountBefore } = await supabaseAdmin
        .from('audit_log').select('*', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('action', 'group.member_removed');

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/groups/${group.id}/members/${neverAdded.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);

      const { count: auditCountAfter } = await supabaseAdmin
        .from('audit_log').select('*', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('action', 'group.member_removed');
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  // ── DELETE /groups/:groupId ─────────────────────────────────────
  describe('DELETE /v1/workspaces/:workspaceId/groups/:groupId', () => {
    it('non-admin caller is rejected with 403', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id);
      const { data: group } = await supabaseAdmin.from('groups').insert({
        workspace_id: workspace.id, name: 'Protected Group', created_by: adminMember.id,
      }).select().single();

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/groups/${group.id}`)
        .set('Authorization', authHeader);
      expect(res.status).toBe(403);
    });

    it('non-existent group returns 404', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/groups/${require('crypto').randomUUID()}`)
        .set('Authorization', adminAuthHeader);
      expect(res.status).toBe(404);
    });
  });

  // ── workspace-invites.routes.js ─────────────────────────────────
  describe('POST /v1/workspaces/:workspaceId/invites', () => {
    it('generates a token + 7-day expiry', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();

      const before = Date.now();
      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/invites`)
        .set('Authorization', adminAuthHeader)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.invite_url).toContain(res.body.data.token);

      const expiresAt = new Date(res.body.data.expires_at).getTime();
      const expectedMin = before + 6.9 * 24 * 60 * 60 * 1000;
      const expectedMax = before + 7.1 * 24 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThan(expectedMin);
      expect(expiresAt).toBeLessThan(expectedMax);
    });

    it('non-admin caller is rejected with 403', async () => {
      const { workspace } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/invites`)
        .set('Authorization', authHeader)
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /v1/workspaces/:workspaceId/invites/:inviteId', () => {
    it('already-used/non-existent invite returns NotFoundError', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/invites/${require('crypto').randomUUID()}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(404);
    });

    it('a valid unused invite is revoked successfully', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();

      const createRes = await request(app)
        .post(`/v1/workspaces/${workspace.id}/invites`)
        .set('Authorization', adminAuthHeader)
        .send({});

      const { data: inviteRow } = await supabaseAdmin
        .from('invite_links').select('id').eq('token', createRes.body.data.token).single();

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/invites/${inviteRow.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
    });
  });

  describe('GET /v1/workspaces/:workspaceId/invites', () => {
    it('non-admin caller is rejected with 403', async () => {
      const { workspace } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id);

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/invites`)
        .set('Authorization', authHeader);
      expect(res.status).toBe(403);
    });

    it('admin lists created invites with created_by_name resolved', async () => {
      const { workspace, adminAuthHeader, adminMember } = await seedTenant();

      await request(app).post(`/v1/workspaces/${workspace.id}/invites`).set('Authorization', adminAuthHeader).send({});

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/invites`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.invites.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.invites[0].created_by_name).toBe(adminMember.display_name);
    });
  });
});
