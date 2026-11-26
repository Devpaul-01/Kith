// src/services/dispute.service.js
//
// Preserves the atomic RPC usage for raise/resolve and the 404-not-500
// fix on the entry lookup.

const { supabaseAdmin } = require('../config/supabase');
const { AppError, NotFoundError, BusinessRuleError, ForbiddenError, ConflictError, ValidationError } = require('../utils/errors');
const {
  raiseDisputeDataSchema, confirmedDisputeEntrySchema, disputeEntryReadSchema, raiseDisputeContextSchema,
  raisedDisputeStateSchema, raiseDisputeResultSchema, raiseDisputeCallerSchema,
  reviewedDisputeRaiseSchema, disputeEntryState, raisedDisputeState, plannedDisputeState,
  disputeRaiseWorkspaceRowSchema, disputeRaiseMemberRowSchema, disputeRaiseContainerRowSchema, disputeRaiseOpenRowSchema,
} = require('../validators/dispute-raise.validator');
const {
  resolveDisputeDataSchema, disputedResolutionEntrySchema, openDisputeResolutionSchema, disputeResolutionReadSchema,
  resolveDisputeContextSchema, resolveDisputeResultSchema, resolveDisputeCallerSchema,
  reviewedDisputeResolutionSchema, disputeResolutionState, resolutionContextMatches, plannedResolvedDisputeState,
} = require('../validators/dispute-resolve.validator');
const notification = require('./notification.service');
const audit        = require('./audit.service');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');
const logger = require('../utils/logger');

const DISPUTE_COLUMNS = 'id, ledger_entry_id, raised_by, reason, status, resolution_note, resolved_by, raised_at, resolved_at';
const ENTRY_COLUMNS = 'id, container_id, cycle_id, entry_type, contributor_id, original_amount, original_currency, base_amount, is_crypto, payment_method, status, note, corrects_entry_id, recorded_at, confirmed_at';

