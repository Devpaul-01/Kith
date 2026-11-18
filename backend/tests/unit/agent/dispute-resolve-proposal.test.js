jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/dispute.service', () => ({ getResolveDisputeContext: jest.fn(), resolveDispute: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { AppError, ConflictError, ForbiddenError, NotFoundError, BusinessRuleError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const members = require('../../../src/services/member.service');
const disputes = require('../../../src/services/dispute.service');
const audit = require('../../../src/services/audit.service');
const domain = require('../../../src/agent/services/dispute-resolve-proposal.service');
const { createProposal, decideProposal, confirmProposal, getProposalStatus, getProposalReceipts } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { serializeToolDefinitions } = require('../../../src/agent/providers/tool-definitions');
const { proposalSchema, proposalRecordSchema, proposalStatusSchema, PROPOSAL_LIMITS } = require('../../../src/agent/validators/proposal.validator');
const { context, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, ENTRY_ID, DISPUTE_ID, SESSION_ID, CONVERSATION_ID, EXECUTION_TIME, RESOLUTION_NOTE,
  adminContext, adminMember, entrySnapshot, disputeSnapshot, resolveContext, resolveAfter, resolveResult,
  resolvedDispute, resolvedEntry,
} = require('../../helpers/agent-dispute-resolve');

let redis;
const create = (overrides = {}) => createProposal({
  context: adminContext(), tool: 'resolve_dispute', selection: resolveContext(),
  args: { resolution_note: RESOLUTION_NOTE }, turnId: SESSION_ID, redisFactory: () => redis, ...overrides,
});
const approve = (proposal, overrides = {}) => decideProposal({
  context: adminContext(), proposalId: proposal.id, data: {}, decision: 'approve', redisFactory: () => redis, ...overrides,
});
const confirm = (proposal, challenge, overrides = {}) => confirmProposal({
  context: adminContext(), proposalId: proposal.id,
  data: { confirmation: 'confirm', confirmation_token: challenge.confirmation_token }, redisFactory: () => redis, ...overrides,
});
const status = (proposal, overrides = {}) => getProposalStatus({
  context: adminContext(), proposalId: proposal.id, redisFactory: () => redis, ...overrides,
});
const stored = async (proposal) => {
  const key = (await redis.keys('kith:agent-proposal:*')).find((value) => value.endsWith(`:${proposal.id}`));
  return { key, record: JSON.parse(await redis.get(key)) };
};

beforeEach(() => {
  redis = new Redis();
  members.getActiveMembership.mockReset().mockResolvedValue(adminMember());
  disputes.getResolveDisputeContext.mockReset().mockResolvedValue(resolveContext());
  disputes.resolveDispute.mockReset().mockImplementation(async (call) => ({
    dispute: resolvedDispute({ resolution_note: call.resolutionNote }), entry: resolvedEntry(),
  }));
  audit.log.mockReset().mockResolvedValue();
});
afterEach(async () => { await redis.flushall(); await redis.quit(); jest.restoreAllMocks(); });

