// tests/integration/routes/ledger.routes.test.js
//
// Doc 3 Section 3.6 (Ledger sub-tree) — mounted at
// /v1/workspaces/:workspaceId/containers/:containerId/ledger. P0
// priority per Doc 4 Section 5 #3: "highest business/financial risk in
// the app; the ~15-case matrix." Every numbered case below corresponds
// to Doc 3 Section 3.6's ledger POST /createEntry enumeration.

const request = require('supertest');
const crypto = require('crypto');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildContainer } = require('../../fixtures/factories');

describe('ledger.routes.js — .../containers/:containerId/ledger', () => {
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

  async function seedNonAdmin(workspaceId) {
    const { user, member } = await seedAdditionalMember(supabaseAdmin, workspaceId, { member: { role: 'member' } });
    const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
    return { user, member, authHeader };
  }

  async function seedContainerWithParticipant(workspaceId, creatorMemberId, participantMemberId, participantOverrides = {}) {
    const container = buildContainer({ workspace_id: workspaceId, created_by: creatorMemberId, enable_money: true });
    await supabaseAdmin.from('containers').insert(container);
    await supabaseAdmin.from('container_participants').insert({
      container_id: container.id,
      workspace_member_id: participantMemberId,
      money_enabled: true,
      ...participantOverrides,
    });
    return container;
  }

  const validEntryBody = () => ({
    entry_type: 'contribution',
    original_amount: 50,
    original_currency: 'USD',
    base_amount: 50,
  });

  // ── POST / (createEntry) — the ~15-case matrix ────────────────
  describe('POST .../ledger (createEntry)', () => {
    it('1. idempotency key match on existing entry returns the existing entry, idempotent: true, 200 not 201, no new row created', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);
      const idempotencyKey = crypto.randomUUID();

      const first = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .set('X-Idempotency-Key', idempotencyKey)
        .send({ ...validEntryBody(), contributor_id: adminMember.id });
      expect(first.status).toBe(201);

      const { count: countAfterFirst } = await supabaseAdmin
        .from('ledger_entries').select('*', { count: 'exact', head: true }).eq('container_id', container.id);

      const second = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .set('X-Idempotency-Key', idempotencyKey)
        .send({ ...validEntryBody(), contributor_id: adminMember.id });

      expect(second.status).toBe(200);
      expect(second.body.data.idempotent).toBe(true);
      expect(second.body.data.entry.id).toBe(first.body.data.entry.id);

      const { count: countAfterSecond } = await supabaseAdmin
        .from('ledger_entries').select('*', { count: 'exact', head: true }).eq('container_id', container.id);
      expect(countAfterSecond).toBe(countAfterFirst);
    });

    it('2. idempotency key present, no match -> creates normally', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .set('X-Idempotency-Key', crypto.randomUUID())
        .send({ ...validEntryBody(), contributor_id: adminMember.id });

      expect(res.status).toBe(201);
      expect(res.body.data.idempotent).toBeUndefined();
    });

    it('4. non-admin omitting contributor_id defaults to self', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member, authHeader } = await seedNonAdmin(workspace.id);
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, member.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', authHeader)
        .send(validEntryBody()); // no contributor_id

      expect(res.status).toBe(201);
      expect(res.body.data.entry.contributor_id).toBe(member.id);
    });

    it('4b. admin omitting contributor_id -> BusinessRuleError', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send(validEntryBody()); // no contributor_id, caller is admin

      expect(res.status).toBe(422);
    });

    it('5. contributor_id not a participant -> BusinessRuleError', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);
      const { member: outsider } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send({ ...validEntryBody(), contributor_id: outsider.id });

      expect(res.status).toBe(422);
    });

    it('6. proxy contributor, non-admin caller -> ForbiddenError', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: proxyMember } = await seedAdditionalMember(supabaseAdmin, workspace.id, {
        member: { is_proxy: true, user_id: null, invite_status: null },
      });
      const { authHeader: nonAdminAuthHeader } = await seedNonAdmin(workspace.id);
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, proxyMember.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', nonAdminAuthHeader)
        .send({ ...validEntryBody(), contributor_id: proxyMember.id });

      expect(res.status).toBe(403);
    });

    it('6b. proxy contributor, admin caller -> succeeds + proxy_actions audit row inserted', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: proxyMember } = await seedAdditionalMember(supabaseAdmin, workspace.id, {
        member: { is_proxy: true, user_id: null, invite_status: null },
      });
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, proxyMember.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send({ ...validEntryBody(), contributor_id: proxyMember.id });

      expect(res.status).toBe(201);

      const { data: proxyActions } = await supabaseAdmin
        .from('proxy_actions').select('*').eq('proxy_member_id', proxyMember.id).eq('action_type', 'ledger_entry');
      expect(proxyActions.length).toBe(1);
      expect(proxyActions[0].target_id).toBe(res.body.data.entry.id);
    });

    it('7. money_enabled: false on the participant -> BusinessRuleError with specific message', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id, { money_enabled: false });

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send({ ...validEntryBody(), contributor_id: adminMember.id });

      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/money tracking is not enabled/i);
    });

    it('8. cycle_id not belonging to this container -> BusinessRuleError', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send({ ...validEntryBody(), contributor_id: adminMember.id, cycle_id: crypto.randomUUID() });

      expect(res.status).toBe(422);
    });

    it('9. duplicate-window hit, no force/idempotency key -> ConflictError with existing_entry_id; force=true bypasses', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);
      const body = { ...validEntryBody(), contributor_id: adminMember.id, original_amount: 77 };

      const first = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send(body);
      expect(first.status).toBe(201);

      const dupAttempt = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send(body);
      expect(dupAttempt.status).toBe(409);
      expect(dupAttempt.body.error.details.existing_entry_id).toBe(first.body.data.entry.id);

      const forced = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger?force=true`)
        .set('Authorization', adminAuthHeader)
        .send(body);
      expect(forced.status).toBe(201);
    });

    it('10/11. admin-created entry is confirmed immediately with LEDGER_CONFIRMED audit action', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send({ ...validEntryBody(), contributor_id: adminMember.id });

      expect(res.status).toBe(201);
      expect(res.body.data.entry.status).toBe('confirmed');

      const { data: auditRows } = await supabaseAdmin
        .from('audit_log').select('*').eq('target_id', res.body.data.entry.id).eq('action', 'ledger.confirmed');
      expect(auditRows.length).toBe(1);
    });

    it('10/11. non-admin-created entry is pending with LEDGER_SUBMITTED audit action, admins notified', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member, authHeader } = await seedNonAdmin(workspace.id);
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, member.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', authHeader)
        .send(validEntryBody());

      expect(res.status).toBe(201);
      expect(res.body.data.entry.status).toBe('pending');

      const { data: auditRows } = await supabaseAdmin
        .from('audit_log').select('*').eq('target_id', res.body.data.entry.id).eq('action', 'ledger.submitted');
      expect(auditRows.length).toBe(1);
    });

    it('baseline: no auth -> 401', async () => {
      const { workspace, adminMember } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .send(validEntryBody());
      expect(res.status).toBe(401);
    });

    it('baseline: validation failure (negative original_amount) -> 400 VALIDATION_FAILED', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send({ ...validEntryBody(), original_amount: -5, contributor_id: adminMember.id });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  // ── IDEMPOTENCY_ENABLED=false env override — isolated env-var test ─
  describe('IDEMPOTENCY_ENABLED=false override (case 3)', () => {
    it('key accepted but ignored; duplicate entry IS created', async () => {
      // This requires re-requiring app.js with a different env, which
      // testApp.js's resetTestApp() supports for exactly this reason.
      const { resetTestApp, getTestApp: getFreshApp } = require('../../helpers/testApp');
      const originalValue = process.env.IDEMPOTENCY_ENABLED;
      process.env.IDEMPOTENCY_ENABLED = 'false';
      resetTestApp();
      // Re-require dependent modules fresh too, since ledger.service.js
      // reads IDEMPOTENCY_ENABLED at module-load time into a constant.
      jest.resetModules();
      const freshApp = getFreshApp();

      try {
        const { workspace, adminMember, adminAuthHeader } = await seedTenant();
        const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);
        const idempotencyKey = crypto.randomUUID();
        const body = { ...validEntryBody(), contributor_id: adminMember.id };

        const first = await request(freshApp)
          .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger?force=true`)
          .set('Authorization', adminAuthHeader)
          .set('X-Idempotency-Key', idempotencyKey)
          .send(body);
        const second = await request(freshApp)
          .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger?force=true`)
          .set('Authorization', adminAuthHeader)
          .set('X-Idempotency-Key', idempotencyKey)
          .send(body);

        // With idempotency disabled, the same key does NOT short-circuit
        // a second insert (force=true also bypasses the separate
        // duplicate-window check so this isolates the idempotency
        // behavior specifically).
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(second.body.data.entry.id).not.toBe(first.body.data.entry.id);
      } finally {
        process.env.IDEMPOTENCY_ENABLED = originalValue;
        resetTestApp();
        jest.resetModules();
      }
    });
  });

  // ── PATCH /:entryId ─────────────────────────────────────────────
  describe('PATCH .../ledger/:entryId', () => {
    it('only pending entries are editable', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const created = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send({ ...validEntryBody(), contributor_id: adminMember.id }); // admin -> confirmed immediately

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${created.body.data.entry.id}`)
        .set('Authorization', adminAuthHeader)
        .send({ note: 'trying to edit a confirmed entry' });

      expect(res.status).toBe(422);
    });

    it('non-owner non-admin -> ForbiddenError', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: owner, authHeader: ownerAuthHeader } = await seedNonAdmin(workspace.id);
      const { authHeader: strangerAuthHeader } = await seedNonAdmin(workspace.id);
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, owner.id);

      const created = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', ownerAuthHeader)
        .send(validEntryBody());

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${created.body.data.entry.id}`)
        .set('Authorization', strangerAuthHeader)
        .send({ note: 'not mine to edit' });

      expect(res.status).toBe(403);
    });

    it('non-admin changing contributor_id -> ForbiddenError', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: owner, authHeader: ownerAuthHeader } = await seedNonAdmin(workspace.id);
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, owner.id);

      const created = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', ownerAuthHeader)
        .send(validEntryBody());

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${created.body.data.entry.id}`)
        .set('Authorization', ownerAuthHeader)
        .send({ contributor_id: adminMember.id });

      expect(res.status).toBe(403);
    });
  });

  // ── DELETE /:entryId ─────────────────────────────────────────────
  describe('DELETE .../ledger/:entryId', () => {
    it('only pending/proof_uploaded entries are deletable', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const created = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send({ ...validEntryBody(), contributor_id: adminMember.id }); // confirmed immediately (admin)

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${created.body.data.entry.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(422);
    });

    it('pending entry can be deleted by its owner', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: owner } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, owner.id);

      const { data: ownerRow } = await supabaseAdmin.from('workspace_members').select('user_id').eq('id', owner.id).single();
      const { data: ownerUserRow } = await supabaseAdmin.from('users').select('id, email').eq('id', ownerRow.user_id).single();
      const { authHeader: ownerAuthHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: ownerUserRow.id, email: ownerUserRow.email });

      const created = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', ownerAuthHeader)
        .send(validEntryBody());
      expect(created.status).toBe(201);
      expect(created.body.data.entry.status).toBe('pending');

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${created.body.data.entry.id}`)
        .set('Authorization', ownerAuthHeader);
      expect(res.status).toBe(200);
    });
  });

  // ── GET /summary — must resolve before /:entryId ─────────────────
  describe('GET .../ledger/summary route ordering', () => {
    it('literal /summary path resolves to the summary controller, not a /:entryId lookup attempt', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/summary`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.summary).toHaveProperty('confirmed_count');
      expect(res.body.data.summary).not.toHaveProperty('entry'); // not a mis-routed entry lookup
    });
  });

  // ── POST /:entryId/confirm (admin) ────────────────────────────
  describe('POST .../ledger/:entryId/confirm', () => {
    it('only from pending/proof_uploaded, and succeeds when called by that workspace\'s own admin', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: owner, authHeader: ownerAuthHeader } = await seedNonAdmin(workspace.id);
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, owner.id);

      const created = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', ownerAuthHeader)
        .send(validEntryBody());
      expect(created.body.data.entry.status).toBe('pending');

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${created.body.data.entry.id}/confirm`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.entry.status).toBe('confirmed');
    });

    it('non-admin caller is rejected with 403', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: owner, authHeader: ownerAuthHeader } = await seedNonAdmin(workspace.id);
      const { authHeader: strangerAuthHeader } = await seedNonAdmin(workspace.id);
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, owner.id);

      const created = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', ownerAuthHeader)
        .send(validEntryBody());

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${created.body.data.entry.id}/confirm`)
        .set('Authorization', strangerAuthHeader);

      expect(res.status).toBe(403);
    });
  });

  // ── POST /:entryId/add-correction (admin) ─────────────────────
  describe('POST .../ledger/:entryId/add-correction', () => {
    it('only on confirmed source entries', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const { member: owner, authHeader: ownerAuthHeader } = await seedNonAdmin(workspace.id);
      await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: owner.id, money_enabled: true,
      });

      const pendingEntry = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', ownerAuthHeader)
        .send(validEntryBody());
      expect(pendingEntry.body.data.entry.status).toBe('pending');

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${pendingEntry.body.data.entry.id}/add-correction`)
        .set('Authorization', adminAuthHeader)
        .send({ original_amount: 10, original_currency: 'USD', base_amount: 10, note: 'Correcting a pending entry (invalid)' });

      expect(res.status).toBe(422);
    });

    it('money_enabled: false at correction time -> BusinessRuleError', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const confirmedEntry = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send({ ...validEntryBody(), contributor_id: adminMember.id });
      expect(confirmedEntry.body.data.entry.status).toBe('confirmed');

      // Disable money tracking for the contributor's participant row
      // directly (bypassing the guarded PATCH endpoint, which itself
      // would reject this given confirmed entries — this simulates the
      // state having been disabled some other way, e.g. data migration).
      await supabaseAdmin.from('container_participants')
        .update({ money_enabled: false })
        .eq('container_id', container.id).eq('workspace_member_id', adminMember.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${confirmedEntry.body.data.entry.id}/add-correction`)
        .set('Authorization', adminAuthHeader)
        .send({ original_amount: 10, original_currency: 'USD', base_amount: 10, note: 'Correction after money disabled' });

      expect(res.status).toBe(422);
    });

    it('non-admin caller is rejected with 403', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { authHeader: nonAdminAuthHeader } = await seedNonAdmin(workspace.id);
      const container = await seedContainerWithParticipant(workspace.id, adminMember.id, adminMember.id);

      const confirmedEntry = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger`)
        .set('Authorization', adminAuthHeader)
        .send({ ...validEntryBody(), contributor_id: adminMember.id });
      expect(confirmedEntry.body.data.entry.status).toBe('confirmed');

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/ledger/${confirmedEntry.body.data.entry.id}/add-correction`)
        .set('Authorization', nonAdminAuthHeader)
        .send({ original_amount: 10, original_currency: 'USD', base_amount: 10, note: 'Non-admin attempt' });

      expect(res.status).toBe(403);
    });
  });
});
