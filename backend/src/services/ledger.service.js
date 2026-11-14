// src/services/ledger.service.js
//
// Preserves the idempotency-key flow, the fail-loud idempotency lookup,
// the duplicate-detection window, the correction-restricted-to-confirmed-
// entries rule, and file verification exactly as designed.

const { supabaseAdmin } = require('../config/supabase');
const { AppError, NotFoundError, BusinessRuleError, ConflictError, ForbiddenError, ValidationError } = require('../utils/errors');
const { z } = require('zod');
const { SUPPORTED_CURRENCIES } = require('../validators/auth.validator');
const {
  selfLedgerContextSchema, selfLedgerSubmissionDataSchema, normalizeSelfLedgerAmount,
} = require('../validators/ledger.validator');
const { generateUploadUrl, generateDownloadUrl, verifyUploadedFile, assertUploadPath } = require('./storage.service');
const notification = require('./notification.service');
const audit        = require('./audit.service');
const { exportLedgerCSV } = require('./export.service');
const logger = require('../utils/logger');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');
const { getSort } = require('../utils/sorting');
const { PAID_STATUSES, PENDING_STATUSES } = require('../constants/ledger-status');

// Defaults to enabled now that the schema confirms the idempotency_key
// column + unique constraint already exist in production.
const IDEMPOTENCY_ENABLED = process.env.IDEMPOTENCY_ENABLED !== 'false';
if (!IDEMPOTENCY_ENABLED) {
  logger.warn('Ledger idempotency-key checking is explicitly DISABLED via IDEMPOTENCY_ENABLED=false.');
}

async function assertWorkspaceContainer({ workspaceId, containerId }) {
  const { data: container, error } = await supabaseAdmin.from('containers').select('id')
    .eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();
  if (error) throw new AppError('Ledger entries are unavailable. Please try again.', 503, 'LEDGER_UNAVAILABLE');
  if (!container) throw new NotFoundError('Container not found');
}

