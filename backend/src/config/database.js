// src/config/database.js
//
// Minimal shim — provides checkConnection() for server startup health-checks.
// All DB operations are now done directly via supabaseAdmin.from() in each
// controller/service. This file no longer contains a query() function.

const { supabaseAdmin } = require('./supabase');
const logger = require('../utils/logger');

async function checkConnection() {
  try {
    const { error } = await supabaseAdmin.from('users').select('id').limit(1);
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    logger.error('Supabase connectivity check failed', { error: err.message });
    return false;
  }
}

module.exports = { checkConnection };