async function listDisputes({ workspaceId, statusFilter, page, perPage, offset, metadataOnly = false }) {
  let query = supabaseAdmin
    .from('disputes')
    .select(`
      ${metadataOnly ? DISPUTE_COLUMNS : '*'}, ledger_entries!ledger_entry_id(original_amount, original_currency, base_amount, status),
      raised_by_member:workspace_members!raised_by(display_name),
      resolved_by_member:workspace_members!resolved_by(display_name)
    `, { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('ledger_entries.workspace_id', workspaceId)
    .eq('raised_by_member.workspace_id', workspaceId)
    .eq('resolved_by_member.workspace_id', workspaceId)
    .order('raised_at', { ascending: false })
    .order('id', { ascending: true })
    .range(offset, offset + perPage - 1);

  if (statusFilter) query = query.eq('status', statusFilter);

  const { data, error, count } = await query;
  if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count < 0) {
    throw new AppError('Disputes are unavailable. Please try again.', 503, 'DISPUTES_UNAVAILABLE');
  }

  const disputes = data.map((d) => ({
    ...d,
    original_amount:   d.ledger_entries?.original_amount,
    original_currency: d.ledger_entries?.original_currency,
    base_amount:       d.ledger_entries?.base_amount,
    entry_status:      d.ledger_entries?.status,
    raised_by_name:    d.raised_by_member?.display_name,
    resolved_by_name:  d.resolved_by_member?.display_name,
    ledger_entries: undefined, raised_by_member: undefined, resolved_by_member: undefined,
  }));

  return { disputes, count };
}

async function getDispute({ workspaceId, disputeId, isAdmin, callerId, notesPagination }) {
  const { data: dispute, error } = await supabaseAdmin
    .from('disputes')
    .select(`${notesPagination ? `${DISPUTE_COLUMNS}, notes` : '*'}, raised_by_member:workspace_members!raised_by(display_name)`)
    .eq('id', disputeId)
    .eq('workspace_id', workspaceId)
    .eq('raised_by_member.workspace_id', workspaceId)
    .maybeSingle();

  if (error) throw new AppError('Disputes are unavailable. Please try again.', 503, 'DISPUTES_UNAVAILABLE');
  if (!dispute) throw new NotFoundError('Dispute not found');
  if (!isAdmin && dispute.raised_by !== callerId) throw new ForbiddenError('Access denied');

  if (notesPagination && (!Array.isArray(dispute.notes)
      || dispute.notes.some((note) => !note || typeof note !== 'object' || Array.isArray(note)))) {
    throw new AppError('Dispute notes are unavailable. Please try again.', 503, 'DISPUTES_UNAVAILABLE');
  }

  // .maybeSingle() + explicit 404 instead of .single(), which threw a raw
  // Postgrest error on a missing referenced entry.
  const { data: entry, error: entryErr } = await supabaseAdmin
    .from('ledger_entries')
    .select(`${notesPagination ? ENTRY_COLUMNS : '*'}, contributor:workspace_members!contributor_id(display_name)`)
    .eq('id', dispute.ledger_entry_id)
    .eq('workspace_id', workspaceId)
    .eq('contributor.workspace_id', workspaceId)
    .maybeSingle();

  if (entryErr) throw new AppError('Disputes are unavailable. Please try again.', 503, 'DISPUTES_UNAVAILABLE');

  return {
    dispute: { ...dispute, raised_by_name: dispute.raised_by_member?.display_name, raised_by_member: undefined,
      ...(notesPagination ? { notes: dispute.notes.slice(notesPagination.offset, notesPagination.offset + notesPagination.perPage) } : {}),
    },
    entry:   entry ? { ...entry, contributor_name: entry.contributor?.display_name, contributor: undefined } : null,
    ...(notesPagination ? { notesCount: dispute.notes.length } : {}),
  };
}

const disputeRaiseUnavailable = () => new AppError('Dispute creation is unavailable. Please try again.', 503, 'DISPUTE_RAISE_UNAVAILABLE');
const reviewedEntryColumns = Object.keys(confirmedDisputeEntrySchema.shape)
  .map((field) => field === 'entry_id' ? 'id'
    : ['original_amount', 'base_amount'].includes(field) ? `${field}::text` : field).join(', ');

async function readReviewedDisputeRow(operation, unavailable = disputeRaiseUnavailable) {
  try {
    const response = await operation();
    if (!response || response.error !== null || !Object.hasOwn(response, 'data')
        || (response.data !== null && (typeof response.data !== 'object' || Array.isArray(response.data)))) {
      throw unavailable();
    }
    return response.data;
  } catch { throw unavailable(); }
}

/** Fresh ownership and eligibility for the caller's explicitly selected confirmed contribution. */
async function getRaiseDisputeContext({ workspaceId, containerId, entryId, callerId, userId, isAdmin }) {
  if (!raiseDisputeCallerSchema.safeParse({ workspaceId, containerId, entryId, callerId, userId, isAdmin }).success) {
    throw new ValidationError('Invalid dispute creation context');
  }
  const workspace = await readReviewedDisputeRow(() => supabaseAdmin.from('workspaces')
    .select('id, name, base_currency, updated_at, deleted_at').eq('id', workspaceId).is('deleted_at', null).maybeSingle());
  if (!workspace) throw new NotFoundError('Workspace not found');
  if (!disputeRaiseWorkspaceRowSchema.safeParse(workspace).success) throw disputeRaiseUnavailable();
  if (workspace.id !== workspaceId || workspace.deleted_at !== null) throw disputeRaiseUnavailable();
  const actor = await readReviewedDisputeRow(() => supabaseAdmin.from('workspace_members')
    .select('id, workspace_id, user_id, role, is_active, is_proxy, display_name, updated_at, deleted_at')
    .eq('id', callerId).eq('workspace_id', workspaceId).eq('user_id', userId)
    .eq('is_active', true).eq('is_proxy', false).is('deleted_at', null).maybeSingle());
  if (actor && !disputeRaiseMemberRowSchema.safeParse(actor).success) throw disputeRaiseUnavailable();
  if (!actor || actor.id !== callerId || actor.workspace_id !== workspaceId || actor.user_id !== userId
      || actor.role !== (isAdmin ? 'admin' : 'member') || actor.is_active !== true
      || actor.is_proxy !== false || actor.deleted_at !== null) {
    throw new ForbiddenError('Active non-proxy workspace membership required');
  }
  const container = await readReviewedDisputeRow(() => supabaseAdmin.from('containers')
    .select('id, workspace_id, name, container_type, status, enable_money, updated_at, deleted_at')
    .eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle());
  if (!container) throw new NotFoundError('Container not found');
  if (!disputeRaiseContainerRowSchema.safeParse(container).success) throw disputeRaiseUnavailable();
  if (container.id !== containerId || container.workspace_id !== workspaceId || container.deleted_at !== null) throw disputeRaiseUnavailable();
  if (container.container_type !== 'event' || container.status !== 'active' || container.enable_money !== true) {
    throw new BusinessRuleError('Dispute creation requires an active event container with money tracking enabled');
  }
  const entry = await readReviewedDisputeRow(() => supabaseAdmin.from('ledger_entries').select(reviewedEntryColumns)
    .eq('id', entryId).eq('workspace_id', workspaceId).eq('container_id', containerId).maybeSingle());
  if (!entry) throw new NotFoundError('Ledger entry not found');
  if (entry.id !== entryId || entry.workspace_id !== workspaceId || entry.container_id !== containerId) throw disputeRaiseUnavailable();
  const read = disputeEntryReadSchema.safeParse(disputeEntryState(entry));
  if (!read.success) throw disputeRaiseUnavailable();
  if (read.data.contributor_id !== callerId) throw new ForbiddenError('You can only dispute your own contributions');
  const snapshot = confirmedDisputeEntrySchema.safeParse(read.data);
  if (!snapshot.success || snapshot.data.original_currency !== workspace.base_currency
      || snapshot.data.original_amount !== snapshot.data.base_amount) {
    throw new BusinessRuleError('Only confirmed base-currency contributions are supported');
  }
  const open = await readReviewedDisputeRow(() => supabaseAdmin.from('disputes')
    .select('id, workspace_id, ledger_entry_id, status').eq('workspace_id', workspaceId)
    .eq('ledger_entry_id', entryId).eq('status', 'open').maybeSingle());
  if (open !== null) {
    if (!disputeRaiseOpenRowSchema.safeParse(open).success
        || open.workspace_id !== workspaceId || open.ledger_entry_id !== entryId) throw disputeRaiseUnavailable();
    throw new BusinessRuleError('This entry already has an open dispute');
  }
  const selected = raiseDisputeContextSchema.safeParse({
    workspace_id: workspaceId, workspace_name: workspace.name, workspace_updated_at: workspace.updated_at,
    base_currency: workspace.base_currency, actor_member_id: callerId, member_role: actor.role,
    actor_display_name: actor.display_name, member_updated_at: actor.updated_at,
    container_id: containerId, container_name: container.name, container_type: container.container_type,
    container_status: container.status, enable_money: container.enable_money, container_updated_at: container.updated_at,
    entry: snapshot.data, dispute: null,
  });
  if (!selected.success) throw disputeRaiseUnavailable();
  return selected.data;
}

async function raiseReviewedDispute({ workspaceId, containerId, entryId, reason, callerId, isAdmin,
  actorDisplayName, actorCtx, reviewedRaise }) {
  const reviewed = reviewedDisputeRaiseSchema.safeParse(reviewedRaise);
  const data = raiseDisputeDataSchema.safeParse({ reason });
  if (!reviewed.success || !data.success || !raiseDisputeCallerSchema.safeParse({ workspaceId, containerId, entryId,
    callerId, userId: reviewed.data?.userId, isAdmin }).success) throw new ValidationError('Valid reviewed dispute details are required');
  const expected = reviewed.data.expected;
  if (expected.workspace_id !== workspaceId || expected.container_id !== containerId
      || expected.entry.workspace_id !== workspaceId || expected.entry.container_id !== containerId
      || expected.entry.entry_id !== entryId || expected.actor_member_id !== callerId
      || expected.entry.contributor_id !== callerId || expected.member_role !== (isAdmin ? 'admin' : 'member')
      || reviewed.data.isAdmin !== isAdmin) {
    throw new ForbiddenError('Dispute creation must use the reviewed workspace, contribution and caller');
  }
  let current;
  try {
    current = await getRaiseDisputeContext({ workspaceId, containerId, entryId, callerId,
      userId: reviewed.data.userId, isAdmin });
  } catch (err) {
    if (['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION'].includes(err.code)) {
      throw new ConflictError('The reviewed dispute creation is no longer available');
    }
    throw err;
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new ConflictError('Dispute eligibility changed since review');

  let response;
  try {
    response = await supabaseAdmin.rpc('raise_dispute_reviewed_atomic', {
      p_workspace_id: workspaceId, p_user_id: reviewed.data.userId, p_raised_by: callerId,
      p_reason: data.data.reason, p_expected: expected,
    });
  } catch { throw disputeRaiseUnavailable(); }
  // Only an explicit PostgreSQL rejection proves the atomic mutation did not run.
  // Transport failures and malformed responses retain the agent execution claim.
  if (response?.data === null && response.error && typeof response.error === 'object'
      && !Array.isArray(response.error) && (response.error.code === '23505'
        || (response.error.code === 'P0001' && response.error.message === 'REVIEWED_DISPUTE_STALE'))) {
    throw new ConflictError('The contribution can no longer be disputed');
  }
  if (!response || response.error !== null) throw disputeRaiseUnavailable();
  // Both projections come from the mutation transaction. A later read must not
  // substitute a newer row for what this approved execution actually changed.
  const result = raiseDisputeResultSchema.safeParse(response.data);
  const planned = plannedDisputeState({ selection: expected, reason: data.data.reason });
  if (!result.success || Object.keys(planned)
    .some((field) => JSON.stringify(result.data.dispute[field]) !== JSON.stringify(planned[field]))
    || JSON.stringify(result.data.entry) !== JSON.stringify({ ...expected.entry, status: 'disputed' })) {
    throw disputeRaiseUnavailable();
  }
  const dispute = result.data.dispute;
  try {
    await audit.log({ ...actorCtx, workspaceId, actorUserId: reviewed.data.userId, actorMemberId: callerId,
      action: AUDIT_ACTIONS.DISPUTE_RAISED, targetType: 'dispute', targetId: dispute.dispute_id, required: true,
      metadata: { agent_initiated: true, proposal_id: reviewed.data.proposalId,
        session_id: reviewed.data.trace.sessionId, conversation_id: reviewed.data.trace.conversationId,
        sensitive_action: true, secondary_confirmation: true } });
  } catch { throw disputeRaiseUnavailable(); }
  try {
    const admins = await supabaseAdmin.from('workspace_members').select('id')
      .eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true).is('deleted_at', null);
    if (admins.error !== null || !Array.isArray(admins.data)
        || admins.data.some((member) => !member || typeof member.id !== 'string')) throw disputeRaiseUnavailable();
    await notification.send({ type: 'contribution_disputed', workspaceId, recipientIds: admins.data.map((member) => member.id),
      referenceType: 'dispute', referenceId: dispute.dispute_id,
      variables: { actor: actorDisplayName, amount: `${expected.entry.original_amount} ${expected.entry.original_currency}`,
        container: expected.container_name }, dedupKey: `contribution_disputed:${dispute.dispute_id}` });
  } catch (err) {
    logger.warn('Dispute creation notification unavailable', { workspaceId, entryId,
      disputeId: dispute.dispute_id, errorCode: err?.code });
  }
  const { dispute_id: id, ...disputeFields } = result.data.dispute;
  const { entry_id: resultEntryId, ...entryFields } = result.data.entry;
  return { dispute: { id, ...disputeFields }, entry: { id: resultEntryId, ...entryFields } };
}

// raise_dispute_atomic inserts the dispute row and updates the ledger
// entry's status inside one Postgres transaction.
async function raiseDispute({ workspaceId, containerId, entryId, reason, callerId, isAdmin, actorDisplayName, actorCtx, reviewedRaise }) {
  if (reviewedRaise !== undefined) {
    return raiseReviewedDispute({ workspaceId, containerId, entryId, reason, callerId, isAdmin, actorDisplayName, actorCtx, reviewedRaise });
  }
  const { data: entry } = await supabaseAdmin
    .from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!entry) throw new NotFoundError('Ledger entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('You can only dispute your own entries');
  if (!['confirmed', 'pending'].includes(entry.status)) throw new BusinessRuleError('Can only dispute confirmed or pending entries');

  const { data: disputeData, error: rpcErr } = await supabaseAdmin.rpc('raise_dispute_atomic', {
    p_workspace_id:    workspaceId,
    p_ledger_entry_id: entryId,
    p_raised_by:       callerId,
    p_reason:          reason,
  });
  if (rpcErr) {
    const m = rpcErr.message || '';
    if (rpcErr.code === '23505' || m.includes('DISPUTE_ALREADY_OPEN')) throw new ConflictError('This entry already has an open dispute');
    if (m.includes('ENTRY_NOT_DISPUTABLE')) throw new BusinessRuleError('Can only dispute confirmed or pending entries');
    if (m.includes('ENTRY_NOT_FOUND')) throw new NotFoundError('Ledger entry not found');
    throw new Error(m);
  }
  const dispute = disputeData;

  const { data: admins } = await supabaseAdmin
    .from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true);

  await notification.send({
    type:          'contribution_disputed',
    workspaceId,
    recipientIds:  (admins || []).map((a) => a.id),
    referenceType: 'dispute',
    referenceId:   dispute.id,
    variables:     { actor: actorDisplayName, amount: `${entry.original_amount} ${entry.original_currency}`, container: containerId },
  });
  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.DISPUTE_RAISED, targetType: 'dispute', targetId: dispute.id });

  return { dispute, entry: { ...entry, status: 'disputed' } };
}