async function listEntries({ workspaceId, containerId, isAdmin, callerId, query = {}, page, perPage, offset }) {
  await assertWorkspaceContainer({ workspaceId, containerId });
  let dbQuery = supabaseAdmin
    .from('ledger_entries')
    .select(`
      *, 
      contributor:workspace_members!contributor_id(display_name),
      recorded_by_member:workspace_members!recorded_by(display_name),
      confirmed_by_member:workspace_members!confirmed_by(display_name)
    `, { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('container_id', containerId);

  if (!isAdmin) {
    dbQuery = dbQuery.eq('contributor_id', callerId);
  } else {
    const contributorFilter = query.contributor_id || query['filter[contributor_id]'];
    if (contributorFilter) dbQuery = dbQuery.eq('contributor_id', contributorFilter);
  }

  const statusFilter = query.status || query['filter[status]'];
  if (statusFilter) dbQuery = dbQuery.eq('status', statusFilter);

  const fromDate = query.from;
  const toDate   = query.to;
  if (fromDate) dbQuery = dbQuery.gte('recorded_at', fromDate);
  if (toDate)   dbQuery = dbQuery.lte('recorded_at', toDate);

  const { field: safeSort, ascending } = getSort(query, {
    allowed: ['recorded_at', 'base_amount', 'status', 'original_amount'],
    defaultField: 'recorded_at',
    defaultDescending: true,
  });

  dbQuery = dbQuery.order(safeSort, { ascending }).order('id', { ascending: true }).range(offset, offset + perPage - 1);

  const { data, error, count } = await dbQuery;
  if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count < 0) {
    throw new AppError('Ledger entries are unavailable. Please try again.', 503, 'LEDGER_UNAVAILABLE');
  }

  const entries = data.map((le) => ({
    ...le,
    contributor_name:   le.contributor?.display_name,
    recorded_by_name:   le.recorded_by_member?.display_name,
    confirmed_by_name:  le.confirmed_by_member?.display_name,
    contributor:         undefined,
    recorded_by_member:  undefined,
    confirmed_by_member: undefined,
  }));

  return { entries, count };
}

async function getEntry({ workspaceId, containerId, entryId, isAdmin, callerId }) {
  await assertWorkspaceContainer({ workspaceId, containerId });
  const { data: entry, error } = await supabaseAdmin
    .from('ledger_entries')
    .select(`
      *,
      contributor:workspace_members!contributor_id(display_name),
      recorded_by_member:workspace_members!recorded_by(display_name),
      confirmed_by_member:workspace_members!confirmed_by(display_name)
    `)
    .eq('id', entryId)
    .eq('container_id', containerId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) throw new AppError('Ledger entries are unavailable. Please try again.', 503, 'LEDGER_UNAVAILABLE');
  if (!entry) throw new NotFoundError('Ledger entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('Access denied');

  return {
    ...entry,
    contributor_name:   entry.contributor?.display_name,
    recorded_by_name:   entry.recorded_by_member?.display_name,
    confirmed_by_name:  entry.confirmed_by_member?.display_name,
    contributor:         undefined,
    recorded_by_member:  undefined,
    confirmed_by_member: undefined,
  };
}

// Validates that `contributorId` is a money-enabled participant in this
// container, and that a non-admin caller isn't recording/reassigning an
// entry to a proxy member. Returns the participant row (so callers that
// also need participant.money_enabled etc. don't have to re-fetch it).
//
// Factored out of createEntry so updateEntry can run the identical check
// when an admin reassigns contributor_id on a pending entry — previously
// updateEntry only validated contributor_id as a well-formed UUID (via
// Zod), so an admin could reassign a pending entry to someone who wasn't
// even a participant in the container, had money tracking disabled, or
// was a proxy member (bypassing the proxy-admin-only rule that createEntry
// enforces up front).
async function validateContributorForContainer({ workspaceId, containerId, contributorId, isAdmin }) {
  if (!contributorId) {
    throw new BusinessRuleError('Contributor ID is required');
  }

  const { data: participant, error: pErr } = await supabaseAdmin
    .from('container_participants')
    .select('*, workspace_member_id')
    .eq('container_id', containerId)
    .eq('workspace_member_id', contributorId)
    .maybeSingle();

  if (pErr) throw new Error(pErr.message);
  if (!participant) throw new BusinessRuleError('Contributor is not a participant in this container');

  const { data: member, error: mErr } = await supabaseAdmin
    .from('workspace_members')
    .select('is_proxy')
    .eq('id', participant.workspace_member_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (mErr) throw new Error(mErr.message);

  if (member?.is_proxy && !isAdmin) {
    throw new ForbiddenError('Only admins can record contributions for proxy members');
  }

  if (!participant.money_enabled) {
    throw new BusinessRuleError(
      'Money tracking is not enabled for this participant. ' +
      'Enable it from the Participants tab before recording a ledger entry.'
    );
  }

  return { participant, isProxy: !!member?.is_proxy };
}

const selfLedgerCallerSchema = z.object({
  workspaceId: z.string().uuid(), containerId: z.string().uuid(),
  callerId: z.string().uuid(), userId: z.string().uuid(), isAdmin: z.boolean(),
}).strict();
const selfSubmissionSchema = z.object({
  userId: z.string().uuid(), expected: selfLedgerContextSchema,
}).strict();
const agentLedgerKeySchema = z.string().length(42)
  .regex(/^agent:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
const selfLedgerWorkspaceRowSchema = z.object({
  id: z.string().uuid(), base_currency: z.enum(SUPPORTED_CURRENCIES),
});
const selfLedgerMemberRowSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(), user_id: z.string().uuid(),
  role: z.enum(['member', 'admin']), is_active: z.boolean(), is_proxy: z.boolean(),
});
const selfLedgerContainerRowSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(), name: z.string().min(1).max(200),
  container_type: z.enum(['event', 'recurring']),
  status: z.enum(['active', 'completed', 'archived', 'cancelled']),
  enable_money: z.boolean(), updated_at: z.string().datetime({ offset: true }),
});
const selfLedgerParticipantRowSchema = z.object({
  id: z.string().uuid(), container_id: z.string().uuid(),
  workspace_member_id: z.string().uuid(), money_enabled: z.boolean(),
});
const selfLedgerStoredIdentitySchema = z.object({
  id: z.string().uuid(), recorded_at: z.string().datetime({ offset: true }),
});
const selfLedgerUnavailable = () => new AppError(
  'Ledger submissions are unavailable. Please try again.', 503, 'LEDGER_UNAVAILABLE',
);

async function selfLedgerOperation(operation) {
  let response;
  try { response = await operation(); } catch { throw selfLedgerUnavailable(); }
  if (!response || typeof response !== 'object'
      || !Object.hasOwn(response, 'data') || !Object.hasOwn(response, 'error')) {
    throw selfLedgerUnavailable();
  }
  return response;
}

