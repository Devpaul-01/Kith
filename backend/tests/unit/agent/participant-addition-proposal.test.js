jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/participant.service', () => ({ getParticipantAdditionContext: jest.fn(), addParticipants: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { AppError, BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const members = require('../../../src/services/member.service');
const participants = require('../../../src/services/participant.service');
const audit = require('../../../src/services/audit.service');
const domain = require('../../../src/agent/services/participant-addition-proposal.service');
const { createProposal, decideProposal, getProposalStatus, getProposalReceipts } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { proposalSchema, proposalStatusSchema, PROPOSAL_LIMITS } = require('../../../src/agent/validators/proposal.validator');
const { context, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, MEMBER_ID, EXECUTION_TIME, adminContext, adminMember,
  additionContext, additionAfter, additionResult, participantRow,
} = require('../../helpers/agent-participant-addition');

let redis;
const create = (overrides = {}) => createProposal({
  context: adminContext(), tool: 'add_participants', selection: additionContext(), args: {},
  turnId: randomUUID(), redisFactory: () => redis, ...overrides,
});
const decide = (proposal, overrides = {}) => decideProposal({
  context: adminContext(), proposalId: proposal.id, data: {}, decision: 'approve',
  redisFactory: () => redis, ...overrides,
});
const status = (proposal, overrides = {}) => getProposalStatus({
  context: adminContext(), proposalId: proposal.id, redisFactory: () => redis, ...overrides,
});
const resultFor = (proposal) => additionResult({ participant_id: proposal.id,
  money_enabled: proposal.parameters.money_enabled, tasks_enabled: proposal.parameters.tasks_enabled });
const nativeResult = (call, changes = {}) => ({
  added: [participantRow({ id: call.reviewedAddition.participantId, ...call.participants[0], ...changes })],
  skipped_already_present: 0, skipped_invalid_member: 0,
});

beforeEach(() => {
  redis = new Redis();
  members.getActiveMembership.mockReset().mockResolvedValue(adminMember());
  participants.getParticipantAdditionContext.mockReset().mockResolvedValue(additionContext());
  participants.addParticipants.mockReset().mockImplementation(async (call) => nativeResult(call));
  audit.log.mockReset().mockResolvedValue();
});
afterEach(async () => { await redis.flushall(); await redis.quit(); jest.restoreAllMocks(); });