async function addDisputeNote({ workspaceId, disputeId, note, isAdmin, callerId }) {
  const { data: dispute } = await supabaseAdmin
    .from('disputes').select('*').eq('id', disputeId).eq('workspace_id', workspaceId).maybeSingle();
  if (!dispute) throw new NotFoundError('Dispute not found');
  if (!isAdmin && dispute.raised_by !== callerId) throw new ForbiddenError('Access denied');

  // One atomic append under the dispute row lock: a read-modify-write of the whole
  // notes array here would drop a concurrent note. The RPC re-derives authority.
  const { data: updated, error } = await supabaseAdmin.rpc('add_dispute_note_atomic', {
    p_workspace_id: workspaceId, p_dispute_id: disputeId, p_author_id: callerId, p_note: note, p_require_open: false,
  });
  if (error) {
    if (error.code === 'P0001' && error.message === 'DISPUTE_NOT_FOUND') throw new NotFoundError('Dispute not found');
    if (error.code === 'P0001' && error.message === 'DISPUTE_ACCESS_DENIED') throw new ForbiddenError('Access denied');
    throw new Error(error.message);
  }

  return updated;
}

const disputeResolveUnavailable = () => new AppError('Dispute resolution is unavailable. Please try again.', 503, 'DISPUTE_RESOLVE_UNAVAILABLE');
const reviewedResolutionColumns = Object.keys(openDisputeResolutionSchema.shape)
  .map((field) => field === 'dispute_id' ? 'id' : field).join(', ');