async function readSelfLedgerRow(operation) {
  const response = await selfLedgerOperation(operation);
  if (response.error !== null || (response.data !== null
      && (typeof response.data !== 'object' || Array.isArray(response.data)))) {
    throw selfLedgerUnavailable();
  }
  return response.data;
}

/** Read only the caller's submission eligibility; tools never query directly. */
async function getSelfSubmissionContext({ workspaceId, containerId, callerId, userId, isAdmin }) {
  if (!selfLedgerCallerSchema.safeParse({ workspaceId, containerId, callerId, userId, isAdmin }).success) {
    throw new ValidationError('Invalid self ledger context');
  }
  const workspaceRaw = await readSelfLedgerRow(() => supabaseAdmin.from('workspaces')
    .select('id, base_currency').eq('id', workspaceId).is('deleted_at', null).maybeSingle());
  if (!workspaceRaw) throw new NotFoundError('Workspace not found');
  const workspace = selfLedgerWorkspaceRowSchema.safeParse(workspaceRaw);
  if (!workspace.success || workspace.data.id !== workspaceId) throw selfLedgerUnavailable();

  const memberRaw = await readSelfLedgerRow(() => supabaseAdmin.from('workspace_members')
    .select('id, workspace_id, user_id, role, is_active, is_proxy')
    .eq('id', callerId).eq('workspace_id', workspaceId).eq('user_id', userId)
    .eq('is_active', true).eq('is_proxy', false).is('deleted_at', null).maybeSingle());
  if (!memberRaw) throw new ForbiddenError('Active workspace membership required');
  const member = selfLedgerMemberRowSchema.safeParse(memberRaw);
  if (!member.success) throw selfLedgerUnavailable();
  if (member.data.id !== callerId || member.data.workspace_id !== workspaceId
      || member.data.user_id !== userId || !member.data.is_active || member.data.is_proxy
      || member.data.role !== (isAdmin ? 'admin' : 'member')) {
    throw new ForbiddenError('Workspace membership changed. Please retry.');
  }

  const containerRaw = await readSelfLedgerRow(() => supabaseAdmin.from('containers')
    .select('id, workspace_id, name, container_type, status, enable_money, updated_at')
    .eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle());
  if (!containerRaw) throw new NotFoundError('Container not found');
  const container = selfLedgerContainerRowSchema.safeParse(containerRaw);
  if (!container.success || container.data.id !== containerId || container.data.workspace_id !== workspaceId) {
    throw selfLedgerUnavailable();
  }
  if (container.data.container_type !== 'event' || container.data.status !== 'active' || !container.data.enable_money) {
    throw new BusinessRuleError('Self contributions require an active event container with money tracking enabled');
  }

  const participantRaw = await readSelfLedgerRow(() => supabaseAdmin.from('container_participants')
    .select('id, container_id, workspace_member_id, money_enabled')
    .eq('container_id', containerId).eq('workspace_member_id', callerId).maybeSingle());
  if (!participantRaw) throw new BusinessRuleError('You must be a participant in this container');
  const participant = selfLedgerParticipantRowSchema.safeParse(participantRaw);
  if (!participant.success || participant.data.container_id !== containerId || participant.data.workspace_member_id !== callerId) {
    throw selfLedgerUnavailable();
  }
  if (!participant.data.money_enabled) throw new BusinessRuleError('Money tracking must be enabled for your participation');

  return selfLedgerContextSchema.parse({
    workspace_id: workspaceId, base_currency: workspace.data.base_currency,
    container_id: containerId, container_name: container.data.name,
    container_type: container.data.container_type, container_status: container.data.status,
    enable_money: container.data.enable_money, container_updated_at: container.data.updated_at,
    contributor_id: callerId, member_role: member.data.role,
    participant_id: participant.data.id, money_enabled: participant.data.money_enabled,
  });
}

async function assertSelfSubmissionCurrent({ workspaceId, containerId, callerId, isAdmin, selfSubmission }) {
  let current;
  try {
    current = await getSelfSubmissionContext({ workspaceId, containerId, callerId, isAdmin, userId: selfSubmission.userId });
  } catch (err) {
    if (['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION'].includes(err.code)) {
      throw new ConflictError('The reviewed ledger submission is no longer available');
    }
    throw err;
  }
  if (Object.keys(selfLedgerContextSchema.shape).some((field) => !Object.is(current[field], selfSubmission.expected[field]))) {
    throw new ConflictError('The ledger submission context changed since it was reviewed');
  }
}

