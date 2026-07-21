// src/services/audit.service.js
const { supabaseAdmin } = require('../config/supabase');
const logger = require('../utils/logger');
const { invalidateDashboard } = require('./dashboard-cache.service');

/**
 * Write an audit log entry. Fire-and-forget — never throws.
 *
 * Also invalidates the workspace's cached dashboard payload. Nearly
 * every mutation that changes what the dashboard shows (containers,
 * ledger entries, disputes, tasks, groups, members, workspace settings)
 * already calls this function, so this is the single cheapest place to
 * keep the dashboard cache correct without adding an invalidation call
 * to every one of those services individually. Fire-and-forget, same as
 * the audit write itself — a slow/failed invalidation just means the
 * dashboard is stale for up to TTL.DASHBOARD_CACHE_SECONDS, not a bug.
 */
async function log({
  workspaceId   = null,
  actorUserId   = null,
  actorMemberId = null,
  action,
  targetType    = null,
  targetId      = null,
  metadata      = null,
  ipAddress     = null,
  userAgent     = null,
}) {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      workspace_id:    workspaceId,
      actor_user_id:   actorUserId,
      actor_member_id: actorMemberId,
      action,
      target_type:     targetType,
      target_id:       targetId,
      metadata:        metadata ?? null,
      ip_address:      ipAddress,
      user_agent:      userAgent,
    });

    if (error) throw new Error(error.message);
  } catch (err) {
    logger.error('Audit log write failed', { action, error: err.message });
  }

  if (workspaceId) invalidateDashboard(workspaceId);
}

/** Convenience helper — extracts common fields from Express req. */
function fromReq(req) {
  return {
    workspaceId:   req.member?.workspaceId || null,
    actorUserId:   req.user?.id            || null,
    actorMemberId: req.member?.id          || null,
    ipAddress:     req.ip,
    userAgent:     req.headers['user-agent'],
  };
}

module.exports = { log, fromReq };