/** Fresh admin authority and eligibility for one explicitly selected dispute. */
async function getResolveDisputeContext({ workspaceId, disputeId, callerId, userId, isAdmin }) {
  if (!resolveDisputeCallerSchema.safeParse({ workspaceId, disputeId, callerId, userId, isAdmin }).success) {
    throw new ValidationError('Invalid dispute resolution context');
  }
  if (!isAdmin) throw new ForbiddenError('Admin access required');
  const workspace = await readReviewedDisputeRow(() => supabaseAdmin.from('workspaces')
    .select('id, name, base_currency, updated_at, deleted_at').eq('id', workspaceId).is('deleted_at', null).maybeSingle(), disputeResolveUnavailable);
  if (!workspace) throw new NotFoundError('Workspace not found');
  if (!disputeRaiseWorkspaceRowSchema.safeParse(workspace).success
      || workspace.id !== workspaceId || workspace.deleted_at !== null) throw disputeResolveUnavailable();
  const actor = await readReviewedDisputeRow(() => supabaseAdmin.from('workspace_members')
    .select('id, workspace_id, user_id, role, is_active, is_proxy, display_name, updated_at, deleted_at')
    .eq('id', callerId).eq('workspace_id', workspaceId).eq('user_id', userId)
    .eq('role', 'admin').eq('is_active', true).eq('is_proxy', false).is('deleted_at', null).maybeSingle(), disputeResolveUnavailable);
  if (actor && !disputeRaiseMemberRowSchema.safeParse(actor).success) throw disputeResolveUnavailable();
  if (!actor || actor.id !== callerId || actor.workspace_id !== workspaceId || actor.user_id !== userId
      || actor.role !== 'admin' || actor.is_active !== true || actor.is_proxy !== false || actor.deleted_at !== null) {
    throw new ForbiddenError('Active non-proxy admin membership required');
  }
  const dispute = await readReviewedDisputeRow(() => supabaseAdmin.from('disputes').select(reviewedResolutionColumns)
    .eq('id', disputeId).eq('workspace_id', workspaceId).maybeSingle(), disputeResolveUnavailable);
  if (!dispute) throw new NotFoundError('Dispute not found');
  const readDispute = disputeResolutionReadSchema.safeParse(disputeResolutionState(dispute));
  if (!readDispute.success || readDispute.data.dispute_id !== disputeId
      || readDispute.data.workspace_id !== workspaceId) throw disputeResolveUnavailable();
  if (readDispute.data.status !== 'open') throw new BusinessRuleError('Dispute is already resolved');
  const open = openDisputeResolutionSchema.safeParse(readDispute.data);
  if (!open.success) throw disputeResolveUnavailable();
  const entry = await readReviewedDisputeRow(() => supabaseAdmin.from('ledger_entries').select(reviewedEntryColumns)
    .eq('id', open.data.ledger_entry_id).eq('workspace_id', workspaceId).maybeSingle(), disputeResolveUnavailable);
  if (!entry) throw new NotFoundError('Ledger entry not found');
  const readEntry = disputeEntryReadSchema.safeParse(disputeEntryState(entry));
  if (!readEntry.success || readEntry.data.entry_id !== open.data.ledger_entry_id
      || readEntry.data.workspace_id !== workspaceId) throw disputeResolveUnavailable();
  const snapshot = disputedResolutionEntrySchema.safeParse(readEntry.data);
  if (!snapshot.success || snapshot.data.original_currency !== workspace.base_currency
      || snapshot.data.original_amount !== snapshot.data.base_amount) {
    throw new BusinessRuleError('Only disputed base-currency contributions with confirmation metadata are supported');
  }
  if (open.data.raised_by !== snapshot.data.contributor_id) {
    throw new BusinessRuleError('Only disputes raised by the contribution owner are supported');
  }
  const container = await readReviewedDisputeRow(() => supabaseAdmin.from('containers')
    .select('id, workspace_id, name, container_type, status, enable_money, updated_at, deleted_at')
    .eq('id', snapshot.data.container_id).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle(), disputeResolveUnavailable);
  if (!container) throw new NotFoundError('Container not found');
  if (!disputeRaiseContainerRowSchema.safeParse(container).success || container.id !== snapshot.data.container_id
      || container.workspace_id !== workspaceId || container.deleted_at !== null) throw disputeResolveUnavailable();
  if (container.container_type !== 'event' || container.status !== 'active' || container.enable_money !== true) {
    throw new BusinessRuleError('Dispute resolution requires an active event container with money tracking enabled');
  }
  const contributor = await readReviewedDisputeRow(() => supabaseAdmin.from('workspace_members')
    .select('id, workspace_id, user_id, role, is_active, is_proxy, display_name, updated_at, deleted_at')
    .eq('id', snapshot.data.contributor_id).eq('workspace_id', workspaceId)
    .eq('is_active', true).eq('is_proxy', false).is('deleted_at', null).maybeSingle(), disputeResolveUnavailable);
  if (contributor && !disputeRaiseMemberRowSchema.safeParse(contributor).success) throw disputeResolveUnavailable();
  if (!contributor || contributor.id !== snapshot.data.contributor_id || contributor.workspace_id !== workspaceId
      || contributor.is_active !== true || contributor.is_proxy !== false || contributor.deleted_at !== null) {
    throw new BusinessRuleError('An active non-proxy contribution owner is required');
  }
  const selected = resolveDisputeContextSchema.safeParse({
    workspace_id: workspaceId, workspace_name: workspace.name, workspace_updated_at: workspace.updated_at,
    base_currency: workspace.base_currency, actor_member_id: callerId, member_role: 'admin',
    actor_display_name: actor.display_name, member_updated_at: actor.updated_at,
    container_id: container.id, container_name: container.name, container_type: container.container_type,
    container_status: container.status, enable_money: container.enable_money, container_updated_at: container.updated_at,
    contributor_display_name: contributor.display_name, contributor_role: contributor.role,
    contributor_updated_at: contributor.updated_at, entry: snapshot.data, dispute: open.data,
  });
  if (!selected.success || !resolutionContextMatches(selected.data)) throw disputeResolveUnavailable();
  return selected.data;
}