it('registers an admin-only Tier 4 proposal, with only the note exposed to the provider and no immediate executor', async () => {
  expect(domain.resolveDisputeDefinition).toMatchObject({ name: 'resolve_dispute', tier: 4, minRole: 'admin' });
  const { name, description, parameterSchema } = domain.resolveDisputeDefinition;
  const [tool] = serializeToolDefinitions([{ name, description, parameterSchema }]);
  expect(tool.function.parameters).toMatchObject({ type: 'object', required: ['resolution_note'], additionalProperties: false });
  expect(Object.keys(tool.function.parameters.properties)).toEqual(['resolution_note']);
  await expect(executeReadTool({ name: 'resolve_dispute', args: { resolution_note: RESOLUTION_NOTE }, context: adminContext() }))
    .rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it.each([context(), null, adminContext({ member: { isActive: false } })])('denies non-admin or invalid contexts before service access: %j', async (actor) => {
  await expect(domain.selectDisputeResolution({ context: actor, disputeId: DISPUTE_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(create({ context: actor })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(members.getActiveMembership).not.toHaveBeenCalled();
  expect(disputes.getResolveDisputeContext).not.toHaveBeenCalled();
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it('normalizes an explicit dispute ID and freezes both reviewed records after fresh admin verification', async () => {
  const selected = await domain.selectDisputeResolution({ context: adminContext(), disputeId: DISPUTE_ID.toUpperCase() });
  expect(selected).toEqual(resolveContext());
  expect([selected, selected.entry, selected.dispute].every(Object.isFrozen)).toBe(true);
  expect(disputes.getResolveDisputeContext).toHaveBeenCalledWith({ workspaceId: adminContext().workspace.id,
    disputeId: DISPUTE_ID, callerId: adminContext().member.id, userId: adminContext().userId, isAdmin: true });
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it.each([
  {}, null, [], { resolution_note: 'too short' }, { resolution_note: '   ' }, { resolution_note: 'x'.repeat(1001) },
  { resolution_note: 'Invalid\u0000note' }, { resolution_note: 'Invalid\ud800note' },
  ...['dispute_id', 'entry_id', 'container_id', 'resolved_by', 'isAdmin', 'original_amount', 'force', 'reason',
    'confirmation_token', 'conversation_id', 'notes', 'proofs'].map((field) => ({ resolution_note: RESOLUTION_NOTE, [field]: OTHER_ID })),
].map((args) => [args]))('rejects invalid notes and model-controlled authority or financial fields: %j', async (args) => {
  await expect(create({ args })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(disputes.getResolveDisputeContext).not.toHaveBeenCalled();
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

it.each([
  { actor_member_id: OTHER_ID }, { workspace_id: OTHER_ID },
  { dispute: disputeSnapshot({ raised_by: SESSION_ID }) }, { dispute: disputeSnapshot({ ledger_entry_id: OTHER_ID }) },
  { entry: entrySnapshot({ container_id: OTHER_ID }) }, { entry: entrySnapshot({ original_currency: 'USD' }) },
])('rejects a review outside the authenticated admin or exact contribution relationship: %j', async (changes) => {
  await expect(create({ selection: resolveContext(changes) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(disputes.getResolveDisputeContext).not.toHaveBeenCalled();
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it('creates the complete closing card without changing money, recording fields or original dispute details', async () => {
  const proposal = await create();
  expect(proposal).toEqual({ id: expect.any(String), tool: 'resolve_dispute', tier: 4,
    summary: 'Resolve the selected dispute and mark its contribution resolved.',
    parameters: { resolution_note: RESOLUTION_NOTE, dispute_id: DISPUTE_ID, container_id: CONTAINER_ID, entry_id: ENTRY_ID },
    before: resolveContext(), after: resolveAfter(), secondary_confirmation: { method: 'typed', phrase: 'confirm' },
    expires_at: expect.any(String) });
  const { record } = await stored(proposal);
  expect(record.conversationId).toBeNull();
  expect(JSON.stringify([proposal, audit.log.mock.calls])).not.toContain(record.secondaryConfirmation.token);
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.AGENT_ACTION_PROPOSED,
    targetType: 'dispute', targetId: DISPUTE_ID,
    metadata: expect.objectContaining({ before: proposal.before, after: proposal.after,
      sensitive_action: true, session_id: SESSION_ID, conversation_id: null, secondary_confirmation: false }) }));
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it('binds trimmed Unicode input while retaining a private stable challenge and original expiry', async () => {
  const note = 'The receipt and payment were checked. 🧾';
  const proposal = await create({ args: { resolution_note: `  ${note}  ` } });
  expect(proposal.parameters.resolution_note).toBe(note);
  expect(proposal.after.dispute.resolution_note).toBe(note);
  const first = await approve(proposal);
  expect(await approve(proposal)).toEqual(first);
  expect(first).toMatchObject({ status: 'awaiting_confirmation', expires_at: proposal.expires_at });
  const receipts = await getProposalReceipts({ context: adminContext(), proposals: [proposal], redisFactory: () => redis });
  expect(receipts[0]).toMatchObject({ tool: 'resolve_dispute', dispute_id: DISPUTE_ID, entry_id: ENTRY_ID,
    container_id: CONTAINER_ID, status: 'awaiting_confirmation' });
  expect(JSON.stringify([proposal, receipts, audit.log.mock.calls])).not.toContain(first.confirmation_token);
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it('does not allow knowledge of the nonce or a member role to bypass the initial approval', async () => {
  const proposal = await create();
  const { record } = await stored(proposal);
  await expect(confirm(proposal, { confirmation_token: record.secondaryConfirmation.token }))
    .rejects.toMatchObject({ code: 'AGENT_PROPOSAL_CONFIRMATION_REQUIRED' });
  await expect(approve(proposal, { context: context() })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
  expect((await status(proposal)).status).toBe('pending');
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it('passes the exact admin identity, reviewed selection and stored trace through one claimed execution', async () => {
  const proposal = await create({ conversationId: CONVERSATION_ID.toUpperCase() });
  const challenge = await approve(proposal);
  const outcomes = await Promise.allSettled([confirm(proposal, challenge), confirm(proposal, challenge)]);
  const executed = outcomes.find((outcome) => outcome.status === 'fulfilled').value;
  expect(executed).toEqual({ proposal_id: proposal.id, status: 'executed', result: resolveResult() });
  expect(await approve(proposal)).toEqual(executed);
  expect(await confirm(proposal, challenge)).toEqual(executed);
  expect(disputes.resolveDispute).toHaveBeenCalledTimes(1);
  expect(disputes.resolveDispute).toHaveBeenCalledWith({ workspaceId: adminContext().workspace.id,
    disputeId: DISPUTE_ID, resolutionNote: RESOLUTION_NOTE, resolvedByMemberId: adminContext().member.id, isAdmin: true,
    actorCtx: { workspaceId: adminContext().workspace.id, actorUserId: adminContext().userId,
      actorMemberId: adminContext().member.id, ipAddress: null, userAgent: null },
    reviewedResolution: { userId: adminContext().userId, isAdmin: true, proposalId: proposal.id,
      trace: { sessionId: SESSION_ID, conversationId: CONVERSATION_ID }, expected: proposal.before },
  });
  const index = audit.log.mock.calls.findIndex(([call]) => call.action === AUDIT_ACTIONS.AGENT_ACTION_CONFIRMED);
  expect(audit.log.mock.calls[index][0]).toMatchObject({ required: true, metadata: { secondary_confirmation: true,
    confirmation_method: 'typed', session_id: SESSION_ID, conversation_id: CONVERSATION_ID } });
  expect(audit.log.mock.invocationCallOrder[index]).toBeLessThan(disputes.resolveDispute.mock.invocationCallOrder[0]);
  jest.clearAllMocks();
  const receipt = await status(proposal);
  expect(receipt).toMatchObject({ dispute_id: DISPUTE_ID, entry_id: ENTRY_ID, container_id: CONTAINER_ID,
    status: 'executed', result: resolveResult() });
  expect(receipt.result.dispute.dispute_id).not.toBe(proposal.id);
  expect(JSON.stringify(receipt)).not.toContain(challenge.confirmation_token);
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
  expect(disputes.getResolveDisputeContext).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

it('requires a server trace and rejects another admin before direct domain revalidation or execution', async () => {
  const proposal = await create();
  await expect(domain.applyProposal({ context: adminContext(), proposal })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  jest.clearAllMocks();
  const other = adminContext({ member: { id: OTHER_ID } });
  await expect(domain.revalidateProposal({ context: other, proposal })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(domain.applyProposal({ context: other, proposal, trace: { sessionId: SESSION_ID, conversationId: null } }))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(disputes.getResolveDisputeContext).not.toHaveBeenCalled();
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it('rejects records that would exceed the storage limit once a full sensitive result is saved', async () => {
  const selected = resolveContext({ workspace_name: '漢'.repeat(200), actor_display_name: '漢'.repeat(200),
    container_name: '漢'.repeat(200), contributor_display_name: '漢'.repeat(200),
    entry: entrySnapshot({ note: '漢'.repeat(500) }), dispute: disputeSnapshot({ reason: '漢'.repeat(1000) }) });
  disputes.getResolveDisputeContext.mockResolvedValue(selected);
  await expect(create({ selection: selected, args: { resolution_note: '漢'.repeat(1000) } }))
    .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  expect(audit.log).not.toHaveBeenCalled();
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it.each([
  { workspace_updated_at: EXECUTION_TIME }, { member_updated_at: EXECUTION_TIME },
  { container_updated_at: EXECUTION_TIME }, { contributor_updated_at: EXECUTION_TIME },
  { contributor_display_name: 'Renamed contributor' }, { dispute: disputeSnapshot({ reason: 'Changed dispute reason.' }) },
  { entry: entrySnapshot({ original_amount: '7000.00', base_amount: '7000.00' }) },
  { entry: entrySnapshot({ note: 'Changed recorded note' }) },
])('fails confirmation after any reviewed context or record changed: %j', async (changes) => {
  const proposal = await create(); const challenge = await approve(proposal);
  disputes.getResolveDisputeContext.mockResolvedValue(resolveContext(changes));
  await expect(confirm(proposal, challenge)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect((await status(proposal)).status).toBe('failed');
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it.each([new ForbiddenError('Admin revoked'), new NotFoundError('Dispute missing'), new BusinessRuleError('Event inactive')])
('requires a fresh card when eligibility is no longer valid: %j', async (error) => {
  const proposal = await create(); const challenge = await approve(proposal);
  disputes.getResolveDisputeContext.mockRejectedValue(error);
  await expect(confirm(proposal, challenge)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
});

it('denies a revoked admin at confirmation and leaves an unavailable pre-execution read retryable', async () => {
  const proposal = await create(); const challenge = await approve(proposal);
  members.getActiveMembership.mockResolvedValue(adminMember({ role: 'member' }));
  await expect(confirm(proposal, challenge)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  members.getActiveMembership.mockResolvedValue(adminMember());
  disputes.getResolveDisputeContext.mockRejectedValueOnce(new AppError('Unavailable', 503, 'DISPUTE_RESOLVE_UNAVAILABLE'));
  await expect(confirm(proposal, challenge)).rejects.toMatchObject({ code: 'DISPUTE_RESOLVE_UNAVAILABLE' });
  expect((await status(proposal)).status).toBe('confirmation_pending');
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
  await expect(confirm(proposal, challenge)).resolves.toMatchObject({ status: 'executed' });
  expect(disputes.resolveDispute).toHaveBeenCalledTimes(1);
});

it('retains the stable secondary audit when a retry is needed and cannot execute through approval alone', async () => {
  const proposal = await create(); const challenge = await approve(proposal);
  let fail = true;
  audit.log.mockImplementation(async (call) => {
    if (call.action === AUDIT_ACTIONS.AGENT_ACTION_CONFIRMED && fail) { fail = false; throw new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'); }
  });
  await expect(confirm(proposal, challenge)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  const before = (await stored(proposal)).record.secondaryConfirmation;
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_BUSY' });
  expect(disputes.resolveDispute).not.toHaveBeenCalled();
  await expect(confirm(proposal, challenge)).resolves.toMatchObject({ status: 'executed' });
  expect((await stored(proposal)).record.secondaryConfirmation).toEqual(before);
  const ids = audit.log.mock.calls.filter(([call]) => call.action === AUDIT_ACTIONS.AGENT_ACTION_CONFIRMED).map(([call]) => call.id);
  expect(new Set(ids).size).toBe(1);
  expect(disputes.resolveDispute).toHaveBeenCalledTimes(1);
});

it('keeps an explicit native conflict failed and never replays the resolution', async () => {
  const proposal = await create(); const challenge = await approve(proposal);
  disputes.resolveDispute.mockRejectedValue(new ConflictError('Atomic rejection'));
  await expect(confirm(proposal, challenge)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect(disputes.resolveDispute).toHaveBeenCalledTimes(1);
});

it.each([new AppError('Unavailable', 503, 'DISPUTE_RESOLVE_UNAVAILABLE'), new Error('PRIVATE_UPSTREAM_FAILURE'), null])
('retains an irreversible claim after uncertain mutation or auditing: %j', async (error) => {
  const proposal = await create(); const challenge = await approve(proposal);
  disputes.resolveDispute.mockRejectedValue(error);
  await expect(confirm(proposal, challenge)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  await expect(confirm(proposal, challenge)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  expect((await status(proposal)).status).toBe('indeterminate');
  expect(disputes.resolveDispute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(audit.log.mock.calls)).not.toContain('PRIVATE_UPSTREAM_FAILURE');
});

it.each([
  { dispute: resolvedDispute({ id: OTHER_ID }) }, { dispute: resolvedDispute({ resolved_by: OTHER_ID }) },
  { dispute: resolvedDispute({ reason: 'Changed original reason.' }) }, { dispute: resolvedDispute({ status: 'open' }) },
  { dispute: resolvedDispute({ resolution_note: ` ${RESOLUTION_NOTE} ` }) },
  { entry: resolvedEntry({ status: 'disputed' }) }, { entry: resolvedEntry({ original_amount: '7000.00' }) },
  { entry: resolvedEntry({ confirmed_by: OTHER_ID }) },
])('never certifies a changed dispute or financial projection: %j', async (changes) => {
  const proposal = await create(); const challenge = await approve(proposal);
  disputes.resolveDispute.mockResolvedValue({ dispute: resolvedDispute(), entry: resolvedEntry(), ...changes });
  await expect(confirm(proposal, challenge)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  expect((await status(proposal)).status).toBe('indeterminate');
});

it('excludes mutable dispute notes, proof metadata and private keys from the result and receipt', async () => {
  const proposal = await create(); const challenge = await approve(proposal);
  disputes.resolveDispute.mockResolvedValue({ dispute: resolvedDispute({ notes: [{ note: 'Unreviewed private note' }] }),
    entry: resolvedEntry({ proofs: [{ name: 'Unreviewed attachment' }], idempotency_key: 'PRIVATE_KEY' }) });
  expect((await confirm(proposal, challenge)).result).toEqual(resolveResult());
  const receipt = await status(proposal);
  expect(JSON.stringify(receipt)).not.toMatch(/Unreviewed|PRIVATE_KEY|proofs|notes|idempotency_key/);
});

it.each(['approve', 'confirm'])('finishes final auditing through %s from the saved result without fresh mutation checks', async (retry) => {
  const proposal = await create(); const challenge = await approve(proposal);
  let fail = true;
  audit.log.mockImplementation(async (call) => {
    if (call.action === AUDIT_ACTIONS.AGENT_ACTION_EXECUTED && fail) { fail = false; throw new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'); }
  });
  await expect(confirm(proposal, challenge)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  expect((await status(proposal)).status).toBe('audit_pending');
  disputes.getResolveDisputeContext.mockRejectedValue(new Error('A saved result must not be revalidated'));
  const result = retry === 'approve' ? await approve(proposal) : await confirm(proposal, challenge);
  expect(result).toEqual({ proposal_id: proposal.id, status: 'executed', result: resolveResult() });
  expect(disputes.resolveDispute).toHaveBeenCalledTimes(1);
});

it('binds stored results and receipts to the exact dispute and both final transitions', async () => {
  const proposal = await create();
  expect(proposalSchema.safeParse({ ...proposal, after: { ...proposal.after,
    entry: { ...proposal.after.entry, status: 'confirmed' } } }).success).toBe(false);
  const { record } = await stored(proposal);
  expect(proposalRecordSchema.safeParse({ ...record, state: 'executing' }).success).toBe(false);
  const challenge = await approve(proposal); await confirm(proposal, challenge);
  const receipt = await status(proposal);
  expect(proposalStatusSchema.safeParse({ ...receipt, dispute_id: OTHER_ID }).success).toBe(false);
  const saved = await stored(proposal);
  saved.record.result.dispute.resolved_by = OTHER_ID;
  await redis.set(saved.key, JSON.stringify(saved.record), 'EX', PROPOSAL_LIMITS.retentionSeconds);
  await expect(status(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
  expect(await getProposalReceipts({ context: adminContext(), proposals: [proposal], redisFactory: () => redis }))
    .toEqual([{ proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String) }]);
  expect(disputes.resolveDispute).toHaveBeenCalledTimes(1);
});
