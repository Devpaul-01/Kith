jest.mock('../../../src/services/search.service', () => ({
  findMembers: jest.fn(),
  findContainers: jest.fn(),
}));
jest.mock('../../../src/services/dashboard.service', () => ({
  getDashboardData: jest.fn(),
  getOverdueSummaryData: jest.fn(),
}));

const searchService = require('../../../src/services/search.service');
const { findMember, findContainer } = require('../../../src/agent/services/resolution-tools.service');
const { getAvailableTools, executeReadTool } = require('../../../src/agent/services/tool-registry.service');
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
