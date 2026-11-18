// Real domain/proposal services, Postgres/PostgREST, audit writes, notifications
// and Redis CAS. No paid provider calls. Fault tests inject a lost reply or audit
// outage around real operations; they do not mock database state transitions.
// Transactional eligibility/missing-ledger-transition regressions belong with
// the separately approved RPC hardening patch, not this baseline contract.
const { createHash, randomUUID } = require('crypto');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getRedis } = require('../../../src/config/redis');
const { agentProposalKey } = require('../../../src/config/redis-keys');
const { closeQueues } = require('../../../src/queues');
const audit = require('../../../src/services/audit.service');
const disputes = require('../../../src/services/dispute.service');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const { AppError } = require('../../../src/utils/errors');
const raising = require('../../../src/agent/services/dispute-raise-proposal.service');
const resolving = require('../../../src/agent/services/dispute-resolve-proposal.service');
const { createProposal, decideProposal, confirmProposal, getProposalStatus, getProposalReceipts } = require('../../../src/agent/services/proposal.service');
const { seedWorkspaceWithAdmin, seedAdditionalMember, seedContainerWithParticipants, seedLedgerEntry, cleanupWorkspace } = require('../../helpers/dbHelper');
const { REASON } = require('../../helpers/agent-dispute-raise');
const { RESOLUTION_NOTE } = require('../../helpers/agent-dispute-resolve');

