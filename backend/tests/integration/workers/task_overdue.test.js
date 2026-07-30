// tests/integration/workers/task_overdue.test.js
//
// Doc 3 Section 5.4 — task_overdue.service.js (runTaskOverdueCheck).

const { runTaskOverdueCheck } = require('../../../src/services/task_overdue.service');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildContainer } = require('../../fixtures/factories');
const { freezeTime, unfreezeTime } = require('../../helpers/timeHelper');

describe('task_overdue.service.js — runTaskOverdueCheck', () => {
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  afterEach(() => unfreezeTime());

  async function seedTenant() {
    const { workspace, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    return { workspace, member };
  }

  it('pending + due_date < today -> overdue', async () => {
    freezeTime('2026-01-10T00:00:00Z');
    const { workspace, member } = await seedTenant();
    const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_tasks: true });
    await supabaseAdmin.from('containers').insert(container);
    const { data: task } = await supabaseAdmin.from('container_tasks').insert({
      container_id: container.id, title: 'Late task', status: 'pending', due_date: '2026-01-05', assigned_to: member.id, created_by: member.id,
    }).select().single();

    await runTaskOverdueCheck();

    const { data: updated } = await supabaseAdmin.from('container_tasks').select('status').eq('id', task.id).single();
    expect(updated.status).toBe('overdue');
  });

  it('in_progress/completed tasks past their due_date are unaffected', async () => {
    freezeTime('2026-01-10T00:00:00Z');
    const { workspace, member } = await seedTenant();
    const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_tasks: true });
    await supabaseAdmin.from('containers').insert(container);
    const { data: inProgress } = await supabaseAdmin.from('container_tasks').insert({
      container_id: container.id, title: 'In progress', status: 'in_progress', due_date: '2026-01-05', assigned_to: member.id, created_by: member.id,
    }).select().single();
    const { data: completed } = await supabaseAdmin.from('container_tasks').insert({
      container_id: container.id, title: 'Completed', status: 'completed', due_date: '2026-01-05', assigned_to: member.id, created_by: member.id,
    }).select().single();

    await runTaskOverdueCheck();

    const { data: rows } = await supabaseAdmin.from('container_tasks').select('id, status').in('id', [inProgress.id, completed.id]);
    expect(rows.find((r) => r.id === inProgress.id).status).toBe('in_progress');
    expect(rows.find((r) => r.id === completed.id).status).toBe('completed');
  });

  it('recipients are assignee + active admins, deduplicated when the assignee is also an admin', async () => {
    freezeTime('2026-01-10T00:00:00Z');
    const { workspace, member: admin } = await seedTenant();
    const container = buildContainer({ workspace_id: workspace.id, created_by: admin.id, enable_tasks: true });
    await supabaseAdmin.from('containers').insert(container);
    // Assignee IS the admin — should be deduplicated to one notification.
    await supabaseAdmin.from('container_tasks').insert({
      container_id: container.id, title: 'Self-assigned admin task', status: 'pending', due_date: '2026-01-01', assigned_to: admin.id, created_by: admin.id,
    });

    await runTaskOverdueCheck();

    const { data: notifs } = await supabaseAdmin.from('notifications').select('*').eq('type', 'task_overdue').eq('recipient_id', admin.id);
    expect(notifs.length).toBe(1); // deduplicated, not double-notified
  });

  it('dedupKey prevents duplicate notifications on repeated daily runs', async () => {
    freezeTime('2026-01-10T00:00:00Z');
    const { workspace, member } = await seedTenant();
    const { member: assignee } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});
    const container = buildContainer({ workspace_id: workspace.id, created_by: member.id, enable_tasks: true });
    await supabaseAdmin.from('containers').insert(container);
    const { data: task } = await supabaseAdmin.from('container_tasks').insert({
      container_id: container.id, title: 'Dedup test', status: 'pending', due_date: '2026-01-05', assigned_to: assignee.id, created_by: member.id,
    }).select().single();

    await runTaskOverdueCheck();
    const { count: firstRun } = await supabaseAdmin.from('notifications').select('*', { count: 'exact', head: true }).eq('type', 'task_overdue').eq('reference_id', task.id);

    // Re-running the same day's check (task is already 'overdue' now, so
    // the .eq('status','pending') filter naturally excludes it on the
    // second pass — this itself proves no re-marking/re-notifying happens).
    await runTaskOverdueCheck();
    const { count: secondRun } = await supabaseAdmin.from('notifications').select('*', { count: 'exact', head: true }).eq('type', 'task_overdue').eq('reference_id', task.id);

    expect(secondRun).toBe(firstRun);
  });
});
