jest.mock('../../../src/services/member.service', () => ({
  getActiveMembership: jest.fn(), getMemberCreationContext: jest.fn(), createMember: jest.fn(),
}));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { AppError, ConflictError, ForbiddenError, NotFoundError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const memberProposals = require('../../../src/agent/services/member-creation-proposal.service');
const { createProposal, decideProposal, getProposalStatus, getProposalReceipts } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { proposalSchema, PROPOSAL_LIMITS } = require('../../../src/agent/validators/proposal.validator');
const { context, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  adminContext, adminMember, creationContext, creationArguments,
  creationAfter, creationResult, createdMember,
} = require('../../helpers/agent-member-creation');

describe('admin member creation proposals', () => {
  let redis;
  const create = (args = creationArguments(), overrides = {}) => createProposal({
    context: adminContext(), tool: 'create_member', args,
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
  const resultFor = (proposal) => ({
    ...proposal.after, joined_at: creationResult().joined_at,
    created_at: creationResult().created_at, updated_at: creationResult().updated_at,
  });
  const serviceResult = ({ workspaceId, data, actorCtx, reviewedCreation }, overrides = {}) => createdMember({
    ...data, id: reviewedCreation.memberId, workspace_id: workspaceId,
    proxy_managed_by: data.is_proxy ? actorCtx.actorMemberId : null, ...overrides,
  });
  async function replaceRecord(proposal, update) {
    const key = (await redis.keys('kith:agent-proposal:*')).find((candidate) => candidate.endsWith(proposal.id));
    const record = JSON.parse(await redis.get(key));
    await redis.set(key, JSON.stringify({ ...record, ...update }), 'EX', PROPOSAL_LIMITS.retentionSeconds);
    return key;
  }

  beforeEach(() => {
    redis = new Redis();
    members.getActiveMembership.mockReset().mockResolvedValue(adminMember());
    members.getMemberCreationContext.mockReset().mockResolvedValue(creationContext());
    members.createMember.mockReset().mockImplementation(async (options) => serviceResult(options));
    audit.log.mockReset().mockResolvedValue();
  });
  afterEach(async () => {
    await redis.flushall();
    await redis.quit();
    jest.restoreAllMocks();
  });

  it('denies members before fresh reads, storage, auditing or writer access', async () => {
    expect(memberProposals.createMemberDefinition).toMatchObject({ name: 'create_member', minRole: 'admin', tier: 3 });
    await expect(create(creationArguments(), { context: context() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(members.getActiveMembership).not.toHaveBeenCalled();
    expect(members.getMemberCreationContext).not.toHaveBeenCalled();
    expect(members.createMember).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('checks role on direct draft, revalidation and execution entry points', async () => {
    const proposal = await create();
    jest.clearAllMocks();
    for (const operation of [
      () => memberProposals.createProposalDraft({ context: context(), tool: 'create_member',
        args: creationArguments(), id: proposal.id, expiresAt: proposal.expires_at }),
      () => memberProposals.revalidateProposal({ context: context(), proposal }),
      () => memberProposals.applyProposal({ context: context(), proposal }),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(members.getActiveMembership).not.toHaveBeenCalled();
    expect(members.getMemberCreationContext).not.toHaveBeenCalled();
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it.each([false, true])('proposes a complete new member, with is_proxy=%s, without inserting', async (is_proxy) => {
    const args = creationArguments({ is_proxy });
    const proposal = await create(args);
    expect(proposal).toEqual({
      id: expect.any(String), tool: 'create_member', tier: 3,
      summary: 'Create a new member in this workspace.', parameters: args,
      before: { ...creationContext(), member: null },
      after: creationAfter({ ...args, member_id: proposal.id }), expires_at: expect.any(String),
    });
    expect(members.getMemberCreationContext).toHaveBeenCalledWith({
      workspaceId: adminContext().workspace.id, callerId: adminContext().member.id,
      userId: adminContext().userId, isAdmin: true,
    });
    expect(members.createMember).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: AUDIT_ACTIONS.AGENT_ACTION_PROPOSED, required: true,
      targetType: 'workspace_member', targetId: proposal.id,
      metadata: expect.objectContaining({ agent_initiated: true, parameters: args,
        before: proposal.before, after: proposal.after }),
    }));
  });

  it('normalizes requested text and displays all defaults, including the absence of account linking', async () => {
    const proposal = await create({ display_name: '  Chika Okafor  ', admin_notes: ' ' });
    expect(proposal.parameters).toEqual({
      display_name: 'Chika Okafor', is_proxy: false, relationship_to_head: null,
      relationship_category: 'other', date_of_birth: null, admin_notes: null,
    });
    expect(proposal.after).toMatchObject({
      role: 'member', user_id: null, proxy_managed_by: null, invite_status: null, invited_at: null,
      is_active: true, contribution_streak_months: 0,
      joined_at: 'on_approval', created_at: 'on_approval', updated_at: 'on_approval',
    });
  });

  it.each([
    ['missing name', {}], ['blank name', { display_name: '  ' }],
    ['oversized name', { display_name: 'x'.repeat(81) }],
    ['admin role', { display_name: 'Chika', role: 'admin' }],
    ['member role override', { display_name: 'Chika', role: 'member' }],
    ['account link', { display_name: 'Chika', user_id: OTHER_ID }],
    ['workspace', { display_name: 'Chika', workspace_id: OTHER_ID }],
    ['manager', { display_name: 'Chika', is_proxy: true, proxy_managed_by: OTHER_ID }],
    ['member ID', { display_name: 'Chika', member_id: OTHER_ID }],
    ['invitation', { display_name: 'Chika', invite_status: 'pending' }],
    ['relative birth date', { display_name: 'Chika', date_of_birth: 'ten years ago' }],
    ['invalid calendar date', { display_name: 'Chika', date_of_birth: '2025-02-29' }],
    ['NUL text', { display_name: 'Chika\u0000' }],
    ['unpaired surrogate', { display_name: 'Chika\uD800' }],
    ['files', { display_name: 'Chika', avatar: 'https://example.com/photo.jpg' }],
  ])('rejects %s before domain reads or proposal persistence', async (_label, args) => {
    await expect(create(args)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(members.getActiveMembership).not.toHaveBeenCalled();
    expect(members.getMemberCreationContext).not.toHaveBeenCalled();
    expect(members.createMember).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('rejects details whose encoded completed receipt would exceed storage before audit or insertion', async () => {
    await expect(create(creationArguments({ admin_notes: '\u0001'.repeat(1000) })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
    expect(audit.log).not.toHaveBeenCalled();
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it.each([{ workspace_id: OTHER_ID }, { actor_member_id: OTHER_ID }])('refuses a mismatched creation scope: %j', async (changes) => {
    members.getMemberCreationContext.mockResolvedValue(creationContext(changes));
    await expect(create()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(members.createMember).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('cannot execute creation through the read dispatcher', async () => {
    await expect(executeReadTool({ name: 'create_member', args: creationArguments(), context: adminContext() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it.each([false, true])('creates is_proxy=%s once on separate approval and returns the verified stored state', async (is_proxy) => {
    const proposal = await create(creationArguments({ is_proxy }));
    const actorCtx = { actorUserId: OTHER_ID, actorMemberId: OTHER_ID, workspaceId: OTHER_ID,
      ipAddress: '127.0.0.1', userAgent: 'member-proposal-test' };
    const first = await decide(proposal, { actorCtx });
    expect(first).toEqual({ proposal_id: proposal.id, status: 'executed', result: resultFor(proposal) });
    expect(await decide(proposal)).toEqual(first);
    expect(members.createMember).toHaveBeenCalledTimes(1);
    expect(members.createMember).toHaveBeenCalledWith({
      workspaceId: adminContext().workspace.id, data: proposal.parameters,
      actorCtx: { workspaceId: adminContext().workspace.id, actorUserId: adminContext().userId,
        actorMemberId: adminContext().member.id, ipAddress: '127.0.0.1', userAgent: 'member-proposal-test' },
      reviewedCreation: { userId: adminContext().userId, isAdmin: true,
        expected: creationContext(), memberId: proposal.id },
    });
    expect(audit.log.mock.calls.map(([entry]) => entry.action)).toEqual([
      AUDIT_ACTIONS.AGENT_ACTION_PROPOSED, AUDIT_ACTIONS.AGENT_ACTION_APPROVED, AUDIT_ACTIONS.AGENT_ACTION_EXECUTED,
    ]);
    const receipt = await status(proposal);
    expect(receipt).toMatchObject({ tool: 'create_member', member_id: proposal.id, status: 'executed', result: first.result });
    expect(await receipts(proposal)).toEqual([expect.objectContaining({ member_id: proposal.id, result: first.result })]);
  });

  it('treats separate approved cards with the same name as separate creations', async () => {
    const first = await create();
    const second = await create();
    expect(first.id).not.toBe(second.id);
    await decide(first);
    await decide(second);
    expect(members.createMember).toHaveBeenCalledTimes(2);
  });

  it('rejects decision parameter overrides and keeps the saved proposal pending', async () => {
    const proposal = await create();
    await expect(decide(proposal, { data: { role: 'admin', parameters: { is_proxy: true } } }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await status(proposal)).toHaveProperty('status', 'pending');
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it.each([
    { workspace_name: 'Renamed family' }, { workspace_updated_at: '2026-11-15T12:01:00.000Z' },
  ])('invalidates changed reviewed workspace state before execution: %j', async (changes) => {
    const proposal = await create();
    members.getMemberCreationContext.mockResolvedValue(creationContext(changes));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(await status(proposal)).toHaveProperty('status', 'failed');
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it.each([
    ['removed admin', new ForbiddenError('Admin removed')],
    ['missing workspace', new NotFoundError('Workspace not found')],
  ])('invalidates revoked eligibility: %s', async (_label, error) => {
    const proposal = await create();
    members.getMemberCreationContext.mockRejectedValue(error);
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it('rechecks current role even when HTTP context still reports admin', async () => {
    const proposal = await create();
    members.getActiveMembership.mockResolvedValue(adminMember({ role: 'member' }));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it('can retry an unavailable pre-execution read without creating early', async () => {
    const proposal = await create();
    members.getMemberCreationContext.mockRejectedValueOnce(new AppError('Unavailable', 503, 'MEMBERS_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'MEMBERS_UNAVAILABLE' });
    expect(members.createMember).not.toHaveBeenCalled();
    expect(await decide(proposal)).toHaveProperty('status', 'executed');
    expect(members.createMember).toHaveBeenCalledTimes(1);
  });

  it('marks a proven pre-insert conflict failed without retrying the writer', async () => {
    const proposal = await create();
    members.createMember.mockRejectedValueOnce(new ConflictError('Reviewed state changed'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(await status(proposal)).toHaveProperty('status', 'failed');
    expect(members.createMember).toHaveBeenCalledTimes(1);
  });

  it.each([
    { role: 'admin' }, { user_id: OTHER_ID }, { proxy_managed_by: OTHER_ID },
    { display_name: 'Different member' }, { id: OTHER_ID }, { is_active: false },
    { admin_notes: undefined }, { joined_at: '2026-11-15T12:01:00.000Z' },
  ])('retains an irreversible claim when the saved member cannot be verified: %j', async (changes) => {
    const proposal = await create();
    members.createMember.mockImplementation(async (options) => serviceResult(options, changes));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(await status(proposal)).toMatchObject({ status: 'indeterminate', member_id: proposal.id });
    expect(members.createMember).toHaveBeenCalledTimes(1);
  });

  it('does not repeat an insert after a native audit or transport failure with an unknown outcome', async () => {
    const proposal = await create(creationArguments({ is_proxy: true }));
    members.createMember.mockRejectedValue(new AppError('Creation unavailable', 503, 'MEMBER_CREATION_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(members.createMember).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({
      action: AUDIT_ACTIONS.AGENT_ACTION_FAILED,
      metadata: expect.objectContaining({ execution_outcome: 'unknown' }),
    }));
  });

  it('finishes a failed final agent audit from its saved result without another member insert', async () => {
    const proposal = await create();
    audit.log.mockImplementation(async ({ action }) => {
      if (action === AUDIT_ACTIONS.AGENT_ACTION_EXECUTED) throw new AppError('Audit unavailable', 503, 'AUDIT_UNAVAILABLE');
    });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(await status(proposal)).toMatchObject({ status: 'audit_pending', result: resultFor(proposal) });
    audit.log.mockResolvedValue();
    expect(await decide(proposal)).toHaveProperty('status', 'executed');
    expect(members.createMember).toHaveBeenCalledTimes(1);
  });

  it('allows only one native insertion under concurrent approval', async () => {
    const proposal = await create();
    const results = await Promise.allSettled([decide(proposal), decide(proposal)]);
    expect(results.some((result) => result.status === 'fulfilled' && result.value.status === 'executed')).toBe(true);
    expect(members.createMember).toHaveBeenCalledTimes(1);
    expect(await decide(proposal)).toHaveProperty('status', 'executed');
  });

  it.each([{ role: 'admin' }, { proxy_managed_by: OTHER_ID }, { member_id: OTHER_ID }])('rejects altered stored after state: %j', async (changes) => {
    const proposal = await create();
    const changed = { ...proposal, after: { ...proposal.after, ...changes } };
    expect(proposalSchema.safeParse(changed).success).toBe(false);
    await replaceRecord(proposal, { proposal: changed });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it('rejects an executed result bound to another member', async () => {
    const proposal = await create();
    await replaceRecord(proposal, { state: 'executed', result: { ...resultFor(proposal), member_id: OTHER_ID } });
    await expect(status(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
    expect(await receipts(proposal)).toEqual([expect.objectContaining({ proposal_id: proposal.id, status: 'unavailable' })]);
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it('never returns a proposal receipt in another user scope', async () => {
    const proposal = await create();
    const other = { ...adminContext(), userId: OTHER_ID };
    members.getActiveMembership.mockResolvedValue(adminMember({ user_id: OTHER_ID }));
    await expect(status(proposal, { context: other })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it('expires pending cards without creating a member', async () => {
    const proposal = await create();
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(proposal.expires_at) + 1);
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_EXPIRED' });
    expect(await status(proposal)).toHaveProperty('status', 'expired');
    expect(members.createMember).not.toHaveBeenCalled();
  });

  it('records rejection without insertion and prevents a later approval', async () => {
    const proposal = await create();
    const rejected = await decide(proposal, { decision: 'reject' });
    expect(rejected).toEqual({ proposal_id: proposal.id, status: 'rejected' });
    expect(await decide(proposal, { decision: 'reject' })).toEqual(rejected);
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_DECIDED' });
    expect(members.createMember).not.toHaveBeenCalled();
  });
});