// Independent expected projections: using the production state builders here
// would allow a dropped field to pass both the receipt and persistence checks.
const ENTRY_COLUMNS = 'id, workspace_id, container_id, contributor_id, entry_type, original_amount::text, original_currency, base_amount::text, payment_method, note, cycle_id, is_crypto, status, corrects_entry_id, recorded_by, recorded_at, confirmed_at, confirmed_by';
function entryState({ id, ...fields }) { return { entry_id: id, ...fields }; }
function disputeState(row, includeNotes = false) {
  const state = { dispute_id: row.id, workspace_id: row.workspace_id, ledger_entry_id: row.ledger_entry_id,
    raised_by: row.raised_by, reason: row.reason, status: row.status, resolution_note: row.resolution_note,
    resolved_by: row.resolved_by, raised_at: row.raised_at, resolved_at: row.resolved_at };
  return includeNotes ? { ...state, notes: row.notes } : state;
}
function context(tenant, actor = tenant.admin) {
  return { userId: actor.user.id, member: { id: actor.member.id, workspaceId: tenant.workspace.id,
    role: actor.member.role, isActive: true }, workspace: { id: tenant.workspace.id }, requestId: randomUUID() };
}
async function readRow(table, id, columns = '*') {
  const { data, error } = await supabaseAdmin.from(table).select(columns).eq('id', id).single();
  if (error) throw error;
  return data;
}
async function updateRow(table, id, values) {
  const { data, error } = await supabaseAdmin.from(table).update(values).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
const approve = (actor, proposal) => decideProposal({ context: actor, proposalId: proposal.id, decision: 'approve', data: {} });
const confirm = (actor, proposal, challenge) => confirmProposal({ context: actor, proposalId: proposal.id,
  data: { confirmation: 'confirm', confirmation_token: challenge.confirmation_token } });
const status = (actor, proposal) => getProposalStatus({ context: actor, proposalId: proposal.id });
async function storedRecord(actor, proposal) {
  const scope = createHash('sha256').update(JSON.stringify([actor.userId, actor.member.id, actor.workspace.id, actor.member.role])).digest('hex');
  return JSON.parse(await getRedis().get(agentProposalKey(scope, proposal.id)));
}
async function actionAudits(tenant, proposal) {
  const { data, error } = await supabaseAdmin.from('audit_log').select('*')
    .eq('workspace_id', tenant.workspace.id).contains('metadata', { proposal_id: proposal.id });
  if (error) throw error;
  return data;
}
async function assertUnresolved(tenant, disputeId) {
  expect((await readRow('disputes', disputeId)).status).toBe('open');
  expect(entryState(await readRow('ledger_entries', tenant.entry.id, ENTRY_COLUMNS)))
    .toEqual({ ...tenant.initialEntry, status: 'disputed' });
}
function rpcCalls(spy, name) { return spy.mock.calls.filter(([rpc]) => rpc === name); }
function failAuditOnce(action) {
  const original = audit.log;
  let failed = false;
  return jest.spyOn(audit, 'log').mockImplementation(async (args) => {
    if (args.action === action && !failed) {
      failed = true;
      throw new AppError('Injected audit outage', 503, 'AUDIT_UNAVAILABLE');
    }
    return original(args);
  });
}

describe('reviewed dispute proposal integration baseline', () => {
  const workspaceIds = [];
  async function seedTenant() {
    const admin = await seedWorkspaceWithAdmin(supabaseAdmin, { workspace: { base_currency: 'NGN' } });
    workspaceIds.push(admin.workspace.id);
    const owner = await seedAdditionalMember(supabaseAdmin, admin.workspace.id);
    const { container } = await seedContainerWithParticipants(supabaseAdmin, { workspaceId: admin.workspace.id,
      createdBy: admin.member.id, participants: [{ workspace_member_id: owner.member.id, money_enabled: true }] });
    // Non-integer values and millisecond timestamps exercise the real text casts
    // and Postgres timestamp representation. Proofs/private keys stay unreviewed.
    const entry = await seedLedgerEntry(supabaseAdmin, { workspace_id: admin.workspace.id, container_id: container.id,
      contributor_id: owner.member.id, recorded_by: owner.member.id, original_amount: '5000.25',
      original_currency: 'NGN', base_amount: '5000.25', status: 'confirmed', note: 'Family groceries',
      recorded_at: '2026-11-15T12:01:00.123Z', confirmed_at: '2026-11-15T12:02:00.456Z', confirmed_by: admin.member.id,
      proofs: [{ name: 'Existing proof metadata' }], idempotency_key: randomUUID() });
    const tenant = { workspace: admin.workspace, admin, owner, container, entry,
      initialEntry: entryState(await readRow('ledger_entries', entry.id, ENTRY_COLUMNS)) };
    tenant.adminContext = context(tenant);
    tenant.ownerContext = context(tenant, owner);
    return tenant;
  }
  async function draftRaise(tenant) {
    const selection = await raising.selectDisputeContribution({ context: tenant.ownerContext,
      containerId: tenant.container.id, entryId: tenant.entry.id });
    return createProposal({ context: tenant.ownerContext, tool: 'raise_dispute', selection,
      args: { reason: `  ${REASON}  ` }, turnId: randomUUID(), conversationId: randomUUID() });
  }
  async function openDispute(tenant) {
    const proposal = await draftRaise(tenant);
    const challenge = await approve(tenant.ownerContext, proposal);
    const outcome = await confirm(tenant.ownerContext, proposal, challenge);
    expect(outcome.status).toBe('executed');
    return { proposal, challenge, outcome, disputeId: outcome.result.dispute.dispute_id };
  }
  async function draftResolve(tenant, disputeId) {
    const selection = await resolving.selectDisputeResolution({ context: tenant.adminContext, disputeId });
    return createProposal({ context: tenant.adminContext, tool: 'resolve_dispute', selection,
      args: { resolution_note: `  ${RESOLUTION_NOTE}  ` }, turnId: randomUUID(), conversationId: randomUUID() });
  }
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await closeQueues();
    for (const workspaceId of workspaceIds.reverse()) await cleanupWorkspace(supabaseAdmin, workspaceId);
  });

  it('opens then resolves only after separate confirmation, preserving exact stored fields, audits and receipts', async () => {
    const tenant = await seedTenant();
    const proposal = await draftRaise(tenant);
    expect(proposal.before.entry).toEqual(tenant.initialEntry);
    expect(proposal.after.entry).toEqual({ ...tenant.initialEntry, status: 'disputed' });
    const challenge = await approve(tenant.ownerContext, proposal);
    expect(challenge.status).toBe('awaiting_confirmation');
    expect(await approve(tenant.ownerContext, proposal)).toEqual(challenge);
    expect((await readRow('ledger_entries', tenant.entry.id)).status).toBe('confirmed');
    const beforeOpen = await supabaseAdmin.from('disputes').select('id').eq('ledger_entry_id', tenant.entry.id);
    expect(beforeOpen.error).toBeNull();
    expect(beforeOpen.data).toEqual([]);
    const opened = await confirm(tenant.ownerContext, proposal, challenge);
    const disputeId = opened.result.dispute.dispute_id;
    const openRow = await readRow('disputes', disputeId);
    expect(openRow).toMatchObject({ workspace_id: tenant.workspace.id, ledger_entry_id: tenant.entry.id,
      raised_by: tenant.owner.member.id, reason: REASON, status: 'open', resolution_note: null,
      resolved_by: null, resolved_at: null, notes: [] });
    expect(Number.isFinite(Date.parse(openRow.raised_at))).toBe(true);
    expect(opened.result).toEqual({ dispute: disputeState(openRow, true), entry: { ...tenant.initialEntry, status: 'disputed' } });
    expect(await confirm(tenant.ownerContext, proposal, challenge)).toEqual(opened);
    expect(await approve(tenant.ownerContext, proposal)).toEqual(opened);

    // Appended notes are outside resolution approval and must be preserved.
    const notes = [{ note: 'Private owner context', author_id: tenant.owner.member.id, added_at: '2026-11-17T12:00:00.000Z' }];
    await updateRow('disputes', disputeId, { notes });
    const resolution = await draftResolve(tenant, disputeId);
    expect(resolution.before.entry).toEqual(opened.result.entry);
    expect(resolution.before.dispute).toEqual(disputeState(openRow));
    const resolutionChallenge = await approve(tenant.adminContext, resolution);
    await assertUnresolved(tenant, disputeId);
    const resolved = await confirm(tenant.adminContext, resolution, resolutionChallenge);
    const resolvedRow = await readRow('disputes', disputeId);
    expect(resolvedRow).toEqual({ ...openRow, notes, status: 'resolved', resolution_note: RESOLUTION_NOTE,
      resolved_by: tenant.admin.member.id, resolved_at: resolved.result.dispute.resolved_at });
    expect(Number.isFinite(Date.parse(resolvedRow.resolved_at))).toBe(true);
    expect(resolved.result).toEqual({ dispute: disputeState(resolvedRow), entry: { ...tenant.initialEntry, status: 'resolved' } });
    expect(entryState(await readRow('ledger_entries', tenant.entry.id, ENTRY_COLUMNS))).toEqual(resolved.result.entry);
    const fullEntry = await readRow('ledger_entries', tenant.entry.id);
    expect(fullEntry.proofs).toEqual(tenant.entry.proofs);
    expect(fullEntry.idempotency_key).toBe(tenant.entry.idempotency_key);
    expect(await approve(tenant.adminContext, resolution)).toEqual(resolved);
    expect(await confirm(tenant.adminContext, resolution, resolutionChallenge)).toEqual(resolved);
    const receipt = await status(tenant.adminContext, resolution);
    expect(receipt).toMatchObject({ status: 'executed', dispute_id: disputeId,
      entry_id: tenant.entry.id, container_id: tenant.container.id, result: resolved.result });
    expect(await getProposalReceipts({ context: tenant.adminContext, proposals: [resolution] }))
      .toEqual([{ ...receipt, checked_at: expect.any(String) }]);
    for (const [card, actor, nativeAction] of [
      [proposal, tenant.owner, AUDIT_ACTIONS.DISPUTE_RAISED],
      [resolution, tenant.admin, AUDIT_ACTIONS.DISPUTE_RESOLVED],
    ]) {
      const events = await actionAudits(tenant, card);
      expect(events.map((event) => event.action).sort()).toEqual([
        AUDIT_ACTIONS.AGENT_ACTION_PROPOSED, AUDIT_ACTIONS.AGENT_ACTION_APPROVED,
        AUDIT_ACTIONS.AGENT_ACTION_CONFIRMED, AUDIT_ACTIONS.AGENT_ACTION_EXECUTED, nativeAction,
      ].sort());
      expect(new Set(events.map((event) => event.id)).size).toBe(5);
      for (const event of events) {
        expect(event).toMatchObject({ actor_user_id: actor.user.id, actor_member_id: actor.member.id,
          metadata: { agent_initiated: true, proposal_id: card.id, sensitive_action: true } });
      }
      const record = await storedRecord(context(tenant, actor), card);
      expect(events.every((event) => event.metadata.session_id === record.turnId
        && event.metadata.conversation_id === record.conversationId)).toBe(true);
      expect(JSON.stringify([card, events, receipt])).not.toContain(record.secondaryConfirmation.token);
    }
    const notifications = await supabaseAdmin.from('notifications').select('type, recipient_id, dedup_key')
      .eq('workspace_id', tenant.workspace.id).eq('reference_id', disputeId);
    expect(notifications.error).toBeNull();
    expect(notifications.data).toEqual(expect.arrayContaining([
      { type: 'contribution_disputed', recipient_id: tenant.admin.member.id,
        dedup_key: `contribution_disputed:${disputeId}:${tenant.admin.member.id}` },
      { type: 'dispute_resolved', recipient_id: tenant.owner.member.id,
        dedup_key: `dispute_resolved:${disputeId}:${tenant.owner.member.id}` },
    ]));
    expect(notifications.data).toHaveLength(2);
    expect(JSON.stringify(resolved.result)).not.toMatch(/Private owner context|Existing proof metadata|idempotency_key/);
  });

  it('cannot confirm a pending card even with its private nonce, or approve with an invalid nonce', async () => {
    const tenant = await seedTenant(); const opened = await openDispute(tenant);
    const proposal = await draftResolve(tenant, opened.disputeId);
    const record = await storedRecord(tenant.adminContext, proposal);
    await expect(confirm(tenant.adminContext, proposal, { confirmation_token: record.secondaryConfirmation.token }))
      .rejects.toMatchObject({ code: 'AGENT_PROPOSAL_CONFIRMATION_REQUIRED' });
    const challenge = await approve(tenant.adminContext, proposal);
    await expect(confirm(tenant.adminContext, proposal, { confirmation_token: randomUUID() }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await status(tenant.adminContext, proposal)).status).toBe('awaiting_confirmation');
    await assertUnresolved(tenant, opened.disputeId);
    expect(JSON.stringify(await getProposalReceipts({ context: tenant.adminContext, proposals: [proposal] })))
      .not.toContain(challenge.confirmation_token);
  });

  it('denies non-admin selection, crossed workspaces and another admin accessing an existing card', async () => {
    const tenant = await seedTenant(); const opened = await openDispute(tenant);
    await expect(resolving.selectDisputeResolution({ context: tenant.ownerContext, disputeId: opened.disputeId }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const otherTenant = await seedTenant();
    await expect(resolving.selectDisputeResolution({ context: otherTenant.adminContext, disputeId: opened.disputeId }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    const otherAdmin = await seedAdditionalMember(supabaseAdmin, tenant.workspace.id, { member: { role: 'admin' } });
    const proposal = await draftResolve(tenant, opened.disputeId);
    await expect(approve(context(tenant, otherAdmin), proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
    await expect(status(tenant.ownerContext, proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
    await assertUnresolved(tenant, opened.disputeId);
  });

  it('rechecks a revoked admin before confirmation despite the original server context', async () => {
    const tenant = await seedTenant(); const opened = await openDispute(tenant);
    const proposal = await draftResolve(tenant, opened.disputeId); const challenge = await approve(tenant.adminContext, proposal);
    await updateRow('workspace_members', tenant.admin.member.id, { role: 'member' });
    const rpc = jest.spyOn(supabaseAdmin, 'rpc');
    await expect(confirm(tenant.adminContext, proposal, challenge)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(rpcCalls(rpc, 'resolve_dispute_atomic')).toHaveLength(0);
    await assertUnresolved(tenant, opened.disputeId);
  });

  it('rejects an exact dispute snapshot changed after approval without attempting resolution', async () => {
    const tenant = await seedTenant(); const opened = await openDispute(tenant);
    const proposal = await draftResolve(tenant, opened.disputeId); const challenge = await approve(tenant.adminContext, proposal);
    await updateRow('disputes', opened.disputeId, { reason: 'Changed reason after the approval card was reviewed.' });
    const rpc = jest.spyOn(supabaseAdmin, 'rpc');
    await expect(confirm(tenant.adminContext, proposal, challenge)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect((await status(tenant.adminContext, proposal)).status).toBe('failed');
    expect(rpcCalls(rpc, 'resolve_dispute_atomic')).toHaveLength(0);
    await assertUnresolved(tenant, opened.disputeId);
  });

  it('serializes duplicate confirmations using real Redis CAS and performs one RPC/native audit', async () => {
    const tenant = await seedTenant(); const opened = await openDispute(tenant);
    const proposal = await draftResolve(tenant, opened.disputeId); const challenge = await approve(tenant.adminContext, proposal);
    const rpc = jest.spyOn(supabaseAdmin, 'rpc');
    const outcomes = await Promise.allSettled([
      confirm(tenant.adminContext, proposal, challenge), confirm(tenant.adminContext, proposal, challenge),
    ]);
    const successes = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(successes.length).toBeGreaterThanOrEqual(1);
    for (const outcome of successes) expect(outcome.value.status).toBe('executed');
    for (const outcome of outcomes.filter((item) => item.status === 'rejected')) {
      expect(['AGENT_PROPOSAL_BUSY', 'AGENT_PROPOSAL_INDETERMINATE']).toContain(outcome.reason.code);
    }
    expect(await confirm(tenant.adminContext, proposal, challenge)).toEqual(successes[0].value);
    expect(rpcCalls(rpc, 'resolve_dispute_atomic')).toHaveLength(1);
    const events = await actionAudits(tenant, proposal);
    expect(events.filter((event) => event.action === AUDIT_ACTIONS.DISPUTE_RESOLVED)).toHaveLength(1);
    expect(events.filter((event) => event.action === AUDIT_ACTIONS.AGENT_ACTION_CONFIRMED)).toHaveLength(1);
  });

  it('fails closed on secondary audit outage and retries the same audit before executing', async () => {
    const tenant = await seedTenant(); const opened = await openDispute(tenant);
    const proposal = await draftResolve(tenant, opened.disputeId); const challenge = await approve(tenant.adminContext, proposal);
    const rpc = jest.spyOn(supabaseAdmin, 'rpc');
    failAuditOnce(AUDIT_ACTIONS.AGENT_ACTION_CONFIRMED);
    await expect(confirm(tenant.adminContext, proposal, challenge)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect((await status(tenant.adminContext, proposal)).status).toBe('confirmation_pending');
    expect(rpcCalls(rpc, 'resolve_dispute_atomic')).toHaveLength(0);
    await assertUnresolved(tenant, opened.disputeId);
    const pending = await storedRecord(tenant.adminContext, proposal);
    expect((await confirm(tenant.adminContext, proposal, challenge)).status).toBe('executed');
    expect((await storedRecord(tenant.adminContext, proposal)).secondaryConfirmation).toEqual(pending.secondaryConfirmation);
    const confirmedAudits = (await actionAudits(tenant, proposal)).filter((event) => event.action === AUDIT_ACTIONS.AGENT_ACTION_CONFIRMED);
    expect(confirmedAudits.map((event) => event.id)).toEqual([pending.auditIds.confirmed]);
    expect(rpcCalls(rpc, 'resolve_dispute_atomic')).toHaveLength(1);
  });

  it.each(['approve', 'confirm'])('finishes final agent auditing through %s from a saved result without repeating the RPC', async (retry) => {
    const tenant = await seedTenant(); const opened = await openDispute(tenant);
    const proposal = await draftResolve(tenant, opened.disputeId); const challenge = await approve(tenant.adminContext, proposal);
    const rpc = jest.spyOn(supabaseAdmin, 'rpc');
    failAuditOnce(AUDIT_ACTIONS.AGENT_ACTION_EXECUTED);
    await expect(confirm(tenant.adminContext, proposal, challenge)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    const receipt = await status(tenant.adminContext, proposal);
    expect(receipt.status).toBe('audit_pending');
    expect(receipt.result.entry.status).toBe('resolved');
    const result = retry === 'approve' ? await approve(tenant.adminContext, proposal) : await confirm(tenant.adminContext, proposal, challenge);
    expect(result).toEqual({ proposal_id: proposal.id, status: 'executed', result: receipt.result });
    expect(rpcCalls(rpc, 'resolve_dispute_atomic')).toHaveLength(1);
    expect((await actionAudits(tenant, proposal)).filter((event) => event.action === AUDIT_ACTIONS.AGENT_ACTION_EXECUTED)).toHaveLength(1);
  });

  it.each(['native audit outage', 'lost RPC response'])('keeps %s indeterminate after real committed mutations and never replays', async (failure) => {
    const tenant = await seedTenant(); const opened = await openDispute(tenant);
    const proposal = await draftResolve(tenant, opened.disputeId); const challenge = await approve(tenant.adminContext, proposal);
    const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
    const rpc = jest.spyOn(supabaseAdmin, 'rpc').mockImplementation(async (name, args) => {
      const response = await originalRpc(name, args);
      if (failure === 'lost RPC response' && name === 'resolve_dispute_atomic') {
        expect(response.error).toBeNull();
        return { data: null, error: { code: 'NETWORK_FAILURE', message: 'Injected lost response after commit' } };
      }
      return response;
    });
    if (failure === 'native audit outage') failAuditOnce(AUDIT_ACTIONS.DISPUTE_RESOLVED);
    await expect(confirm(tenant.adminContext, proposal, challenge)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect((await readRow('disputes', opened.disputeId)).status).toBe('resolved');
    expect((await readRow('ledger_entries', tenant.entry.id)).status).toBe('resolved');
    const receipt = await status(tenant.adminContext, proposal);
    expect(receipt.status).toBe('indeterminate');
    expect(receipt).not.toHaveProperty('result');
    await expect(confirm(tenant.adminContext, proposal, challenge)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(approve(tenant.adminContext, proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(rpcCalls(rpc, 'resolve_dispute_atomic')).toHaveLength(1);
    expect(await actionAudits(tenant, proposal)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: AUDIT_ACTIONS.AGENT_ACTION_FAILED, metadata: expect.objectContaining({ execution_outcome: 'unknown' }) }),
    ]));
  });

  it('preserves the ordinary HTTP service result shape without reviewed options', async () => {
    const tenant = await seedTenant(); const opened = await openDispute(tenant);
    const result = await disputes.resolveDispute({ workspaceId: tenant.workspace.id, disputeId: opened.disputeId,
      resolutionNote: RESOLUTION_NOTE, resolvedByMemberId: tenant.admin.member.id,
      actorCtx: { workspaceId: tenant.workspace.id, actorUserId: tenant.admin.user.id, actorMemberId: tenant.admin.member.id } });
    expect(result).toMatchObject({ id: opened.disputeId, status: 'resolved', resolution_note: RESOLUTION_NOTE });
    expect(result).not.toHaveProperty('dispute');
    expect(result).not.toHaveProperty('entry');
    expect((await readRow('ledger_entries', tenant.entry.id)).status).toBe('resolved');
  });
});
