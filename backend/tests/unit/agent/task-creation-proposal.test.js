jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/task.service', () => ({ getTaskCreationContext: jest.fn(), createTask: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { AppError, BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const members = require('../../../src/services/member.service');
const tasks = require('../../../src/services/task.service');
const audit = require('../../../src/services/audit.service');
const domain = require('../../../src/agent/services/task-creation-proposal.service');
const { createProposal, decideProposal, getProposalStatus, getProposalReceipts } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { proposalSchema, proposalStatusSchema, PROPOSAL_LIMITS } = require('../../../src/agent/validators/proposal.validator');
const { context, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, ASSIGNEE_ID, EXECUTION_TIME, adminContext, adminMember,
  creationAssignee, creationContext, creationData, creationAfter, creationResult, createdTask,
} = require('../../helpers/agent-task-creation');

let redis;
const create = (overrides = {}) => createProposal({
  context: adminContext(), tool: 'create_task', selection: creationContext(), args: { title: 'Buy groceries' },
  turnId: randomUUID(), redisFactory: () => redis, ...overrides,
});
const decide = (proposal, overrides = {}) => decideProposal({
  context: adminContext(), proposalId: proposal.id, data: {}, decision: 'approve',
  redisFactory: () => redis, ...overrides,
});
const status = (proposal, overrides = {}) => getProposalStatus({
  context: adminContext(), proposalId: proposal.id, redisFactory: () => redis, ...overrides,
});
const resultFor = (proposal) => creationResult({ task_id: proposal.id,
  title: proposal.parameters.title, description: proposal.parameters.description,
  assigned_to: proposal.parameters.assigned_to, due_date: proposal.parameters.due_date });

beforeEach(() => {
  redis = new Redis();
  members.getActiveMembership.mockReset().mockResolvedValue(adminMember());
  tasks.getTaskCreationContext.mockReset().mockResolvedValue(creationContext());
  tasks.createTask.mockReset().mockImplementation(async (call) => createdTask({
    id: call.reviewedCreation.taskId, container_id: call.containerId, ...call.data,
  }));
  audit.log.mockReset().mockResolvedValue();
});
afterEach(async () => { await redis.flushall(); await redis.quit(); jest.restoreAllMocks(); });

