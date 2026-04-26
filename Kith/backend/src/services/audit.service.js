// src/services/audit.service.js
const { supabaseAdmin } = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Write an audit log entry. Fire-and-forget — never throws.
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