it('registers an admin Tier 3 proposal with tracking flags only, outside the read executor', async () => {
  expect(domain.addParticipantsDefinition).toMatchObject({ name: 'add_participants', tier: 3, minRole: 'admin' });
  expect(domain.addParticipantsDefinition.parameterSchema.parse({})).toEqual({ money_enabled: false, tasks_enabled: false });
  await expect(executeReadTool({ name: 'add_participants', args: {}, context: adminContext() }))
    .rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it('reads the explicit member/event pair through the native service using authenticated identity', async () => {
  const selected = await domain.selectParticipantAddition({ context: adminContext(),
    containerId: CONTAINER_ID.toUpperCase(), memberId: MEMBER_ID.toUpperCase() });
  expect(selected).toEqual(additionContext());
  expect(Object.isFrozen(selected)).toBe(true);
  expect(participants.getParticipantAdditionContext).toHaveBeenCalledWith({ workspaceId: context().workspace.id,
    containerId: CONTAINER_ID, memberId: MEMBER_ID, callerId: context().member.id,
    userId: context().userId, isAdmin: true });
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it('denies every direct handler to members before native service access', async () => {
  const proposal = await create();
  jest.clearAllMocks();
  for (const operation of [
    () => domain.selectParticipantAddition({ context: context(), containerId: CONTAINER_ID, memberId: MEMBER_ID }),
    () => domain.createProposalDraft({ context: context(), tool: 'add_participants', selection: proposal.before, args: {} }),
    () => domain.revalidateProposal({ context: context(), proposal }),
    () => domain.applyProposal({ context: context(), proposal }),
    () => create({ context: context() }),
  ]) await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(members.getActiveMembership).not.toHaveBeenCalled();
  expect(participants.getParticipantAdditionContext).not.toHaveBeenCalled();
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it.each([
  { container_id: OTHER_ID }, { workspace_member_id: OTHER_ID }, { participants: [MEMBER_ID] },
  { role: 'admin' }, { notes: 'New note' }, { target_amount: '5000.00' }, { isAdmin: true },
  { money_enabled: 'true' }, { tasks_enabled: null }, [], null,
].map((args) => [args]))('rejects unsupported model arguments %j before reading or auditing a draft', async (args) => {
  await expect(create({ args })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(participants.getParticipantAdditionContext).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

it.each([{ workspace_id: OTHER_ID }, { actor_member_id: OTHER_ID }])('rejects selections outside the current actor scope: %j', async (changes) => {
  await expect(create({ selection: additionContext(changes) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(participants.getParticipantAdditionContext).not.toHaveBeenCalled();
});

it.each([{ container_type: 'recurring' }, { selected_member_proxy: true }, { selected_member_active: false }, { participant: { id: OTHER_ID } }])
('rejects ineligible selection snapshots: %j', async (changes) => {
  await expect(create({ selection: additionContext(changes) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it.each([{ container_id: OTHER_ID }, { workspace_member_id: OTHER_ID }, { display_name: null }])
('rejects mismatched or malformed native selection data: %j', async (changes) => {
  participants.getParticipantAdditionContext.mockResolvedValue(additionContext(changes));
  await expect(domain.selectParticipantAddition({ context: adminContext(), containerId: CONTAINER_ID, memberId: MEMBER_ID }))
    .rejects.toMatchObject({ code: 'AGENT_SELECTION_UNAVAILABLE' });
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it('creates a complete default card with an absent participant and fixed adder, and audits only the proposal', async () => {
  const proposal = await create();
  expect(proposal).toEqual({ id: expect.any(String), tool: 'add_participants', tier: 3,
    summary: 'Add the selected member to the selected event container.',
    parameters: { container_id: CONTAINER_ID, workspace_member_id: MEMBER_ID, money_enabled: false, tasks_enabled: false },
    before: additionContext(), after: additionAfter({ participant_id: proposal.id }), expires_at: expect.any(String) });
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
    action: AUDIT_ACTIONS.AGENT_ACTION_PROPOSED, required: true, targetType: 'container', targetId: CONTAINER_ID,
    actorUserId: context().userId, actorMemberId: context().member.id,
    metadata: expect.objectContaining({ tool: 'add_participants', tier: 3, before: proposal.before, after: proposal.after }),
  }));
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it('preserves an existing admin membership role and requested tracking flags in the reviewed card', async () => {
  const selection = additionContext({ selected_member_role: 'admin' });
  participants.getParticipantAdditionContext.mockResolvedValue(selection);
  const proposal = await create({ selection, args: { money_enabled: true, tasks_enabled: true } });
  expect(proposal.before.selected_member_role).toBe('admin');
  expect(proposal.after).toEqual(additionAfter({ participant_id: proposal.id, money_enabled: true, tasks_enabled: true }));
  expect(proposal.after.role).toBeNull();
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it.each([['money_enabled', 'enable_money'], ['tasks_enabled', 'enable_tasks']])
('rejects %s when %s is disabled instead of silently changing the approved request', async (flag, feature) => {
  await expect(create({ selection: additionContext({ [feature]: false }), args: { [flag]: true } }))
    .rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  expect(participants.getParticipantAdditionContext).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

it('revalidates the selection during draft creation before storing a card', async () => {
  participants.getParticipantAdditionContext.mockResolvedValue(additionContext({ display_name: 'Renamed member' }));
  await expect(create()).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  expect(audit.log).not.toHaveBeenCalled();
});

it.each([
  { workspace_name: 'Renamed family' }, { workspace_updated_at: EXECUTION_TIME },
  { container_name: 'Renamed event' }, { container_updated_at: EXECUTION_TIME }, { enable_money: false }, { enable_tasks: false },
  { display_name: 'Renamed member' }, { selected_member_role: 'admin' }, { selected_member_updated_at: EXECUTION_TIME },
])('fails approval when reviewed member/event context changed: %j', async (changes) => {
  const proposal = await create();
  participants.getParticipantAdditionContext.mockResolvedValue(additionContext(changes));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect((await status(proposal)).status).toBe('failed');
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it.each([
  ['removed member or container', new NotFoundError('Missing')],
  ['revoked admin', new ForbiddenError('Admin required')],
  ['existing participant', new BusinessRuleError('Already participates')],
])('fails approval after %s', async (_label, error) => {
  const proposal = await create();
  participants.getParticipantAdditionContext.mockRejectedValue(error);
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect((await status(proposal)).status).toBe('failed');
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it('can retry a failed pre-execution read without issuing another write claim', async () => {
  const proposal = await create();
  participants.getParticipantAdditionContext.mockRejectedValueOnce(new AppError('Unavailable', 503, 'PARTICIPANT_ADDITION_UNAVAILABLE'));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'PARTICIPANT_ADDITION_UNAVAILABLE' });
  expect((await status(proposal)).status).toBe('approval_pending');
  expect(participants.addParticipants).not.toHaveBeenCalled();
  expect((await decide(proposal)).result).toEqual(resultFor(proposal));
  expect(participants.addParticipants).toHaveBeenCalledTimes(1);
});

it('rejects stale admin membership and hides another actor\'s receipts', async () => {
  const proposal = await create();
  members.getActiveMembership.mockResolvedValue(adminMember({ role: 'member' }));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  members.getActiveMembership.mockResolvedValue(adminMember({ id: OTHER_ID }));
  const other = { ...adminContext(), member: { ...adminContext().member, id: OTHER_ID } };
  await expect(status(proposal, { context: other })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it('executes one exact participant across concurrent approvals, retries, and read-only receipt lookups', async () => {
  const proposal = await create({ args: { money_enabled: true } });
  const results = await Promise.allSettled([decide(proposal), decide(proposal)]);
  const success = results.find((result) => result.status === 'fulfilled').value;
  expect(success).toEqual({ proposal_id: proposal.id, status: 'executed', result: resultFor(proposal) });
  expect(await decide(proposal)).toEqual(success);
  expect(participants.addParticipants).toHaveBeenCalledTimes(1);
  expect(participants.addParticipants).toHaveBeenCalledWith({
    workspaceId: context().workspace.id, containerId: CONTAINER_ID,
    participants: [{ workspace_member_id: MEMBER_ID, money_enabled: true, tasks_enabled: false }],
    actorMemberId: context().member.id,
    actorCtx: { workspaceId: context().workspace.id, actorUserId: context().userId,
      actorMemberId: context().member.id, ipAddress: null, userAgent: null },
    reviewedAddition: { userId: context().userId, isAdmin: true, participantId: proposal.id, expected: proposal.before },
  });
  jest.clearAllMocks();
  expect(await status(proposal)).toMatchObject({ ...success, tool: 'add_participants', participant_id: proposal.id,
    container_id: CONTAINER_ID, workspace_member_id: MEMBER_ID });
  expect(await getProposalReceipts({ context: adminContext(), proposals: [proposal], redisFactory: () => redis }))
    .toEqual([expect.objectContaining({ status: 'executed', result: resultFor(proposal) })]);
  expect(participants.addParticipants).not.toHaveBeenCalled();
  expect(participants.getParticipantAdditionContext).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

it.each([{ money_enabled: true }, { participant_id: OTHER_ID }, { isAdmin: true }])
('rejects approval-body overrides %j before execution', async (data) => {
  const proposal = await create();
  await expect(decide(proposal, { data })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it('expires or rejects cards without adding the member', async () => {
  const rejected = await create();
  expect(await decide(rejected, { decision: 'reject' })).toEqual({ proposal_id: rejected.id, status: 'rejected' });
  await expect(decide(rejected)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_DECIDED' });
  const expired = await create();
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(expired.expires_at) + 1);
  await expect(decide(expired)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_EXPIRED' });
  expect(participants.addParticipants).not.toHaveBeenCalled();
});

it('records a definite duplicate-ignore conflict as failed and never retries insertion', async () => {
  const proposal = await create();
  participants.addParticipants.mockRejectedValue(new ConflictError('Already added before INSERT'));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect((await status(proposal)).status).toBe('failed');
  expect(participants.addParticipants).toHaveBeenCalledTimes(1);
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
    action: AUDIT_ACTIONS.AGENT_ACTION_FAILED,
    metadata: expect.objectContaining({ execution_outcome: 'not_applied' }),
  }));
});

it.each([
  ['transport or required native audit failure', new AppError('Unavailable', 503, 'PARTICIPANT_ADDITION_UNAVAILABLE')],
  ['unexpected failure', new Error('Private upstream error')],
])('retains an irreversible claim after %s', async (_label, error) => {
  const proposal = await create();
  participants.addParticipants.mockRejectedValue(error);
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  expect((await status(proposal)).status).toBe('indeterminate');
  expect(participants.addParticipants).toHaveBeenCalledTimes(1);
});

it.each([
  { id: OTHER_ID }, { container_id: OTHER_ID }, { workspace_member_id: OTHER_ID }, { added_by: OTHER_ID },
  { money_enabled: true }, { tasks_enabled: true }, { role: 'admin' }, { notes: 'Unexpected note' },
  { exclude_from_public: true }, { added_at: null },
])('never certifies altered or malformed stored participant state: %j', async (changes) => {
  const proposal = await create();
  participants.addParticipants.mockImplementation(async (call) => nativeResult(call, changes));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  expect((await status(proposal)).status).toBe('indeterminate');
  expect(participants.addParticipants).toHaveBeenCalledTimes(1);
});

it.each([
  { added: [], skipped_already_present: 1, skipped_invalid_member: 0 },
  { added: null, skipped_already_present: 0, skipped_invalid_member: 0 },
  { added: [participantRow()], skipped_already_present: 0, skipped_invalid_member: 1 },
])('retains the claim for unverified native batch responses: %j', async (response) => {
  const proposal = await create();
  participants.addParticipants.mockResolvedValue(response);
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  expect((await status(proposal)).status).toBe('indeterminate');
});

it('fails required approval auditing before insertion and can complete final auditing without reinserting', async () => {
  const proposal = await create();
  audit.log.mockRejectedValueOnce(new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  expect(participants.addParticipants).not.toHaveBeenCalled();
  audit.log.mockImplementationOnce(async () => {});
  audit.log.mockImplementationOnce(async () => { throw new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'); });
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  expect((await status(proposal)).status).toBe('audit_pending');
  expect((await decide(proposal)).status).toBe('executed');
  expect(participants.addParticipants).toHaveBeenCalledTimes(1);
});

it('rejects changed full-card projections and corrupted stored results', async () => {
  const proposal = await create();
  expect(proposalSchema.safeParse({ ...proposal, after: { ...proposal.after, participant_id: OTHER_ID } }).success).toBe(false);
  expect(proposalSchema.safeParse({ ...proposal, after: { ...proposal.after, tasks_enabled: true } }).success).toBe(false);
  await decide(proposal);
  const receipt = await status(proposal);
  expect(proposalStatusSchema.safeParse({ ...receipt, container_id: OTHER_ID }).success).toBe(false);
  expect(proposalStatusSchema.safeParse({ ...receipt, participant_id: OTHER_ID }).success).toBe(false);
  const key = (await redis.keys('kith:agent-proposal:*'))[0];
  const record = JSON.parse(await redis.get(key));
  record.result.money_enabled = true;
  await redis.set(key, JSON.stringify(record), 'EX', PROPOSAL_LIMITS.retentionSeconds);
  await expect(status(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
  expect(await getProposalReceipts({ context: adminContext(), proposals: [proposal], redisFactory: () => redis }))
    .toEqual([{ proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String) }]);
  expect(participants.addParticipants).toHaveBeenCalledTimes(1);
});
