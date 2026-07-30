// tests/helpers/dbHelper.js
//
// Composite seed helpers for INTEGRATION tests (real Postgres, real
// Redis). Reduce the ~10-line boilerplate every integration test would
// otherwise repeat to get a valid tenant + authenticated actor in place
// before exercising the endpoint under test.
//
// ID NAMESPACING CONVENTION (Doc 4 Section 2.4) — READ THIS BEFORE
// WRITING A NEW TEST FILE:
//
//   Redis is FLUSHDB'd between test FILES (see tests/setup.integration.js
//   beforeAll/afterAll), NOT between individual tests within the same
//   file. Every test within a file that touches Redis-cached data —
//   membership cache (middleware/workspace.js), rate limiters
//   (middleware/rateLimiter.js), last-seen debounce (middleware/auth.js)
//   — MUST use a freshly-generated workspace/user ID per test (which
//   these seed helpers already do, via the factories' internal counters
//   + crypto.randomUUID()) rather than a shared constant ID declared
//   once at the top of a `describe` block. Reusing one seeded
//   workspace/user across multiple tests in the same file risks one
//   test's cached membership state (e.g. a stale cached `role` after a
//   promote/demote test) leaking into the next test. When in doubt, call
//   seedWorkspaceWithAdmin() (or the other seeders below) fresh inside
//   each `test()`/`it()`, not once in a `beforeAll`.

const { buildWorkspace, buildUser, buildMember, buildContainer, buildParticipant, buildLedgerEntry, buildGroup, buildMilestone, buildInviteLink } = require('../fixtures/factories');

/**
 * Seeds a workspace + an admin user/member for it. The most common
 * starting point for integration tests.
 *
 * @returns {Promise<{workspace, user, member}>}
 */
async function seedWorkspaceWithAdmin(supabaseAdmin, overrides = {}) {
  const { data: workspace, error: wErr } = await supabaseAdmin
    .from('workspaces')
    .insert(buildWorkspace(overrides.workspace))
    .select()
    .single();
  if (wErr) throw new Error(`seedWorkspaceWithAdmin: workspace insert failed: ${wErr.message}`);

  const { data: user, error: uErr } = await supabaseAdmin
    .from('users')
    .insert(buildUser(overrides.user))
    .select()
    .single();
  if (uErr) throw new Error(`seedWorkspaceWithAdmin: user insert failed: ${uErr.message}`);

  const { data: member, error: mErr } = await supabaseAdmin
    .from('workspace_members')
    .insert(buildMember({ workspace_id: workspace.id, user_id: user.id, role: 'admin', ...overrides.member }))
    .select()
    .single();
  if (mErr) throw new Error(`seedWorkspaceWithAdmin: member insert failed: ${mErr.message}`);

  return { workspace, user, member };
}

/**
 * Seeds an additional (non-admin, by default) member + user into an
 * EXISTING workspace. Use after seedWorkspaceWithAdmin() when a test
 * needs a second actor (e.g. testing requireSelfOrAdmin, or a
 * non-admin's restricted view of an endpoint).
 */
async function seedAdditionalMember(supabaseAdmin, workspaceId, overrides = {}) {
  const { data: user, error: uErr } = await supabaseAdmin
    .from('users')
    .insert(buildUser(overrides.user))
    .select()
    .single();
  if (uErr) throw new Error(`seedAdditionalMember: user insert failed: ${uErr.message}`);

  const { data: member, error: mErr } = await supabaseAdmin
    .from('workspace_members')
    .insert(buildMember({ workspace_id: workspaceId, user_id: user.id, role: 'member', ...overrides.member }))
    .select()
    .single();
  if (mErr) throw new Error(`seedAdditionalMember: member insert failed: ${mErr.message}`);

  return { user, member };
}

/**
 * Seeds a container in an existing workspace, with an optional set of
 * participants (each { workspace_member_id, ...participantOverrides }).
 */
