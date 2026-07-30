// tests/integration/routes/public.routes.test.js
//
// Doc 3 Section 3.2 — public.routes.js (mounted /v1/public) and the
// legacy invite.routes.js (mounted /v1/invites). NO requireMembership on
// any of these — the baseline matrix's "not a member" case does not
// apply, per Doc 3's own note.

const request = require('supertest');
const crypto = require('crypto');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, cleanupWorkspace, seedAdditionalMember } = require('../../helpers/dbHelper');
const { buildInviteLink, buildExpiredInviteLink, buildUsedInviteLink, buildContainer } = require('../../fixtures/factories');

describe('public.routes.js — /v1/public, invite.routes.js — /v1/invites (legacy)', () => {
  const app = getTestApp();
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  async function seedWorkspace() {
    const { workspace, user, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    return { workspace, user, member };
  }

  // ── GET /invites/:token (public preview) ──────────────────────
  describe('GET /v1/public/invites/:token', () => {
    it('valid, unexpired, unused invite returns is_valid: true with workspace/container preview, status 200', async () => {
      const { workspace, member } = await seedWorkspace();
      const invite = buildInviteLink({ workspace_id: workspace.id, created_by: member.id });
      await supabaseAdmin.from('invite_links').insert(invite);

      const res = await request(app).get(`/v1/public/invites/${invite.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.is_valid).toBe(true);
      expect(res.body.data.workspace_name).toBe(workspace.name);
    });

    it('expired invite returns is_valid: false with status 200 (anti-enumeration — NOT 410)', async () => {
      const { workspace, member } = await seedWorkspace();
      const invite = buildExpiredInviteLink({ workspace_id: workspace.id, created_by: member.id });
      await supabaseAdmin.from('invite_links').insert(invite);

      const res = await request(app).get(`/v1/public/invites/${invite.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.is_valid).toBe(false);
    });

    it('already-used invite returns is_valid: false with status 200', async () => {
      const { workspace, member } = await seedWorkspace();
      const invite = buildUsedInviteLink({ workspace_id: workspace.id, created_by: member.id });
      await supabaseAdmin.from('invite_links').insert(invite);

      const res = await request(app).get(`/v1/public/invites/${invite.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.is_valid).toBe(false);
    });

    it('non-existent token returns is_valid: false with status 200 (identical shape to expired/used — Issue L3)', async () => {
      const res = await request(app).get('/v1/public/invites/this-token-does-not-exist-anywhere');

      expect(res.status).toBe(200);
      expect(res.body.data.is_valid).toBe(false);
      expect(res.body.data).toEqual(
        expect.objectContaining({ is_valid: false, error: expect.any(String) })
      );
    });

    it('all four failure shapes (not-found/expired/used) share the identical top-level key set — locking in the anti-enumeration design', async () => {
      const { workspace, member } = await seedWorkspace();
      const expired = buildExpiredInviteLink({ workspace_id: workspace.id, created_by: member.id });
      const used = buildUsedInviteLink({ workspace_id: workspace.id, created_by: member.id });
      await supabaseAdmin.from('invite_links').insert([expired, used]);

      const [notFoundRes, expiredRes, usedRes] = await Promise.all([
        request(app).get('/v1/public/invites/absolutely-does-not-exist'),
        request(app).get(`/v1/public/invites/${expired.token}`),
        request(app).get(`/v1/public/invites/${used.token}`),
      ]);

      const keysOf = (body) => Object.keys(body.data).sort();
      expect(keysOf(notFoundRes.body)).toEqual(keysOf(expiredRes.body));
      expect(keysOf(expiredRes.body)).toEqual(keysOf(usedRes.body));
      expect([notFoundRes.status, expiredRes.status, usedRes.status]).toEqual([200, 200, 200]);
    });
  });

  // ── POST /invites/:token/accept ────────────────────────────────
  describe('POST /v1/public/invites/:token/accept', () => {
    it('requires auth — no Authorization header returns 401', async () => {
      const { workspace, member } = await seedWorkspace();
      const invite = buildInviteLink({ workspace_id: workspace.id, created_by: member.id });
      await supabaseAdmin.from('invite_links').insert(invite);

      const res = await request(app).post(`/v1/public/invites/${invite.token}/accept`);
      expect(res.status).toBe(401);
    });

    it('an already-a-member caller gets ConflictError', async () => {
      const { workspace, member } = await seedWorkspace();
      const invite = buildInviteLink({ workspace_id: workspace.id, created_by: member.id });
      await supabaseAdmin.from('invite_links').insert(invite);

      // The seeded workspace's own admin (created by seedWorkspaceWithAdmin)
      // is already a member of `workspace` — attempting to accept an
      // invite to a workspace they're already in must be rejected.
      const { data: existingMemberRow } = await supabaseAdmin
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspace.id)
        .eq('role', 'admin')
        .single();
      const { data: existingUserRow } = await supabaseAdmin
        .from('users')
        .select('id, email')
        .eq('id', existingMemberRow.user_id)
        .single();

      const { authHeader: adminAuthHeader } = mockAuthenticatedRequest({
        supabaseAdmin,
        userId: existingUserRow.id,
        email: existingUserRow.email,
      });

      const res = await request(app)
        .post(`/v1/public/invites/${invite.token}/accept`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(409);
    });

    it('race condition: two concurrent accept requests for the same token — exactly one succeeds (Issue C4)', async () => {
      const { workspace, member } = await seedWorkspace();
      const invite = buildInviteLink({ workspace_id: workspace.id, created_by: member.id });
      await supabaseAdmin.from('invite_links').insert(invite);

      const { user: user1 } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});
      // seedAdditionalMember already inserts a workspace_members row for
      // user1 — to test the ACCEPT race we need a user who is NOT yet a
      // member, so undo that membership row before racing the accept.
      await supabaseAdmin.from('workspace_members').delete().eq('workspace_id', workspace.id).eq('user_id', user1.id);

      const { authHeader: auth1 } = mockAuthenticatedRequest({ supabaseAdmin, userId: user1.id, email: user1.email });

      const { data: user2Row } = await supabaseAdmin.from('users').insert({
        id: crypto.randomUUID(), email: `racer2-${Date.now()}@example.test`, full_name: 'Racer Two',
      }).select().single();
      const { authHeader: auth2 } = mockAuthenticatedRequest({ supabaseAdmin, userId: user2Row.id, email: user2Row.email });

      // NOTE: acceptInvite is keyed by TOKEN + the CALLER's own userId —
      // both "racers" here are attempting to accept the SAME invite
      // token as two DIFFERENT users, which is the realistic race (two
      // different people clicking the same shared invite link at once).
      const [res1, res2] = await Promise.all([
        request(app).post(`/v1/public/invites/${invite.token}/accept`).set('Authorization', auth1),
        request(app).post(`/v1/public/invites/${invite.token}/accept`).set('Authorization', auth2),
      ]);

      const statuses = [res1.status, res2.status].sort();
      // Exactly one must succeed (200); the other must get the
      // already-used BusinessRuleError (422), never a duplicate
      // membership row for the SAME invite token.
      expect(statuses).toEqual([200, 422]);

      const { count: membershipCount } = await supabaseAdmin
        .from('workspace_members')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .in('user_id', [user1.id, user2Row.id]);
      expect(membershipCount).toBe(1);

      await supabaseAdmin.from('users').delete().eq('id', user2Row.id);
    });
  });

  // ── GET /containers/:publicToken (public, no auth) ────────────
  describe('GET /v1/public/containers/:publicToken', () => {
    it('public_show_names: false omits the contributors key entirely', async () => {
      const { workspace, member } = await seedWorkspace();
      const container = buildContainer({
        workspace_id: workspace.id,
        created_by: member.id,
        public_token: `public-token-${Date.now()}`,
        public_show_names: false,
        enable_money: true,
        budget_target: 500,
        budget_currency: 'USD',
      });
      await supabaseAdmin.from('containers').insert(container);

      const res = await request(app).get(`/v1/public/containers/${container.public_token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty('contributors');

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('public_show_names: true includes a contributors array', async () => {
      const { workspace, member } = await seedWorkspace();
      const container = buildContainer({
        workspace_id: workspace.id,
        created_by: member.id,
        public_token: `public-token-shown-${Date.now()}`,
        public_show_names: true,
        enable_money: true,
      });
      await supabaseAdmin.from('containers').insert(container);

      const res = await request(app).get(`/v1/public/containers/${container.public_token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('contributors');
      expect(Array.isArray(res.body.data.contributors)).toBe(true);

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('non-existent token returns NotFound (404) — this endpoint is NOT anti-enumeration-shaped like invites', async () => {
      const res = await request(app).get('/v1/public/containers/no-such-public-token-at-all');
      expect(res.status).toBe(404);
    });

    it('requires no Authorization header at all', async () => {
      const { workspace, member } = await seedWorkspace();
      const container = buildContainer({
        workspace_id: workspace.id, created_by: member.id, public_token: `no-auth-needed-${Date.now()}`,
      });
      await supabaseAdmin.from('containers').insert(container);

      const res = await request(app).get(`/v1/public/containers/${container.public_token}`);
      expect(res.status).toBe(200);

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });
  });

  // ── Legacy /v1/invites/:token/accept parity ────────────────────
  describe('legacy invite.routes.js parity with /v1/public/invites', () => {
    it('the legacy /v1/invites/:token/accept path hits the SAME inviteService.acceptInvite and behaves identically', async () => {
      const { workspace, member } = await seedWorkspace();
      const invite = buildInviteLink({ workspace_id: workspace.id, created_by: member.id });
      await supabaseAdmin.from('invite_links').insert(invite);

      const { user } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});
      await supabaseAdmin.from('workspace_members').delete().eq('workspace_id', workspace.id).eq('user_id', user.id);
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const res = await request(app)
        .post(`/v1/invites/${invite.token}/accept`)
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.workspace.id).toBe(workspace.id);
    });

    it('legacy GET /v1/invites/:token/preview mirrors the same is_valid shape', async () => {
      const { workspace, member } = await seedWorkspace();
      const invite = buildInviteLink({ workspace_id: workspace.id, created_by: member.id });
      await supabaseAdmin.from('invite_links').insert(invite);

      const res = await request(app).get(`/v1/invites/${invite.token}/preview`);

      expect(res.status).toBe(200);
      expect(res.body.data.is_valid).toBe(true);
    });
  });
});
