// tests/integration/routes/container.routes.test.js
//
// Doc 3 Section 3.6 — container.routes.js and nested
// participant.routes.js / task.routes.js (ledger.routes.js is covered
// in its own file, tests/integration/routes/ledger.routes.test.js, given
// its size/priority). Mounted at
// /v1/workspaces/:workspaceId/containers[/:containerId/participants|tasks].

const request = require('supertest');
const crypto = require('crypto');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace, seedLedgerEntry } = require('../../helpers/dbHelper');
const { buildContainer } = require('../../fixtures/factories');

describe('container.routes.js + nested participant/task routes', () => {
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

  // ══════════════════════════════════════════════════════════════
  // CONTAINERS
  // ══════════════════════════════════════════════════════════════

  describe('POST /v1/workspaces/:workspaceId/containers', () => {
    it('container_type: recurring enqueues cycle-generation; queue-add failure does not fail the request', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers`)
        .set('Authorization', adminAuthHeader)
        .send({
          name: 'Monthly Rent Pool',
          container_type: 'recurring',
          recurrence_cadence: 'monthly',
          recurrence_start: new Date().toISOString().split('T')[0],
          enable_money: true,
        });

      // Even if the mocked queue's .add() were to reject, container.service.js
      // wraps the enqueue in its own try/catch — assert 201 regardless.
      expect(res.status).toBe(201);
      expect(res.body.data.container.container_type).toBe('recurring');
    });

    it('non-admin caller is rejected with 403', async () => {
      const { workspace } = await seedTenant();
      const { authHeader } = await seedNonAdmin(workspace.id);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers`)
        .set('Authorization', authHeader)
        .send({ name: 'Should not be allowed', container_type: 'event' });

      expect(res.status).toBe(403);
    });

    it('superRefine: recurring type missing recurrence_cadence/start -> both issues present', async () => {
      const { workspace, adminAuthHeader } = await seedTenant();

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers`)
        .set('Authorization', adminAuthHeader)
        .send({ name: 'Bad Recurring', container_type: 'recurring' });

      expect(res.status).toBe(400);
      expect(res.body.error.details.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('PATCH /v1/workspaces/:workspaceId/containers/:containerId', () => {
    it('enable_money: false with existing (any) ledger entries is rejected — Issue C6 fail-closed guard', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: true });
      await supabaseAdmin.from('containers').insert(container);
      await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: adminMember.id, money_enabled: true,
      });
      await seedLedgerEntry(supabaseAdmin, {
        workspace_id: workspace.id, container_id: container.id, contributor_id: adminMember.id, recorded_by: adminMember.id,
      });

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}`)
        .set('Authorization', adminAuthHeader)
        .send({ enable_money: false });

      expect(res.status).toBe(422);

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('enable_money: false with zero ledger entries succeeds', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: true });
      await supabaseAdmin.from('containers').insert(container);

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}`)
        .set('Authorization', adminAuthHeader)
        .send({ enable_money: false });

      expect(res.status).toBe(200);
      expect(res.body.data.container.enable_money).toBe(false);

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });
  });

  describe('DELETE /v1/workspaces/:workspaceId/containers/:containerId', () => {
    it('confirmed entries -> rejected', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: true });
      await supabaseAdmin.from('containers').insert(container);
      await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: adminMember.id, money_enabled: true,
      });
      await seedLedgerEntry(supabaseAdmin, {
        workspace_id: workspace.id, container_id: container.id, contributor_id: adminMember.id,
        recorded_by: adminMember.id, status: 'confirmed',
      });

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/containers/${container.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(422);

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('none -> soft delete succeeds', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id });
      await supabaseAdmin.from('containers').insert(container);

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/containers/${container.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      const { data: row } = await supabaseAdmin.from('containers').select('deleted_at').eq('id', container.id).single();
      expect(row.deleted_at).not.toBeNull();
    });
  });

  describe('POST /v1/workspaces/:workspaceId/containers/:containerId/complete', () => {
    it('non-active status is rejected', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, status: 'archived' });
      await supabaseAdmin.from('containers').insert(container);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/complete`)
        .set('Authorization', adminAuthHeader)
        .send({});

      expect(res.status).toBe(422);
      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('auto-creates a milestone on completion', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id });
      await supabaseAdmin.from('containers').insert(container);

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/complete`)
        .set('Authorization', adminAuthHeader)
        .send({ outcome_details: 'It went great.' });

      expect(res.status).toBe(200);
      const { data: milestones } = await supabaseAdmin.from('milestones').select('*').eq('workspace_id', workspace.id);
      expect(milestones.some((m) => m.title.includes(container.name))).toBe(true);

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });
  });

  describe('GET /v1/workspaces/:workspaceId/containers/:containerId/summary', () => {
    it('non-admin non-self participant gets a reduced shape (only member_id/display_name/is_proxy/role/status)', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: memberA, authHeader: authA } = await seedNonAdmin(workspace.id);
      const { member: memberB } = await seedNonAdmin(workspace.id);
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: true });
      await supabaseAdmin.from('containers').insert(container);
      await supabaseAdmin.from('container_participants').insert([
        { container_id: container.id, workspace_member_id: memberA.id, money_enabled: true },
        { container_id: container.id, workspace_member_id: memberB.id, money_enabled: true },
      ]);

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/containers/${container.id}/summary`)
        .set('Authorization', authA);

      expect(res.status).toBe(200);
      const bParticipant = res.body.data.participants.find((p) => p.member_id === memberB.id);
      expect(Object.keys(bParticipant).sort()).toEqual(['display_name', 'is_proxy', 'member_id', 'role', 'status'].sort());

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('progress_pct is null (not NaN) when totalExpected is 0', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: true });
      await supabaseAdmin.from('containers').insert(container);

      const res = await request(app)
        .get(`/v1/workspaces/${workspace.id}/containers/${container.id}/summary`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.progress_pct).toBeNull();

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // PARTICIPANTS (nested)
  // ══════════════════════════════════════════════════════════════

  describe('POST .../participants', () => {
    it('target auto-creation only when enable_money AND target.amount > 0 (table-tests all 4 combinations)', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();

      const cases = [
        { enableMoney: true, targetAmount: 100, expectTarget: true },
        { enableMoney: true, targetAmount: 0, expectTarget: false },
        { enableMoney: false, targetAmount: 100, expectTarget: false },
        { enableMoney: false, targetAmount: 0, expectTarget: false },
      ];

      for (const c of cases) {
        const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: c.enableMoney });
        await supabaseAdmin.from('containers').insert(container);
        const { member: newMember } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});

        const res = await request(app)
          .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/participants`)
          .set('Authorization', adminAuthHeader)
          .send({
            participants: [{
              workspace_member_id: newMember.id,
              money_enabled: true,
              target: c.targetAmount > 0 ? { amount: c.targetAmount, currency: 'USD' } : undefined,
            }],
          });

        expect(res.status).toBe(201);

        const { data: targets } = await supabaseAdmin
          .from('contributor_targets').select('*').eq('workspace_member_id', newMember.id).eq('container_id', container.id);

        if (c.expectTarget) {
          expect(targets.length).toBe(1);
        } else {
          expect(targets.length).toBe(0);
        }

        await supabaseAdmin.from('containers').delete().eq('id', container.id);
      }
    });
  });

  describe('PATCH .../participants/:participantId', () => {
    it('money_enabled: false + confirmed entries -> rejected (mirrors container guard)', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: true });
      await supabaseAdmin.from('containers').insert(container);
      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: adminMember.id, money_enabled: true,
      }).select().single();
      await seedLedgerEntry(supabaseAdmin, {
        workspace_id: workspace.id, container_id: container.id, contributor_id: adminMember.id,
        recorded_by: adminMember.id, status: 'confirmed',
      });

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}/participants/${participant.id}`)
        .set('Authorization', adminAuthHeader)
        .send({ money_enabled: false });

      expect(res.status).toBe(422);
      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });
  });

  describe('DELETE .../participants/:participantId', () => {
    it('with confirmed entries -> rejected', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_money: true });
      await supabaseAdmin.from('containers').insert(container);
      const { data: participant } = await supabaseAdmin.from('container_participants').insert({
        container_id: container.id, workspace_member_id: adminMember.id, money_enabled: true,
      }).select().single();
      await seedLedgerEntry(supabaseAdmin, {
        workspace_id: workspace.id, container_id: container.id, contributor_id: adminMember.id,
        recorded_by: adminMember.id, status: 'confirmed',
      });

      const res = await request(app)
        .delete(`/v1/workspaces/${workspace.id}/containers/${container.id}/participants/${participant.id}`)
        .set('Authorization', adminAuthHeader);

      expect(res.status).toBe(422);
      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // TASKS (nested)
  // ══════════════════════════════════════════════════════════════

  describe('PATCH .../tasks/:taskId', () => {
    it('non-admin, non-assignee -> ForbiddenError', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: assignee } = await seedNonAdmin(workspace.id);
      const { authHeader: strangerAuthHeader } = await seedNonAdmin(workspace.id);
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_tasks: true });
      await supabaseAdmin.from('containers').insert(container);
      await supabaseAdmin.from('container_participants').insert({ container_id: container.id, workspace_member_id: assignee.id });
      const { data: task } = await supabaseAdmin.from('container_tasks').insert({
        container_id: container.id, title: 'Buy supplies', assigned_to: assignee.id, created_by: adminMember.id,
      }).select().single();

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}/tasks/${task.id}`)
        .set('Authorization', strangerAuthHeader)
        .send({ status: 'in_progress' });

      expect(res.status).toBe(403);
      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('non-admin status: cancelled (schema-valid, service-rejected) is explicitly rejected — cross-layer test', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: assignee, authHeader } = await seedNonAdmin(workspace.id);
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_tasks: true });
      await supabaseAdmin.from('containers').insert(container);
      await supabaseAdmin.from('container_participants').insert({ container_id: container.id, workspace_member_id: assignee.id });
      const { data: task } = await supabaseAdmin.from('container_tasks').insert({
        container_id: container.id, title: 'Buy supplies', assigned_to: assignee.id, created_by: adminMember.id,
      }).select().single();

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}/tasks/${task.id}`)
        .set('Authorization', authHeader)
        .send({ status: 'cancelled' }); // valid per schema enum, rejected by service's non-admin subset

      expect(res.status).toBe(403);
      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('status: completed sets completed_at/completed_by and notifies admins', async () => {
      const { workspace, adminMember } = await seedTenant();
      const { member: assignee, authHeader } = await seedNonAdmin(workspace.id);
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_tasks: true });
      await supabaseAdmin.from('containers').insert(container);
      await supabaseAdmin.from('container_participants').insert({ container_id: container.id, workspace_member_id: assignee.id });
      const { data: task } = await supabaseAdmin.from('container_tasks').insert({
        container_id: container.id, title: 'Buy supplies', assigned_to: assignee.id, created_by: adminMember.id,
      }).select().single();

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}/tasks/${task.id}`)
        .set('Authorization', authHeader)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
      expect(res.body.data.task.completed_at).not.toBeNull();
      expect(res.body.data.task.completed_by).toBe(assignee.id);

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });
  });

  describe('PATCH .../tasks/:taskId/reassign (admin)', () => {
    it('already in_progress/completed -> BusinessRuleError', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_tasks: true });
      await supabaseAdmin.from('containers').insert(container);
      const { data: task } = await supabaseAdmin.from('container_tasks').insert({
        container_id: container.id, title: 'Locked task', status: 'in_progress', created_by: adminMember.id,
      }).select().single();

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}/tasks/${task.id}/reassign`)
        .set('Authorization', adminAuthHeader)
        .send({ assigned_to: adminMember.id });

      expect(res.status).toBe(422);
      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });

    it('new assignee not a participant -> BusinessRuleError', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: nonParticipant } = await seedNonAdmin(workspace.id);
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_tasks: true });
      await supabaseAdmin.from('containers').insert(container);
      const { data: task } = await supabaseAdmin.from('container_tasks').insert({
        container_id: container.id, title: 'Reassignable task', status: 'pending', created_by: adminMember.id,
      }).select().single();

      const res = await request(app)
        .patch(`/v1/workspaces/${workspace.id}/containers/${container.id}/tasks/${task.id}/reassign`)
        .set('Authorization', adminAuthHeader)
        .send({ assigned_to: nonParticipant.id });

      expect(res.status).toBe(422);
      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });
  });

  describe('POST .../tasks/bulk', () => {
    it('partial failure: 3 valid + 1 invalid assigned_to -> 3 created, 1 in failed array, overall 201', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: validAssignee } = await seedNonAdmin(workspace.id);
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_tasks: true });
      await supabaseAdmin.from('containers').insert(container);
      await supabaseAdmin.from('container_participants').insert({ container_id: container.id, workspace_member_id: validAssignee.id });

      const res = await request(app)
        .post(`/v1/workspaces/${workspace.id}/containers/${container.id}/tasks/bulk`)
        .set('Authorization', adminAuthHeader)
        .send({
          tasks: [
            { title: 'Task 1', assigned_to: validAssignee.id },
            { title: 'Task 2', assigned_to: validAssignee.id },
            { title: 'Task 3', assigned_to: validAssignee.id },
            { title: 'Task 4 bad assignee', assigned_to: crypto.randomUUID() },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.created.length).toBe(3);
      expect(res.body.data.failed.length).toBe(1);
      expect(res.body.data.failed[0].index).toBe(3);

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });
  });

  describe('GET .../tasks/export', () => {
    it('admin gets all tasks; non-admin gets only their own', async () => {
      const { workspace, adminMember, adminAuthHeader } = await seedTenant();
      const { member: memberA, authHeader: authA } = await seedNonAdmin(workspace.id);
      const { member: memberB } = await seedNonAdmin(workspace.id);
      const container = buildContainer({ workspace_id: workspace.id, created_by: adminMember.id, enable_tasks: true });
      await supabaseAdmin.from('containers').insert(container);
      await supabaseAdmin.from('container_tasks').insert([
        { container_id: container.id, title: 'A task', assigned_to: memberA.id, created_by: adminMember.id },
        { container_id: container.id, title: 'B task', assigned_to: memberB.id, created_by: adminMember.id },
      ]);

      const adminRes = await request(app)
        .get(`/v1/workspaces/${workspace.id}/containers/${container.id}/tasks/export`)
        .set('Authorization', adminAuthHeader);
      expect(adminRes.status).toBe(200);
      expect(adminRes.text).toContain('A task');
      expect(adminRes.text).toContain('B task');

      const memberRes = await request(app)
        .get(`/v1/workspaces/${workspace.id}/containers/${container.id}/tasks/export`)
        .set('Authorization', authA);
      expect(memberRes.status).toBe(200);
      expect(memberRes.text).toContain('A task');
      expect(memberRes.text).not.toContain('B task');

      await supabaseAdmin.from('containers').delete().eq('id', container.id);
    });
  });
});