async function resolveReviewedDispute({ workspaceId, disputeId, resolutionNote, resolvedByMemberId, isAdmin, actorCtx, reviewedResolution }) {
  const reviewed = reviewedDisputeResolutionSchema.safeParse(reviewedResolution);
  const data = resolveDisputeDataSchema.safeParse({ resolution_note: resolutionNote });
  if (!reviewed.success || !data.success || !resolveDisputeCallerSchema.safeParse({ workspaceId, disputeId,
    callerId: resolvedByMemberId, userId: reviewed.data?.userId, isAdmin }).success) {
    throw new ValidationError('Valid reviewed dispute resolution details are required');
  }
  if (!isAdmin) throw new ForbiddenError('Admin access required');
  const expected = reviewed.data.expected;
  if (expected.workspace_id !== workspaceId || expected.dispute.dispute_id !== disputeId
      || expected.actor_member_id !== resolvedByMemberId || !resolutionContextMatches(expected)) {
    throw new ForbiddenError('Dispute resolution must use the reviewed workspace, dispute and admin');
  }
  let current;
  try {
    current = await getResolveDisputeContext({ workspaceId, disputeId, callerId: resolvedByMemberId,
      userId: reviewed.data.userId, isAdmin });
  } catch (err) {
    if (['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION'].includes(err.code)) {
      throw new ConflictError('The reviewed dispute resolution is no longer available');
    }
    throw err;
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new ConflictError('Dispute eligibility changed since review');
  const resolvedAt = new Date().toISOString();
  let response;
  try {
    response = await supabaseAdmin.rpc('resolve_dispute_reviewed_atomic', {
      p_workspace_id: workspaceId, p_dispute_id: disputeId, p_user_id: reviewed.data.userId,
      p_resolution_note: data.data.resolution_note, p_resolved_by: resolvedByMemberId,
      p_resolved_at: resolvedAt, p_expected: expected,
    });
  } catch { throw disputeResolveUnavailable(); }
  // Only this exact typed PostgreSQL rejection proves the mutation did not run.
  if (response?.data === null && response.error && typeof response.error === 'object' && !Array.isArray(response.error)
      && response.error.code === 'P0001' && response.error.message === 'REVIEWED_DISPUTE_STALE') {
    throw new ConflictError('The dispute can no longer be resolved');
  }
  if (!response || response.error !== null) throw disputeResolveUnavailable();
  // Both projections come from the mutation transaction. A later read must not
  // substitute a newer row for what this approved execution actually changed.
  const result = resolveDisputeResultSchema.safeParse(response.data);
  if (!result.success) throw disputeResolveUnavailable();
  const dispute = result.data.dispute;
  const fractionalTime = /\.(\d+)/.exec(dispute.resolved_at)?.[1] ?? '';
  if (Date.parse(dispute.resolved_at) !== Date.parse(resolvedAt)
      || /[1-9]/.test(fractionalTime.slice(3))) throw disputeResolveUnavailable();
  const planned = plannedResolvedDisputeState({ selection: expected, resolutionNote: data.data.resolution_note,
    resolvedAt: dispute.resolved_at });
  if (JSON.stringify(dispute) !== JSON.stringify(planned)
      || JSON.stringify(result.data.entry) !== JSON.stringify({ ...expected.entry, status: 'resolved' })) {
    throw disputeResolveUnavailable();
  }
  try {
    await audit.log({ ...actorCtx, workspaceId, actorUserId: reviewed.data.userId, actorMemberId: resolvedByMemberId,
      action: AUDIT_ACTIONS.DISPUTE_RESOLVED, targetType: 'dispute', targetId: disputeId, required: true,
      metadata: { agent_initiated: true, proposal_id: reviewed.data.proposalId,
        session_id: reviewed.data.trace.sessionId, conversation_id: reviewed.data.trace.conversationId,
        sensitive_action: true, secondary_confirmation: true } });
  } catch { throw disputeResolveUnavailable(); }
  try {
    await notification.send({ type: 'dispute_resolved', workspaceId, recipientIds: [expected.dispute.raised_by],
      referenceType: 'dispute', referenceId: disputeId, variables: { container: expected.container_name },
      dedupKey: `dispute_resolved:${disputeId}` });
  } catch (err) {
    logger.warn('Dispute resolution notification unavailable', { workspaceId, disputeId, errorCode: err?.code });
  }
  const { dispute_id: id, ...disputeFields } = result.data.dispute;
  const { entry_id: resultEntryId, ...entryFields } = result.data.entry;
  return { dispute: { id, ...disputeFields }, entry: { id: resultEntryId, ...entryFields } };
}

// Both resolvers require dual transitions in one transaction. The reviewed RPC
// also locks eligibility rows and returns both exact approved projections.
async function resolveDispute({ workspaceId, disputeId, resolutionNote, resolvedByMemberId, isAdmin, actorCtx, reviewedResolution }) {
  if (reviewedResolution !== undefined) {
    return resolveReviewedDispute({ workspaceId, disputeId, resolutionNote, resolvedByMemberId, isAdmin, actorCtx, reviewedResolution });
  }
  const { data: dispute } = await supabaseAdmin
    .from('disputes')
    .select('*, ledger_entries!ledger_entry_id(container_id, containers!container_id(name))')
    .eq('id', disputeId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!dispute) throw new NotFoundError('Dispute not found');
  if (dispute.status !== 'open') throw new BusinessRuleError('Dispute is already resolved');

  const containerName = dispute.ledger_entries?.containers?.name || 'a container';

  const now = new Date().toISOString();
  const { data: updatedData, error: rpcErr } = await supabaseAdmin.rpc('resolve_dispute_atomic', {
    p_dispute_id:      disputeId,
    p_resolution_note: resolutionNote,
    p_resolved_by:     resolvedByMemberId,
    p_resolved_at:     now,
  });
  if (rpcErr) throw new Error(rpcErr.message);
  const updated = updatedData;

  await notification.send({
    type:          'dispute_resolved',
    workspaceId,
    recipientIds:  [dispute.raised_by],
    referenceType: 'dispute',
    referenceId:   disputeId,
    variables:     { container: containerName },
  });
  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.DISPUTE_RESOLVED, targetType: 'dispute', targetId: disputeId });

  return updated;
}

module.exports = { listDisputes, getDispute, getRaiseDisputeContext, getResolveDisputeContext, raiseDispute, addDisputeNote, resolveDispute };
