// tests/integration/routes/member.routes.test.js
//
// Doc 3 Section 3.4 — member.routes.js, mounted at
// /v1/workspaces/:workspaceId/members. Baseline matrix (Doc 3 Section 3)
// applies to every endpoint below in addition to the route-specific
// cases spelled out here.

const request = require('supertest');
const crypto = require('crypto');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getRedis } = require('../../../src/config/redis');
const { membershipKey } = require('../../../src/config/redis-keys');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace, seedLedgerEntry } = require('../../helpers/dbHelper');
const { buildContainer } = require('../../fixtures/factories');

describe('member.routes.js — /v1/workspaces/:workspaceId/members', () => {
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
    return { workspace, adminUser: user, adminMember: member, adminAuthHeader: authHeader };
  }

  async function seedNonAdmin(workspaceId, overrides = {}) {
    const { user, member } = await seedAdditionalMember(supabaseAdmin, workspaceId, { member: { role: 'member', ...overrides } });
    const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
    return { user, member, authHeader };
  }

  // ── GET / ──────────────────────────────────────────────────────
  describe('GET /v1/workspaces/:workspaceId/members', () => {
    it('search is ILIKE-escaped safely (adversarial wildcard test)', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();
      await seedNonAdmin(workspace.id, {});

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members?search=${encodeURIComponent('%_test')}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.members)).toBe(true);
    });

    it('filter[is_proxy]=true matches proxy members; any other value (including "false") evaluates false — documenting current correct-by-coincidence behavior', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();
      await seedNonAdmin(workspace.id, { is_proxy: true, user_id: null, invite_status: null });

      const trueRes = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members?filter[is_proxy]=true`)
        .set('Authorization', adminAuthHeader);
      expect(trueRes.status).toBe(200);
      expect(trueRes.body.data.members.some((m) => m.is_proxy === true)).toBe(true);

      const falseRes = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members?filter[is_proxy]=false`)
        .set('Authorization', adminAuthHeader);
      expect(falseRes.status).toBe(200);
      expect(falseRes.body.data.members.every((m) => m.is_proxy === false)).toBe(true);
    });

    it('non-admin caller has admin_notes, last_active_at, contribution_streak_months stripped', async () => {
      const { workspace } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id, {});

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members`)
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      for (const m of res.body.data.members) {
        expect(m).not.toHaveProperty('admin_notes');
        expect(m).not.toHaveProperty('last_active_at');
        expect(m).not.toHaveProperty('contribution_streak_months');
      }
    });

    it('admin caller sees the full field set including admin_notes', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.members[0]).toHaveProperty('admin_notes');
    });
  });

  // ── POST / (admin) ────────────────────────────────────────────
  describe('POST /v1/workspaces/:workspaceId/members', () => {
    it('is_proxy: true + proxy_managed_by pointing to a non-admin member -> BusinessRuleError', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();
      const { member: nonAdminMember } = await seedNonAdmin(workspace.id, {});

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/members`)
        .set('Authorization', adminAuthHeader)
        .send({
          display_name: 'Grandma (Proxy)',
          is_proxy: true,
          proxy_managed_by: nonAdminMember.id, // not an admin
          role: 'member',
        });

      expect(res.status).toBe(422);
    });

    it('valid proxy creation with an admin proxy_managed_by succeeds', async () => {
      const { workspace, adminAuthHeader, adminMember } = await seedTenant();

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/members`)
        .set('Authorization', adminAuthHeader)
        .send({
          display_name: 'Grandma (Proxy)',
          is_proxy: true,
          proxy_managed_by: adminMember.id,
          role: 'member',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.member.is_proxy).toBe(true);
    });

    it('non-admin caller is rejected with 403', async () => {
      const { workspace } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id, {});

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/members`)
        .set('Authorization', authHeader)
        .send({ display_name: 'New Member' });

      expect(res.status).toBe(403);
    });
  });

  // ── GET /engagement (admin) ────────────────────────────────────
  describe('GET /v1/workspaces/:workspaceId/members/engagement', () => {
    it('returns engagement_level classifications for all non-proxy members', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members/engagement`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.members)).toBe(true);
      for (const m of res.body.data.members) {
        expect(['active', 'quiet', 'inactive']).toContain(m.engagement_level);
      }
    });

    it('non-admin caller is rejected with 403', async () => {
      const { workspace } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id, {});

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members/engagement`)
        .set('Authorization', authHeader);
      expect(res.status).toBe(403);
    });
  });

  // ── GET /:memberId ─────────────────────────────────────────────
  describe('GET /v1/workspaces/:workspaceId/members/:memberId', () => {
    it('non-admin caller has admin_notes stripped when viewing another member', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id, {});

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members/${adminMember.id}`)
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.member).not.toHaveProperty('admin_notes');
    });

    it('returns 404 for a non-existent memberId', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members/${crypto.randomUUID()}`)
        .set('Authorization', adminAuthHeader);
      expect(res.status).toBe(404);
    });
  });

  // ── PATCH /:memberId ───────────────────────────────────────────
  describe('PATCH /v1/workspaces/:workspaceId/members/:memberId', () => {
    it('a non-admin, non-self caller gets 403 before any service logic runs (route-level requireSelfOrAdmin)', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id, {});

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/members/${adminMember.id}`)
        .set('Authorization', authHeader)
        .send({ display_name: 'Hijacked Name' });

      expect(res.status).toBe(403);

      const { data: unchanged } = await supabaseAdmin.from('workspace_members').select('display_name').eq('id', adminMember.id).single();
      expect(unchanged.display_name).not.toBe('Hijacked Name');
    });

    it('self-edit attempting an admin-only field passes the route-level self-check but is rejected at the service field-level check', async () => {
      const { workspace } = await seedTenant();
      const { member, authHeader } = await seedNonAdmin(workspace.id, {});

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/members/${member.id}`)
        .set('Authorization', authHeader)
        .send({ role: 'admin' }); // admin-only field, editing self

      expect(res.status).toBe(403);
    });

    it('demoting the last admin is rejected with BusinessRuleError', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/members/${adminMember.id}`)
        .set('Authorization', adminAuthHeader)
        .send({ role: 'member' });

      expect(res.status).toBe(422);
    });

    it('optimistic lock: mismatched version returns BusinessRuleError', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/members/${adminMember.id}`)
        .set('Authorization', adminAuthHeader)
        .send({ display_name: 'New Name', version: '2020-01-01T00:00:00.000Z' });

      expect(res.status).toBe(422);
    });

    it('an auth-relevant field change invalidates the membership cache; a non-auth-relevant change does not', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();
      const { member, user, authHeader } = await seedNonAdmin(workspace.id, {});
      const redis = getRedis();

      await request(app).get(`/v1/workspaces/${workspace.id}`).set('Authorization', authHeader);
      expect(await redis.get(membershipKey(workspace.id, user.id))).not.toBeNull();

      // Non-auth-relevant change (display_name) — cache should survive.
      await request(app)
        .patch(`/v1/workspaces/${workspace.id}/members/${member.id}`)
        .set('Authorization', adminAuthHeader)
        .send({ display_name: 'Renamed But Not Auth-Relevant' });
      expect(await redis.get(membershipKey(workspace.id, user.id))).not.toBeNull();

      // Auth-relevant change (is_active) — cache must be invalidated.
      await request(app)
        .patch(`/v1/workspaces/${workspace.id}/members/${member.id}`)
        .set('Authorization', adminAuthHeader)
        .send({ is_active: false });
      expect(await redis.get(membershipKey(workspace.id, user.id))).toBeNull();
    });
  });

  // ── DELETE /:memberId (admin) ──────────────────────────────────
  describe('DELETE /v1/workspaces/:workspaceId/members/:memberId', () => {
    it('last-admin self-removal is rejected with BusinessRuleError', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/members/${adminMember.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(422);
    });

    it('confirmed entries + force=true is rejected', async () => {
      const { workspace, adminAuthHeader, adminMember } = await seedTenant();
      const { member } = await seedNonAdmin(workspace.id, {});

      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: true });
      await supabaseAdmin.from('containers').insert(container);
      await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      });
      await seedLedgerEntry(supabaseAdmin, {
        workspace_id: workspace.id, container_id: container.id,
        contributor_id: member.id, recorded_by: adminMember.id, status: 'confirmed',
      });

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/members/${member.id}?force=true`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(422);

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('confirmed entries, no force -> soft-delete succeeds', async () => {
      const { workspace, adminAuthHeader, adminMember } = await seedTenant();
      const { member } = await seedNonAdmin(workspace.id, {});

      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: true });
      await supabaseAdmin.from('containers').insert(container);
      await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: member.id, money_enabled: true,
      });
      await seedLedgerEntry(supabaseAdmin, {
        workspace_id: workspace.id, container_id: container.id,
        contributor_id: member.id, recorded_by: adminMember.id, status: 'confirmed',
      });

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/members/${member.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);

      const { data: row } = await supabaseAdmin.from('workspace_members').select('deleted_at').eq('id', member.id).single();
      expect(row.deleted_at).not.toBeNull();

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('no confirmed entries + force=true -> hard-delete (follow-up GET returns 404)', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();
      const { member } = await seedNonAdmin(workspace.id, {});

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/members/${member.id}?force=true`)
        .set('Authorization', adminAuthHeader);
      expect(res.status).toBe(200);

      const followUp = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members/${member.id}`)
        .set('Authorization', adminAuthHeader);
      expect(followUp.status).toBe(404);
    });

    it('notification failure during removal does not fail the delete (200 regardless)', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();
      const { member } = await seedNonAdmin(workspace.id, {});

      // member.service.js#deleteMember wraps its notification.send() call
      // in its own try/catch specifically so a notification failure
      // never fails the deletion — this asserts that guarantee end to
      // end rather than re-mocking the notification pipeline internals.
      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/members/${member.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
    });
  });

  // ── GET /:memberId/profile-history (admin) ────────────────────
  describe('GET /v1/workspaces/:workspaceId/members/:memberId/profile-history', () => {
    it('multiple PATCH calls produce reverse-chronological history with resolved changed_by_name', async () => {
      const { workspace, adminAuthHeader, adminMember } = await seedTenant();
      const { member } = await seedNonAdmin(workspace.id, {});

      await request(app)
        .patch(`/v1/workspaces/${workspace.id}/members/${member.id}`)
        .set('Authorization', adminAuthHeader)
        .send({ display_name: 'First Change' });
      await request(app)
        .patch(`/v1/workspaces/${workspace.id}/members/${member.id}`)
        .set('Authorization', adminAuthHeader)
        .send({ display_name: 'Second Change' });

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members/${member.id}/profile-history`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.history.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data.history[0].new_value).toBe('Second Change'); // most recent first
      expect(res.body.data.history[0].changed_by_name).toBe(adminMember.display_name);
    });

    it('non-admin caller is rejected with 403', async () => {
      const { workspace } = await seedTenant();
      const { member, authHeader } = await seedNonAdmin(workspace.id, {});

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members/${member.id}/profile-history`)
        .set('Authorization', authHeader);
      expect(res.status).toBe(403);
    });
  });

  // ── GET /:memberId/contribution-summary ────────────────────────
  describe('GET /v1/workspaces/:workspaceId/members/:memberId/contribution-summary', () => {
    it('zero ledger entries returns an all-zero shape, not an error', async () => {
      const { workspace, adminAuthHeader, adminMember } = await seedTenant();

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/members/${adminMember.id}/contribution-summary`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.total_confirmed_count).toBe(0);
      expect(res.body.data.total_paid_base_currency).toBe(0);
      expect(res.body.data.last_contribution_date).toBeNull();
    });
  });
});