function verifySelfLedgerEntry({ entry, workspaceId, containerId, callerId, data, idempotencyKey, inserted = false }) {
  const matches = selfLedgerStoredIdentitySchema.safeParse(entry).success
    && entry.workspace_id === workspaceId && entry.container_id === containerId
    && entry.contributor_id === callerId && entry.recorded_by === callerId
    && entry.entry_type === data.entry_type && entry.original_currency === data.original_currency
    && normalizeSelfLedgerAmount(entry.original_amount) === data.original_amount
    && normalizeSelfLedgerAmount(entry.base_amount) === data.base_amount
    && entry.payment_method === data.payment_method && entry.note === data.note
    && entry.cycle_id === null && entry.is_crypto === false && entry.status === 'pending'
    && entry.confirmed_at === null && entry.confirmed_by === null && entry.corrects_entry_id === null
    && entry.idempotency_key === idempotencyKey;
  if (!matches) {
    if (inserted) {
      throw new AppError('The ledger submission result could not be verified.', 503, 'LEDGER_SUBMISSION_INDETERMINATE');
    }
    throw new ConflictError('The ledger submission key belongs to a different or changed entry');
  }
}

async function createEntry({ workspaceId, containerId, data, isAdmin, callerId, force, idempotencyKey, actorDisplayName, actorCtx, selfSubmission }) {
  if (selfSubmission !== undefined) {
    const options = selfSubmissionSchema.safeParse(selfSubmission);
    const submission = selfLedgerSubmissionDataSchema.safeParse(data);
    if (!options.success || !submission.success
        || !selfLedgerCallerSchema.safeParse({ workspaceId, containerId, callerId, isAdmin, userId: options.data?.userId }).success
        || (force !== undefined && force !== false) || !agentLedgerKeySchema.safeParse(idempotencyKey).success) {
      throw new ValidationError('Invalid self ledger submission');
    }
    selfSubmission = options.data;
    data = submission.data;
    if (selfSubmission.expected.workspace_id !== workspaceId || selfSubmission.expected.container_id !== containerId
        || selfSubmission.expected.contributor_id !== callerId || data.contributor_id !== callerId
        || selfSubmission.expected.member_role !== (isAdmin ? 'admin' : 'member')) {
      throw new ForbiddenError('Only your own contribution can use self submission');
    }
    if (data.original_currency !== selfSubmission.expected.base_currency || data.original_amount !== data.base_amount) {
      throw new ValidationError('Self contributions must use the workspace base currency without conversion');
    }
    if (!IDEMPOTENCY_ENABLED) throw selfLedgerUnavailable();
    await assertSelfSubmissionCurrent({ workspaceId, containerId, callerId, isAdmin, selfSubmission });
  }

  if (idempotencyKey && IDEMPOTENCY_ENABLED) {
    const lookup = () => supabaseAdmin
      .from('ledger_entries')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    let existing;
    if (selfSubmission) {
      existing = await readSelfLedgerRow(lookup);
    } else {
      const { data: existingRow, error: idempErr } = await lookup();
      if (idempErr) {
        logger.error('Idempotency-key lookup failed', { idempotencyKey, workspaceId, error: idempErr.message });
        throw new Error(idempErr.message);
      }
      existing = existingRow;
    }

    if (existing) {
      if (selfSubmission) verifySelfLedgerEntry({ entry: existing, workspaceId, containerId, callerId, data, idempotencyKey });
      return { entry: existing, idempotent: true };
    }
  }

  // A non-admin always records for themselves, but if they explicitly
  // target a proxy member, reject that up front — otherwise the request
  // silently falls through to "caller is not a participant" (422) and the
  // proxy-admin-only rule is never enforced.
  if (!isAdmin && data.contributor_id && data.contributor_id !== callerId) {
    const { data: target, error: tErr } = await supabaseAdmin
      .from('workspace_members')
      .select('is_proxy')
      .eq('id', data.contributor_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (target?.is_proxy) {
      throw new ForbiddenError('Only admins can record contributions for proxy members');
    }
  }

  const contributorId = isAdmin ? data.contributor_id : callerId;

  let isProxy = false;
  if (!selfSubmission) {
    ({ isProxy } = await validateContributorForContainer({ workspaceId, containerId, contributorId, isAdmin }));
    if (data.cycle_id) {
      const { data: cycle } = await supabaseAdmin
        .from('container_cycles')
        .select('id')
        .eq('id', data.cycle_id)
        .eq('container_id', containerId)
        .maybeSingle();
      if (!cycle) throw new BusinessRuleError('Cycle does not belong to this container');
    }
  }

  const now    = new Date().toISOString();
  const status = selfSubmission ? 'pending' : (isAdmin ? 'confirmed' : 'pending');

  let entry;

  if (idempotencyKey && IDEMPOTENCY_ENABLED) {
    // Idempotency-key path: a plain INSERT, backed by the real UNIQUE
    // constraint on idempotency_key. Two concurrent requests sharing a
    // key race on the INSERT itself (not a separate check), and the
    // loser's 23505 is caught below and turned into a clean idempotent
    // replay. This path was independently verified under concurrency
    // (scripts/experiments/m2-idempotency-race.js — 9/9 runs, 0
    // violations) and is unchanged by this fix.
    if (selfSubmission) await assertSelfSubmissionCurrent({ workspaceId, containerId, callerId, isAdmin, selfSubmission });
    const insert = () => supabaseAdmin
      .from('ledger_entries')
      .insert({
        workspace_id:      workspaceId,
        container_id:      containerId,
        cycle_id:          data.cycle_id || null,
        entry_type:        data.entry_type,
        contributor_id:    contributorId,
        original_amount:   data.original_amount,
        original_currency: data.original_currency,
        base_amount:       data.base_amount,
        payment_method:    data.payment_method || null,
        note:              data.note           || null,
        is_crypto:         data.is_crypto      || false,
        idempotency_key:   idempotencyKey,
        status,
        recorded_by:       callerId,
        confirmed_at:      status === 'confirmed' ? now : null,
        confirmed_by:      status === 'confirmed' ? callerId : null,
      })
      .select()
      .single();
    const { data: inserted, error: entryErr } = selfSubmission
      ? await selfLedgerOperation(insert) : await insert();

    if (entryErr) {
      // Lost an idempotency race: a concurrent request with the same key inserted first.
      // Return that entry (idempotent replay) instead of surfacing a 409.
      if (entryErr.code === '23505') {
        const findWinner = () => supabaseAdmin
          .from('ledger_entries').select('*')
          .eq('idempotency_key', idempotencyKey).eq('workspace_id', workspaceId).maybeSingle();
        const winner = selfSubmission ? await readSelfLedgerRow(findWinner) : (await findWinner()).data;
        if (winner) {
          if (selfSubmission) verifySelfLedgerEntry({ entry: winner, workspaceId, containerId, callerId, data, idempotencyKey });
          return { entry: winner, idempotent: true };
        }
      }
      if (selfSubmission) throw selfLedgerUnavailable();
      throw new Error(entryErr.message);
    }
    if (selfSubmission) {
      if (entryErr !== null) throw selfLedgerUnavailable();
      verifySelfLedgerEntry({ entry: inserted, workspaceId, containerId, callerId, data, idempotencyKey, inserted: true });
    }
    entry = inserted;
  } else {
    // No idempotency key: the 10-minute duplicate-detection window has
    // no database constraint behind it, so the check and the insert
    // must happen atomically under a lock, or two concurrent identical
    // submissions (e.g. a double-tapped submit button) both pass the
    // check and both insert. create_ledger_entry_checked takes a
    // pg_advisory_xact_lock keyed on (container_id, contributor_id)
    // around the check-then-insert so concurrent callers for the same
    // contributor serialize instead of racing past the check. See
    // migrations/004_fix_ledger_entry_duplicate_check_race.sql.
    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc('create_ledger_entry_checked', {
      p_workspace_id:      workspaceId,
      p_container_id:      containerId,
      p_cycle_id:          data.cycle_id || null,
      p_entry_type:        data.entry_type,
      p_contributor_id:    contributorId,
      p_original_amount:   data.original_amount,
      p_original_currency: data.original_currency,
      p_base_amount:       data.base_amount,
      p_payment_method:    data.payment_method || null,
      p_note:              data.note           || null,
      p_is_crypto:         data.is_crypto      || false,
      p_status:            status,
      p_recorded_by:       callerId,
      p_confirmed_at:      status === 'confirmed' ? now : null,
      p_confirmed_by:      status === 'confirmed' ? callerId : null,
      p_dup_window:        '10 minutes',
      p_force:             !!force,
    });

    if (rpcErr) throw new Error(rpcErr.message);

    if (rpcResult.duplicate) {
      throw new ConflictError('Possible duplicate contribution detected within the last 10 minutes. Use ?force=true to override.', { existing_entry_id: rpcResult.existing_entry_id });
    }
    entry = rpcResult.entry;
  }

  if (isProxy) {
    await supabaseAdmin.from('proxy_actions').insert({
      workspace_id:    workspaceId,
      proxy_member_id: contributorId,
      managed_by_id:   callerId,
      action_type:     'ledger_entry',
      target_id:       entry.id,
      action_details:  { amount: data.original_amount, currency: data.original_currency },
    });
  }

  if (status === 'pending') {
    const findAdmins = () => supabaseAdmin
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('role', 'admin')
      .eq('is_active', true);
    const adminResponse = selfSubmission ? await selfLedgerOperation(findAdmins) : await findAdmins();
    if (selfSubmission && (adminResponse.error !== null || !Array.isArray(adminResponse.data)
        || adminResponse.data.some((member) => !z.object({ id: z.string().uuid() }).safeParse(member).success))) {
      throw selfLedgerUnavailable();
    }
    const admins = adminResponse.data;

    try {
      await notification.send({
        type:          'contribution_submitted',
        workspaceId,
        recipientIds:  (admins || []).map((a) => a.id),
        referenceType: 'ledger_entry',
        referenceId:   entry.id,
        variables: {
          actor:     actorDisplayName,
          amount:    `${data.original_amount} ${data.original_currency}`,
          container: containerId,
        },
      });
    } catch (err) {
      if (selfSubmission) throw selfLedgerUnavailable();
      throw err;
    }
  }

  try {
    await audit.log({
      ...actorCtx,
      action:     status === 'confirmed' ? AUDIT_ACTIONS.LEDGER_CONFIRMED : AUDIT_ACTIONS.LEDGER_SUBMITTED,
      targetType: 'ledger_entry',
      targetId:   entry.id,
    });
  } catch (err) {
    if (selfSubmission) throw selfLedgerUnavailable();
    throw err;
  }

  return { entry, idempotent: false };
}

async function updateEntry({ workspaceId, containerId, entryId, data, isAdmin, callerId }) {
  const { data: entry, error: fetchErr } = await supabaseAdmin
    .from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();

  if (fetchErr) throw new Error(fetchErr.message);
  if (!entry) throw new NotFoundError('Ledger entry not found');
  if (entry.status !== 'pending') throw new BusinessRuleError('Only pending entries can be edited');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('You can only edit your own entries');
  if (!isAdmin && data.contributor_id !== undefined) throw new ForbiddenError('Only admins can change the contributor');

  // Reassigning contributor_id used to skip validation entirely (Zod only
  // checked it was a UUID) — an admin could move a pending entry onto a
  // workspace member who isn't even a participant in this container, has
  // money tracking disabled, or is a proxy member. createEntry already
  // runs this exact check when an entry is first recorded; a reassignment
  // is no different and needs the same guarantee to hold.
  if (isAdmin && data.contributor_id !== undefined && data.contributor_id !== entry.contributor_id) {
    await validateContributorForContainer({
      workspaceId, containerId, contributorId: data.contributor_id, isAdmin,
    });
  }

  const allowedFields = isAdmin
    ? ['original_amount','original_currency','base_amount','payment_method','note','contributor_id']
    : ['original_amount','original_currency','base_amount','payment_method','note'];

  const updates = {};
  for (const field of allowedFields) {
    if (data[field] !== undefined) updates[field] = data[field];
  }

  if (!Object.keys(updates).length) return entry;

  const { data: updated, error } = await supabaseAdmin.from('ledger_entries').update(updates).eq('id', entryId).select().single();
  if (error) throw new Error(error.message);

  return updated;
}

async function deleteEntry({ containerId, entryId, isAdmin, callerId, actorCtx }) {
  const { data: entry, error: fetchErr } = await supabaseAdmin
    .from('ledger_entries')
    .select('id, status, contributor_id')
    .eq('id', entryId)
    .eq('container_id', containerId)
    .maybeSingle();

  if (fetchErr) throw new Error(fetchErr.message);
  if (!entry) throw new NotFoundError('Ledger entry not found');

  if (!['pending', 'proof_uploaded'].includes(entry.status)) {
    throw new BusinessRuleError('Only pending or proof-uploaded entries can be deleted. Use corrections to adjust confirmed entries.');
  }

  if (!isAdmin && entry.contributor_id !== callerId) {
    throw new ForbiddenError('You can only delete your own entries');
  }

  const { error: delErr } = await supabaseAdmin
    .from('ledger_entries')
    .delete()
    .eq('id', entryId)
    .eq('container_id', containerId);

  if (delErr) throw new Error(delErr.message);

  await audit.log({
    ...actorCtx,
    action:     AUDIT_ACTIONS.LEDGER_DELETED,
    targetType: 'ledger_entry',
    targetId:   entryId,
  });
}

async function getLedgerSummary({ workspaceId, containerId, isAdmin, callerId }) {
  let query = supabaseAdmin
    .from('ledger_entries')
    .select('status, base_amount')
    .eq('workspace_id', workspaceId)
    .eq('container_id', containerId);

  if (!isAdmin) query = query.eq('contributor_id', callerId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const entries = data || [];

  // "confirmed" here means PAID_STATUSES (confirmed + resolved), not just
  // status === 'confirmed' — a resolved dispute is still money the
  // contributor has credit for. See constants/ledger-status.js.
  const confirmed     = entries.filter((e) => PAID_STATUSES.includes(e.status));
  const pending       = entries.filter((e) => e.status === 'pending');
  const proofUploaded = entries.filter((e) => e.status === 'proof_uploaded');
  const disputed      = entries.filter((e) => e.status === 'disputed');

  const sum = (arr) => arr.reduce((s, e) => s + parseFloat(e.base_amount || 0), 0);

  return {
    confirmed_count:        confirmed.length,
    confirmed_base_total:   sum(confirmed),
    pending_count:          pending.length + proofUploaded.length,
    pending_base_total:     sum([...pending, ...proofUploaded]),
    disputed_count:         disputed.length,
    disputed_base_total:    sum(disputed),
    total_count:            entries.length,
    total_base_amount:      sum(entries),
  };
}

async function getUploadProofUrl({ workspaceId, containerId, entryId, isAdmin, callerId, filename, contentType, fileSize }) {
  const { data: entry } = await supabaseAdmin.from('ledger_entries').select('contributor_id').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!entry) throw new NotFoundError('Entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('Access denied');

  return generateUploadUrl({ workspaceId, folder: `proofs/${entryId}`, filename, contentType, fileSize, fileType: 'proof' });
}

async function confirmProof({ workspaceId, containerId, entryId, isAdmin, callerId, filePayload, actorDisplayName }) {
  const { data: entry } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!entry) throw new NotFoundError('Entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('Access denied');

  // Verify the uploaded file's actual bytes match its declared content
  // type before trusting it as proof.
  assertUploadPath(filePayload.file_path, `workspaces/${workspaceId}/proofs/${entryId}/`);
  await verifyUploadedFile(filePayload.file_path, filePayload.mime_type);

  const fileObject    = { url: filePayload.file_path, name: filePayload.name, size: filePayload.size, mime_type: filePayload.mime_type, uploaded_by: callerId, uploaded_at: new Date().toISOString() };
  const currentProofs = Array.isArray(entry.proofs) ? entry.proofs : [];
  const newStatus     = entry.status === 'pending' ? 'proof_uploaded' : entry.status;

  const { data: updated, error } = await supabaseAdmin
    .from('ledger_entries')
    .update({ proofs: [...currentProofs, fileObject], status: newStatus })
    .eq('id', entryId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  if (newStatus === 'proof_uploaded') {
    const { data: admins } = await supabaseAdmin.from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true);
    await notification.send({ type: 'contribution_submitted', workspaceId, recipientIds: (admins || []).map((a) => a.id), referenceType: 'ledger_entry', referenceId: entryId, variables: { actor: actorDisplayName, amount: '', container: containerId } });
  }

  return updated;
}

async function confirmEntry({ workspaceId, containerId, entryId, actorMemberId, actorCtx }) {
  const { data: entry } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!entry) throw new NotFoundError('Entry not found');
  if (!['pending','proof_uploaded'].includes(entry.status)) throw new BusinessRuleError('Only pending or proof_uploaded entries can be confirmed');

  const { data: updated, error } = await supabaseAdmin
    .from('ledger_entries')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), confirmed_by: actorMemberId })
    .eq('id', entryId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  await notification.send({ type: 'contribution_confirmed', workspaceId, recipientIds: [entry.contributor_id], referenceType: 'ledger_entry', referenceId: entryId, variables: { amount: `${entry.original_amount} ${entry.original_currency}`, container: containerId } });
  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.LEDGER_CONFIRMED, targetType: 'ledger_entry', targetId: entryId });

  return updated;
}

