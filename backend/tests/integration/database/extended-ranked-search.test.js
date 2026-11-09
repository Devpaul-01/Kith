// Requires the real Postgres/PostgREST/Redis test stack and the approved
// additions in 001_schema.sql. Unit mocks cannot verify SQL visibility or ranking.
const { randomUUID } = require('crypto');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { containsPattern } = require('../../../src/utils/ilike');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildContainer, buildTask, buildLedgerEntry, buildDispute, buildGroup } = require('../../fixtures/factories');

const workspaceIds = [];
async function insert(table, row) {
  const { data, error } = await supabaseAdmin.from(table).insert(row).select().single();
  if (error) throw error;
  return data;
}
async function update(table, id, data) {
  const { error } = await supabaseAdmin.from(table).update(data).eq('id', id);
  if (error) throw error;
}
async function seedTenant(displayName = 'Zinnia') {
  const tenant = await seedWorkspaceWithAdmin(supabaseAdmin, { member: { display_name: 'Xylophone' } });
  workspaceIds.push(tenant.workspace.id);
  const { member: caller } = await seedAdditionalMember(supabaseAdmin, tenant.workspace.id, { member: { display_name: displayName } });
  const container = await insert('containers', buildContainer({
    workspace_id: tenant.workspace.id, created_by: tenant.member.id, name: 'General',
  }));
  return { ...tenant, caller, container };
}
const addTask = (tenant, title, overrides = {}) => insert('container_tasks', buildTask({
  container_id: tenant.container.id, created_by: tenant.member.id, assigned_to: tenant.caller.id, title, ...overrides,
}));
const addEntry = (tenant, note, overrides = {}) => insert('ledger_entries', buildLedgerEntry({
  workspace_id: tenant.workspace.id, container_id: tenant.container.id,
  contributor_id: tenant.caller.id, recorded_by: tenant.member.id, note, ...overrides,
}));
async function addDispute(tenant, reason, overrides = {}) {
  const entryId = overrides.ledger_entry_id || (await addEntry(tenant, 'Unrelated', {
    status: 'confirmed', confirmed_by: tenant.member.id, confirmed_at: new Date().toISOString(),
  })).id;
  return insert('disputes', buildDispute({
    workspace_id: tenant.workspace.id, ledger_entry_id: entryId, raised_by: tenant.caller.id, reason, ...overrides,
  }));
}
const addGroup = (tenant, name, overrides = {}) => insert('groups', buildGroup({
  workspace_id: tenant.workspace.id, created_by: tenant.member.id, name, ...overrides,
}));
const definitions = [
  { label: 'tasks', rpc: 'search_tasks_ranked', create: addTask, ownerKey: 'assigned_to', containerFilter: true },
  { label: 'ledger entries', rpc: 'search_ledger_entries_ranked', create: addEntry, ownerKey: 'contributor_id', containerFilter: true },
  { label: 'disputes', rpc: 'search_disputes_ranked', create: addDispute, ownerKey: 'raised_by' },
  { label: 'groups', rpc: 'search_groups_ranked', create: addGroup },
];
async function search(definition, tenant, {
  query = 'Rent', limit = 11, callerId = tenant.caller.id, isAdmin = false, containerId = null,
} = {}) {
  const { data, error } = await supabaseAdmin.rpc(definition.rpc, {
    p_workspace_id: tenant.workspace.id, p_query: query, p_pattern: containsPattern(query), p_limit: limit,
    ...(definition.ownerKey ? { p_caller_id: callerId, p_is_admin: isAdmin } : {}),
    ...(definition.containerFilter ? { p_container_id: containerId } : {}),
  });
  if (error) throw error;
  return data;
}
const ids = (rows) => rows.map((row) => row.id).sort();

afterAll(async () => {
  for (const workspaceId of workspaceIds.reverse()) await cleanupWorkspace(supabaseAdmin, workspaceId);
});

