jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/container.service', () => ({ getContainerArchiveContext: jest.fn(), archiveReviewedContainer: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { ConflictError, NotFoundError, BusinessRuleError, ForbiddenError } = require('../../../src/utils/errors');
const members = require('../../../src/services/member.service');
const containers = require('../../../src/services/container.service');
const audit = require('../../../src/services/audit.service');
const domain = require('../../../src/agent/services/container-archive-proposal.service');
const { createProposal, decideProposal, getProposalStatus } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { serializeToolDefinitions } = require('../../../src/agent/providers/tool-definitions');
const { proposalSchema, proposalStatusSchema } = require('../../../src/agent/validators/proposal.validator');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');
const { SESSION_ID } = require('../../helpers/agent-dispute-raise');

const CONTAINER_ID = '33333333-3333-4333-8333-333333333333';
const UPDATED_AT = '2026-11-26T10:00:00.123456+00:00';
const asAdmin = (base = context()) => ({ ...base, member: { ...base.member, role: 'admin' } });
const actor = asAdmin();
const selection = (changes = {}) => ({ workspace_id: actor.workspace.id, actor_member_id: actor.member.id, member_role: 'admin',
  container: { container_id: CONTAINER_ID, name: 'Wedding', container_type: 'event', status: 'active', enable_money: true,
    enable_tasks: false, updated_at: UPDATED_AT, ...changes.container },
  ...Object.fromEntries(Object.entries(changes).filter(([key]) => key !== 'container')) });
const archived = (changes = {}) => ({ container_id: CONTAINER_ID, status: 'archived', updated_at: '2026-11-26T11:00:00.000000+00:00', ...changes });

let redis;
const create = (overrides = {}) => createProposal({ context: actor, tool: 'archive_container', selection: selection(),
  args: {}, turnId: SESSION_ID, redisFactory: () => redis, ...overrides });
const approve = (proposal) => decideProposal({ context: actor, proposalId: proposal.id, data: {}, decision: 'approve', redisFactory: () => redis });

beforeEach(() => {
  redis = new Redis();
  members.getActiveMembership.mockReset().mockResolvedValue({ ...member(), role: 'admin' });
  containers.getContainerArchiveContext.mockReset().mockResolvedValue(selection());
  containers.archiveReviewedContainer.mockReset().mockResolvedValue(archived());
  audit.log.mockReset().mockResolvedValue();
});
afterEach(async () => { await redis.flushall(); await redis.quit(); });

