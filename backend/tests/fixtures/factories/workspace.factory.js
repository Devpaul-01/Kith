// tests/fixtures/factories/workspace.factory.js
//
// Factory FUNCTIONS, not static JSON fixtures — every test produces a
// minimal valid object and overrides only what's relevant to that test
// (Doc 4 Section 2.1). Mirrors public.workspaces from schema.txt.

const crypto = require('crypto');

let workspaceCounter = 0;

function buildWorkspace(overrides = {}) {
  workspaceCounter += 1;
  const now = new Date().toISOString();
  return {
    id: overrides.id || crypto.randomUUID(),
    name: `Test Workspace ${workspaceCounter}`,
    base_currency: 'USD',
    family_type: 'extended',
    description: null,
    avatar_url: null,
    bank_details: {},
    visibility: 'private',
    created_by: overrides.created_by || crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  };
}

function buildWorkspaceSettingsRow(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    workspace_id: overrides.workspace_id, // required — no default, force explicitness
    setting_key: overrides.setting_key || 'notification_prefs',
    setting_value: overrides.setting_value || { reminder_days_before: [3, 1], overdue_notify_after_days: [3, 7], weekly_digest_enabled: true },
    updated_by: overrides.updated_by || null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

module.exports = { buildWorkspace, buildWorkspaceSettingsRow };