describe.each(definitions)('ranked $label SQL', (definition) => {
  it('ranks exact text before literal substrings and typos', async () => {
    const tenant = await seedTenant();
    const fuzzy = await definition.create(tenant, 'Adaze');
    const substring = await definition.create(tenant, 'Adaeze Okafor');
    const exact = await definition.create(tenant, 'Adaeze');
    const result = await search(definition, tenant, { query: 'adaeze' });
    expect(result.map((row) => row.id)).toEqual([exact.id, substring.id, fuzzy.id]);
    expect(result.map((row) => row.match_type)).toEqual(['exact', 'substring', 'fuzzy']);
    expect(result[2].score).toBeGreaterThan(0.3);
    expect(result[2].score).toBeLessThan(1);
  });

  it.each(['%_', '\\_'])('treats short wildcard characters literally: %s', async (query) => {
    const tenant = await seedTenant();
    const literal = await definition.create(tenant, `Literal ${query} text`);
    await definition.create(tenant, 'Unrelated');
    expect(ids(await search(definition, tenant, { query }))).toEqual([literal.id]);
  });

  it('preserves deterministic ID ordering and caps even a large requested limit', async () => {
    const tenant = await seedTenant();
    const rows = [];
    for (let i = 0; i < 23; i += 1) rows.push(await definition.create(tenant, 'Rent'));
    const expected = ids(rows);
    const bounded = await search(definition, tenant, { limit: 999 });
    expect(bounded.map((row) => row.id)).toEqual(expected.slice(0, 21));
    expect((await search(definition, tenant, { limit: 2 })).map((row) => row.id)).toEqual(expected.slice(0, 2));
    expect((await search(definition, tenant, { limit: 1 })).map((row) => row.id)).toEqual(expected.slice(0, 2));
  });

  it('excludes other workspaces, unmatched text and deleted workspaces', async () => {
    const tenant = await seedTenant();
    const other = await seedTenant();
    const visible = await definition.create(tenant, 'Rent');
    await definition.create(other, 'Rent');
    expect(ids(await search(definition, tenant, { callerId: tenant.member.id, isAdmin: true }))).toEqual([visible.id]);
    expect(await search(definition, tenant, { query: 'Zqvjkx' })).toEqual([]);
    await update('workspaces', tenant.workspace.id, { deleted_at: new Date().toISOString() });
    expect(await search(definition, tenant, { callerId: tenant.member.id, isAdmin: true })).toEqual([]);
  });

  it('rejects short or oversized queries in SQL even if the service validation was skipped', async () => {
    const tenant = await seedTenant();
    await definition.create(tenant, 'Rent');
    for (const query of ['', 'R', '9'.repeat(201)]) {
      expect(await search(definition, tenant, { query })).toEqual([]);
    }
  });
});

describe.each(definitions.filter((definition) => definition.ownerKey))('$label ownership in SQL', (definition) => {
  it('limits members to their own records and requires both admin sources for broader visibility', async () => {
    const tenant = await seedTenant();
    const own = await definition.create(tenant, 'Rent');
    const other = await definition.create(tenant, 'Rent', { [definition.ownerKey]: tenant.member.id });
    const all = [own, other];
    if (definition.containerFilter) all.push(await definition.create(tenant, 'Rent', { [definition.ownerKey]: null }));
    expect(ids(await search(definition, tenant))).toEqual([own.id]);
    // A stale or forged admin flag must not promote an actual member.
    expect(ids(await search(definition, tenant, { isAdmin: true }))).toEqual([own.id]);
    expect(ids(await search(definition, tenant, { callerId: tenant.member.id, isAdmin: true }))).toEqual(ids(all));
    expect(ids(await search(definition, tenant, { callerId: tenant.member.id, isAdmin: false }))).toEqual([other.id]);
  });

  it('requires a current membership in the requested workspace, including for claimed admins', async () => {
    const tenant = await seedTenant();
    const other = await seedTenant();
    await definition.create(tenant, 'Rent');
    for (const callerId of [null, randomUUID(), other.member.id]) {
      expect(await search(definition, tenant, { callerId, isAdmin: true })).toEqual([]);
    }
    await update('workspace_members', tenant.caller.id, { role: 'admin', is_active: false });
    expect(await search(definition, tenant, { isAdmin: true })).toEqual([]);
    await update('workspace_members', tenant.caller.id, { is_active: true, deleted_at: new Date().toISOString() });
    expect(await search(definition, tenant, { isAdmin: true })).toEqual([]);
  });
});

describe.each(definitions.filter((definition) => definition.containerFilter))('$label container boundaries', (definition) => {
  it('honors container filters without allowing a foreign or deleted parent', async () => {
    const tenant = await seedTenant();
    const foreign = await seedTenant();
    const secondContainer = await insert('containers', buildContainer({ workspace_id: tenant.workspace.id, created_by: tenant.member.id }));
    const first = await definition.create(tenant, 'Rent');
    const second = await definition.create(tenant, 'Rent', { container_id: secondContainer.id });
    await definition.create(foreign, 'Rent', { [definition.ownerKey]: tenant.caller.id });
    expect(ids(await search(definition, tenant))).toEqual(ids([first, second]));
    expect(ids(await search(definition, tenant, { containerId: secondContainer.id }))).toEqual([second.id]);
    expect(await search(definition, tenant, { containerId: foreign.container.id, isAdmin: true, callerId: tenant.member.id })).toEqual([]);
    await update('containers', tenant.container.id, { deleted_at: new Date().toISOString() });
    expect(ids(await search(definition, tenant))).toEqual([second.id]);
    expect(await search(definition, tenant, { containerId: tenant.container.id })).toEqual([]);
  });
});

it('excludes soft-deleted tasks even for admins', async () => {
  const tenant = await seedTenant();
  await addTask(tenant, 'Rent', { deleted_at: new Date().toISOString() });
  expect(await search(definitions[0], tenant, { callerId: tenant.member.id, isAdmin: true })).toEqual([]);
});

