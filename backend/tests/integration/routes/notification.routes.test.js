// tests/integration/routes/notification.routes.test.js
//
// Doc 3 Section 3.9 — notification.routes.js, mounted at
// /v1/notifications (user-scoped, NOT workspace-scoped).

const request = require('supertest');
const crypto = require('crypto');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildNotification } = require('../../fixtures/factories');

describe('notification.routes.js — /v1/notifications', () => {
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
    return { workspace, user, member, authHeader };
  }

  // ── resolveMember middleware ───────────────────────────────────
  describe('resolveMember custom middleware', () => {
    it('no active membership anywhere -> NotFoundError (Issue 3 fix regression test)', async () => {
      const { data: lonelyUser } = await supabaseAdmin.from('users').insert({
        id: crypto.randomUUID(), email: `lonely-${Date.now()}@example.test`, full_name: 'Lonely User',
      }).select().single();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: lonelyUser.id, email: lonelyUser.email });

      const res = await request(app).get('/v1/notifications').set('Authorization', authHeader);

      expect(res.status).toBe(404);
      await supabaseAdmin.from('users').delete().eq('id', lonelyUser.id);
    });

    it('workspace_id param for a workspace the caller is not in -> still NotFoundError', async () => {
      const { authHeader } = await seedTenant();
      const otherWorkspaceId = crypto.randomUUID();

      const res = await request(app)
        .get(`/v1/notifications?workspace_id=${otherWorkspaceId}`)
        .set('Authorization', authHeader);

      expect(res.status).toBe(404);
    });

    it('no param, multiple memberships -> resolves to the most-recently-joined', async () => {
      const { user, authHeader } = await seedTenant();

      const { data: ws2 } = await supabaseAdmin.from('workspaces').insert({
        name: 'Second WS', base_currency: 'USD', family_type: 'extended', created_by: user.id,
      }).select().single();
      seededWorkspaceIds.push(ws2.id);

      const { data: laterMember } = await supabaseAdmin.from('workspace_members').insert({
        workspace_id: ws2.id, user_id: user.id, role: 'admin', display_name: 'Later Joiner',
        invite_status: 'accepted', joined_at: new Date(Date.now() + 60000).toISOString(),
      }).select().single();

      const notif = buildNotification({ recipient_id: laterMember.id, workspace_id: ws2.id, title: 'For the later workspace' });
      await supabaseAdmin.from('notifications').insert(notif);

      const res = await request(app).get('/v1/notifications').set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.notifications.some((n) => n.id === notif.id)).toBe(true);
    });
  });

  // ── GET /count registered before GET / and PATCH /:id/read ─────
  describe('route ordering', () => {
    it('GET /count resolves to the unread-count controller, not a mis-routed /:notificationId lookup', async () => {
      const { member, authHeader } = await seedTenant();
      await supabaseAdmin.from('notifications').insert(
        buildNotification({ recipient_id: member.id, is_read: false })
      );

      const res = await request(app).get('/v1/notifications/count').set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(typeof res.body.data.unread_count).toBe('number');
    });
  });

  // ── PATCH /:notificationId/read ─────────────────────────────────
  describe('PATCH /v1/notifications/:notificationId/read', () => {
    it('on another member\'s notification returns 404 (invisible, not 403)', async () => {
      const { authHeader } = await seedTenant();

      // A separate, unrelated recipient in a DIFFERENT workspace.
      const other = await seedWorkspaceWithAdmin(supabaseAdmin);
      seededWorkspaceIds.push(other.workspace.id);
      const otherNotif = buildNotification({ recipient_id: other.member.id });
      await supabaseAdmin.from('notifications').insert(otherNotif);

      const res = await request(app)
        .patch(`/v1/notifications/${otherNotif.id}/read`)
        .set('Authorization', authHeader);

      expect(res.status).toBe(404);
    });

    it('own notification is marked read successfully', async () => {
      const { member, authHeader } = await seedTenant();
      const notif = buildNotification({ recipient_id: member.id, is_read: false });
      await supabaseAdmin.from('notifications').insert(notif);

      const res = await request(app)
        .patch(`/v1/notifications/${notif.id}/read`)
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.notification.is_read).toBe(true);
    });
  });

  // ── PATCH /read-all ──────────────────────────────────────────────
  describe('PATCH /v1/notifications/read-all', () => {
    it('without workspace_id scoping marks ALL unread notifications for the member as read', async () => {
      const { member, authHeader } = await seedTenant();
      await supabaseAdmin.from('notifications').insert([
        buildNotification({ recipient_id: member.id, is_read: false }),
        buildNotification({ recipient_id: member.id, is_read: false }),
      ]);

      const res = await request(app).patch('/v1/notifications/read-all').set('Authorization', authHeader).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.updated_count).toBeGreaterThanOrEqual(2);

      const { count: remainingUnread } = await supabaseAdmin
        .from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', member.id).eq('is_read', false);
      expect(remainingUnread).toBe(0);
    });

    it('with workspace_id scoping only marks that workspace\'s notifications as read', async () => {
      const { user, member, authHeader } = await seedTenant();

      const { data: ws2 } = await supabaseAdmin.from('workspaces').insert({
        name: 'Scoped WS', base_currency: 'USD', family_type: 'extended', created_by: user.id,
      }).select().single();
      seededWorkspaceIds.push(ws2.id);
      const { data: member2 } = await supabaseAdmin.from('workspace_members').insert({
        workspace_id: ws2.id, user_id: user.id, role: 'admin', display_name: 'Scoped Member', invite_status: 'accepted',
      }).select().single();

      const notifWs1 = buildNotification({ recipient_id: member.id, workspace_id: member.workspace_id, is_read: false });
      const notifWs2 = buildNotification({ recipient_id: member2.id, workspace_id: ws2.id, is_read: false });
      await supabaseAdmin.from('notifications').insert([notifWs1, notifWs2]);

      const res = await request(app)
        .patch('/v1/notifications/read-all')
        .set('Authorization', authHeader)
        .send({ workspace_id: ws2.id });

      expect(res.status).toBe(200);

      const { data: ws2Notif } = await supabaseAdmin.from('notifications').select('is_read').eq('id', notifWs2.id).single();
      expect(ws2Notif.is_read).toBe(true);
    });
  });
});
