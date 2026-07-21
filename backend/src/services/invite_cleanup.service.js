// src/services/invite_cleanup.service.js
const { supabaseAdmin } = require('../config/supabase');
const logger = require('../utils/logger');

async function runInviteCleanup() {
  const { data, error } = await supabaseAdmin
    .from('invite_links')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .is('used_at', null)
    .select('id');

  if (error) throw new Error(error.message);
  logger.info('Invite cleanup complete', { deleted: (data || []).length });
}

module.exports = { runInviteCleanup };
