// src/middleware/workspace.js
const { supabaseAdmin } = require('../config/supabase');
const { NotFoundError } = require('../utils/errors');

/**
 * Verifies the caller is an active member of :workspaceId.
 * Attaches req.member and req.workspace.
 * Returns 404 (never 403) to prevent workspace enumeration.
 */
 // src/middleware/workspace.js


/**
 * Verifies the caller is an active member of :workspaceId.
 * Attaches req.member and req.workspace.
 * Returns 404 (never 403) to prevent workspace enumeration.
 */
// src/middleware/workspace.js


async function requireMembership(req, res, next) {
  try {
    const workspaceId = req.params.workspaceId;
    const userId = req.user.id;

    if (!workspaceId || workspaceId === 'undefined' || workspaceId === 'null') {
      throw new NotFoundError('Workspace not found');
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(workspaceId)) {
      throw new NotFoundError('Workspace not found');
    }

    // Fetch workspace member
    const { data: member, error: memberErr } = await supabaseAdmin
      .from('workspace_members')
      .select('id, role, display_name, is_proxy, is_active, workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('deleted_at', null)
      .maybeSingle();

    if (memberErr) throw new Error(memberErr.message);
    if (!member) throw new NotFoundError('Workspace not found');

    // Fetch workspace
    const { data: workspace, error: wsErr } = await supabaseAdmin
      .from('workspaces')
      .select('id, name, base_currency, plan, visibility, bank_details')
      .eq('id', workspaceId)
      .is('deleted_at', null)
      .maybeSingle();

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
      plan:         workspace.plan,
      visibility:   workspace.visibility,
      bankDetails:  workspace.bank_details,
    };

    next();
  } catch (err) {
    next(err);
  }
}




module.exports = { requireMembership };