it('matches ledger notes and contributor names without exposing joined private fields', async () => {
  const tenant = await seedTenant('Adaeze Okafor');
  const entry = await addEntry(tenant, 'House repairs', { proofs: [{ url: 'PRIVATE_FILE' }] });
  const result = await search(definitions[1], tenant, { query: 'Adaze' });
  expect(result).toEqual([expect.objectContaining({ id: entry.id, contributor_name: 'Adaeze Okafor', match_type: 'fuzzy' })]);
  expect(ids(await search(definitions[1], tenant, { query: 'House repairs' }))).toEqual([entry.id]);
  expect(result[0]).not.toHaveProperty('proofs');
  expect(result[0]).not.toHaveProperty('base_amount');
  expect(result[0]).not.toHaveProperty('recorded_by');
});

it('matches exact original decimals in SQL and retains separate currencies and signed corrections', async () => {
  const tenant = await seedTenant();
  const ngn = await addEntry(tenant, null, { original_amount: '5000.10', original_currency: 'NGN' });
  const usd = await addEntry(tenant, null, { original_amount: '5000.10', original_currency: 'USD' });
  await addEntry(tenant, null, { original_amount: '5000.11' });
  const large = await addEntry(tenant, null, { original_amount: '9999999999999.99' });
  const negative = await addEntry(tenant, null, { original_amount: '-0.01', entry_type: 'correction', corrects_entry_id: ngn.id });
  const result = await search(definitions[1], tenant, { query: '+5000.1' });
  expect(ids(result)).toEqual(ids([ngn, usd]));
  expect(result.map((row) => row.original_currency).sort()).toEqual(['NGN', 'USD']);
  result.forEach((row) => expect(row).toMatchObject({ original_amount: '5000.10', match_type: 'exact' }));
  expect(await search(definitions[1], tenant, { query: '9999999999999.99' }))
    .toEqual([expect.objectContaining({ id: large.id, original_amount: '9999999999999.99' })]);
  expect(await search(definitions[1], tenant, { query: '-0.01' }))
    .toEqual([expect.objectContaining({ id: negative.id, original_amount: '-0.01', entry_type: 'correction' })]);
  for (const query of ['5,000.10', '5e3', '5000.100', '999999999999999999999999999999.99']) {
    expect(await search(definitions[1], tenant, { query })).toEqual([]);
  }
});

it('requires both ledger and container workspace IDs and scopes contributor joins', async () => {
  const tenant = await seedTenant();
  const foreign = await seedTenant('Quetzalforeign');
  await addEntry(tenant, 'Rent', { container_id: foreign.container.id });
  await addEntry(tenant, 'Rent', { workspace_id: foreign.workspace.id });
  const visible = await addEntry(tenant, 'Rent', { contributor_id: foreign.caller.id });
  const result = await search(definitions[1], tenant, { callerId: tenant.member.id, isAdmin: true });
  expect(result).toEqual([expect.objectContaining({ id: visible.id, contributor_name: null })]);
  expect(await search(definitions[1], tenant, { query: 'Quetzalforeign', callerId: tenant.member.id, isAdmin: true })).toEqual([]);
});

it('finds historical disputes by raiser or ledger note even after their container is deleted', async () => {
  const tenant = await seedTenant('Adaeze Okafor');
  const entry = await addEntry(tenant, 'Receipt reference');
  const dispute = await addDispute(tenant, 'Wrong amount', { ledger_entry_id: entry.id, notes: [{ note: 'PRIVATE_NOTE' }] });
  await update('containers', tenant.container.id, { deleted_at: new Date().toISOString() });
  const result = await search(definitions[2], tenant, { query: 'Receipt reference' });
  expect(result).toEqual([expect.objectContaining({ id: dispute.id, ledger_entry_id: entry.id, match_type: 'exact' })]);
  expect(result[0]).not.toHaveProperty('notes');
  expect(result[0]).not.toHaveProperty('note');
  expect(ids(await search(definitions[2], tenant, { query: 'Adaze' }))).toEqual([dispute.id]);
});

it('does not match dispute candidates through foreign member names or ledger notes', async () => {
  const tenant = await seedTenant();
  const foreign = await seedTenant('Quetzalforeign');
  const entry = await addEntry(foreign, 'Privatereceipt');
  const dispute = await addDispute(tenant, 'Localreason', { raised_by: foreign.caller.id, ledger_entry_id: entry.id });
  const asAdmin = { callerId: tenant.member.id, isAdmin: true };
  expect(await search(definitions[2], tenant, { ...asAdmin, query: 'Localreason' }))
    .toEqual([expect.objectContaining({ id: dispute.id, raised_by_name: null })]);
  expect(await search(definitions[2], tenant, { ...asAdmin, query: 'Quetzalforeign' })).toEqual([]);
  expect(await search(definitions[2], tenant, { ...asAdmin, query: 'Privatereceipt' })).toEqual([]);
});