it('registers an admin Tier 3 proposal with no arguments and no immediate executor', async () => {
  expect(domain.archiveContainerDefinition).toMatchObject({ name: 'archive_container', tier: 3, minRole: 'admin' });
  const { name, description, parameterSchema } = domain.archiveContainerDefinition;
  const [tool] = serializeToolDefinitions([{ name, description, parameterSchema }]);
  expect(tool.function.parameters.properties).toEqual({});
  expect(tool.function.parameters).toMatchObject({ additionalProperties: false });
  await expect(executeReadTool({ name: 'archive_container', args: {}, context: actor })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(containers.archiveReviewedContainer).not.toHaveBeenCalled();
});

it('selects a container as the authenticated admin and returns a frozen snapshot', async () => {
  const selected = await domain.selectContainerArchive({ context: actor, containerId: CONTAINER_ID.toUpperCase() });
  expect(containers.getContainerArchiveContext).toHaveBeenCalledWith({ workspaceId: actor.workspace.id,
    containerId: CONTAINER_ID, callerId: actor.member.id, userId: actor.userId });
  expect(selected).toEqual(selection());
  expect(Object.isFrozen(selected) && Object.isFrozen(selected.container)).toBe(true);
});

it('refuses members and invalid contexts before reading anything', async () => {
  await expect(domain.selectContainerArchive({ context: context(), containerId: CONTAINER_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(domain.selectContainerArchive({ context: null, containerId: CONTAINER_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(containers.getContainerArchiveContext).not.toHaveBeenCalled();
});

it('creates the exact Tier 3 card binding the reviewed container version', async () => {
  const proposal = await create();
  expect(proposalSchema.parse(proposal)).toEqual(proposal);
  expect(proposal).toMatchObject({ tool: 'archive_container', tier: 3, summary: 'Archive the selected container.',
    parameters: { container_id: CONTAINER_ID }, before: selection(), after: { container_id: CONTAINER_ID, status: 'archived' } });
  expect(containers.archiveReviewedContainer).not.toHaveBeenCalled();
});

it.each([{ container_id: CONTAINER_ID }, { note: 'x' }])('rejects arguments %j before any proposal', async (args) => {
  await expect(create({ args })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await redis.keys('*')).toEqual([]);
});

it.each([
  [{ actor_member_id: OTHER_ID }], [{ workspace_id: OTHER_ID }], [{ member_role: 'member' }],
  [{ container: { status: 'archived' } }], [{ container: { updated_at: 'not-a-time' } }],
])('refuses a selection that is not the authenticated admin or an archivable container %j', async (changes) => {
  await expect(create({ selection: selection(changes) })).rejects.toBeDefined();
  expect(await redis.keys('*')).toEqual([]);
});

it('executes after approval with the exact reviewed version and returns a receipt', async () => {
  const proposal = await create();
  const reply = await approve(proposal);
  expect(containers.archiveReviewedContainer).toHaveBeenCalledTimes(1);
  expect(containers.archiveReviewedContainer).toHaveBeenCalledWith({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
    expected: proposal.before, proposalId: proposal.id,
    actorCtx: { workspaceId: actor.workspace.id, actorUserId: actor.userId, actorMemberId: actor.member.id, ipAddress: null, userAgent: null } });
  expect(reply).toMatchObject({ status: 'executed', result: archived() });
  const receipt = await getProposalStatus({ context: actor, proposalId: proposal.id, redisFactory: () => redis });
  expect(proposalStatusSchema.parse(receipt)).toMatchObject({ proposal_id: proposal.id, status: 'executed',
    tool: 'archive_container', container_id: CONTAINER_ID, result: archived() });
  expect(audit.log.mock.calls.every(([entry]) => entry.targetId === CONTAINER_ID && entry.targetType === 'container')).toBe(true);
});

it.each([
  ['not found', new NotFoundError('Container not found')], ['no longer archivable', new BusinessRuleError('Only active or completed containers can be archived')],
  ['no longer permitted', new ForbiddenError('Only an active workspace admin can archive containers')],
])('treats a container that is %s at approval as stale and writes nothing', async (_label, error) => {
  const proposal = await create();
  containers.getContainerArchiveContext.mockRejectedValue(error);
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect(containers.archiveReviewedContainer).not.toHaveBeenCalled();
});

it.each([
  ['renamed', { container: { name: 'Renamed' } }], ['touched', { container: { updated_at: '2026-11-26T10:30:00.000000+00:00' } }],
  ['completed', { container: { status: 'completed' } }],
])('treats a container that was %s after review as stale', async (_label, changes) => {
  const proposal = await create();
  containers.getContainerArchiveContext.mockResolvedValue(selection(changes));
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect(containers.archiveReviewedContainer).not.toHaveBeenCalled();
});

it('maps the compare-and-set conflict to stale and never retries it', async () => {
  const proposal = await create();
  containers.archiveReviewedContainer.mockRejectedValue(new ConflictError('The container changed and can no longer be archived'));
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE', statusCode: 409 });
  await expect(approve(proposal)).rejects.toBeDefined();
  expect(containers.archiveReviewedContainer).toHaveBeenCalledTimes(1);
});

it.each([
  ['an unexpected failure', () => { containers.archiveReviewedContainer.mockRejectedValue(new Error('PRIVATE')); }],
  ['a different container', () => { containers.archiveReviewedContainer.mockResolvedValue(archived({ container_id: OTHER_ID })); }],
  ['a wrong status', () => { containers.archiveReviewedContainer.mockResolvedValue(archived({ status: 'active' })); }],
  ['a malformed result', () => { containers.archiveReviewedContainer.mockResolvedValue({ container_id: CONTAINER_ID }); }],
])('keeps %s uncertain and blocks a second mutation', async (_label, script) => {
  const proposal = await create();
  script();
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  await expect(approve(proposal)).rejects.toBeDefined();
  expect(containers.archiveReviewedContainer).toHaveBeenCalledTimes(1);
});
