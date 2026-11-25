jest.mock('../../../src/services/container.service', () => ({ getContainer: jest.fn() }));
jest.mock('../../../src/services/dashboard.service', () => ({ getDashboardData: jest.fn(), getOverdueSummaryData: jest.fn() }));

const containers = require('../../../src/services/container.service');
const { getViewedContainerContext } = require('../../../src/agent/services/read-tools.service');
const { chatInputSchema } = require('../../../src/agent/validators/read-turn.validator');
const { runReadTurnWithHistory } = require('../../../src/agent/services/read-loop.service');
const { NotFoundError } = require('../../../src/utils/errors');

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '99999999-9999-4999-8999-999999999999';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const CONTAINER_ID = '33333333-3333-4333-8333-333333333333';
const context = () => ({
  userId: '66666666-6666-4666-8666-666666666666',
  member: { id: MEMBER_ID, workspaceId: WORKSPACE_ID, isActive: true, role: 'member', displayName: 'Ada', isProxy: false },
  workspace: { id: WORKSPACE_ID, name: 'Family', baseCurrency: 'NGN' },
});
const row = (overrides = {}) => ({
  id: CONTAINER_ID, name: 'Wedding', container_type: 'event', status: 'active',
  enable_money: true, enable_tasks: false, description: 'private-ish detail', budget_target: '500000.00', ...overrides,
});
const viewed = (overrides = {}) => ({
  workspace_id: WORKSPACE_ID, container_id: CONTAINER_ID, name: 'Wedding', container_type: 'event',
  status: 'active', enable_money: true, enable_tasks: false, ...overrides,
});

beforeEach(() => jest.resetAllMocks());

describe('chat input', () => {
  it('accepts and lowercases a viewed container UUID, and rejects anything else', () => {
    const parsed = chatInputSchema.parse({ message: 'Hi', viewed_container_id: CONTAINER_ID.toUpperCase() });
    expect(parsed.viewed_container_id).toBe(CONTAINER_ID);
    expect(chatInputSchema.safeParse({ message: 'Hi', viewed_container_id: 'Wedding' }).success).toBe(false);
    expect(chatInputSchema.safeParse({ message: 'Hi', viewed_container_id: null }).success).toBe(false);
    expect(chatInputSchema.safeParse({ message: 'Hi', viewed_containers: [CONTAINER_ID] }).success).toBe(false);
  });
});

