jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/ledger.service', () => ({ getSelfSubmissionContext: jest.fn(), createEntry: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { AppError, BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } = require('../../../src/utils/errors');
const ledger = require('../../../src/services/ledger.service');
const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const ledgerProposals = require('../../../src/agent/services/ledger-proposal.service');
const { createProposal, decideProposal, getProposalStatus } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');
const { CONTAINER_ID, ENTRY_ID, ledgerContext, ledgerArguments, submittedEntry } = require('../../helpers/agent-ledger-proposal');

describe('self contribution proposals', () => {
  let redis;
  const create = (args = ledgerArguments(), overrides = {}) => createProposal({
    context: context(), tool: 'create_ledger_entry', selection: ledgerContext(), args,
    turnId: randomUUID(), redisFactory: () => redis, ...overrides,
  });
  const decide = (proposal, overrides = {}) => decideProposal({
    context: context(), proposalId: proposal.id, data: {}, decision: 'approve',
    redisFactory: () => redis, ...overrides,
  });
  const status = (proposal) => getProposalStatus({ context: context(), proposalId: proposal.id, redisFactory: () => redis });

  beforeEach(() => {
    redis = new Redis();
    members.getActiveMembership.mockReset().mockResolvedValue(member());
    ledger.getSelfSubmissionContext.mockReset().mockResolvedValue(ledgerContext());
    ledger.createEntry.mockReset().mockImplementation(async ({ data, idempotencyKey }) => ({
      entry: submittedEntry({ ...data, idempotency_key: idempotencyKey }), idempotent: false,
    }));
    audit.log.mockReset().mockResolvedValue();
  });
  afterEach(async () => { await redis.flushall(); await redis.quit(); });

  it('verifies a selected container through the service with the authenticated identity and actual role', async () => {
    const selected = await ledgerProposals.selectLedgerContainer({ context: context(), containerId: CONTAINER_ID });
    expect(selected).toEqual(ledgerContext());
    expect(Object.isFrozen(selected)).toBe(true);
    expect(ledger.getSelfSubmissionContext).toHaveBeenCalledWith({
      workspaceId: context().workspace.id, containerId: CONTAINER_ID,
      callerId: context().member.id, userId: context().userId, isAdmin: false,
    });
    expect(ledger.createEntry).not.toHaveBeenCalled();
  });

  it('rejects inactive membership before reading contribution eligibility', async () => {
    members.getActiveMembership.mockResolvedValue({ ...member(), is_active: false });
    await expect(ledgerProposals.selectLedgerContainer({ context: context(), containerId: CONTAINER_ID }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ledger.getSelfSubmissionContext).not.toHaveBeenCalled();
  });

  it.each([
    { contributor_id: OTHER_ID }, { workspace_id: OTHER_ID }, { member_role: 'admin' },
  ])('rejects a selection for a different identity or role: %j', async (changes) => {
    ledger.getSelfSubmissionContext.mockResolvedValue(ledgerContext(changes));
    await expect(ledgerProposals.selectLedgerContainer({ context: context(), containerId: CONTAINER_ID }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ledger.createEntry).not.toHaveBeenCalled();
  });

  it('creates a reviewed pending card with equal exact amounts and no ledger write', async () => {
    const proposal = await create({ ...ledgerArguments(), amount: '005000.0' });
    expect(proposal).toMatchObject({
      tool: 'create_ledger_entry', tier: 2, before: ledgerContext(),
      parameters: {
        container_id: CONTAINER_ID, contributor_id: context().member.id, entry_type: 'contribution',
        original_amount: '5000.00', base_amount: '5000.00', original_currency: 'NGN',
        payment_method: 'bank_transfer', note: 'Family groceries', cycle_id: null, is_crypto: false,
      },
      after: { status: 'pending', confirmed_at: null, confirmed_by: null },
    });
    expect(ledger.createEntry).not.toHaveBeenCalled();
    expect(proposal.parameters).not.toHaveProperty('idempotency_key');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agent.action_proposed', targetType: 'container', targetId: CONTAINER_ID,
    }));
  });

  it('uses the freshly read currency even when cached workspace currency differs', async () => {
    const actor = context();
    actor.workspace.baseCurrency = 'USD';
    const proposal = await create(undefined, { context: actor });
    expect(proposal.parameters.original_currency).toBe('NGN');
  });

  it.each(['0', '-1', '1.001', '1e3', '1,000', ' 1', '10000000000000', 'NaN'])('rejects invalid decimal text %s before a proposal read', async (amount) => {
    await expect(create({ ...ledgerArguments(), amount })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(ledger.getSelfSubmissionContext).not.toHaveBeenCalled();
    expect(ledger.createEntry).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('preserves the maximum supported amount without rounding', async () => {
    const proposal = await create({ ...ledgerArguments(), amount: '9999999999999.99' });
    const receipt = await decide(proposal);
    expect(receipt.result.original_amount).toBe('9999999999999.99');
    expect(receipt.result.base_amount).toBe('9999999999999.99');
  });

  it.each([
    ['numeric amount', { amount: 5000 }], ['container ID', { container_id: OTHER_ID }],
    ['contributor ID', { contributor_id: OTHER_ID }], ['base amount', { base_amount: '1.00' }],
    ['status', { status: 'confirmed' }], ['idempotency key', { idempotency_key: 'chosen' }],
    ['cycle', { cycle_id: OTHER_ID }], ['expense', { entry_type: 'expense' }],
    ['crypto', { payment_method: 'crypto' }], ['force override', { force: true }],
  ])('rejects model-controlled %s', async (_label, fields) => {
    await expect(create({ ...ledgerArguments(), ...fields })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(ledger.createEntry).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('rejects foreign-currency creation rather than converting it', async () => {
    await expect(create({ ...ledgerArguments(), currency: 'USD' })).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(ledger.getSelfSubmissionContext).not.toHaveBeenCalled();
    expect(ledger.createEntry).not.toHaveBeenCalled();
  });

  it('requires an explicit selection and cannot execute through the read registry', async () => {
    await expect(create(undefined, { selection: undefined })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(executeReadTool({ name: 'create_ledger_entry', args: ledgerArguments(), context: context() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ledger.createEntry).not.toHaveBeenCalled();
  });

  it.each(['member', 'admin'])('applies a %s self entry once, pending, with a server key and authenticated audit context', async (role) => {
    const actor = context();
    actor.member.role = role;
    const selection = ledgerContext({ member_role: role });
    members.getActiveMembership.mockResolvedValue({ ...member(), role });
    ledger.getSelfSubmissionContext.mockResolvedValue(selection);
    const proposal = await create(undefined, { context: actor, selection });
    const actorCtx = { workspaceId: OTHER_ID, actorUserId: OTHER_ID, actorMemberId: OTHER_ID, ipAddress: '127.0.0.1', userAgent: 'ledger-test' };
    const first = await decide(proposal, { context: actor, actorCtx });
    expect(await decide(proposal, { context: actor })).toEqual(first);
    expect(first.result).toMatchObject({
      entry_id: ENTRY_ID, original_amount: '5000.00', base_amount: '5000.00',
      status: 'pending', confirmed_at: null, confirmed_by: null,
    });
    expect(ledger.createEntry).toHaveBeenCalledTimes(1);
    expect(ledger.createEntry).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: actor.workspace.id, containerId: CONTAINER_ID, callerId: actor.member.id,
      isAdmin: role === 'admin', force: false, idempotencyKey: `agent:${proposal.id}`,
      selfSubmission: { userId: actor.userId, expected: selection },
      actorCtx: {
        workspaceId: actor.workspace.id, actorUserId: actor.userId, actorMemberId: actor.member.id,
        ipAddress: '127.0.0.1', userAgent: 'ledger-test',
      },
    }));
    expect(audit.log.mock.calls.map(([entry]) => [entry.action, entry.targetType, entry.targetId])).toEqual([
      ['agent.action_proposed', 'container', CONTAINER_ID],
      ['agent.action_approved', 'container', CONTAINER_ID],
      ['agent.action_executed', 'ledger_entry', ENTRY_ID],
    ]);
    const receipt = await getProposalStatus({ context: actor, proposalId: proposal.id, redisFactory: () => redis });
    expect(receipt).toMatchObject({ tool: 'create_ledger_entry', container_id: CONTAINER_ID, contributor_id: actor.member.id, status: 'executed', result: first.result });
    expect(JSON.stringify(first)).not.toContain('PRIVATE_LEDGER_PROOF');
    expect(first.result).not.toHaveProperty('idempotency_key');
  });

  it('rejects a changed approval body before executing', async () => {
    const proposal = await create();
    await expect(decide(proposal, { data: { amount: '1.00' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(ledger.createEntry).not.toHaveBeenCalled();
    expect((await status(proposal)).status).toBe('pending');
  });

  it.each([
    { base_currency: 'USD' }, { participant_id: OTHER_ID },
    { container_name: 'Different name' }, { container_updated_at: '2026-11-14T12:00:30.000Z' },
  ])('makes changed reviewed eligibility final before insertion: %j', async (changes) => {
    const proposal = await create();
    ledger.getSelfSubmissionContext.mockResolvedValueOnce(ledgerContext(changes));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect((await status(proposal)).status).toBe('failed');
    expect(ledger.createEntry).not.toHaveBeenCalled();
  });

  it.each([
    ['membership removal', () => new ForbiddenError('Removed')],
    ['container deletion', () => new NotFoundError('Deleted')],
    ['money disabled', () => new BusinessRuleError('Disabled')],
  ])('invalidates %s rather than executing', async (_label, error) => {
    const proposal = await create();
    ledger.getSelfSubmissionContext.mockRejectedValueOnce(error());
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect((await status(proposal)).status).toBe('failed');
    expect(ledger.createEntry).not.toHaveBeenCalled();
  });

  it('can retry a failed pre-execution read without inserting early', async () => {
    const proposal = await create();
    ledger.getSelfSubmissionContext.mockRejectedValueOnce(new AppError('Unavailable', 503, 'LEDGER_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' });
    expect((await status(proposal)).status).toBe('approval_pending');
    expect(ledger.createEntry).not.toHaveBeenCalled();
    await expect(decide(proposal)).resolves.toMatchObject({ status: 'executed' });
    expect(ledger.createEntry).toHaveBeenCalledTimes(1);
  });

  it('makes a definitive final guard conflict stale without a retry', async () => {
    const proposal = await create();
    ledger.createEntry.mockRejectedValueOnce(new ConflictError('Participation changed before insert'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(ledger.createEntry).toHaveBeenCalledTimes(1);
    expect((await status(proposal)).status).toBe('failed');
  });

  it.each([
    { workspace_id: OTHER_ID }, { container_id: OTHER_ID }, { contributor_id: OTHER_ID },
    { recorded_by: OTHER_ID }, { original_amount: 5001 }, { base_amount: 5001 },
    { original_currency: 'USD' }, { status: 'confirmed' }, { confirmed_by: context().member.id },
    { note: 'Other note' }, { corrects_entry_id: OTHER_ID }, { idempotency_key: 'other-key' },
  ])('never reports or repeats an unverified money result: %j', async (changes) => {
    const proposal = await create();
    ledger.createEntry.mockImplementationOnce(async ({ data, idempotencyKey }) => ({
      entry: submittedEntry({ ...data, idempotency_key: idempotencyKey, ...changes }),
    }));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    const receipt = await status(proposal);
    expect(receipt.status).toBe('indeterminate');
    expect(receipt).not.toHaveProperty('result');
    expect(ledger.createEntry).toHaveBeenCalledTimes(1);
  });

  it('does not retry a possible post-insert transport or side-effect failure', async () => {
    const proposal = await create();
    ledger.createEntry.mockRejectedValueOnce(new AppError('Unknown outcome', 503, 'LEDGER_SUBMISSION_INDETERMINATE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(ledger.createEntry).toHaveBeenCalledTimes(1);
  });

  it('rejects a card without submitting a contribution', async () => {
    const proposal = await create();
    await expect(decide(proposal, { decision: 'reject' })).resolves.toMatchObject({ status: 'rejected' });
    expect(ledger.createEntry).not.toHaveBeenCalled();
  });
});
