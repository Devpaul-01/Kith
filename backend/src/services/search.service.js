// src/services/search.service.js
//
// Query-building/escaping/shaping logic for cross-entity search. The
// controller is a thin HTTP adapter around this.

const { supabaseAdmin } = require('../config/supabase');
const { containsPattern } = require('../utils/ilike');
const { AppError, ValidationError } = require('../utils/errors');
const { entitySearchRequestSchema, callerEntitySearchRequestSchema, callerContainerSearchRequestSchema } = require('../validators/search.validator');
const logger = require('../utils/logger');

/**
 * Cross-entity search across active members (by display_name) and
 * containers (by name) in parallel. Results are typed so the client can
 * render them differently. Scoped to the current workspace.
 *
 * ILIKE wildcard escaping is shared via utils/ilike.js.
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

/**
 * Shared adapter for the ranked entity RPCs. All results are
 * candidates: single_match still needs user confirmation before a write.
 * Scores are database similarities, not probabilities or proof of identity.
 */
async function findCandidates(params, rpcName, shapeCandidate, { requestSchema = entitySearchRequestSchema, rpcScope = () => ({}) } = {}) {
  const parsed = requestSchema.safeParse(params);
  if (!parsed.success) {
    throw new ValidationError('Invalid entity search', null, parsed.error.issues);
  }
  const { workspaceId, query, limit } = parsed.data;

  let rows;
  try {
    const { data, error } = await supabaseAdmin.rpc(rpcName, {
      p_workspace_id: workspaceId,
      p_query: query,
      p_pattern: containsPattern(query),
      p_limit: limit + 1,
      ...rpcScope(parsed.data),
    });
    if (error || !Array.isArray(data) || data.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      logger.error('Ranked entity search failed', { workspaceId, rpcName, error: error?.message || 'Invalid RPC result' });
      throw new AppError('Entity search is unavailable. Please try again.', 503, 'SEARCH_UNAVAILABLE');
    }
    rows = data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error('Ranked entity search failed', { workspaceId, rpcName, error: err.message });
    throw new AppError('Entity search is unavailable. Please try again.', 503, 'SEARCH_UNAVAILABLE');
  }

  // Determine ambiguity before truncation. Never select the highest-scoring
  // candidate on behalf of the caller, even if it is an exact match.
  return {
    query,
    status: rows.length === 0 ? 'not_found' : rows.length === 1 ? 'single_match' : 'ambiguous',
    candidates: rows.slice(0, limit).map(shapeCandidate),
    has_more: rows.length > limit,
  };
}

async function findMembers(params) {
  return findCandidates(params, 'search_members_ranked', (row) => ({
    id: row.id, display_name: row.display_name, role: row.role, is_proxy: row.is_proxy,
    match_type: row.match_type, score: row.score,
  }));
}

async function findContainers(params) {
  return findCandidates(params, 'search_containers_ranked', (row) => ({
    id: row.id, name: row.name, container_type: row.container_type, status: row.status,
    match_type: row.match_type, score: row.score,
  }));
}

const callerRpcScope = ({ callerId, isAdmin }) => ({ p_caller_id: callerId, p_is_admin: isAdmin });
const containerCallerRpcScope = (params) => ({ ...callerRpcScope(params), p_container_id: params.containerId ?? null });

async function findTasks(params) {
  return findCandidates(params, 'search_tasks_ranked', (row) => ({
    id: row.id, container_id: row.container_id, title: row.title, assigned_to: row.assigned_to,
    status: row.status, due_date: row.due_date, match_type: row.match_type, score: row.score,
  }), { requestSchema: callerContainerSearchRequestSchema, rpcScope: containerCallerRpcScope });
}

async function findLedgerEntries(params) {
  return findCandidates(params, 'search_ledger_entries_ranked', (row) => ({
    id: row.id, container_id: row.container_id, contributor_id: row.contributor_id, contributor_name: row.contributor_name,
    note: row.note, original_amount: row.original_amount, original_currency: row.original_currency,
    entry_type: row.entry_type, status: row.status, recorded_at: row.recorded_at, match_type: row.match_type, score: row.score,
  }), { requestSchema: callerContainerSearchRequestSchema, rpcScope: containerCallerRpcScope });
}

async function findDisputes(params) {
  return findCandidates(params, 'search_disputes_ranked', (row) => ({
    id: row.id, ledger_entry_id: row.ledger_entry_id, raised_by: row.raised_by, raised_by_name: row.raised_by_name,
    reason: row.reason, status: row.status, raised_at: row.raised_at, match_type: row.match_type, score: row.score,
  }), { requestSchema: callerEntitySearchRequestSchema, rpcScope: callerRpcScope });
}

async function findGroups(params) {
  return findCandidates(params, 'search_groups_ranked', (row) => ({
    id: row.id, name: row.name, description: row.description, created_at: row.created_at, match_type: row.match_type, score: row.score,
  }));
}

module.exports = { searchWorkspace, findMembers, findContainers, findTasks, findLedgerEntries, findDisputes, findGroups };
