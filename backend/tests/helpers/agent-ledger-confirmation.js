const { context, member, OTHER_ID } = require('./agent-proposal');
const {
  CONTAINER_ID, PARTICIPANT_ID, ENTRY_ID, submittedEntry, participantRow,
} = require('./agent-ledger-proposal');

const adminContext = () => ({ ...context(), member: { ...context().member, role: 'admin' } });
const adminMember = (overrides = {}) => ({ ...member(), role: 'admin', is_proxy: false, deleted_at: null, ...overrides });
const contributor = (overrides = {}) => ({
  id: OTHER_ID, workspace_id: context().workspace.id,
  user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', display_name: 'Emeka',
  role: 'member', is_active: true, is_proxy: false, deleted_at: null, ...overrides,
});
const confirmationParticipant = (overrides = {}) => participantRow({ workspace_member_id: OTHER_ID, ...overrides });
const confirmationEntry = (overrides = {}) => submittedEntry({
  contributor_id: OTHER_ID, recorded_by: OTHER_ID, proofs: [], ...overrides,
});
const confirmationSnapshot = (overrides = {}) => ({
  entry_id: ENTRY_ID, workspace_id: context().workspace.id, container_id: CONTAINER_ID,
  contributor_id: OTHER_ID, entry_type: 'contribution', original_amount: '5000.00',
  original_currency: 'NGN', base_amount: '5000.00', payment_method: 'bank_transfer',
  note: 'Family groceries', cycle_id: null, is_crypto: false, proofs: [], status: 'pending',
  corrects_entry_id: null, recorded_by: OTHER_ID, recorded_at: '2026-11-14T12:01:00.000Z',
  confirmed_at: null, confirmed_by: null, ...overrides,
});
const confirmationContext = (overrides = {}) => ({
  ...confirmationSnapshot(), base_currency: 'NGN', container_name: 'Family groceries',
  container_type: 'event', container_status: 'active', enable_money: true,
  container_updated_at: '2026-11-14T12:00:00.000Z',
  actor_member_id: context().member.id, member_role: 'admin',
  contributor_display_name: 'Emeka', contributor_role: 'member',
  participant_id: PARTICIPANT_ID, money_enabled: true, ...overrides,
});
const confirmationAfter = (overrides = {}) => confirmationSnapshot({
  status: 'confirmed', confirmed_by: context().member.id, confirmed_at: 'on_approval', ...overrides,
});
const confirmationResult = (overrides = {}) => confirmationAfter({
  confirmed_at: '2026-11-14T12:02:00.000Z', ...overrides,
});
const confirmedEntry = (overrides = {}) => confirmationEntry({
  status: 'confirmed', confirmed_by: context().member.id,
  confirmed_at: '2026-11-14T12:02:00.000Z', ...overrides,
});

module.exports = {
  CONTAINER_ID, PARTICIPANT_ID, ENTRY_ID, adminContext, adminMember, contributor,
  confirmationParticipant, confirmationEntry, confirmationSnapshot, confirmationContext,
  confirmationAfter, confirmationResult, confirmedEntry,
};
