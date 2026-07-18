// src/controllers/search.controller.js
//
// Extracted from workspace.controller.js (audit finding 3.6).

const { supabaseAdmin } = require('../config/supabase');
const { success } = require('../utils/response');
const { containsPattern } = require('../utils/ilike');

// ── Search ─────────────────────────────────────────────────────────
//
// Cross-entity search across active members (by display_name) and
// containers (by name) in
// parallel. Results are typed so the client can render them differently.
// Scoped to the current workspace; requires active membership (via requireMembership).
//
// ILIKE wildcard escaping is shared via utils/ilike.js (audit finding
// 5.3 — this same escaping used to live only here and was missing from
// member.controller.js#listMembers's structurally identical search).

async function searchWorkspace(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const query           = (req.query.q || '').trim();
    const limit           = Math.min(20, parseInt(req.query.limit) || 10);

    if (!query || query.length < 2) {
      return success(res, { results: [] });
    }

    const pattern = containsPattern(query);

    const [{ data: members }, { data: containers }] = await Promise.all([
      supabaseAdmin
        .from('workspace_members')
        .select('id, display_name, role, is_proxy')
        .eq('workspace_id', workspaceId)
        .eq('is_active', true)
        .is('deleted_at', null)
        .ilike('display_name', pattern)
        .limit(limit),

      supabaseAdmin
        .from('containers')
        .select('id, name, container_type, status')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .ilike('name', pattern)
        .limit(limit),
    ]);

    const results = [
      ...(members    || []).map((m) => ({ type: 'member',    id: m.id, display_name: m.display_name, role: m.role, is_proxy: m.is_proxy })),
      ...(containers || []).map((c) => ({ type: 'container', id: c.id, name: c.name, container_type: c.container_type, status: c.status })),
    ];

    success(res, { results, query });
  } catch (err) { next(err); }
}

module.exports = {
  searchWorkspace,
};
