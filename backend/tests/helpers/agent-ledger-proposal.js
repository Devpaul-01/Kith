const { context, member } = require('./agent-proposal');

const CONTAINER_ID = '77777777-7777-4777-8777-777777777777';
const PARTICIPANT_ID = '99999999-9999-4999-8999-999999999999';
const ENTRY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ledgerContext = (overrides = {}) => ({
  workspace_id: context().workspace.id, base_currency: 'NGN',
  container_id: CONTAINER_ID, container_name: 'Family groceries',
  container_type: 'event', container_status: 'active', enable_money: true,
  container_updated_at: '2026-11-14T12:00:00.000Z',
  contributor_id: context().member.id, member_role: 'member',
  participant_id: PARTICIPANT_ID, money_enabled: true, ...overrides,
});
const workspaceRow = (overrides = {}) => ({
  id: context().workspace.id, base_currency: 'NGN', deleted_at: null, ...overrides,
});
const ledgerMember = (overrides = {}) => ({ ...member(), is_proxy: false, deleted_at: null, ...overrides });
const containerRow = (overrides = {}) => ({
  id: CONTAINER_ID, workspace_id: context().workspace.id, name: 'Family groceries',
  container_type: 'event', status: 'active', enable_money: true, deleted_at: null,
  updated_at: ledgerContext().container_updated_at, ...overrides,
});
const participantRow = (overrides = {}) => ({
  id: PARTICIPANT_ID, container_id: CONTAINER_ID, workspace_member_id: context().member.id,
  money_enabled: true, ...overrides,
});
const ledgerArguments = () => ({
  amount: '5000.00', currency: 'NGN', payment_method: 'bank_transfer', note: 'Family groceries',
});
const submittedEntry = (overrides = {}) => ({
  id: ENTRY_ID, workspace_id: context().workspace.id, container_id: CONTAINER_ID,
  contributor_id: context().member.id, recorded_by: context().member.id,
  entry_type: 'contribution', original_amount: 5000, original_currency: 'NGN', base_amount: 5000,
  payment_method: 'bank_transfer', note: 'Family groceries', cycle_id: null, is_crypto: false,
  corrects_entry_id: null,
  status: 'pending', confirmed_at: null, confirmed_by: null,
  recorded_at: '2026-11-14T12:01:00.000Z',
  proofs: [{ storage_path: 'PRIVATE_LEDGER_PROOF' }], ...overrides,
});

module.exports = {
  CONTAINER_ID, PARTICIPANT_ID, ENTRY_ID, ledgerContext, workspaceRow, ledgerMember,
  containerRow, participantRow, ledgerArguments, submittedEntry,
};
