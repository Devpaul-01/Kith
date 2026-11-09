// Requires the real Postgres/PostgREST/Redis test stack with 001_schema.sql
// applied. Unit mocks cannot validate trigram operators, indexes, or SQL scope.
const { Pool } = require('pg');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { containsPattern } = require('../../../src/utils/ilike');
const { seedWorkspaceWithAdmin, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildProxyMember, buildContainer } = require('../../fixtures/factories');

describe('ranked entity search RPCs with Postgres', () => {
  const workspaceIds = [];

  async function search(rpcName, { workspaceId, query, limit = 11 }) {
    const { data, error } = await supabaseAdmin.rpc(rpcName, {
      p_workspace_id: workspaceId, p_query: query, p_pattern: containsPattern(query), p_limit: limit,
    });
    if (error) throw error;
    return data;
  }

  const searchMembers = (params) => search('search_members_ranked', params);
  const searchContainers = (params) => search('search_containers_ranked', params);

  async function seedTenant() {
    const tenant = await seedWorkspaceWithAdmin(supabaseAdmin, { member: { display_name: 'Xylophone' } });
    workspaceIds.push(tenant.workspace.id);
    return tenant;
  }

  async function addMember(workspaceId, name, overrides = {}) {
    const { data, error } = await supabaseAdmin.from('workspace_members').insert(buildProxyMember({
      workspace_id: workspaceId, display_name: name, ...overrides,
    })).select().single();
    if (error) throw error;
    return data;
  }

  async function addContainer(tenant, name, overrides = {}) {
    const { data, error } = await supabaseAdmin.from('containers').insert(buildContainer({
      workspace_id: tenant.workspace.id, created_by: tenant.member.id, name, ...overrides,
    })).select().single();
    if (error) throw error;
    return data;
  }

  afterAll(async () => {
    for (const workspaceId of workspaceIds) await cleanupWorkspace(supabaseAdmin, workspaceId);
  });

  it('finds a misspelled first name within a full member name', async () => {
    const { workspace } = await seedTenant();
    const member = await addMember(workspace.id, 'Adaeze Okafor');
    const result = await searchMembers({ workspaceId: workspace.id, query: 'Adaze' });
    expect(result).toEqual([expect.objectContaining({ id: member.id, match_type: 'fuzzy', is_proxy: true })]);
    expect(result[0].score).toBeGreaterThan(0.3);
    expect(result[0].score).toBeLessThan(1);
  });

  it('ranks exact names before substrings before fuzzy matches, returning all candidates', async () => {
    const { workspace } = await seedTenant();
    const fuzzy = await addMember(workspace.id, 'Adaze');
    const substring = await addMember(workspace.id, 'Adaeze Okafor');
    const exact = await addMember(workspace.id, 'Adaeze');
    const result = await searchMembers({ workspaceId: workspace.id, query: 'adaeze' });
    expect(result.map((candidate) => candidate.id)).toEqual([exact.id, substring.id, fuzzy.id]);
    expect(result.map((candidate) => candidate.match_type)).toEqual(['exact', 'substring', 'fuzzy']);
  });

  it('excludes inactive, deleted, and other-workspace members', async () => {
    const first = await seedTenant();
    const second = await seedTenant();
    const active = await addMember(first.workspace.id, 'Adaeze');
    await addMember(first.workspace.id, 'Adaeze', { is_active: false });
    await addMember(first.workspace.id, 'Adaeze', { deleted_at: new Date().toISOString() });
    await addMember(second.workspace.id, 'Adaeze');
    const result = await searchMembers({ workspaceId: first.workspace.id, query: 'Adaeze' });
    expect(result.map((candidate) => candidate.id)).toEqual([active.id]);
  });

  it('uses a deterministic order for duplicate names when limiting results', async () => {
    const { workspace } = await seedTenant();
    const members = [];
    for (let i = 0; i < 3; i += 1) members.push(await addMember(workspace.id, 'Adaeze'));
    const result = await searchMembers({ workspaceId: workspace.id, query: 'Adaeze', limit: 2 });
    expect(result.map((candidate) => candidate.id)).toEqual(members.map((member) => member.id).sort().slice(0, 2));
  });

  it('finds typo matches in container names and preserves exact-match priority', async () => {
    const tenant = await seedTenant();
    const fuzzy = await addContainer(tenant, 'Adaeze rent pool');
    const exact = await addContainer(tenant, 'Adaze');
    const result = await searchContainers({ workspaceId: tenant.workspace.id, query: 'Adaze' });
    expect(result.map((candidate) => candidate.id)).toEqual([exact.id, fuzzy.id]);
    expect(result[1].match_type).toBe('fuzzy');
  });

  it('includes archived containers but excludes deleted and other-workspace containers', async () => {
    const first = await seedTenant();
    const second = await seedTenant();
    const archived = await addContainer(first, 'Rent', { status: 'archived' });
    await addContainer(first, 'Rent', { deleted_at: new Date().toISOString() });
    await addContainer(second, 'Rent');
    const result = await searchContainers({ workspaceId: first.workspace.id, query: 'Rent' });
    expect(result).toEqual([expect.objectContaining({ id: archived.id, status: 'archived' })]);
  });

  it.each(['%_', '\\_'])('treats short ILIKE metacharacters literally: %s', async (query) => {
    const tenant = await seedTenant();
    const member = await addMember(tenant.workspace.id, `Member ${query} literal`);
    const container = await addContainer(tenant, `Container ${query} literal`);
    await addMember(tenant.workspace.id, 'Unrelated');
    await addContainer(tenant, 'Unrelated');
    const members = await searchMembers({ workspaceId: tenant.workspace.id, query });
    const containers = await searchContainers({ workspaceId: tenant.workspace.id, query });
    expect(members.map((candidate) => candidate.id)).toEqual([member.id]);
    expect(containers.map((candidate) => candidate.id)).toEqual([container.id]);
  });

  it('returns no match for an unrelated name or a deleted workspace', async () => {
    const tenant = await seedTenant();
    await addMember(tenant.workspace.id, 'Adaeze');
    await addContainer(tenant, 'Rent');
    expect(await searchMembers({ workspaceId: tenant.workspace.id, query: 'Zqvjkx' })).toEqual([]);
    expect(await searchContainers({ workspaceId: tenant.workspace.id, query: 'Zqvjkx' })).toEqual([]);
    const { error } = await supabaseAdmin.from('workspaces').update({ deleted_at: new Date().toISOString() }).eq('id', tenant.workspace.id);
    if (error) throw error;
    expect(await searchMembers({ workspaceId: tenant.workspace.id, query: 'Adaeze' })).toEqual([]);
    expect(await searchContainers({ workspaceId: tenant.workspace.id, query: 'Rent' })).toEqual([]);
  });

  it('has indexes and keeps the RPCs unavailable to PUBLIC and existing browser roles', async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:test@localhost:54322/kith_test' });
    try {
      const { rows: functions } = await pool.query(`
        SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig, p.proacl FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN (
          'search_members_ranked', 'search_containers_ranked', 'search_tasks_ranked',
          'search_ledger_entries_ranked', 'search_disputes_ranked', 'search_groups_ranked'
        )
      `);
      expect(functions).toHaveLength(6);
      for (const fn of functions) {
        expect(fn.prosecdef).toBe(false);
        expect(fn.provolatile).toBe('s');
        expect(fn.proconfig).toEqual(expect.arrayContaining([
          'search_path=pg_catalog, public, extensions, pg_temp', 'pg_trgm.word_similarity_threshold=0.3',
        ]));
        expect(fn.proacl).not.toBeNull();
        const { rows: publicGrants } = await pool.query('SELECT * FROM aclexplode($1::aclitem[]) WHERE grantee = 0', [fn.proacl]);
        expect(publicGrants).toEqual([]);
        const { rows: browserGrants } = await pool.query(`
          SELECT rolname, has_function_privilege(oid, $1::oid, 'EXECUTE') AS can_execute
          FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
        `, [fn.oid]);
        browserGrants.forEach((role) => expect(role.can_execute).toBe(false));
        const { rows: serviceGrants } = await pool.query(`
          SELECT has_function_privilege(oid, $1::oid, 'EXECUTE') AS can_execute
          FROM pg_roles WHERE rolname = 'service_role'
        `, [fn.oid]);
        serviceGrants.forEach((role) => expect(role.can_execute).toBe(true));
      }
      const { rows: indexes } = await pool.query(`
        SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN (
          'idx_workspace_members_display_name_trgm', 'idx_containers_name_trgm', 'idx_tasks_title_trgm',
          'idx_ledger_note_trgm', 'idx_disputes_reason_trgm', 'idx_groups_name_trgm'
        )
      `);
      expect(indexes).toHaveLength(6);
      indexes.forEach((index) => expect(index.indexdef).toMatch(/USING gin/));
    } finally {
      await pool.end();
    }
  });
});
