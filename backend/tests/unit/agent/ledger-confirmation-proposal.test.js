jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/ledger.service', () => ({ getEntryConfirmationContext: jest.fn(), confirmEntry: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { AppError, BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const ledger = require('../../../src/services/ledger.service');
const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const ledgerProposals = require('../../../src/agent/services/ledger-confirmation-proposal.service');
const { createProposal, decideProposal, getProposalStatus, getProposalReceipts } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { proposalSchema, PROPOSAL_LIMITS } = require('../../../src/agent/validators/proposal.validator');
const { context, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, ENTRY_ID, adminContext, adminMember, confirmationSnapshot,
  confirmationContext, confirmationAfter, confirmationResult, confirmedEntry,
} = require('../../helpers/agent-ledger-confirmation');

describe('admin ledger confirmation proposals', () => {
  let redis;
  const create = (args = {}, overrides = {}) => createProposal({
    context: adminContext(), tool: 'confirm_ledger_entry', selection: confirmationContext(), args,
    turnId: randomUUID(), redisFactory: () => redis, ...overrides,
  });
  const decide = (proposal, overrides = {}) => decideProposal({
    context: adminContext(), proposalId: proposal.id, data: {}, decision: 'approve',
    redisFactory: () => redis, ...overrides,
  });
  const status = (proposal, overrides = {}) => getProposalStatus({
    context: adminContext(), proposalId: proposal.id, redisFactory: () => redis, ...overrides,
  });
  const receipts = (proposal, overrides = {}) => getProposalReceipts({
    context: adminContext(), proposals: [proposal], redisFactory: () => redis, ...overrides,
  });
  const serviceResult = (expected, actorMemberId) => {
    const { entry_id, ...snapshot } = confirmationSnapshot();
    const reviewed = Object.fromEntries(Object.keys(snapshot).map((field) => [field, expected[field]]));
    return confirmedEntry({
      ...reviewed, id: expected.entry_id, status: 'confirmed',
      confirmed_by: actorMemberId, confirmed_at: confirmationResult().confirmed_at,
    });
  };
  async function replaceRecord(proposal, update) {
    const key = (await redis.keys('kith:agent-proposal:*')).find((candidate) => candidate.endsWith(proposal.id));
    const record = JSON.parse(await redis.get(key));
    await redis.set(key, JSON.stringify({ ...record, ...update }), 'EX', PROPOSAL_LIMITS.retentionSeconds);
    return key;
  }

  beforeEach(() => {
    redis = new Redis();
    members.getActiveMembership.mockReset().mockResolvedValue(adminMember());
    ledger.getEntryConfirmationContext.mockReset().mockResolvedValue(confirmationContext());
    ledger.confirmEntry.mockReset().mockImplementation(async ({ actorMemberId, reviewedConfirmation }) =>
      serviceResult(reviewedConfirmation.expected, actorMemberId));
    audit.log.mockReset().mockResolvedValue();
  });
  afterEach(async () => {
    await redis.flushall();
    await redis.quit();
    jest.restoreAllMocks();
  });

  it('registers an admin-only Tier 3 proposal accepting no model-controlled fields', () => {
    expect(ledgerProposals.confirmLedgerEntryDefinition).toMatchObject({
      name: 'confirm_ledger_entry', tier: 3, minRole: 'admin',
    });
    expect(ledgerProposals.confirmLedgerEntryDefinition.parameterSchema.safeParse({}).success).toBe(true);
    expect(ledgerProposals.confirmLedgerEntryDefinition.parameterSchema.safeParse({ entry_id: ENTRY_ID }).success).toBe(false);
  });

  it('verifies a selected entry with the real admin identity and normalizes selected UUIDs', async () => {
    const selected = await ledgerProposals.selectLedgerEntry({
      context: adminContext(), containerId: CONTAINER_ID, entryId: ENTRY_ID.toUpperCase(),
    });
    expect(selected).toEqual(confirmationContext());
    expect(Object.isFrozen(selected)).toBe(true);
    expect(ledger.getEntryConfirmationContext).toHaveBeenCalledWith({
      workspaceId: adminContext().workspace.id, containerId: CONTAINER_ID, entryId: ENTRY_ID,
      callerId: adminContext().member.id, userId: adminContext().userId, isAdmin: true,
    });
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
  });

  it('denies a member before calling membership or ledger services', async () => {
    await expect(ledgerProposals.selectLedgerEntry({
      context: context(), containerId: CONTAINER_ID, entryId: ENTRY_ID,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(create({}, { context: context() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(members.getActiveMembership).not.toHaveBeenCalled();
    expect(ledger.getEntryConfirmationContext).not.toHaveBeenCalled();
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('protects direct draft, revalidation, and apply handlers from non-admin callers', async () => {
    const proposal = await create();
    jest.clearAllMocks();
    for (const operation of [
      () => ledgerProposals.createProposalDraft({
        context: context(), tool: 'confirm_ledger_entry', selection: confirmationContext(), args: {},
        id: randomUUID(), expiresAt: proposal.expires_at,
      }),
      () => ledgerProposals.revalidateProposal({ context: context(), proposal }),
      () => ledgerProposals.applyProposal({ context: context(), proposal }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(members.getActiveMembership).not.toHaveBeenCalled();
    expect(ledger.getEntryConfirmationContext).not.toHaveBeenCalled();
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
  });

  it.each([{ role: 'member' }, { is_active: false }, { user_id: OTHER_ID }])('stops changed authenticated membership before reading an entry: %j', async (changes) => {
    members.getActiveMembership.mockResolvedValue(adminMember(changes));
    await expect(ledgerProposals.selectLedgerEntry({
      context: adminContext(), containerId: CONTAINER_ID, entryId: ENTRY_ID,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ledger.getEntryConfirmationContext).not.toHaveBeenCalled();
  });

  it.each([
    { containerId: 'not-an-id', entryId: ENTRY_ID },
    { containerId: CONTAINER_ID, entryId: 'not-an-id' },
  ])('rejects invalid selected IDs before a ledger read: %j', async (target) => {
    await expect(ledgerProposals.selectLedgerEntry({ context: adminContext(), ...target }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(ledger.getEntryConfirmationContext).not.toHaveBeenCalled();
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
  });

  it.each([
    { actor_member_id: OTHER_ID }, { workspace_id: OTHER_ID },
  ])('rejects eligibility scoped to another authenticated actor: %j', async (changes) => {
    ledger.getEntryConfirmationContext.mockResolvedValue(confirmationContext(changes));
    await expect(ledgerProposals.selectLedgerEntry({
      context: adminContext(), containerId: CONTAINER_ID, entryId: ENTRY_ID,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
  });

  it('creates the exact pending-to-confirmed card without confirming any entry', async () => {
    const proposal = await create();
    expect(proposal).toEqual({
      id: expect.any(String), tool: 'confirm_ledger_entry', tier: 3,
      summary: expect.any(String), parameters: { container_id: CONTAINER_ID, entry_id: ENTRY_ID },
      before: confirmationContext(), after: confirmationAfter(), expires_at: expect.any(String),
    });
    expect(proposal.after.original_amount).toBe('5000.00');
    expect(proposal.after.base_amount).toBe('5000.00');
    expect(proposal.before.confirmed_at).toBeNull();
    expect(proposal.after.confirmed_at).toBe('on_approval');
    expect(proposal.after.confirmed_by).toBe(adminContext().member.id);
    expect(proposal.after.proofs).toEqual([]);
    expect(proposal.after).not.toHaveProperty('idempotency_key');
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: AUDIT_ACTIONS.AGENT_ACTION_PROPOSED, targetType: 'ledger_entry', targetId: ENTRY_ID,
      metadata: expect.objectContaining({ tool: 'confirm_ledger_entry', tier: 3 }),
    }));
  });

  it('reviews freshly read currency and exact stored amounts without converting cached context', async () => {
    const actor = adminContext();
    actor.workspace.baseCurrency = 'USD';
    const selected = confirmationContext({ original_amount: '9999999999999.99', base_amount: '9999999999999.99' });
    ledger.getEntryConfirmationContext.mockResolvedValue(selected);
    const proposal = await create({}, { context: actor, selection: selected });
    const reply = await decide(proposal, { context: actor });
    expect(proposal.before.base_currency).toBe('NGN');
    expect(reply.result.original_amount).toBe('9999999999999.99');
    expect(reply.result.base_amount).toBe('9999999999999.99');
  });

  it.each([
    ['amount', { amount: '1.00' }], ['contributor', { contributor_id: OTHER_ID }],
    ['confirmer', { confirmed_by: OTHER_ID }], ['timestamp', { confirmed_at: '2026-11-14T12:02:00.000Z' }],
    ['entry', { entry_id: OTHER_ID }], ['container', { container_id: OTHER_ID }],
    ['currency', { currency: 'USD' }], ['status', { status: 'confirmed' }],
    ['force', { force: true }], ['role', { isAdmin: true }], ['tier', { tier: 2 }],
  ])('rejects model-controlled %s before draft reads or persistence', async (_label, args) => {
    await expect(create(args)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(ledger.getEntryConfirmationContext).not.toHaveBeenCalled();
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('cannot execute the confirmation through the read-tool dispatcher', async () => {
    await expect(executeReadTool({ name: 'confirm_ledger_entry', args: {}, context: adminContext() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
  });

  it('confirms once through separate approval, binds real audit identity, and returns a complete confirmed receipt', async () => {
    const proposal = await create();
    const actor = adminContext();
    const actorCtx = {
      workspaceId: OTHER_ID, actorUserId: OTHER_ID, actorMemberId: OTHER_ID,
      ipAddress: '127.0.0.1', userAgent: 'confirmation-unit-test',
    };
    const first = await decide(proposal, { actorCtx });
    expect(await decide(proposal)).toEqual(first);
    expect(first).toEqual({ proposal_id: proposal.id, status: 'executed', result: confirmationResult() });
    expect(ledger.confirmEntry).toHaveBeenCalledTimes(1);
    expect(ledger.confirmEntry).toHaveBeenCalledWith({
      workspaceId: actor.workspace.id, containerId: CONTAINER_ID, entryId: ENTRY_ID,
      actorMemberId: actor.member.id,
      actorCtx: {
        workspaceId: actor.workspace.id, actorUserId: actor.userId, actorMemberId: actor.member.id,
        ipAddress: '127.0.0.1', userAgent: 'confirmation-unit-test',
      },
      reviewedConfirmation: { userId: actor.userId, isAdmin: true, expected: confirmationContext() },
    });
    expect(audit.log.mock.calls.map(([entry]) => [entry.action, entry.targetType, entry.targetId])).toEqual([
      [AUDIT_ACTIONS.AGENT_ACTION_PROPOSED, 'ledger_entry', ENTRY_ID],
      [AUDIT_ACTIONS.AGENT_ACTION_APPROVED, 'ledger_entry', ENTRY_ID],
      [AUDIT_ACTIONS.AGENT_ACTION_EXECUTED, 'ledger_entry', ENTRY_ID],
    ]);
    expect(await status(proposal)).toEqual({
      proposal_id: proposal.id, tool: 'confirm_ledger_entry', entry_id: ENTRY_ID, container_id: CONTAINER_ID,
      status: 'executed', expires_at: proposal.expires_at, checked_at: expect.any(String), result: first.result,
    });
    expect((await receipts(proposal))[0]).toMatchObject({ status: 'executed', result: first.result });
  });

  it('never treats an edited approval body as authority to change the reviewed entry', async () => {
    const proposal = await create();
    await expect(decide(proposal, { data: { amount: '1.00' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
    expect((await status(proposal)).status).toBe('pending');
  });

  it.each([
    { original_currency: 'USD', base_currency: 'USD' },
    { original_amount: '5001.00', base_amount: '5001.00' },
    { note: 'An edited contribution' }, { payment_method: 'cash' },
    { contributor_display_name: 'Renamed contributor' }, { contributor_role: 'admin' },
    { recorded_by: adminContext().member.id }, { recorded_at: '2026-11-14T12:00:30.000Z' },
    { participant_id: OTHER_ID }, { container_name: 'Renamed container' },
    { container_updated_at: '2026-11-14T12:00:30.000Z' },
  ])('makes changed reviewed entry or eligibility final before mutation: %j', async (changes) => {
    const proposal = await create();
    ledger.getEntryConfirmationContext.mockResolvedValueOnce(confirmationContext(changes));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect((await status(proposal)).status).toBe('failed');
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
  });

  it.each([
    ['membership removed', () => new ForbiddenError('Removed')],
    ['entry deleted', () => new NotFoundError('Deleted')],
    ['proof or dispute appeared', () => new BusinessRuleError('No longer eligible')],
  ])('invalidates %s on approval rather than confirming', async (_label, error) => {
    const proposal = await create();
    ledger.getEntryConfirmationContext.mockRejectedValueOnce(error());
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect((await status(proposal)).status).toBe('failed');
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
  });

  it('retries a failed pre-execution read without confirming early', async () => {
    const proposal = await create();
    ledger.getEntryConfirmationContext.mockRejectedValueOnce(new AppError('Unavailable', 503, 'LEDGER_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' });
    expect((await status(proposal)).status).toBe('approval_pending');
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
    await expect(decide(proposal)).resolves.toMatchObject({ status: 'executed' });
    expect(ledger.confirmEntry).toHaveBeenCalledTimes(1);
  });

  it('does not retry a definitive conditional-update conflict', async () => {
    const proposal = await create();
    ledger.confirmEntry.mockRejectedValueOnce(new ConflictError('Entry changed before the conditional update'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(ledger.confirmEntry).toHaveBeenCalledTimes(1);
    expect((await status(proposal)).status).toBe('failed');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: AUDIT_ACTIONS.AGENT_ACTION_FAILED,
      metadata: expect.objectContaining({ execution_outcome: 'not_applied' }),
    }));
  });

  it.each([
    { id: OTHER_ID }, { workspace_id: OTHER_ID }, { container_id: OTHER_ID }, { contributor_id: adminContext().member.id },
    { original_amount: 5001 }, { base_amount: 5001 }, { original_currency: 'USD' },
    { payment_method: 'cash' }, { note: 'An unexpected note' }, { proofs: [{ storage_path: 'PRIVATE_PROOF' }] },
    { status: 'pending' }, { confirmed_by: OTHER_ID }, { confirmed_at: null }, { recorded_by: adminContext().member.id },
    { recorded_at: '2026-11-14T12:00:30.000Z' }, { corrects_entry_id: OTHER_ID }, { cycle_id: OTHER_ID },
  ])('never returns or repeats an unverified confirmation result: %j', async (changes) => {
    const proposal = await create();
    ledger.confirmEntry.mockResolvedValueOnce(confirmedEntry(changes));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    const receipt = await status(proposal);
    expect(receipt.status).toBe('indeterminate');
    expect(receipt).not.toHaveProperty('result');
    expect(ledger.confirmEntry).toHaveBeenCalledTimes(1);
  });

  it('retains the irreversible claim after possible update or notification/audit failure', async () => {
    const proposal = await create();
    ledger.confirmEntry.mockRejectedValueOnce(new AppError('Unknown outcome', 503, 'LEDGER_CONFIRMATION_INDETERMINATE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect((await status(proposal)).status).toBe('indeterminate');
    expect(ledger.confirmEntry).toHaveBeenCalledTimes(1);
  });

  it('can finish a failed executed audit without repeating the confirmed mutation', async () => {
    const proposal = await create();
    audit.log.mockImplementation(async (entry) => {
      if (entry.action === AUDIT_ACTIONS.AGENT_ACTION_EXECUTED) throw new AppError('Audit unavailable', 503, 'AUDIT_UNAVAILABLE');
    });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect((await status(proposal)).status).toBe('audit_pending');
    audit.log.mockResolvedValue();
    await expect(decide(proposal)).resolves.toMatchObject({ status: 'executed', result: confirmationResult() });
    expect(ledger.confirmEntry).toHaveBeenCalledTimes(1);
  });

  it('permits only one in-flight confirmation under concurrent approval attempts', async () => {
    const proposal = await create();
    let started;
    let release;
    const enteredService = new Promise((resolve) => { started = resolve; });
    ledger.confirmEntry.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => { release = resolve; });
    });
    const first = decide(proposal);
    await enteredService;
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    release(confirmedEntry());
    await expect(first).resolves.toMatchObject({ status: 'executed' });
    expect(ledger.confirmEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    { original_amount: '5001.00' }, { entry_id: OTHER_ID }, { confirmed_by: OTHER_ID },
    { confirmed_at: 'on_approval' }, { note: 'Changed in saved result' },
  ])('rejects a saved result that differs from the approved card: %j', async (changes) => {
    const proposal = await create();
    await decide(proposal);
    await replaceRecord(proposal, { state: 'executed', result: confirmationResult(changes) });
    jest.clearAllMocks();
    await expect(status(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
    expect(await receipts(proposal)).toEqual([{
      proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String),
    }]);
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each(['user', 'member', 'workspace', 'role'])('does not expose or execute confirmation records across %s scope', async (scope) => {
    const proposal = await create();
    const actor = adminContext();
    if (scope === 'user') actor.userId = OTHER_ID;
    if (scope === 'member') actor.member.id = OTHER_ID;
    if (scope === 'workspace') { actor.workspace.id = OTHER_ID; actor.member.workspaceId = OTHER_ID; }
    if (scope === 'role') actor.member.role = 'member';
    members.getActiveMembership.mockResolvedValue(adminMember({
      id: actor.member.id, workspace_id: actor.workspace.id, user_id: actor.userId, role: actor.member.role,
    }));
    await expect(status(proposal, { context: actor })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
    await expect(decide(proposal, { context: actor })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
    expect(await receipts(proposal, { context: actor })).toEqual([{
      proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String),
    }]);
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
  });

  it.each([
    (proposal) => ({ ...proposal, tier: 2 }),
    (proposal) => ({ ...proposal, parameters: { ...proposal.parameters, entry_id: OTHER_ID } }),
    (proposal) => ({ ...proposal, after: { ...proposal.after, original_amount: '5001.00' } }),
    (proposal) => ({ ...proposal, after: { ...proposal.after, confirmed_by: OTHER_ID } }),
    (proposal) => ({ ...proposal, after: { ...proposal.after, confirmed_at: '2026-11-14T12:02:00.000Z' } }),
  ])('rejects mismatched before/after, target, tier or time-policy cards', async (change) => {
    const proposal = await create();
    expect(proposalSchema.safeParse(change(proposal)).success).toBe(false);
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
  });

  it('rejects an approval card without confirming and prevents later approval', async () => {
    const proposal = await create();
    await expect(decide(proposal, { decision: 'reject' })).resolves.toMatchObject({ status: 'rejected' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_DECIDED' });
    expect(ledger.confirmEntry).not.toHaveBeenCalled();
  });
});
