jest.mock('../../../src/services/search.service', () => ({
  findMembers: jest.fn(),
  findContainers: jest.fn(),
  findTasks: jest.fn(),
  findLedgerEntries: jest.fn(),
  findDisputes: jest.fn(),
  findGroups: jest.fn(),
}));
jest.mock('../../../src/services/dashboard.service', () => ({
  getDashboardData: jest.fn(),
  getOverdueSummaryData: jest.fn(),
}));

const searchService = require('../../../src/services/search.service');
const { findMember, findContainer, findTasks, findLedgerEntries, findDisputes, findGroup } = require('../../../src/agent/services/resolution-tools.service');
const { getAvailableTools, executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { serializeToolDefinitions } = require('../../../src/agent/providers/tool-definitions');
const { ForbiddenError, ValidationError, AppError } = require('../../../src/utils/errors');

function makeContext(role = 'member') {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    member: {
      id: '22222222-2222-4222-8222-222222222222', role, displayName: 'Adaeze',
      isProxy: false, isActive: true, workspaceId: '33333333-3333-4333-8333-333333333333',
    },
    workspace: { id: '33333333-3333-4333-8333-333333333333', name: 'Family', baseCurrency: 'NGN' },
  };
}

describe.each([
  ['find_member', findMember, searchService.findMembers],
  ['find_container', findContainer, searchService.findContainers],
])('%s resolution tool', (name, handler, service) => {
  beforeEach(() => service.mockReset());

  it.each(['member', 'admin'])('is a Tier 0 tool available to an authenticated %s', async (role) => {
    const context = makeContext(role);
    expect(getAvailableTools(context).find((tool) => tool.name === name)).toMatchObject({ tier: 0, minRole: 'member' });
    service.mockResolvedValue({ query: 'Adaeze', status: 'not_found', candidates: [], has_more: false });
    await executeReadTool({ name, args: { query: '  Adaeze  ' }, context });
    expect(service).toHaveBeenCalledWith({ workspaceId: context.workspace.id, query: 'Adaeze', limit: 10 });
  });

  it.each(['not_found', 'single_match', 'ambiguous'])('preserves the %s result without choosing a candidate', async (status) => {
    const candidates = status === 'not_found' ? [] : [{ id: 'candidate-a', score: 0.5 }];
    if (status === 'ambiguous') candidates.push({ id: 'candidate-b', score: 0.4 });
    const payload = { query: 'Adaze', status, candidates, has_more: false };
    service.mockResolvedValue(payload);
    const result = await executeReadTool({ name, args: { query: 'Adaze' }, context: makeContext() });
    expect(result).toBe(payload);
    expect(result).not.toHaveProperty('resolved_id');
  });

  it.each([
    null,
    { ...makeContext(), member: { ...makeContext().member, role: 'owner' } },
    { ...makeContext(), member: { ...makeContext().member, isActive: false } },
    { ...makeContext(), workspace: { id: 'another-workspace' } },
  ])('denies an invalid context even when calling the handler directly', async (context) => {
    await expect(handler({ args: { query: 'Adaeze' }, context })).rejects.toBeInstanceOf(ForbiddenError);
    expect(service).not.toHaveBeenCalled();
  });

  it.each([
    { workspace_id: 'another-workspace' }, { workspaceId: 'another-workspace' },
    { isAdmin: true }, { role: 'admin' }, { query: '' }, { query: 'a' }, { query: 'a'.repeat(201) },
    { limit: 1 }, { limit: 21 }, { limit: '10' },
  ])('rejects malformed or forged arguments: %j', async (override) => {
    await expect(executeReadTool({ name, args: { query: 'Adaeze', ...override }, context: makeContext() }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(service).not.toHaveBeenCalled();
  });

  it('always supplies the server workspace even if a direct caller includes a different one', async () => {
    const context = makeContext();
    await handler({ args: { query: 'Adaeze', workspaceId: 'another-workspace', limit: 2 }, context });
    expect(service).toHaveBeenCalledWith({ workspaceId: context.workspace.id, query: 'Adaeze', limit: 2 });
  });

  it('preserves service errors rather than inventing an empty candidate list', async () => {
    const error = new AppError('Search unavailable', 503, 'SEARCH_UNAVAILABLE');
    service.mockRejectedValue(error);
    await expect(executeReadTool({ name, args: { query: 'Adaeze' }, context: makeContext() })).rejects.toBe(error);
  });
});

describe.each([
  ['find_tasks', findTasks, searchService.findTasks, true, true],
  ['find_ledger_entries', findLedgerEntries, searchService.findLedgerEntries, true, true],
  ['find_disputes', findDisputes, searchService.findDisputes, true, false],
  ['find_group', findGroup, searchService.findGroups, false, false],
])('%s resolution tool', (name, handler, service, privateRead, containerFilter) => {
  const containerId = '44444444-4444-4444-8444-444444444444';
  beforeEach(() => service.mockReset());

  it.each(['member', 'admin'])('checks %s membership and forwards only authenticated scope', async (role) => {
    const context = makeContext(role);
    const args = { query: '  Shopping  ', limit: 2, ...(containerFilter ? { container_id: containerId } : {}) };
    const payload = { query: 'Shopping', status: 'not_found', candidates: [], has_more: false };
    service.mockResolvedValue(payload);
    expect(getAvailableTools(context).find((tool) => tool.name === name)).toMatchObject({ tier: 0, minRole: 'member' });
    await expect(executeReadTool({ name, args, context })).resolves.toBe(payload);
    expect(service).toHaveBeenCalledWith({
      workspaceId: context.workspace.id, query: 'Shopping', limit: 2,
      ...(privateRead ? { callerId: context.member.id, isAdmin: role === 'admin' } : {}),
      ...(containerFilter ? { containerId } : {}),
    });
  });

  it('validates direct calls and supplies the default limit without choosing a container', async () => {
    const context = makeContext();
    await handler({ args: { query: '  Shopping  ' }, context });
    expect(service).toHaveBeenCalledWith({
      workspaceId: context.workspace.id, query: 'Shopping', limit: 10,
      ...(privateRead ? { callerId: context.member.id, isAdmin: false } : {}),
      ...(containerFilter ? { containerId: undefined } : {}),
    });
  });

  it.each(['not_found', 'single_match', 'ambiguous'])('preserves %s candidates, scores and continuation without resolving an ID', async (status) => {
    const candidates = status === 'not_found' ? [] : [{ id: 'candidate-a', match_type: 'exact', score: 1 }];
    if (status === 'ambiguous') candidates.push({ id: 'candidate-b', match_type: 'fuzzy', score: 0.4 });
    const payload = { query: 'Shopping', status, candidates, has_more: status === 'ambiguous' };
    service.mockResolvedValue(payload);
    const result = await executeReadTool({ name, args: { query: 'Shopping' }, context: makeContext() });
    expect(result).toBe(payload);
    expect(result).not.toHaveProperty('resolved_id');
  });

  it.each([
    null, makeContext('owner'), { ...makeContext(), userId: null },
    { ...makeContext(), member: { ...makeContext().member, id: '' } },
    { ...makeContext(), member: { ...makeContext().member, isActive: false } },
    { ...makeContext(), workspace: { id: 'another-workspace' } },
  ])('denies invalid membership at the registry and direct handler: %j', async (context) => {
    await expect(executeReadTool({ name, args: { query: 'Shopping' }, context })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(handler({ args: { query: 'Shopping' }, context })).rejects.toBeInstanceOf(ForbiddenError);
    expect(service).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { query: '' }, { query: 'a' }, { query: 'a'.repeat(201) },
    { query: 5000 }, { limit: 1 }, { limit: 21 }, { limit: '10' },
    { workspace_id: containerId }, { workspaceId: containerId },
    { callerId: containerId }, { caller_id: containerId }, { member_id: containerId },
    { isAdmin: true }, { is_admin: true }, { role: 'admin' }, { approved: true },
    { containerId }, { p_pattern: '%' }, { assigned_to: containerId }, { contributor_id: containerId },
  ])('rejects malformed or forged arguments before any service call: %j', async (input) => {
    const args = input && !Array.isArray(input) && Object.keys(input).length ? { query: 'Shopping', ...input } : input;
    await expect(executeReadTool({ name, args, context: makeContext() })).rejects.toBeInstanceOf(ValidationError);
    await expect(handler({ args, context: makeContext() })).rejects.toBeInstanceOf(ValidationError);
    expect(service).not.toHaveBeenCalled();
  });

  it('rejects invalid or unsupported container filters', async () => {
    const args = { query: 'Shopping', container_id: containerFilter ? 'Rent' : containerId };
    await expect(handler({ args, context: makeContext() })).rejects.toBeInstanceOf(ValidationError);
    expect(service).not.toHaveBeenCalled();
  });

  it('preserves a search failure rather than inventing a no-match result', async () => {
    const error = new AppError('Search unavailable', 503, 'SEARCH_UNAVAILABLE');
    service.mockRejectedValue(error);
    await expect(executeReadTool({ name, args: { query: 'Shopping' }, context: makeContext() })).rejects.toBe(error);
  });

  it('offers strict model arguments without caller identity or approval controls', () => {
    const definition = getAvailableTools(makeContext()).find((tool) => tool.name === name);
    const { function: wire } = serializeToolDefinitions([definition]
      .map(({ name: toolName, description, parameterSchema }) => ({ name: toolName, description, parameterSchema })))[0];
    expect(wire.parameters).toEqual({
      type: 'object', properties: {
        query: { type: 'string', minLength: 2, maxLength: 200 },
        limit: { type: 'integer', minimum: 2, maximum: 20, default: 10 },
        ...(containerFilter ? { container_id: { type: 'string', format: 'uuid' } } : {}),
      }, required: ['query'], additionalProperties: false,
    });
  });
});