describe('getViewedContainerContext', () => {
  it('reads metadata through the container service and returns only whitelisted display fields', async () => {
    containers.getContainer.mockResolvedValue({ container: row() });
    const result = await getViewedContainerContext({ context: context(), containerId: CONTAINER_ID });
    expect(containers.getContainer).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, callerMemberId: MEMBER_ID, metadataOnly: true,
    });
    expect(result).toEqual(viewed());
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('accepts every status the database allows, including cancelled', async () => {
    containers.getContainer.mockResolvedValue({ container: row({ status: 'cancelled' }) });
    await expect(getViewedContainerContext({ context: context(), containerId: CONTAINER_ID }))
      .resolves.toMatchObject({ status: 'cancelled' });
  });

  it('propagates not-found for a missing, deleted or other-workspace container', async () => {
    containers.getContainer.mockRejectedValue(new NotFoundError('Container not found'));
    await expect(getViewedContainerContext({ context: context(), containerId: CONTAINER_ID }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ['malformed', { id: 'not-a-uuid' }],
    ['a different record than requested', { id: OTHER_WORKSPACE_ID }],
    ['a deleted record', { deleted_at: '2026-01-01T00:00:00Z' }],
    ['another workspace', { workspace_id: OTHER_WORKSPACE_ID }],
  ])('fails closed on %s service data', async (_label, overrides) => {
    containers.getContainer.mockResolvedValue({ container: row(overrides) });
    await expect(getViewedContainerContext({ context: context(), containerId: CONTAINER_ID }))
      .rejects.toMatchObject({ statusCode: 503, code: 'AGENT_CONTEXT_UNAVAILABLE' });
  });

  it('rejects a non-UUID id before calling the service', async () => {
    await expect(getViewedContainerContext({ context: context(), containerId: 'Wedding' })).rejects.toHaveProperty('code', 'VALIDATION_FAILED');
    expect(containers.getContainer).not.toHaveBeenCalled();
  });
});

describe('read loop', () => {
  const model = (...replies) => { const chat = jest.fn(); replies.forEach((r) => chat.mockResolvedValueOnce(r)); return { chat }; };
  const run = (provider, options = {}) => runReadTurnWithHistory({
    data: { message: 'What is this event?' }, context: context(), provider, ...options,
  });
  const bootstrapResult = (provider) => {
    const message = provider.chat.mock.calls[0][0].messages.find((m) => m.role === 'tool');
    return JSON.parse(message.content).data;
  };

  it('adds viewed_container only to the initial context result and tells the model it is not a target', async () => {
    const provider = model({ text: 'It is a wedding.' });
    await run(provider, { viewedContainer: viewed() });
    expect(bootstrapResult(provider)).toMatchObject({ member_id: MEMBER_ID, viewed_container: viewed() });
    const { messages, tools } = provider.chat.mock.calls[0][0];
    expect(messages[0].content).toMatch(/viewed_container[\s\S]*never selects a write target/);
    // A viewed container offers no extra capability to the model.
    expect(tools.map((tool) => tool.name)).not.toContain('create_ledger_entry');
  });

  it('omits the field when nothing is viewed', async () => {
    const provider = model({ text: 'Hello.' });
    await run(provider);
    expect(bootstrapResult(provider)).not.toHaveProperty('viewed_container');
  });

  it('rejects invalid or cross-workspace viewed context', async () => {
    await expect(run(model({ text: 'x' }), { viewedContainer: viewed({ workspace_id: OTHER_WORKSPACE_ID }) }))
      .rejects.toHaveProperty('code', 'FORBIDDEN');
    await expect(run(model({ text: 'x' }), { viewedContainer: { container_id: CONTAINER_ID } }))
      .rejects.toHaveProperty('code', 'VALIDATION_FAILED');
  });

  it('does not restore a prior turn\'s viewed container for a later turn without one', async () => {
    const first = model({ text: 'It is a wedding.' });
    const turn = await run(first, { viewedContainer: viewed() });
    const next = model({ text: 'Okay.' });
    await run(next, { history: turn.history });
    // Current turn's own bootstrap carries nothing; only inert history remains.
    const messages = next.chat.mock.calls[0][0].messages;
    const current = messages.slice(messages.findLastIndex((m) => m.role === 'user')).find((m) => m.role === 'tool');
    expect(JSON.parse(current.content).data).not.toHaveProperty('viewed_container');
  });
});

describe('chat composition', () => {
  const mockLoop = () => {
    jest.resetModules();
    const loop = { runReadTurn: jest.fn().mockResolvedValue({ text: 'ok' }), runReadTurnWithHistory: jest.fn() };
    const conversation = { runConversationTurn: jest.fn(async ({ runTurn }) => (await runTurn({ history: [], conversationId: 'c' })).reply) };
    loop.runReadTurnWithHistory.mockResolvedValue({ reply: { text: 'ok' }, history: [] });
    const tools = { getViewedContainerContext: jest.fn().mockResolvedValue(viewed()), getMyContext: jest.fn() };
    jest.doMock('../../../src/agent/services/read-loop.service', () => loop);
    jest.doMock('../../../src/agent/services/conversation.service', () => conversation);
    jest.doMock('../../../src/agent/services/read-tools.service', () => tools);
    jest.doMock('../../../src/agent/services/budget.service', () => ({ createWorkspaceBudget: jest.fn() }));
    jest.doMock('../../../src/agent/providers/groq.provider', () => ({ createGroqProvider: jest.fn(() => ({ chat: jest.fn() })) }));
    return { loop, tools, chat: require('../../../src/agent/services/chat.service') };
  };

  it('resolves the viewed container once and passes it to a stateless turn', async () => {
    const { loop, tools, chat } = mockLoop();
    await chat.runChatTurn({ data: { message: 'Hi', viewed_container_id: CONTAINER_ID }, context: context() });
    expect(tools.getViewedContainerContext).toHaveBeenCalledWith(expect.objectContaining({ containerId: CONTAINER_ID }));
    expect(loop.runReadTurn).toHaveBeenCalledWith(expect.objectContaining({ viewedContainer: viewed() }));
  });

  it('passes it to a conversation turn and skips the lookup when absent', async () => {
    const { loop, tools, chat } = mockLoop();
    await chat.runChatTurn({ data: { message: 'Hi', conversation_id: '44444444-4444-4444-8444-444444444444', viewed_container_id: CONTAINER_ID }, context: context() });
    expect(loop.runReadTurnWithHistory).toHaveBeenCalledWith(expect.objectContaining({ viewedContainer: viewed() }));
    tools.getViewedContainerContext.mockClear();
    await chat.runChatTurn({ data: { message: 'Hi' }, context: context() });
    expect(tools.getViewedContainerContext).not.toHaveBeenCalled();
  });
});
