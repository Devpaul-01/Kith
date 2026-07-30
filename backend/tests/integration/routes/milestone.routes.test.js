// tests/integration/routes/milestone.routes.test.js
//
// Doc 3 Section 3.8 — milestone.routes.js, mounted at the workspace
// router's root ('/'), covering /timeline and /milestones*.

const request = require('supertest');
const { getTestApp, resetTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, cleanupWorkspace, seedAdditionalMember } = require('../../helpers/dbHelper');
const { buildContainer, buildMilestone } = require('../../fixtures/factories');

describe('milestone.routes.js — /v1/workspaces/:workspaceId/{timeline,milestones}', () => {
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

  // ── GET /timeline — cursor pagination with per-source cursors ──
  describe('GET /v1/workspaces/:workspaceId/timeline', () => {
    it('dedicated multi-page test: an uneven mix of completed containers and milestones pages with no item skipped/duplicated', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();

      // Seed 3 completed containers and 30 milestones (uneven mix, per
      // Doc 3 Section 3.8's exact scenario), each with distinct,
      // strictly-decreasing dates so ordering is deterministic.
      const baseDate = new Date('2026-01-01T00:00:00Z');

      const containerRows = [];
      for (let i = 0; i < 3; i++) {
        const completedAt = new Date(baseDate.getTime() - i * 86400000 * 5).toISOString();
        const container = buildContainer({
          workspace_id: workspace.id, created_by: adminMember.id, status: 'completed', completed_at: completedAt,
        });
        containerRows.push(container);
      }
      await supabaseAdmin.from('containers').insert(containerRows);

      const milestoneRows = [];
      for (let i = 0; i < 30; i++) {
        const milestoneDate = new Date(baseDate.getTime() - i * 86400000).toISOString().split('T')[0];
        milestoneRows.push(buildMilestone({ workspace_id: workspace.id, created_by: adminMember.id, milestone_date: milestoneDate }));
      }
      await supabaseAdmin.from('milestones').insert(milestoneRows);

      const seenReferenceIds = new Set();
      let cursor = {};
      let pageCount = 0;
      const limit = 7; // small limit forces several pages

      while (pageCount < 20) { // hard cap to prevent infinite loop on a bug
        const query = new URLSearchParams({ limit: String(limit) });
        if (cursor.before_container) query.set('before_container', cursor.before_container);
        if (cursor.before_milestone) query.set('before_milestone', cursor.before_milestone);

        const res = await request(app)
          .get(`/v1/workspaces/${workspace.id}/timeline?${query.toString()}`)
          .set('Authorization', adminAuthHeader);

        expect(res.status).toBe(200);
        pageCount += 1;

        for (const item of res.body.data.items) {
          const key = `${item.reference_type}:${item.reference_id}`;
          expect(seenReferenceIds.has(key)).toBe(false); // no duplicates across pages
          seenReferenceIds.add(key);
        }

        if (!res.body.data.has_more) break;
        cursor = res.body.data.next_cursor;
      }

      // 3 containers + 30 milestones = 33 total items, none skipped.
      expect(seenReferenceIds.size).toBe(33);

      await supabaseAdmin.from('containers').delete().in('id', containerRows.map((c) => c.id));
      await supabaseAdmin.from('milestones').delete().in('id', milestoneRows.map((m) => m.id));
    });

    it('back-compat: a bare "before" param seeds both cursors on first call', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const milestone = buildMilestone({ workspace_id: workspace.id, created_by: adminMember.id, milestone_date: '2026-01-01' });
      await supabaseAdmin.from('milestones').insert(milestone);

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/timeline?before=2026-02-01`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.items.some((i) => i.reference_id === milestone.id)).toBe(true);

      await supabaseAdmin.from('milestones').delete().eq('id', milestone.id);
    });
  });

  // ── POST /milestones (admin) ────────────────────────────────────
  describe('POST /v1/workspaces/:workspaceId/milestones', () => {
    it('non-admin caller is rejected with 403', async () => {
      const { workspace } = await seedTenant();
      const { user } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/milestones`)
        .set('Authorization', authHeader)
        .send({ title: 'Should not be allowed', milestone_date: '2026-01-01' });
      expect(res.status).toBe(403);
    });

    it('admin creates a milestone successfully', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/milestones`)
        .set('Authorization', adminAuthHeader)
        .send({ title: 'Graduation Day', milestone_date: '2026-06-01', milestone_type: 'graduation' });

      expect(res.status).toBe(201);
      expect(res.body.data.milestone.title).toBe('Graduation Day');
    });
  });

  // ── GET /milestones/:milestoneId (route ordering) ──────────────
  describe('GET /v1/workspaces/:workspaceId/milestones/:milestoneId', () => {
    it('resolves before the PATCH/DELETE routes without ambiguity', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const milestone = buildMilestone({ workspace_id: workspace.id, created_by: adminMember.id });
      await supabaseAdmin.from('milestones').insert(milestone);

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/milestones/${milestone.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.milestone.id).toBe(milestone.id);

      await supabaseAdmin.from('milestones').delete().eq('id', milestone.id);
    });
  });

  // ── POST /milestones/:id/photos/confirm ────────────────────────
  describe('POST /v1/workspaces/:workspaceId/milestones/:milestoneId/photos/confirm', () => {
    it('magic-byte mismatch is rejected with BusinessRuleError, same pattern as ledger proofs', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const milestone = buildMilestone({ workspace_id: workspace.id, created_by: adminMember.id });
      await supabaseAdmin.from('milestones').insert(milestone);

      // storage.service.js#verifyUploadedFile downloads and inspects
      // real bytes from Supabase Storage — this test relies on
      // FILE_VERIFICATION_ENABLED (set to 'false' by
      // tests/setup.integration.js by default, per its own comment
      // "integration tests don't upload real bytes to real storage by
      // default"). This specific test REQUIRES verification to be
      // active to exercise the magic-byte rejection path, so it
      // temporarily overrides the env var and forces a fresh app.
      const original = process.env.FILE_VERIFICATION_ENABLED;
      process.env.FILE_VERIFICATION_ENABLED = 'true';
      resetTestApp();
      jest.resetModules();
      const freshApp = getTestApp();

      try {
        // Upload a real (non-image) text file to the actual test-Storage
        // bucket at a known path, then attempt to confirm it as an
        // 'image/png'-declared photo — the magic bytes won't match.
        const filePath = `workspaces/${workspace.id}/milestones/${milestone.id}/fake-photo.png`;
        await supabaseAdmin.storage
          .from(process.env.STORAGE_BUCKET_NAME)
          .upload(filePath, Buffer.from('this is not an image'), { contentType: 'image/png', upsert: true });

        const res = await request(freshApp)
          .post(`/v1/workspaces/${workspace.id}/milestones/${milestone.id}/photos/confirm`)
          .set('Authorization', adminAuthHeader)
          .send({ file_path: filePath, name: 'fake-photo.png', size: 21, mime_type: 'image/png' });

        expect(res.status).toBe(422);

        await supabaseAdmin.storage.from(process.env.STORAGE_BUCKET_NAME).remove([filePath]);
      } finally {
        process.env.FILE_VERIFICATION_ENABLED = original;
        resetTestApp();
        jest.resetModules();
        await supabaseAdmin.from('milestones').delete().eq('id', milestone.id);
      }
    });
  });

  describe('DELETE /v1/workspaces/:workspaceId/milestones/:milestoneId', () => {
    it('non-admin caller is rejected with 403', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { user } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
      const milestone = buildMilestone({ workspace_id: workspace.id, created_by: adminMember.id });
      await supabaseAdmin.from('milestones').insert(milestone);

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/milestones/${milestone.id}`)
        .set('Authorization', authHeader);
      expect(res.status).toBe(403);

      await supabaseAdmin.from('milestones').delete().eq('id', milestone.id);
    });
  });
});
