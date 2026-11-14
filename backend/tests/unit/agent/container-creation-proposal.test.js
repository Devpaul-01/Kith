jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/container.service', () => ({ getContainerCreationContext: jest.fn(), createContainer: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { AppError, ConflictError, ForbiddenError, NotFoundError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const containers = require('../../../src/services/container.service');
const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const containerProposals = require('../../../src/agent/services/container-creation-proposal.service');
const { createProposal, decideProposal, getProposalStatus, getProposalReceipts } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { proposalSchema, PROPOSAL_LIMITS } = require('../../../src/agent/validators/proposal.validator');
const { context, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  adminContext, adminMember, creationContext, creationArguments, creationData,
  creationAfter, creationResult, createdContainer,
} = require('../../helpers/agent-container-creation');

describe('admin event-container creation proposals', () => {
  let redis;
  const create = (args = creationArguments(), overrides = {}) => createProposal({
    context: adminContext(), tool: 'create_container', args,
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
  const resultFor = (proposal, overrides = {}) => ({
    ...proposal.after, created_at: creationResult().created_at, updated_at: creationResult().updated_at,
    ...overrides,
  });
  const serviceResult = ({ workspaceId, data, actorMemberId, reviewedCreation }, overrides = {}) => createdContainer({
    ...data, id: reviewedCreation.containerId, workspace_id: workspaceId, created_by: actorMemberId,
    ...overrides,
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
    containers.getContainerCreationContext.mockReset().mockResolvedValue(creationContext());
    containers.createContainer.mockReset().mockImplementation(async (options) => serviceResult(options));
    audit.log.mockReset().mockResolvedValue();
  });
  afterEach(async () => {
    await redis.flushall();
    await redis.quit();
    jest.restoreAllMocks();
  });

  it('registers an admin-only Tier 3 creation proposal with an event-only argument contract', () => {
    expect(containerProposals.createContainerDefinition).toMatchObject({ name: 'create_container', tier: 3, minRole: 'admin' });
    expect(containerProposals.createContainerDefinition.parameterSchema.safeParse({ name: 'Family picnic' }).success).toBe(true);
    expect(containerProposals.createContainerDefinition.parameterSchema.safeParse({ name: 'Family picnic', container_type: 'recurring' }).success).toBe(false);
  });

  it('reads and freezes creation eligibility using the actual admin identity without selecting an existing container', async () => {
    const selected = await containerProposals.selectContainerCreationContext({ context: adminContext() });
    expect(selected).toEqual(creationContext());
    expect(Object.isFrozen(selected)).toBe(true);
    expect(containers.getContainerCreationContext).toHaveBeenCalledWith({
      workspaceId: adminContext().workspace.id, callerId: adminContext().member.id,
      userId: adminContext().userId, isAdmin: true,
    });
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it('denies members before reading creation eligibility, persisting a proposal, or calling the writer', async () => {
    await expect(containerProposals.selectContainerCreationContext({ context: context() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(create(creationArguments(), { context: context() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(members.getActiveMembership).not.toHaveBeenCalled();
    expect(containers.getContainerCreationContext).not.toHaveBeenCalled();
    expect(containers.createContainer).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('protects direct draft, revalidation and apply calls from non-admin contexts', async () => {
    const proposal = await create();
    jest.clearAllMocks();
    for (const operation of [
      () => containerProposals.createProposalDraft({ context: context(), tool: 'create_container', args: creationArguments(), id: randomUUID(), expiresAt: proposal.expires_at }),
      () => containerProposals.revalidateProposal({ context: context(), proposal }),
      () => containerProposals.applyProposal({ context: context(), proposal }),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(members.getActiveMembership).not.toHaveBeenCalled();
    expect(containers.getContainerCreationContext).not.toHaveBeenCalled();
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it.each([{ role: 'member' }, { is_active: false }, { user_id: OTHER_ID }])('checks fresh admin membership before exposing creation context: %j', async (changes) => {
    members.getActiveMembership.mockResolvedValue(adminMember(changes));
    await expect(containerProposals.selectContainerCreationContext({ context: adminContext() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(containers.getContainerCreationContext).not.toHaveBeenCalled();
  });

  it.each([{ workspace_id: OTHER_ID }, { actor_member_id: OTHER_ID }])('rejects a creation context belonging to another actor or workspace: %j', async (changes) => {
    containers.getContainerCreationContext.mockResolvedValue(creationContext(changes));
    await expect(containerProposals.selectContainerCreationContext({ context: adminContext() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it('creates a complete absent-to-active card bound to the server proposal UUID without inserting', async () => {
    const proposal = await create();
    expect(proposal).toEqual({
      id: expect.any(String), tool: 'create_container', tier: 3, summary: expect.any(String),
      parameters: creationData(), before: { ...creationContext(), container: null },
      after: creationAfter({ container_id: proposal.id }), expires_at: expect.any(String),
    });
    expect(proposal.after).toMatchObject({
      container_type: 'event', status: 'active', budget_target: null, budget_currency: null,
      recurrence_cadence: null, recurrence_days: null, recurrence_start: null, recurrence_end: null,
      carry_forward_unpaid: false, auto_generate_cycles: true, public_token: null, public_show_names: true,
      cover_photos: [], outcome_files: [], created_by: adminContext().member.id,
      created_at: 'on_approval', updated_at: 'on_approval',
    });
    expect(containers.createContainer).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: AUDIT_ACTIONS.AGENT_ACTION_PROPOSED, targetType: 'container', targetId: proposal.id,
      metadata: expect.objectContaining({ tier: 3, before: proposal.before, after: proposal.after }),
    }));
  });

  it('normalizes explicitly requested text and exposes every default before approval', async () => {
    const proposal = await create({ name: '  Family picnic  ', subtitle: '   ', description: ' Plans ', event_type: '   ' });
    expect(proposal.parameters).toEqual({
      name: 'Family picnic', subtitle: null, description: 'Plans', container_type: 'event',
      enable_money: false, enable_tasks: false, event_date: null, event_type: null, event_type_category: 'other',
    });
    expect(proposal.after).toMatchObject({ ...proposal.parameters, container_id: proposal.id });
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it('accepts maximum native ASCII metadata when the eventual executed record fits', async () => {
    const args = creationArguments({ name: 'N'.repeat(100), subtitle: 'S'.repeat(200), description: 'D'.repeat(2000), event_type: 'T'.repeat(80) });
    const proposal = await create(args);
    await expect(decide(proposal)).resolves.toMatchObject({ status: 'executed', result: resultFor(proposal) });
    const key = (await redis.keys('kith:agent-proposal:*')).find((candidate) => candidate.endsWith(proposal.id));
    expect(Buffer.byteLength(await redis.get(key), 'utf8')).toBeLessThanOrEqual(PROPOSAL_LIMITS.recordBytes);
    expect(containers.createContainer).toHaveBeenCalledTimes(1);
  });

  it('rejects multibyte metadata that would overflow an executed record before persistence, audit or insertion', async () => {
    await expect(create(creationArguments({ description: '界'.repeat(2000) }))).rejects.toBeInstanceOf(AppError);
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
    expect(audit.log).not.toHaveBeenCalled();
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it.each([
    ['missing name', {}], ['short name', { name: 'a' }], ['blank name', { name: '  ' }],
    ['long name', { name: 'N'.repeat(101) }], ['long subtitle', { name: 'Picnic', subtitle: 'S'.repeat(201) }],
    ['long description', { name: 'Picnic', description: 'D'.repeat(2001) }],
    ['invalid date', { name: 'Picnic', event_date: '2026-02-30' }], ['non-ISO date', { name: 'Picnic', event_date: 'tomorrow' }],
    ['money coercion', { name: 'Picnic', enable_money: 'true' }], ['task coercion', { name: 'Picnic', enable_tasks: 1 }],
    ['ID', { name: 'Picnic', id: OTHER_ID }], ['container ID', { name: 'Picnic', container_id: OTHER_ID }],
    ['workspace', { name: 'Picnic', workspace_id: OTHER_ID }], ['creator', { name: 'Picnic', created_by: OTHER_ID }],
    ['status', { name: 'Picnic', status: 'active' }], ['type', { name: 'Picnic', container_type: 'event' }],
    ['budget', { name: 'Picnic', budget_target: 100 }], ['currency', { name: 'Picnic', budget_currency: 'NGN' }],
    ['recurrence', { name: 'Picnic', recurrence_cadence: 'monthly' }], ['carry', { name: 'Picnic', carry_forward_unpaid: true }],
    ['participants', { name: 'Picnic', member_ids: [OTHER_ID] }], ['assets', { name: 'Picnic', cover_photos: [] }],
    ['public link', { name: 'Picnic', public_token: 'token' }], ['role', { name: 'Picnic', isAdmin: true }],
  ])('rejects invalid or model-controlled %s before draft persistence', async (_label, args) => {
    await expect(create(args)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(containers.getContainerCreationContext).not.toHaveBeenCalled();
    expect(containers.createContainer).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('cannot create a container through the read-tool dispatcher', async () => {
    await expect(executeReadTool({ name: 'create_container', args: creationArguments(), context: adminContext() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it('creates once through separate approval and returns the exact state with stored timestamps', async () => {
    const proposal = await create();
    const actor = adminContext();
    const actorCtx = { workspaceId: OTHER_ID, actorUserId: OTHER_ID, actorMemberId: OTHER_ID, ipAddress: '127.0.0.1', userAgent: 'creation-unit-test' };
    const first = await decide(proposal, { actorCtx });
    expect(await decide(proposal)).toEqual(first);
    expect(first).toEqual({ proposal_id: proposal.id, status: 'executed', result: resultFor(proposal) });
    expect(containers.createContainer).toHaveBeenCalledTimes(1);
    expect(containers.createContainer).toHaveBeenCalledWith({
      workspaceId: actor.workspace.id, data: creationData(), actorMemberId: actor.member.id,
      actorCtx: { workspaceId: actor.workspace.id, actorUserId: actor.userId, actorMemberId: actor.member.id, ipAddress: '127.0.0.1', userAgent: 'creation-unit-test' },
      reviewedCreation: { userId: actor.userId, isAdmin: true, expected: creationContext(), containerId: proposal.id },
    });
    expect(audit.log.mock.calls.map(([entry]) => [entry.action, entry.targetType, entry.targetId])).toEqual([
      [AUDIT_ACTIONS.AGENT_ACTION_PROPOSED, 'container', proposal.id],
      [AUDIT_ACTIONS.AGENT_ACTION_APPROVED, 'container', proposal.id],
      [AUDIT_ACTIONS.AGENT_ACTION_EXECUTED, 'container', proposal.id],
    ]);
    expect(await status(proposal)).toEqual({
      proposal_id: proposal.id, tool: 'create_container', container_id: proposal.id, status: 'executed',
      expires_at: proposal.expires_at, checked_at: expect.any(String), result: first.result,
    });
    expect((await receipts(proposal))[0]).toMatchObject({ status: 'executed', result: first.result });
  });

  it('treats separately approved cards with identical names as distinct creations', async () => {
    const first = await create();
    const second = await create();
    expect(first.id).not.toBe(second.id);
    await decide(first);
    await decide(second);
    expect(containers.createContainer).toHaveBeenCalledTimes(2);
    expect(containers.createContainer.mock.calls.map(([options]) => options.reviewedCreation.containerId)).toEqual([first.id, second.id]);
  });

  it('rejects altered approval data without changing the stored pending card', async () => {
    const proposal = await create();
    await expect(decide(proposal, { data: { name: 'Different container' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await status(proposal)).status).toBe('pending');
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it.each([{ workspace_name: 'Renamed workspace' }, { workspace_updated_at: '2026-11-14T12:01:00.000Z' }])('invalidates changed workspace review context before creating: %j', async (changes) => {
    const proposal = await create();
    containers.getContainerCreationContext.mockResolvedValueOnce(creationContext(changes));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect((await status(proposal)).status).toBe('failed');
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it.each([() => new ForbiddenError('Membership changed'), () => new NotFoundError('Workspace deleted')])('invalidates unavailable creation eligibility before mutation', async (error) => {
    const proposal = await create();
    containers.getContainerCreationContext.mockRejectedValueOnce(error());
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect((await status(proposal)).status).toBe('failed');
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it('can retry a pre-execution context outage without creating early', async () => {
    const proposal = await create();
    containers.getContainerCreationContext.mockRejectedValueOnce(new AppError('Unavailable', 503, 'CONTAINERS_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'CONTAINERS_UNAVAILABLE' });
    expect((await status(proposal)).status).toBe('approval_pending');
    expect(containers.createContainer).not.toHaveBeenCalled();
    await expect(decide(proposal)).resolves.toMatchObject({ status: 'executed' });
    expect(containers.createContainer).toHaveBeenCalledTimes(1);
  });

  it('makes a proven pre-insert conflict final without retrying the writer', async () => {
    const proposal = await create();
    containers.createContainer.mockRejectedValueOnce(new ConflictError('Workspace changed before INSERT'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect((await status(proposal)).status).toBe('failed');
    expect(containers.createContainer).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: OTHER_ID }, { workspace_id: OTHER_ID }, { name: 'Wrong name' }, { created_by: OTHER_ID },
    { container_type: 'recurring' }, { status: 'archived' }, { enable_money: false }, { enable_tasks: false },
    { event_date: '2026-12-02' }, { event_type_category: 'financial' }, { subtitle: 'Wrong subtitle' },
    { description: 'Wrong description' }, { recurrence_cadence: 'monthly' }, { budget_target: 10 },
    { public_token: 'PRIVATE_TOKEN' }, { public_show_names: false }, { cover_photos: [{ path: 'PRIVATE_ASSET' }] },
    { outcome_files: [{ path: 'PRIVATE_OUTCOME' }] }, { deleted_at: '2026-11-14T12:02:00.000Z' },
    { created_at: null }, { updated_at: 'on_approval' },
  ])('retains uncertainty for an unverified inserted result instead of exposing or repeating it: %j', async (changes) => {
    const proposal = await create();
    containers.createContainer.mockImplementationOnce(async (options) => serviceResult(options, changes));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    const receipt = await status(proposal);
    expect(receipt.status).toBe('indeterminate');
    expect(receipt).not.toHaveProperty('result');
    expect(containers.createContainer).toHaveBeenCalledTimes(1);
  });

  it('retains an irreversible execution claim after insert, result, or native audit uncertainty', async () => {
    const proposal = await create();
    containers.createContainer.mockRejectedValueOnce(new AppError('Unknown creation outcome', 503, 'CONTAINER_CREATION_INDETERMINATE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect((await status(proposal)).status).toBe('indeterminate');
    expect(containers.createContainer).toHaveBeenCalledTimes(1);
  });

  it('finishes a pending execution audit from the saved result without creating again', async () => {
    const proposal = await create();
    audit.log.mockImplementation(async (entry) => {
      if (entry.action === AUDIT_ACTIONS.AGENT_ACTION_EXECUTED) throw new AppError('Audit unavailable', 503, 'AUDIT_UNAVAILABLE');
    });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect((await status(proposal)).status).toBe('audit_pending');
    audit.log.mockResolvedValue();
    await expect(decide(proposal)).resolves.toMatchObject({ status: 'executed', result: resultFor(proposal) });
    expect(containers.createContainer).toHaveBeenCalledTimes(1);
  });

  it('keeps a known container audit target and prevents re-execution when result persistence is uncertain', async () => {
    const proposal = await create();
    const evaluate = redis.eval.bind(redis);
    jest.spyOn(redis, 'eval').mockImplementation((...args) => {
      if (JSON.parse(args[4]).state === 'applied') return Promise.reject(new Error('Lost result-save response'));
      return evaluate(...args);
    });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect((await status(proposal)).status).toBe('indeterminate');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: AUDIT_ACTIONS.AGENT_ACTION_EXECUTED, targetType: 'container', targetId: proposal.id,
      metadata: expect.objectContaining({ execution_outcome: 'applied' }),
    }));
    expect(containers.createContainer).toHaveBeenCalledTimes(1);
  });

  it('permits only one in-flight creation under concurrent approvals', async () => {
    const proposal = await create();
    let started;
    let release;
    let options;
    const enteredService = new Promise((resolve) => { started = resolve; });
    containers.createContainer.mockImplementationOnce((input) => {
      options = input;
      started();
      return new Promise((resolve) => { release = resolve; });
    });
    const first = decide(proposal);
    await enteredService;
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    release(serviceResult(options));
    await expect(first).resolves.toMatchObject({ status: 'executed' });
    expect(containers.createContainer).toHaveBeenCalledTimes(1);
  });

  it.each([{ container_id: OTHER_ID }, { name: 'Changed after approval' }, { created_by: OTHER_ID }, { created_at: 'on_approval' }])('rejects a saved result that differs from the approved creation: %j', async (changes) => {
    const proposal = await create();
    await decide(proposal);
    await replaceRecord(proposal, { state: 'executed', result: resultFor(proposal, changes) });
    jest.clearAllMocks();
    await expect(status(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
    expect(await receipts(proposal)).toEqual([{ proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String) }]);
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
    expect(containers.createContainer).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each(['user', 'member', 'workspace', 'role'])('does not expose or execute a creation record across %s scope', async (scope) => {
    const proposal = await create();
    const actor = adminContext();
    if (scope === 'user') actor.userId = OTHER_ID;
    if (scope === 'member') actor.member.id = OTHER_ID;
    if (scope === 'workspace') { actor.workspace.id = OTHER_ID; actor.member.workspaceId = OTHER_ID; }
    if (scope === 'role') actor.member.role = 'member';
    members.getActiveMembership.mockResolvedValue(adminMember({ id: actor.member.id, workspace_id: actor.workspace.id, user_id: actor.userId, role: actor.member.role }));
    await expect(status(proposal, { context: actor })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
    await expect(decide(proposal, { context: actor })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
    expect(await receipts(proposal, { context: actor })).toEqual([{ proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String) }]);
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it.each([
    (proposal) => ({ ...proposal, tier: 2 }),
    (proposal) => ({ ...proposal, parameters: { ...proposal.parameters, name: 'Another container' } }),
    (proposal) => ({ ...proposal, before: { ...proposal.before, container: { id: OTHER_ID } } }),
    (proposal) => ({ ...proposal, after: { ...proposal.after, container_id: OTHER_ID } }),
    (proposal) => ({ ...proposal, after: { ...proposal.after, workspace_id: OTHER_ID } }),
    (proposal) => ({ ...proposal, after: { ...proposal.after, created_by: OTHER_ID } }),
    (proposal) => ({ ...proposal, after: { ...proposal.after, created_at: '2026-11-14T12:02:00.000Z' } }),
  ])('rejects a card with a mismatched requested payload, new identity, actor, tier or timestamp policy', async (change) => {
    const proposal = await create();
    expect(proposalSchema.safeParse(change(proposal)).success).toBe(false);
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it('expires unapproved cards without creating a container', async () => {
    const proposal = await create();
    await replaceRecord(proposal, { proposal: { ...proposal, expires_at: '2020-01-01T00:00:00.000Z' } });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_EXPIRED' });
    expect((await status(proposal)).status).toBe('expired');
    expect(containers.createContainer).not.toHaveBeenCalled();
  });

  it('rejects a creation card without inserting and prevents later approval', async () => {
    const proposal = await create();
    await expect(decide(proposal, { decision: 'reject' })).resolves.toMatchObject({ status: 'rejected' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_DECIDED' });
    expect(containers.createContainer).not.toHaveBeenCalled();
  });
});
