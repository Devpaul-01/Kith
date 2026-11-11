const context = () => ({
  userId: '11111111-1111-4111-8111-111111111111',
  member: { id: '22222222-2222-4222-8222-222222222222', workspaceId: '33333333-3333-4333-8333-333333333333', isActive: true, role: 'member', displayName: 'Adaeze' },
  workspace: { id: '33333333-3333-4333-8333-333333333333', name: 'Family', baseCurrency: 'NGN' },
});
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_NOTIFICATION_ID = '66666666-6666-4666-8666-666666666666';
const snapshot = () => ({
  id: '55555555-5555-4555-8555-555555555555', type: 'task.assigned', title: 'Your task is ready',
  is_read: false, read_at: null, created_at: '2026-11-09T12:00:00.000Z',
});
const row = () => ({ ...snapshot(), workspace_id: context().workspace.id, recipient_id: context().member.id });
const secondSnapshot = () => ({
  ...snapshot(), id: SECOND_NOTIFICATION_ID, title: 'Another unread notification', created_at: '2026-11-09T11:00:00.000Z',
});
const secondRow = () => ({ ...secondSnapshot(), workspace_id: context().workspace.id, recipient_id: context().member.id });
const member = () => ({ id: context().member.id, workspace_id: context().workspace.id, user_id: context().userId, role: 'member', is_active: true });
module.exports = {
  context, snapshot, row, secondSnapshot, secondRow, member, OTHER_ID, SECOND_NOTIFICATION_ID,
};