// Corrections may only be attached to confirmed entries — non-confirmed
// entries can simply be edited (updateEntry) or deleted (deleteEntry)
// instead.
async function addCorrection({ workspaceId, containerId, entryId, data, actorMemberId, actorCtx }) {
  const { data: source } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!source) throw new NotFoundError('Entry not found');

  if (source.status !== 'confirmed') {
    throw new BusinessRuleError(
      'Only confirmed entries can be corrected. Pending or proof-uploaded entries can be edited or deleted directly instead.'
    );
  }

  const { data: corrParticipant } = await supabaseAdmin
    .from('container_participants')
    .select('money_enabled')
    .eq('container_id', containerId)
    .eq('workspace_member_id', source.contributor_id)
    .maybeSingle();

  if (!corrParticipant?.money_enabled) {
    throw new BusinessRuleError('Cannot add a correction: money tracking is not enabled for this participant.');
  }

  const now = new Date().toISOString();
  const { data: correction, error } = await supabaseAdmin
    .from('ledger_entries')
    .insert({
      workspace_id: workspaceId, container_id: containerId, entry_type: 'correction',
      contributor_id: source.contributor_id, original_amount: data.original_amount,
      original_currency: data.original_currency, base_amount: data.base_amount,
      note: data.note, status: 'confirmed', recorded_by: actorMemberId,
      corrects_entry_id: entryId, confirmed_at: now, confirmed_by: actorMemberId,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.LEDGER_CORRECTED, targetType: 'ledger_entry', targetId: entryId, metadata: { correction_entry_id: correction.id } });

  return correction;
}

