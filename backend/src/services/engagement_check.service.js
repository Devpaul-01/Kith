// src/services/engagement_check.service.js
//
// Delegates the batched fetch to services/engagement.service.js#fetchEngagementData
// — the same helper member.service.js#getMemberEngagement uses — instead
// of maintaining an independent copy of the same batching logic.

const { supabaseAdmin } = require('../config/supabase');
const { fetchEngagementData } = require('./engagement.service');
const logger = require('../utils/logger');

async function runEngagementCheck() {
  logger.info('Running engagement check');

  const { data: members } = await supabaseAdmin
    .from('workspace_members')
    .select('id, workspace_id, last_active_at')
    .eq('is_proxy', false)
    .is('deleted_at', null)
    .eq('is_active', true);

  if (!(members || []).length) {
    logger.info('Engagement check complete', { processed: 0 });
    return;
  }

  const memberIds = members.map((m) => m.id);
  const { ledgerByMember, tasksByMember } = await fetchEngagementData(memberIds);

  const updates = [];

  for (const m of members) {
    const ledger = (ledgerByMember.get(m.id) || []).filter((le) => le.status === 'confirmed');
    const tasks  = tasksByMember.get(m.id) || [];

    const candidates = [
      m.last_active_at,
      ...ledger.map((le) => le.confirmed_at),
      ...tasks.map((t) => t.completed_at),
    ].filter(Boolean);

    if (!candidates.length) continue;

    const latest = new Date(Math.max(...candidates.map((d) => new Date(d)))).toISOString();

    updates.push(
      supabaseAdmin
        .from('workspace_members')
        .update({ last_active_at: latest })
        .eq('id', m.id)
        .or(`last_active_at.is.null,last_active_at.lt.${latest}`)
    );
  }

  await Promise.all(updates);

  logger.info('Engagement check complete', { processed: members.length });
}

module.exports = { runEngagementCheck };
