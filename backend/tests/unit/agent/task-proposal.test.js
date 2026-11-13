jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/task.service', () => ({ getTask: jest.fn(), updateTask: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { AppError, ConflictError, ForbiddenError, NotFoundError } = require('../../../src/utils/errors');
const tasks = require('../../../src/services/task.service');
const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const taskProposals = require('../../../src/agent/services/task-proposal.service');
const { createProposal, decideProposal, getProposalStatus } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');
const { CONTAINER_ID, TASK_ID, taskSnapshot, taskRow, updatedTask } = require('../../helpers/agent-task-proposal');

describe('own task progress proposals', () => {
  let redis;
  const create = (args = { status: 'completed', completion_note: 'Done' }, overrides = {}) => createProposal({
    context: context(), tool: 'update_task', selection: taskSnapshot(), args, turnId: randomUUID(),
    redisFactory: () => redis, ...overrides,
  });
  const decide = (proposal, overrides = {}) => decideProposal({
    context: context(), proposalId: proposal.id, data: {}, decision: 'approve',
    redisFactory: () => redis, ...overrides,
  });
  const status = (proposal) => getProposalStatus({
    context: context(), proposalId: proposal.id, redisFactory: () => redis,
  });

  beforeEach(() => {
    redis = new Redis();
    members.getActiveMembership.mockReset().mockResolvedValue(member());
    tasks.getTask.mockReset().mockResolvedValue(taskRow());
    tasks.updateTask.mockReset().mockImplementation(async ({ data }) => updatedTask(data));
    audit.log.mockReset().mockResolvedValue();
  });
  afterEach(async () => { await redis.flushall(); await redis.quit(); });

  it('checks a current selection through the task service and trims private fields', async () => {
    const selected = await taskProposals.selectTask({ context: context(), containerId: CONTAINER_ID, taskId: TASK_ID });
    expect(selected).toEqual(taskSnapshot());
    expect(Object.isFrozen(selected)).toBe(true);
    expect(tasks.getTask).toHaveBeenCalledWith({
      workspaceId: context().workspace.id, containerId: CONTAINER_ID, taskId: TASK_ID,
      isAdmin: false, callerId: context().member.id,
    });
    expect(JSON.stringify(selected)).not.toContain('PRIVATE_');
    expect(tasks.updateTask).not.toHaveBeenCalled();
  });

  it.each(['member', 'admin'])('denies a %s selection assigned to another member', async (role) => {
    const actor = context();
    actor.member.role = role;
    members.getActiveMembership.mockResolvedValue({ ...member(), role });
    tasks.getTask.mockResolvedValue(taskRow({ assigned_to: OTHER_ID }));
    await expect(taskProposals.selectTask({ context: actor, containerId: CONTAINER_ID, taskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(tasks.getTask).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: role === 'admin' }));
    expect(tasks.updateTask).not.toHaveBeenCalled();
  });

  it('denies inactive membership before looking up a task', async () => {
    members.getActiveMembership.mockResolvedValue({ ...member(), is_active: false });
    await expect(taskProposals.selectTask({ context: context(), containerId: CONTAINER_ID, taskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(tasks.getTask).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'completed' }, { status: 'cancelled' }, { admin_confirmed_at: '2026-11-13T12:01:00.000Z' },
  ])('keeps reopening and admin-confirmed task changes outside Tier 2: %j', async (changes) => {
    tasks.getTask.mockResolvedValue(taskRow(changes));
    await expect(taskProposals.selectTask({ context: context(), containerId: CONTAINER_ID, taskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(tasks.updateTask).not.toHaveBeenCalled();
  });

  it.each(['pending', 'in_progress', 'overdue'])('supports completing an own %s task', async (state) => {
    tasks.getTask.mockResolvedValue(taskRow({ status: state }));
    const proposal = await create(undefined, { selection: { ...taskSnapshot(), status: state } });
    expect(proposal.before.status).toBe(state);
    expect(proposal.after.status).toBe('completed');
    expect(tasks.updateTask).not.toHaveBeenCalled();
  });

  it('creates an immutable-target card with the reviewed before/after state and no write', async () => {
    const proposal = await create();
    expect(proposal).toMatchObject({
      tool: 'update_task', tier: 2, summary: 'Mark the selected task as completed.',
      parameters: { container_id: CONTAINER_ID, task_id: TASK_ID, status: 'completed', completion_note: 'Done' },
      before: taskSnapshot(), after: { status: 'completed', completion_note: 'Done' },
    });
    expect(JSON.stringify(proposal)).not.toContain('PRIVATE_');
    expect(tasks.updateTask).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agent.action_proposed', targetType: 'task', targetId: TASK_ID,
      actorMemberId: context().member.id,
      metadata: expect.objectContaining({ agent_initiated: true, tool: 'update_task', parameters: proposal.parameters }),
    }));
  });

  it('preserves an omitted completion note and supports explicitly clearing it', async () => {
    tasks.getTask.mockResolvedValue(taskRow({ completion_note: 'Earlier progress' }));
    const selection = { ...taskSnapshot(), completion_note: 'Earlier progress' };
    const preserved = await create({ status: 'in_progress' }, { selection });
    expect(preserved.parameters).not.toHaveProperty('completion_note');
    expect(preserved.after.completion_note).toBe('Earlier progress');
    const cleared = await create({ status: 'in_progress', completion_note: null }, { selection });
    expect(cleared.after.completion_note).toBeNull();
  });

  it.each([
    ['missing status', {}], ['pending status', { status: 'pending' }], ['cancelled status', { status: 'cancelled' }],
    ['model task ID', { status: 'completed', task_id: OTHER_ID }],
    ['model container ID', { status: 'completed', container_id: OTHER_ID }],
    ['reassignment', { status: 'completed', assigned_to: OTHER_ID }],
    ['title change', { status: 'completed', title: 'Injected title' }],
    ['admin confirmation', { status: 'completed', admin_confirmed_at: '2026-11-13T12:01:00.000Z' }],
    ['oversized note', { status: 'completed', completion_note: 'x'.repeat(1001) }],
  ])('rejects %s before storing a card', async (_label, args) => {
    await expect(create(args)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(tasks.getTask).not.toHaveBeenCalled();
    expect(tasks.updateTask).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('requires an explicit selection and refuses direct execution through the read registry', async () => {
    await expect(create(undefined, { selection: undefined })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(executeReadTool({ name: 'update_task', args: { status: 'completed' }, context: context() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(tasks.updateTask).not.toHaveBeenCalled();
  });

  it('refuses a no-op progress change', async () => {
    tasks.getTask.mockResolvedValue(taskRow({ status: 'in_progress' }));
    await expect(create({ status: 'in_progress' }, { selection: { ...taskSnapshot(), status: 'in_progress' } }))
      .rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('applies once through approval, pins audit identity, and returns only verified progress', async () => {
    const proposal = await create();
    const actorCtx = {
      workspaceId: OTHER_ID, actorUserId: OTHER_ID, actorMemberId: OTHER_ID,
      ipAddress: '127.0.0.1', userAgent: 'task-test',
    };
    const first = await decide(proposal, { actorCtx });
    expect(await decide(proposal)).toEqual(first);
    expect(first).toEqual({
      proposal_id: proposal.id, status: 'executed', result: {
        task_id: TASK_ID, container_id: CONTAINER_ID, status: 'completed', completion_note: 'Done',
        completed_at: '2026-11-13T12:01:00.000Z', updated_at: '2026-11-13T12:01:00.000Z',
      },
    });
    expect(tasks.updateTask).toHaveBeenCalledTimes(1);
    expect(tasks.updateTask).toHaveBeenCalledWith({
      workspaceId: context().workspace.id, containerId: CONTAINER_ID, taskId: TASK_ID,
      isAdmin: false, callerId: context().member.id, actorDisplayName: 'Adaeze',
      data: { status: 'completed', completion_note: 'Done' }, expectedTask: taskSnapshot(),
      actorCtx: {
        workspaceId: context().workspace.id, actorUserId: context().userId, actorMemberId: context().member.id,
        ipAddress: '127.0.0.1', userAgent: 'task-test',
      },
    });
    expect(await status(proposal)).toMatchObject({
      tool: 'update_task', task_id: TASK_ID, container_id: CONTAINER_ID, status: 'executed', result: first.result,
    });
    expect(audit.log.mock.calls.map(([entry]) => entry.action)).toEqual([
      'agent.action_proposed', 'agent.action_approved', 'agent.action_executed',
    ]);
    expect(JSON.stringify(first)).not.toContain('PRIVATE_');
  });

  it('still restricts an admin approval to their own assignment and progress fields', async () => {
    const actor = context();
    actor.member.role = 'admin';
    members.getActiveMembership.mockResolvedValue({ ...member(), role: 'admin' });
    const proposal = await create(undefined, { context: actor });
    await decide(proposal, { context: actor });
    expect(tasks.updateTask).toHaveBeenCalledWith(expect.objectContaining({
      isAdmin: true, callerId: actor.member.id, data: { status: 'completed', completion_note: 'Done' },
    }));
  });

  it('starts an own task without completion metadata and preserves an omitted note', async () => {
    tasks.getTask.mockResolvedValue(taskRow({ completion_note: 'Earlier progress' }));
    tasks.updateTask.mockResolvedValue(updatedTask({ status: 'in_progress', completion_note: 'Earlier progress' }));
    const proposal = await create({ status: 'in_progress' }, {
      selection: { ...taskSnapshot(), completion_note: 'Earlier progress' },
    });
    await expect(decide(proposal)).resolves.toMatchObject({
      status: 'executed', result: { status: 'in_progress', completion_note: 'Earlier progress', completed_at: null },
    });
    expect(tasks.updateTask).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'in_progress' } }));
  });

  it.each([
    { assigned_to: OTHER_ID }, { title: 'Changed task' }, { status: 'in_progress' },
    { completion_note: 'Other progress' }, { updated_at: '2026-11-13T12:00:30.000Z' },
    { admin_confirmed_at: '2026-11-13T12:00:30.000Z' },
    { completed_at: '2026-11-13T12:00:30.000Z' },
  ])('permanently rejects changed reviewed state before applying: %j', async (changes) => {
    const proposal = await create();
    tasks.getTask.mockResolvedValueOnce(taskRow(changes));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect((await status(proposal)).status).toBe('failed');
    expect(tasks.updateTask).not.toHaveBeenCalled();
  });

  it.each([
    ['reassignment', () => new ForbiddenError('Reassigned')],
    ['deletion', () => new NotFoundError('Deleted')],
  ])('makes %s final before execution', async (_label, error) => {
    const proposal = await create();
    tasks.getTask.mockRejectedValueOnce(error());
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect((await status(proposal)).status).toBe('failed');
    expect(tasks.updateTask).not.toHaveBeenCalled();
  });

  it('can retry a transient revalidation failure without executing early', async () => {
    const proposal = await create();
    tasks.getTask.mockRejectedValueOnce(new AppError('Unavailable', 503, 'TASKS_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'TASKS_UNAVAILABLE' });
    expect((await status(proposal)).status).toBe('approval_pending');
    expect(tasks.updateTask).not.toHaveBeenCalled();
    await expect(decide(proposal)).resolves.toMatchObject({ status: 'executed' });
    expect(tasks.updateTask).toHaveBeenCalledTimes(1);
  });

  it('treats an atomic conditional miss as not applied and never retries that proposal', async () => {
    const proposal = await create();
    tasks.updateTask.mockRejectedValueOnce(new ConflictError('Reassigned during approval'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(tasks.updateTask).toHaveBeenCalledTimes(1);
    expect((await status(proposal)).status).toBe('failed');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agent.action_failed', metadata: expect.objectContaining({ execution_outcome: 'not_applied' }),
    }));
  });

  it.each([
    { id: OTHER_ID }, { container_id: OTHER_ID }, { status: 'in_progress' },
    { completion_note: 'Different result' }, { assigned_to: OTHER_ID },
    { completed_by: OTHER_ID }, { completed_at: null },
  ])('keeps an unverified write outcome indeterminate without repeating it: %j', async (changes) => {
    const proposal = await create();
    tasks.updateTask.mockResolvedValueOnce({ ...updatedTask(), ...changes });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    const receipt = await status(proposal);
    expect(receipt.status).toBe('indeterminate');
    expect(receipt).not.toHaveProperty('result');
    expect(tasks.updateTask).toHaveBeenCalledTimes(1);
  });

  it('does not repeat an uncertain transport failure', async () => {
    const proposal = await create();
    tasks.updateTask.mockRejectedValueOnce(new AppError('Connection lost', 503, 'TASKS_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(tasks.updateTask).toHaveBeenCalledTimes(1);
  });

  it('rejects a proposal without changing the task', async () => {
    const proposal = await create();
    await expect(decide(proposal, { decision: 'reject' })).resolves.toEqual({ proposal_id: proposal.id, status: 'rejected' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_DECIDED' });
    expect(tasks.updateTask).not.toHaveBeenCalled();
  });
});