async function getProofUrl({ containerId, entryId, fileIndex, isAdmin, callerId }) {
  const { data: entry } = await supabaseAdmin.from('ledger_entries').select('contributor_id, proofs').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!entry) throw new NotFoundError('Entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('Access denied');

  const proofs = entry.proofs || [];
  if (fileIndex >= proofs.length) throw new NotFoundError(`No proof file at index ${fileIndex}`);

  return generateDownloadUrl(proofs[fileIndex].url, 900);
}

async function deleteProof({ containerId, entryId, proofIndex, isAdmin, callerId }) {
  if (isNaN(proofIndex) || proofIndex < 0) {
    throw new BusinessRuleError('Invalid proof index');
  }

  const { data: entry, error: fetchErr } = await supabaseAdmin
    .from('ledger_entries')
    .select('contributor_id, proofs, status')
    .eq('id', entryId)
    .eq('container_id', containerId)
    .maybeSingle();

  if (fetchErr) throw new Error(fetchErr.message);
  if (!entry) throw new NotFoundError('Ledger entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('Access denied');

  // Only pending/proof_uploaded entries are freely editable by their
  // owner. Previously this only blocked 'confirmed' — a non-admin could
  // still delete proofs on a 'disputed' or 'resolved' entry (the
  // immutability trigger exempts `proofs` from its lock), which is just
  // as settled/evidentiary as 'confirmed' and should get the same
  // protection.
  if (!isAdmin && !PENDING_STATUSES.includes(entry.status)) {
    throw new ForbiddenError('Only pending entry proofs can be removed by their owner; an admin is required once an entry is confirmed, disputed, or resolved');
  }

  const proofs = Array.isArray(entry.proofs) ? entry.proofs : [];
  if (proofIndex >= proofs.length) throw new NotFoundError(`No proof file at index ${proofIndex}`);

  const updatedProofs = proofs.filter((_, i) => i !== proofIndex);

  const { data: updated, error } = await supabaseAdmin
    .from('ledger_entries')
    .update({ proofs: updatedProofs })
    .eq('id', entryId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  return updated;
}

async function exportLedger({ workspaceId, containerId, from, to }) {
  return exportLedgerCSV({ workspaceId, containerId, from, to });
}

module.exports = {
  listEntries,
  getEntry,
  getSelfSubmissionContext,
  createEntry,
  updateEntry,
  deleteEntry,
  getLedgerSummary,
  getUploadProofUrl,
  confirmProof,
  confirmEntry,
  addCorrection,
  getProofUrl,
  deleteProof,
  exportLedger,
};
