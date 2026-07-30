// tests/integration/routes/dispute.routes.test.js
//
// Doc 3 Section 3.7 — dispute.routes.js, mounted at
// /v1/workspaces/:workspaceId/disputes.

const request = require('supertest');
const crypto = require('crypto');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace, seedLedgerEntry } = require('../../helpers/dbHelper');
const { buildContainer } = require('../../fixtures/factories');

describe('dispute.routes.js — /v1/workspaces/:workspaceId/disputes', () => {
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

  async function seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember, raiserAuthHeader }) {
    const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: true });
    await supabaseAdmin.from('containers').insert(container);
    await supabaseAdmin.from('container_participants').insert({
      container_id: container.id, workspace_member_id: raiserMember.id, money_enabled: true,
    });
    const entry = await seedLedgerEntry(supabaseAdmin, {
      workspace_id: workspace.id, container_id: container.id, contributor_id: raiserMember.id,
      recorded_by: raiserMember.id, status: 'confirmed',
    });

    const raiseRes = await request(app)
      .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${entry.id}/dispute`)
      .set('Authorization', raiserAuthHeader)
      .send({ reason: 'This amount does not look right to me at all.' });

    return { container, entry, dispute: raiseRes.body.data.dispute };
  }

  // ── GET /:disputeId ─────────────────────────────────────────────
  describe('GET /v1/workspaces/:workspaceId/disputes/:disputeId', () => {
    it('non-admin, not the raiser -> ForbiddenError', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);
      const { authHeader: strangerAuthHeader } = await seedNonAdmin(workspace.id);

      const { dispute } = await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}`)
        .set('Authorization', strangerAuthHeader);

      expect(res.status).toBe(403);
    });

    it('the raiser themselves can view it', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);

      const { dispute } = await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}`)
        .set('Authorization', raiserAuthHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.dispute.id).toBe(dispute.id);
    });

    it('an admin can view any dispute', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);

      const { dispute } = await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
    });
  });

  // ── POST /:disputeId/note — no route-level role restriction ───
  describe('POST /v1/workspaces/:workspaceId/disputes/:disputeId/note', () => {
    it('a third, unrelated active member attempting to add a note is rejected (service-level check is the SOLE enforcement point)', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);
      const { authHeader: unrelatedAuthHeader } = await seedNonAdmin(workspace.id);

      const { dispute } = await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}/note`)
        .set('Authorization', unrelatedAuthHeader)
        .send({ note: 'I should not be able to add this.' });

      expect(res.status).toBe(403);
    });

    it('the raiser can add their own note', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);

      const { dispute } = await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}/note`)
        .set('Authorization', raiserAuthHeader)
        .send({ note: 'Adding more context.' });

      expect(res.status).toBe(200);
      expect(res.body.data.dispute.notes.length).toBe(1);
    });

    it('an admin can add a note even though they did not raise it', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);

      const { dispute } = await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}/note`)
        .set('Authorization', adminAuthHeader)
        .send({ note: 'Admin weighing in.' });

      expect(res.status).toBe(200);
    });
  });

  // ── POST /:disputeId/resolve (admin) ──────────────────────────
  describe('POST /v1/workspaces/:workspaceId/disputes/:disputeId/resolve', () => {
    it('non-open dispute -> BusinessRuleError', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);

      const { dispute } = await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const firstResolve = await request(app)
        .post(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}/resolve`)
        .set('Authorization', adminAuthHeader)
        .send({ resolution_note: 'Resolved after review of receipts.' });
      expect(firstResolve.status).toBe(200);

      const secondResolve = await request(app)
        .post(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}/resolve`)
        .set('Authorization', adminAuthHeader)
        .send({ resolution_note: 'Trying to resolve again.' });

      expect(secondResolve.status).toBe(422);
    });

    it('non-admin caller is rejected with 403', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);

      const { dispute } = await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}/resolve`)
        .set('Authorization', raiserAuthHeader)
        .send({ resolution_note: 'Trying to resolve my own dispute as a non-admin.' });

      expect(res.status).toBe(403);
    });

    it('resolution_note under 10 chars is rejected by validation', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);

      const { dispute } = await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}/resolve`)
        .set('Authorization', adminAuthHeader)
        .send({ resolution_note: 'short' });

      expect(res.status).toBe(400);
    });

    it('successful resolution updates both the dispute and its ledger entry status', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);

      const { dispute, entry } = await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/disputes/${dispute.id}/resolve`)
        .set('Authorization', adminAuthHeader)
        .send({ resolution_note: 'Verified with the bank statement.' });

      expect(res.status).toBe(200);
      expect(res.body.data.dispute.status).toBe('resolved');

      const { data: entryRow } = await supabaseAdmin.from('ledger_entries').select('status').eq('id', entry.id).single();
      expect(entryRow.status).toBe('resolved');
    });
  });

  // ── GET / (list, admin) ─────────────────────────────────────────
  describe('GET /v1/workspaces/:workspaceId/disputes', () => {
    it('non-admin caller is rejected with 403', async () => {
      const { workspace } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id);

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/disputes`)
        .set('Authorization', authHeader);
      expect(res.status).toBe(403);
    });

    it('admin lists disputes with statusFilter honored', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: raiser, authHeader: raiserAuthHeader } = await seedNonAdmin(workspace.id);

      await seedConfirmedEntryAndDispute({ workspace, adminMember, raiserMember: raiser, raiserAuthHeader });

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/disputes?status=open`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      for (const d of res.body.data.disputes) {
        expect(d.status).toBe('open');
      }
    });
  });
});
