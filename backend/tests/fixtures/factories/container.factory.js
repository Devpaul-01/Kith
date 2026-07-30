// tests/fixtures/factories/container.factory.js
// Mirrors public.containers from schema.txt.

const crypto = require('crypto');

let containerCounter = 0;

function buildContainer(overrides = {}) {
  if (!overrides.workspace_id) {
    throw new Error('buildContainer requires an explicit workspace_id override');
  }

  containerCounter += 1;
  const now = new Date().toISOString();

  return {
    id: overrides.id || crypto.randomUUID(),
    workspace_id: overrides.workspace_id,
    name: `Test Container ${containerCounter}`,
    subtitle: null,
    description: null,
    cover_photos: [],
    container_type: 'event',
    enable_money: true,
    enable_tasks: false,
    event_date: null,
    event_type: null,
    event_type_category: 'other',
    recurrence_cadence: null,
    recurrence_days: null,
    recurrence_start: null,
    recurrence_end: null,
    carry_forward_unpaid: false,
    auto_generate_cycles: true,
    budget_target: null,
    budget_currency: null,
    public_token: null,
    public_show_names: true,
    status: 'active',
    outcome_details: null,
    outcome_files: [],
    converted_from_id: null,
    created_by: overrides.created_by || crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    completed_at: null,
    deleted_at: null,
    ...overrides,
  };
}

/** Convenience: a recurring pool container with the fields set_contributor_target/cycle-generation code paths expect. */
function buildRecurringContainer(overrides = {}) {
  return buildContainer({
    container_type: 'recurring',
    recurrence_cadence: 'monthly',
    recurrence_start: new Date().toISOString().split('T')[0],
    ...overrides,
  });
}

module.exports = { buildContainer, buildRecurringContainer };