async function seedContainerWithParticipants(supabaseAdmin, { workspaceId, createdBy, containerOverrides = {}, participants = [] }) {
  const { data: container, error: cErr } = await supabaseAdmin
    .from('containers')
    .insert(buildContainer({ workspace_id: workspaceId, created_by: createdBy, ...containerOverrides }))
    .select()
    .single();
  if (cErr) throw new Error(`seedContainerWithParticipants: container insert failed: ${cErr.message}`);

  const seededParticipants = [];
  for (const p of participants) {
    const { data: participant, error: pErr } = await supabaseAdmin
      .from('container_participants')
      .insert(buildParticipant({ container_id: container.id, ...p }))
      .select()
      .single();
    if (pErr) throw new Error(`seedContainerWithParticipants: participant insert failed: ${pErr.message}`);
    seededParticipants.push(participant);
  }

  return { container, participants: seededParticipants };
}

/**
 * Seeds a single ledger entry against an existing workspace/container.
 */
async function seedLedgerEntry(supabaseAdmin, overrides = {}) {
  const { data: entry, error } = await supabaseAdmin
    .from('ledger_entries')
    .insert(buildLedgerEntry(overrides))
    .select()
    .single();
  if (error) throw new Error(`seedLedgerEntry: insert failed: ${error.message}`);
  return entry;
}

/**
 * Seeds a group in an existing workspace, with optional member ids added.
 */
async function seedGroupWithMembers(supabaseAdmin, { workspaceId, createdBy, groupOverrides = {}, memberIds = [] }) {
  const { data: group, error: gErr } = await supabaseAdmin
    .from('groups')
    .insert(buildGroup({ workspace_id: workspaceId, created_by: createdBy, ...groupOverrides }))
    .select()
    .single();
  if (gErr) throw new Error(`seedGroupWithMembers: group insert failed: ${gErr.message}`);

  if (memberIds.length) {
    const rows = memberIds.map((id) => ({ group_id: group.id, workspace_member_id: id, added_by: createdBy }));
    const { error: gmErr } = await supabaseAdmin.from('group_members').insert(rows);
    if (gmErr) throw new Error(`seedGroupWithMembers: group_members insert failed: ${gmErr.message}`);
  }

  return group;
}

/**
 * Seeds a milestone in an existing workspace.
 */
async function seedMilestone(supabaseAdmin, overrides = {}) {
  const { data: milestone, error } = await supabaseAdmin
    .from('milestones')
    .insert(buildMilestone(overrides))
    .select()
    .single();
  if (error) throw new Error(`seedMilestone: insert failed: ${error.message}`);
  return milestone;
}

/**
 * Seeds an invite link for an existing workspace.
 */
async function seedInviteLink(supabaseAdmin, overrides = {}) {
  const { data: invite, error } = await supabaseAdmin
    .from('invite_links')
    .insert(buildInviteLink(overrides))
    .select()
    .single();
  if (error) throw new Error(`seedInviteLink: insert failed: ${error.message}`);
  return invite;
}

/**
 * Hard-deletes everything created for a workspace, in FK-safe order.
 * Use in an afterEach/afterAll for integration test files that seed a
 * lot of relational data and want a clean slate without waiting for a
 * full DB reset between files.
 *
 * NOTE: relies on ON DELETE CASCADE for most child tables (see
 * schema.txt's FK constraints on containers/groups/milestones/
 * invite_links/workspace_members, all of which cascade from
 * workspace_id) — deleting the workspace row itself is usually
 * sufficient. ledger_entries/disputes do NOT cascade from workspace_id
 * in the schema (no ON DELETE clause), so they're cleaned up explicitly
 * first to avoid FK violations on the workspace delete.
 */
async function cleanupWorkspace(supabaseAdmin, workspaceId) {
  await supabaseAdmin.from('ledger_entries').delete().eq('workspace_id', workspaceId);
  await supabaseAdmin.from('disputes').delete().eq('workspace_id', workspaceId);
  await supabaseAdmin.from('notifications').delete().eq('workspace_id', workspaceId);
  await supabaseAdmin.from('audit_log').delete().eq('workspace_id', workspaceId);
  await supabaseAdmin.from('workspace_settings').delete().eq('workspace_id', workspaceId);
  await supabaseAdmin.from('workspaces').delete().eq('id', workspaceId);
}

module.exports = {
  seedWorkspaceWithAdmin,
  seedAdditionalMember,
  seedContainerWithParticipants,
  seedLedgerEntry,
  seedGroupWithMembers,
  seedMilestone,
  seedInviteLink,
  cleanupWorkspace,
};
