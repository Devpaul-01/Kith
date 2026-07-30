// tests/fixtures/factories/participant.factory.js
// Mirrors public.container_participants and public.contributor_targets.

const crypto = require('crypto');

function buildParticipant(overrides = {}) {
  if (!overrides.container_id) throw new Error('buildParticipant requires an explicit container_id override');
  if (!overrides.workspace_member_id) throw new Error('buildParticipant requires an explicit workspace_member_id override');

  return {
    id: overrides.id || crypto.randomUUID(),
    container_id: overrides.container_id,
    workspace_member_id: overrides.workspace_member_id,
    role: null,
    money_enabled: true,
    tasks_enabled: false,
    notes: null,
    exclude_from_public: false,
    added_at: new Date().toISOString(),
    added_by: overrides.added_by || null,
    ...overrides,
  };
}

function buildContributorTarget(overrides = {}) {
  if (!overrides.container_participant_id) throw new Error('buildContributorTarget requires container_participant_id');
  if (!overrides.container_id) throw new Error('buildContributorTarget requires container_id');
  if (!overrides.workspace_member_id) throw new Error('buildContributorTarget requires workspace_member_id');

  return {
    id: overrides.id || crypto.randomUUID(),
    container_participant_id: overrides.container_participant_id,
    container_id: overrides.container_id,
    workspace_member_id: overrides.workspace_member_id,
    cycle_id: overrides.cycle_id !== undefined ? overrides.cycle_id : null,
    target_amount: 100,
    target_currency: 'USD',
    due_date: null,
    is_current: true,
    superseded_by: null,
    superseded_at: null,
    set_by: overrides.set_by || crypto.randomUUID(),
    set_at: new Date().toISOString(),
    ...overrides,
  };
}

module.exports = { buildParticipant, buildContributorTarget };
