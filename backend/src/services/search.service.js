// src/services/search.service.js
//
// Extracted from search.controller.js as part of the service-layer
// refactor. Behavior is unchanged — same queries, same shape, same
// escaping. The controller is now a thin HTTP adapter around this.

const { supabaseAdmin } = require('../config/supabase');
const { containsPattern } = require('../utils/ilike');

/**
 * Cross-entity search across active members (by display_name) and
 * containers (by name) in parallel. Results are typed so the client can
 * render them differently. Scoped to the current workspace.
 *
 * ILIKE wildcard escaping is shared via utils/ilike.js (audit finding
 * 5.3).
 *
 * @returns {Promise<{results: Array, query: string}>}
 */
async function searchWorkspace({ workspaceId, query, limit = 10 }) {
  const trimmedQuery = (query || '').trim();
  const safeLimit    = Math.min(20, parseInt(limit) || 10);

  if (!trimmedQuery || trimmedQuery.length < 2) {
    return { results: [], query: trimmedQuery };
  }

  const pattern = containsPattern(trimmedQuery);

  const [{ data: members }, { data: containers }] = await Promise.all([
    supabaseAdmin
      .from('workspace_members')
      .select('id, display_name, role, is_proxy')
      .eq('workspace_id', workspaceId)
      .eq('is_active', true)
      .is('deleted_at', null)
      .ilike('display_name', pattern)
      .limit(safeLimit),

    supabaseAdmin
      .from('containers')
      .select('id, name, container_type, status')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .ilike('name', pattern)
      .limit(safeLimit),
  ]);

  const results = [
    ...(members    || []).map((m) => ({ type: 'member',    id: m.id, display_name: m.display_name, role: m.role, is_proxy: m.is_proxy })),
    ...(containers || []).map((c) => ({ type: 'container', id: c.id, name: c.name, container_type: c.container_type, status: c.status })),
  ];

  return { results, query: trimmedQuery };
}

module.exports = { searchWorkspace };
