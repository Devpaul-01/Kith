jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/task.service', () => ({ getTaskConfirmationContext: jest.fn(), adminConfirmTask: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { AppError, ConflictError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const members = require('../../../src/services/member.service');
const tasks = require('../../../src/services/task.service');
const audit = require('../../../src/services/audit.service');
const domain = require('../../../src/agent/services/task-confirmation-proposal.service');
const { createProposal, decideProposal, getProposalStatus, getProposalReceipts } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { proposalSchema, PROPOSAL_LIMITS } = require('../../../src/agent/validators/proposal.validator');
const { context, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, TASK_ID, adminContext, adminMember, proof, confirmationContext,
  confirmationAfter, confirmationResult, confirmedTask,
} = require('../../helpers/agent-task-confirmation');

let redis;
const create = (overrides = {}) => createProposal({
  context: adminContext(), tool: 'admin_confirm_task', selection: confirmationContext(), args: {},
  turnId: randomUUID(), redisFactory: () => redis, ...overrides,
});
const decide = (proposal, overrides = {}) => decideProposal({
  context: adminContext(), proposalId: proposal.id, data: {}, decision: 'approve',
  redisFactory: () => redis, ...overrides,
});
const status = (proposal, overrides = {}) => getProposalStatus({
  context: adminContext(), proposalId: proposal.id, redisFactory: () => redis, ...overrides,
});

beforeEach(() => {
  redis = new Redis();
  members.getActiveMembership.mockReset().mockResolvedValue(adminMember());
  tasks.getTaskConfirmationContext.mockReset().mockResolvedValue(confirmationContext());
  tasks.adminConfirmTask.mockReset().mockResolvedValue(confirmedTask());
  audit.log.mockReset().mockResolvedValue();
});
afterEach(async () => { await redis.flushall(); await redis.quit(); jest.restoreAllMocks(); });

it('registers a Tier 3 admin proposal with empty model arguments, outside the read executor', async () => {
  expect(domain.adminConfirmTaskDefinition).toMatchObject({ name: 'admin_confirm_task', tier: 3, minRole: 'admin' });
  expect(domain.adminConfirmTaskDefinition.parameterSchema.safeParse({}).success).toBe(true);
  await expect(executeReadTool({ name: 'admin_confirm_task', args: {}, context: adminContext() }))
    .rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
});

it('reads the selected task through the native service using authenticated identity', async () => {
  const selection = await domain.selectTaskConfirmation({ context: adminContext(), containerId: CONTAINER_ID, taskId: TASK_ID.toUpperCase() });
  expect(selection).toEqual(confirmationContext());
  expect(Object.isFrozen(selection)).toBe(true);
  expect(tasks.getTaskConfirmationContext).toHaveBeenCalledWith({ workspaceId: context().workspace.id,
    containerId: CONTAINER_ID, taskId: TASK_ID, callerId: context().member.id, userId: context().userId, isAdmin: true });
  expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
});

it('denies every direct handler to members before service access', async () => {
  const proposal = await create();
  jest.clearAllMocks();
  for (const operation of [
    () => domain.selectTaskConfirmation({ context: context(), containerId: CONTAINER_ID, taskId: TASK_ID }),
    () => domain.createProposalDraft({ context: context(), tool: 'admin_confirm_task', selection: proposal.before, args: {} }),
    () => domain.revalidateProposal({ context: context(), proposal }),
    () => domain.applyProposal({ context: context(), proposal }),
    () => create({ context: context() }),
  ]) await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(members.getActiveMembership).not.toHaveBeenCalled();
  expect(tasks.getTaskConfirmationContext).not.toHaveBeenCalled();
  expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
});