it('registers a Tier 3 admin creation proposal outside the read executor', async () => {
  expect(domain.createTaskDefinition).toMatchObject({ name: 'create_task', tier: 3, minRole: 'admin' });
  expect(domain.createTaskDefinition.parameterSchema.parse({ title: 'Buy groceries' }))
    .toEqual({ title: 'Buy groceries', description: null, due_date: null });
  await expect(executeReadTool({ name: 'create_task', args: { title: 'Buy groceries' }, context: adminContext() }))
    .rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it.each([null, ASSIGNEE_ID])('reads and freezes the explicit container/assignee selection (%s) using authenticated identity', async (assigneeId) => {
  const selection = creationContext({ assignee: assigneeId ? creationAssignee() : null });
  tasks.getTaskCreationContext.mockResolvedValue(selection);
  const selected = await domain.selectTaskCreation({ context: adminContext(),
    containerId: CONTAINER_ID.toUpperCase(), assigneeId: assigneeId?.toUpperCase() ?? null });
  expect(selected).toEqual(selection);
  expect(Object.isFrozen(selected)).toBe(true);
  if (selected.assignee) expect(Object.isFrozen(selected.assignee)).toBe(true);
  expect(tasks.getTaskCreationContext).toHaveBeenCalledWith({ workspaceId: context().workspace.id,
    containerId: CONTAINER_ID, assigneeId, callerId: context().member.id, userId: context().userId, isAdmin: true });
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it('denies every direct handler to members before native service access', async () => {
  const proposal = await create();
  jest.clearAllMocks();
  for (const operation of [
    () => domain.selectTaskCreation({ context: context(), containerId: CONTAINER_ID }),
    () => domain.createProposalDraft({ context: context(), tool: 'create_task', selection: proposal.before, args: { title: 'Buy groceries' } }),
    () => domain.revalidateProposal({ context: context(), proposal }),
    () => domain.applyProposal({ context: context(), proposal }),
    () => create({ context: context() }),
  ]) await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(members.getActiveMembership).not.toHaveBeenCalled();
  expect(tasks.getTaskCreationContext).not.toHaveBeenCalled();
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it.each([
  {}, { title: '' }, { title: '   ' }, { title: 'x'.repeat(201) }, { title: 'Buy groceries', description: 'x'.repeat(2001) },
  { title: 'Invalid\u0000title' }, { title: 'Invalid\ud800title' }, { title: 'Buy groceries', description: 'Invalid\udfff' },
  { title: 'Buy groceries', due_date: 'tomorrow' }, { title: 'Buy groceries', due_date: '2025-02-29' },
  { title: 'Buy groceries', due_date: '2026-12-01T00:00:00Z' },
  ...['assigned_to', 'container_id', 'task_id', 'created_by', 'isAdmin', 'status', 'sort_order', 'proofs', 'admin_note']
    .map((field) => ({ title: 'Buy groceries', [field]: OTHER_ID })), [], null,
].map((args) => [args]))('rejects invalid dates/text or model-controlled authority fields: %j', async (args) => {
  await expect(create({ args })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(tasks.getTaskCreationContext).not.toHaveBeenCalled();
  expect(tasks.createTask).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

it.each([{ workspace_id: OTHER_ID }, { actor_member_id: OTHER_ID }])('rejects a selection outside the current actor scope: %j', async (changes) => {
  await expect(create({ selection: creationContext(changes) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(tasks.getTaskCreationContext).not.toHaveBeenCalled();
});

it.each([
  { container_status: 'archived' }, { enable_tasks: false }, { task: { task_id: OTHER_ID } },
  { assignee: creationAssignee({ is_proxy: true }) }, { assignee: creationAssignee({ is_active: false }) },
  { assignee: creationAssignee({ tasks_enabled: false }) },
])('rejects an unsupported selection snapshot: %j', async (changes) => {
  await expect(create({ selection: creationContext(changes) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it.each([
  { container_id: OTHER_ID }, { assignee: creationAssignee() }, { container_name: null },
])('rejects mismatched or malformed native selection data: %j', async (changes) => {
  tasks.getTaskCreationContext.mockResolvedValue(creationContext(changes));
  await expect(domain.selectTaskCreation({ context: adminContext(), containerId: CONTAINER_ID }))
    .rejects.toMatchObject({ code: 'AGENT_SELECTION_UNAVAILABLE' });
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it('creates a complete unassigned card with fixed pending defaults and audits only the proposal', async () => {
  const proposal = await create();
  expect(proposal).toEqual({ id: expect.any(String), tool: 'create_task', tier: 3,
    summary: 'Create a task in the selected container.',
    parameters: { ...creationData(), container_id: CONTAINER_ID },
    before: creationContext(), after: creationAfter({ task_id: proposal.id }), expires_at: expect.any(String) });
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
    action: AUDIT_ACTIONS.AGENT_ACTION_PROPOSED, required: true, targetType: 'task', targetId: proposal.id,
    metadata: expect.objectContaining({ tier: 3, tool: 'create_task', before: proposal.before, after: proposal.after }),
  }));
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it.each(['event', 'recurring'])('creates the requested assigned task in a %s with normalized text and an explicit date', async (containerType) => {
  const selection = creationContext({ container_type: containerType, assignee: creationAssignee({ member_role: 'admin' }) });
  tasks.getTaskCreationContext.mockResolvedValue(selection);
  const proposal = await create({ selection, args: { title: '  Buy groceries 🧺 ', description: '  Bring the list. ', due_date: '2024-02-29' } });
  expect(proposal.parameters).toEqual({ container_id: CONTAINER_ID, assigned_to: ASSIGNEE_ID,
    title: 'Buy groceries 🧺', description: 'Bring the list.', due_date: '2024-02-29' });
  expect(proposal.after).toEqual(creationAfter({ task_id: proposal.id, assigned_to: ASSIGNEE_ID,
    title: 'Buy groceries 🧺', description: 'Bring the list.', due_date: '2024-02-29' }));
  expect(proposal.before.assignee.member_role).toBe('admin');
});

it('rejects a Unicode-heavy eventual record before storing or auditing a card', async () => {
  await expect(create({ args: { title: 'Buy groceries', description: '漢'.repeat(2000) } }))
    .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  expect(audit.log).not.toHaveBeenCalled();
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it('revalidates reviewed state during draft creation before persistence', async () => {
  tasks.getTaskCreationContext.mockResolvedValue(creationContext({ container_name: 'A renamed container' }));
  await expect(create()).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  expect(audit.log).not.toHaveBeenCalled();
});

it.each([
  { workspace_name: 'Renamed family' }, { workspace_updated_at: EXECUTION_TIME },
  { container_name: 'Renamed container' }, { container_type: 'recurring' }, { container_updated_at: EXECUTION_TIME },
  { assignee: creationAssignee({ display_name: 'Renamed member' }) },
  { assignee: creationAssignee({ member_role: 'admin' }) },
  { assignee: creationAssignee({ member_updated_at: EXECUTION_TIME }) },
  { assignee: creationAssignee({ participant_id: OTHER_ID }) },
  { assignee: creationAssignee({ participant_added_at: EXECUTION_TIME }) },
])('fails approval when reviewed context changed: %j', async (changes) => {
  const selection = creationContext({ assignee: creationAssignee() });
  tasks.getTaskCreationContext.mockResolvedValue(selection);
  const proposal = await create({ selection });
  tasks.getTaskCreationContext.mockResolvedValue(creationContext({ ...selection, ...changes }));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect((await status(proposal)).status).toBe('failed');
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it.each([
  ['missing workspace/container/assignee', new NotFoundError('Missing')],
  ['revoked admin', new ForbiddenError('Admin required')],
  ['ineligible participation', new BusinessRuleError('Participant task tracking is disabled')],
])('fails approval after %s', async (_label, error) => {
  const proposal = await create();
  tasks.getTaskCreationContext.mockRejectedValue(error);
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect((await status(proposal)).status).toBe('failed');
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it('can retry a failed pre-execution read without repeating any task write', async () => {
  const proposal = await create();
  tasks.getTaskCreationContext.mockRejectedValueOnce(new AppError('Unavailable', 503, 'TASK_CREATION_UNAVAILABLE'));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'TASK_CREATION_UNAVAILABLE' });
  expect((await status(proposal)).status).toBe('approval_pending');
  expect(tasks.createTask).not.toHaveBeenCalled();
  expect((await decide(proposal)).result).toEqual(resultFor(proposal));
  expect(tasks.createTask).toHaveBeenCalledTimes(1);
});

it('denies changed admin membership and hides another actor\'s saved receipt', async () => {
  const proposal = await create();
  members.getActiveMembership.mockResolvedValue(adminMember({ role: 'member' }));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  members.getActiveMembership.mockResolvedValue(adminMember({ id: OTHER_ID }));
  const other = { ...adminContext(), member: { ...adminContext().member, id: OTHER_ID } };
  await expect(status(proposal, { context: other })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it('executes one exact task across concurrent approvals, retries and read-only receipt lookups', async () => {
  const selection = creationContext({ assignee: creationAssignee() });
  tasks.getTaskCreationContext.mockResolvedValue(selection);
  const proposal = await create({ selection, args: { title: 'Buy groceries', due_date: '2026-12-01' } });
  const results = await Promise.allSettled([decide(proposal), decide(proposal)]);
  const success = results.find((result) => result.status === 'fulfilled').value;
  expect(success).toEqual({ proposal_id: proposal.id, status: 'executed', result: resultFor(proposal) });
  expect(await decide(proposal)).toEqual(success);
  expect(tasks.createTask).toHaveBeenCalledTimes(1);
  expect(tasks.createTask).toHaveBeenCalledWith({ workspaceId: context().workspace.id, containerId: CONTAINER_ID,
    data: creationData({ assigned_to: ASSIGNEE_ID, due_date: '2026-12-01' }),
    actorMemberId: context().member.id, actorDisplayName: context().member.displayName,
    actorCtx: { workspaceId: context().workspace.id, actorUserId: context().userId,
      actorMemberId: context().member.id, ipAddress: null, userAgent: null },
    reviewedCreation: { userId: context().userId, isAdmin: true, taskId: proposal.id, expected: proposal.before },
  });
  jest.clearAllMocks();
  expect(await status(proposal)).toMatchObject({ ...success, tool: 'create_task', task_id: proposal.id,
    container_id: CONTAINER_ID, assigned_to: ASSIGNEE_ID });
  expect(await getProposalReceipts({ context: adminContext(), proposals: [proposal], redisFactory: () => redis }))
    .toEqual([expect.objectContaining({ status: 'executed', result: resultFor(proposal) })]);
  expect(tasks.createTask).not.toHaveBeenCalled();
  expect(tasks.getTaskCreationContext).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

it.each([{ title: 'Changed title' }, { assigned_to: OTHER_ID }, { task_id: OTHER_ID }, { isAdmin: true }])
('rejects approval-body overrides %j', async (data) => {
  const proposal = await create();
  await expect(decide(proposal, { data })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it('expires or rejects cards without creating a task', async () => {
  const rejected = await create();
  expect(await decide(rejected, { decision: 'reject' })).toEqual({ proposal_id: rejected.id, status: 'rejected' });
  await expect(decide(rejected)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_DECIDED' });
  const expired = await create();
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(expired.expires_at) + 1);
  await expect(decide(expired)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_EXPIRED' });
  expect(tasks.createTask).not.toHaveBeenCalled();
});

it('records a definite pre-insert eligibility conflict as failed without retrying creation', async () => {
  const proposal = await create();
  tasks.createTask.mockRejectedValue(new ConflictError('Eligibility changed before INSERT'));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect((await status(proposal)).status).toBe('failed');
  expect(tasks.createTask).toHaveBeenCalledTimes(1);
});

it.each([
  ['database/primary-key/required-native-audit uncertainty', new AppError('Unavailable', 503, 'TASK_CREATION_UNAVAILABLE')],
  ['unexpected failure', new Error('Private upstream error')],
])('retains an irreversible claim after %s', async (_label, error) => {
  const proposal = await create();
  tasks.createTask.mockRejectedValue(error);
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  expect((await status(proposal)).status).toBe('indeterminate');
  expect(tasks.createTask).toHaveBeenCalledTimes(1);
});

it.each([
  { id: OTHER_ID }, { container_id: OTHER_ID }, { title: 'Changed title' }, { description: 'Changed details' },
  { assigned_to: OTHER_ID }, { due_date: '2026-12-01' }, { created_by: OTHER_ID }, { status: 'completed' },
  { proofs: [{}] }, { sort_order: 1 }, { completion_note: 'Unreviewed note' }, { admin_note: 'Unreviewed note' },
  { created_at: null }, { updated_at: '2026-11-15T12:04:00.000Z' },
])('never certifies altered or malformed stored task state: %j', async (changes) => {
  const proposal = await create();
  tasks.createTask.mockImplementation(async (call) => createdTask({ id: call.reviewedCreation.taskId, ...changes }));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  expect((await status(proposal)).status).toBe('indeterminate');
  expect(tasks.createTask).toHaveBeenCalledTimes(1);
});

it('fails required approval auditing before creation and finishes final auditing without another insertion', async () => {
  const proposal = await create();
  audit.log.mockRejectedValueOnce(new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'));
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  expect(tasks.createTask).not.toHaveBeenCalled();
  audit.log.mockImplementationOnce(async () => {});
  audit.log.mockImplementationOnce(async () => { throw new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'); });
  await expect(decide(proposal)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  expect((await status(proposal)).status).toBe('audit_pending');
  expect((await decide(proposal)).status).toBe('executed');
  expect(tasks.createTask).toHaveBeenCalledTimes(1);
});

it('binds full-card projections, receipt headers and stored results to the created state', async () => {
  const proposal = await create();
  expect(proposalSchema.safeParse({ ...proposal, after: { ...proposal.after, task_id: OTHER_ID } }).success).toBe(false);
  expect(proposalSchema.safeParse({ ...proposal, parameters: { ...proposal.parameters, assigned_to: OTHER_ID } }).success).toBe(false);
  const pending = await status(proposal);
  expect(proposalStatusSchema.safeParse({ ...pending, task_id: OTHER_ID }).success).toBe(false);
  await decide(proposal);
  const receipt = await status(proposal);
  expect(proposalStatusSchema.safeParse({ ...receipt, container_id: OTHER_ID }).success).toBe(false);
  expect(proposalStatusSchema.safeParse({ ...receipt, assigned_to: OTHER_ID }).success).toBe(false);
  const key = (await redis.keys('kith:agent-proposal:*'))[0];
  const record = JSON.parse(await redis.get(key));
  record.result.title = 'Corrupted stored title';
  await redis.set(key, JSON.stringify(record), 'EX', PROPOSAL_LIMITS.retentionSeconds);
  await expect(status(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
  expect(await getProposalReceipts({ context: adminContext(), proposals: [proposal], redisFactory: () => redis }))
    .toEqual([{ proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String) }]);
  expect(tasks.createTask).toHaveBeenCalledTimes(1);
});
