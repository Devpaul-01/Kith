// Requires the real Postgres/PostgREST/Redis test stack. These assertions cover
// append-only audit constraints and conditional updates that mocks cannot prove.
const { randomUUID } = require('crypto');
const { supabaseAdmin } = require('../../../src/config/supabase');
const inbox = require('../../../src/services/notification_inbox.service');
const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');

describe('notification proposal database boundaries', () => {
  const workspaceIds = [];
  async function tenant() {
    const result = await seedWorkspaceWithAdmin(supabaseAdmin);
    workspaceIds.push(result.workspace.id);
    return result;
  }
  async function notification(owner) {
    const { data, error } = await supabaseAdmin.from('notifications').insert({
      workspace_id: owner.workspace.id, recipient_id: owner.member.id,
      type: 'task.assigned', title: 'Task ready', is_read: false,
    }).select().single();
    if (error) throw error;
    return data;
  }
  afterAll(async () => { for (const id of workspaceIds) await cleanupWorkspace(supabaseAdmin, id); });

  it('loads only the current active membership in a live workspace', async () => {
    const owner = await tenant();
    const other = await seedAdditionalMember(supabaseAdmin, owner.workspace.id);
    expect((await members.getActiveMembership({ workspaceId: owner.workspace.id, userId: owner.user.id })).id).toBe(owner.member.id);
    const { error } = await supabaseAdmin.from('workspace_members').update({ is_active: false }).eq('id', other.member.id);
    if (error) throw error;
    await expect(members.getActiveMembership({ workspaceId: owner.workspace.id, userId: other.user.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const removed = await supabaseAdmin.from('workspaces').update({ deleted_at: new Date().toISOString() }).eq('id', owner.workspace.id);
    if (removed.error) throw removed.error;
    await expect(members.getActiveMembership({ workspaceId: owner.workspace.id, userId: owner.user.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('scopes previews to both recipient and workspace', async () => {
    const owner = await tenant();
    const other = await tenant();
    const item = await notification(owner);
    for (const params of [
      { memberId: other.member.id, workspaceId: owner.workspace.id },
      { memberId: owner.member.id, workspaceId: other.workspace.id },
    ]) {
      await expect(inbox.getNotification({ notificationId: item.id, ...params })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('applies the unread transition once under concurrent conditional updates', async () => {
    const owner = await tenant();
    const item = await notification(owner);
    const params = { notificationId: item.id, memberId: owner.member.id, workspaceId: owner.workspace.id };
    const expectedNotification = await inbox.getNotification(params);
    const outcomes = await Promise.allSettled([
      inbox.markAsRead({ ...params, expectedNotification }), inbox.markAsRead({ ...params, expectedNotification }),
    ]);
    const success = outcomes.filter((result) => result.status === 'fulfilled');
    expect(success).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected').reason.code).toBe('CONFLICT');
    expect((await inbox.getNotification(params)).read_at).toBe(success[0].value.read_at);
  });

  it('rejects a changed preview without changing its read state', async () => {
    const owner = await tenant();
    const item = await notification(owner);
    const params = { notificationId: item.id, memberId: owner.member.id, workspaceId: owner.workspace.id };
    const expectedNotification = await inbox.getNotification(params);
    const { error } = await supabaseAdmin.from('notifications').update({ title: 'Changed' }).eq('id', item.id);
    if (error) throw error;
    await expect(inbox.markAsRead({ ...params, expectedNotification })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await inbox.getNotification(params)).is_read).toBe(false);
  });

  it('deduplicates required audit events without changing an append-only record', async () => {
    const owner = await tenant();
    const id = randomUUID();
    const entry = { id, required: true, workspaceId: owner.workspace.id, actorUserId: owner.user.id, actorMemberId: owner.member.id,
      action: AUDIT_ACTIONS.AGENT_ACTION_APPROVED, metadata: { original: true } };
    await audit.log(entry);
    await audit.log({ ...entry, metadata: { original: false } });
    const { data, error } = await supabaseAdmin.from('audit_log').select('id, metadata').eq('id', id);
    if (error) throw error;
    expect(data).toEqual([{ id, metadata: { original: true } }]);
  });
});