it.each([{ task_id: OTHER_ID }, { note: 'New admin note' }, { isAdmin: true }, [], null])('rejects model arguments %j before issuing a card', async (args) => {
  await expect(create({ args })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(tasks.getTaskConfirmationContext).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

it.each([{ workspace_id: OTHER_ID }, { actor_member_id: OTHER_ID }])('rejects a selection for another authenticated scope: %j', async (changes) => {
  await expect(create({ selection: confirmationContext({ ...changes, proofs: [] }) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(tasks.getTaskConfirmationContext).not.toHaveBeenCalled();
});

it('creates a full card with proofs and preserved notes, and audits only the proposal', async () => {
  const proposal = await create();
  expect(proposal).toEqual({ id: expect.any(String), tool: 'admin_confirm_task', tier: 3,
    summary: 'Confirm completion of the selected task.', parameters: { container_id: CONTAINER_ID, task_id: TASK_ID },
    before: confirmationContext(), after: confirmationAfter(), expires_at: expect.any(String) });
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
    action: AUDIT_ACTIONS.AGENT_ACTION_PROPOSED, required: true, targetType: 'task', targetId: TASK_ID,
    metadata: expect.objectContaining({ tier: 3, before: proposal.before, after: proposal.after }),
  }));
  expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
});

it('checks eventual receipt size before persisting or auditing a proof-heavy card', async () => {
  const selected = confirmationContext({ proofs: Array.from({ length: 20 }, (_, index) => proof({ name: `${index}${'x'.repeat(250)}` })) });
  tasks.getTaskConfirmationContext.mockResolvedValue(selected);
  await expect(create({ selection: selected })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  expect(audit.log).not.toHaveBeenCalled();
  expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
});

it.each([
  { title: 'A different task' }, { proofs: [] }, { proofs: [proof({ name: 'Changed attachment' })] },
  { completion_note: 'Changed completion' }, { admin_note: 'Changed review' }, { assigned_to: null },
])('rejects changed reviewed data on approval: %j', async (changes) => {
  const proposal = await create();
  tasks.getTaskConfirmationContext.mockResolvedValue(confirmationContext(changes));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect((await status(proposal)).status).toBe('failed');
  expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
});

it('blocks stale admin membership and prevents other actors reading a receipt', async () => {
  const proposal = await create();
  members.getActiveMembership.mockResolvedValue(adminMember({ role: 'member' }));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  members.getActiveMembership.mockResolvedValue(adminMember({ id: OTHER_ID }));
  await expect(status(proposal, { context: { ...adminContext(), member: { ...adminContext().member, id: OTHER_ID } } }))
    .rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
  expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
});

it('executes once across concurrent approvals, retries and receipt reads', async () => {
  const proposal = await create();
  const results = await Promise.allSettled([decide(proposal), decide(proposal)]);
  const success = results.find((result) => result.status === 'fulfilled').value;
  expect(success).toEqual({ proposal_id: proposal.id, status: 'executed', result: confirmationResult() });
  expect(await decide(proposal)).toEqual(success);
  expect(tasks.adminConfirmTask).toHaveBeenCalledTimes(1);
  expect(tasks.adminConfirmTask).toHaveBeenCalledWith({
    workspaceId: context().workspace.id, containerId: CONTAINER_ID, taskId: TASK_ID,
    actorMemberId: context().member.id, actorDisplayName: context().member.displayName,
    actorCtx: { workspaceId: context().workspace.id, actorUserId: context().userId,
      actorMemberId: context().member.id, ipAddress: null, userAgent: null },
    reviewedConfirmation: { userId: context().userId, isAdmin: true, expected: proposal.before },
  });
  expect(await status(proposal)).toMatchObject({ ...success, tool: 'admin_confirm_task', task_id: TASK_ID, container_id: CONTAINER_ID });
  expect(await getProposalReceipts({ context: adminContext(), proposals: [proposal], redisFactory: () => redis }))
    .toEqual([expect.objectContaining({ status: 'executed', result: confirmationResult() })]);
});

it('expires or rejects a card without confirming the task', async () => {
  const rejected = await create();
  expect(await decide(rejected, { decision: 'reject' })).toEqual({ proposal_id: rejected.id, status: 'rejected' });
  await expect(decide(rejected)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_DECIDED' });
  const expired = await create();
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(expired.expires_at) + 1);
  await expect(decide(expired)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_EXPIRED' });
  expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
});

it('records a definite conditional conflict as failed and never retries the mutation', async () => {
  const proposal = await create();
  tasks.adminConfirmTask.mockRejectedValue(new ConflictError('Changed before UPDATE'));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect((await status(proposal)).status).toBe('failed');
  expect(tasks.adminConfirmTask).toHaveBeenCalledTimes(1);
});

it.each([
  ['transport or required native audit failure', new AppError('Unavailable', 503, 'TASK_CONFIRMATION_UNAVAILABLE')],
  ['unexpected failure', new Error('Private upstream error')],
])('keeps an irreversible claim after %s', async (_label, error) => {
  const proposal = await create();
  tasks.adminConfirmTask.mockRejectedValue(error);
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  expect((await status(proposal)).status).toBe('indeterminate');
  expect(tasks.adminConfirmTask).toHaveBeenCalledTimes(1);
});

it.each([{ title: 'Changed title' }, { proofs: [] }, { admin_confirmed_by: OTHER_ID }, { admin_note: null }])('never certifies a mutated execution result: %j', async (changes) => {
  const proposal = await create();
  tasks.adminConfirmTask.mockResolvedValue(confirmedTask(changes));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  expect((await status(proposal)).status).toBe('indeterminate');
});

it('can finish a failed final agent audit without confirming the task again', async () => {
  const proposal = await create();
  audit.log.mockImplementationOnce(async () => {}); // Approval audit.
  audit.log.mockImplementationOnce(async () => { throw new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'); });
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  expect((await status(proposal)).status).toBe('audit_pending');
  expect((await decide(proposal)).status).toBe('executed');
  expect(tasks.adminConfirmTask).toHaveBeenCalledTimes(1);
});

it('binds stored results and proposal projections to the full reviewed proof state', async () => {
  const proposal = await create();
  expect(proposalSchema.safeParse({ ...proposal, after: { ...proposal.after, proofs: [] } }).success).toBe(false);
  await decide(proposal);
  const key = (await redis.keys('kith:agent-proposal:*'))[0];
  const record = JSON.parse(await redis.get(key));
  record.result.proofs[0].name = 'Different proof';
  await redis.set(key, JSON.stringify(record), 'EX', PROPOSAL_LIMITS.retentionSeconds);
  await expect(status(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
  expect(tasks.adminConfirmTask).toHaveBeenCalledTimes(1);
});
