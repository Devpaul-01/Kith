// src/middleware/workspace.js
const { supabaseAdmin } = require('../config/supabase');
const { NotFoundError } = require('../utils/errors');
const {
  getCachedMembership,
  setCachedMembership,
} = require('../services/membership-cache.service');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies the caller is an active member of :workspaceId.
 * Attaches req.member and req.workspace.
 * Returns 404 (never 403) to prevent workspace enumeration.
 *
 * Both lookups (workspace_members, workspaces) are fetched in parallel
 * when not cached, and the combined result is cached in Redis for
 * TTL.MEMBERSHIP_CACHE_SECONDS (see membership-cache.service.js for the
 * invalidation strategy and the staleness tradeoff this accepts).
 *
 * `bank_details` is intentionally NOT selected here — nothing in the
 * codebase reads req.workspace.bankDetails, so fetching it into every
 * single workspace-scoped request was pure overhead on a sensitive jsonb
 * column with no consumer (audit finding 7.3). If a future endpoint
 * genuinely needs it, fetch it explicitly in that controller instead of
 * reintroducing it here.
 */
async function requireMembership(req, res, next) {
  try {
    const workspaceId = req.params.workspaceId;
    const userId = req.user.id;

    if (!workspaceId || workspaceId === 'undefined' || workspaceId === 'null') {
      throw new NotFoundError('Workspace not found');
    }

    if (!UUID_REGEX.test(workspaceId)) {
      throw new NotFoundError('Workspace not found');
    }

    const cached = await getCachedMembership(workspaceId, userId);
    if (cached) {
      req.member = cached.member;
      req.workspace = cached.workspace;
      return next();
    }

    const [{ data: member, error: memberErr }, { data: workspace, error: wsErr }] = await Promise.all([
      supabaseAdmin
        .from('workspace_members')
        .select('id, role, display_name, is_proxy, is_active, workspace_id')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .eq('is_active', true)
        .is('deleted_at', null)
        .maybeSingle(),
      supabaseAdmin
        .from('workspaces')
        .select('id, name, base_currency, visibility')
        .eq('id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle(),
    ]);

    if (memberErr) throw new Error(memberErr.message);
    if (!member) throw new NotFoundError('Workspace not found');

    if (wsErr) throw new Error(wsErr.message);
    if (!workspace) throw new NotFoundError('Workspace not found');

    req.member = {
      id:          member.id,
      role:        member.role,
      displayName: member.display_name,
      isProxy:     member.is_proxy,
      isActive:    member.is_active,
      workspaceId: member.workspace_id,
    };

    req.workspace = {
      id:           workspace.id,
      name:         workspace.name,
      baseCurrency: workspace.base_currency,
      visibility:   workspace.visibility,
    };

    // Fire-and-forget cache write — never block the request on it.
    setCachedMembership(workspaceId, userId, { member: req.member, workspace: req.workspace });

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireMembership };
