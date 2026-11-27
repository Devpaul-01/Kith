jest.mock('../../../src/services/container.service', () => ({ getContainer: jest.fn() }));
jest.mock('../../../src/services/dashboard.service', () => ({ getDashboardData: jest.fn(), getOverdueSummaryData: jest.fn() }));

const { runReadTurnWithHistory } = require('../../../src/agent/services/read-loop.service');
const { markAllNotificationsReadDefinition } = require('../../../src/agent/services/notification-proposal.service');
const { randomUUID } = require('crypto');
const { context } = require('../../helpers/agent-proposal');
const { taskSnapshot } = require('../../helpers/agent-task-proposal');

const actor = context();
const admin = { ...actor, member: { ...actor.member, role: 'admin' } };
const TASK_ID = '77777777-7777-4777-8777-777777777777';
const CONTAINER_ID = '33333333-3333-4333-8333-333333333333';
const call = (args, id = 'call_1', name = 'select_target') => ({ id, name, arguments: JSON.stringify(args) });
const model = (...replies) => { const chat = jest.fn(); replies.forEach((reply) => chat.mockResolvedValueOnce(reply)); return { chat }; };
const request = () => ({ purpose: 'update_task', selected_field: 'selected_task', status: 'ambiguous', query: 'tent', has_more: false,
  candidates: [{ selection: { container_id: CONTAINER_ID, task_id: TASK_ID }, title: 'Tent setup', subtitle: 'Wedding · pending' },
    { selection: { container_id: CONTAINER_ID, task_id: '88888888-8888-4888-8888-888888888888' }, title: 'Tent teardown', subtitle: null }] });
const bound = (changes = {}) => ({ kind: 'bound', purpose: 'update_task', tool: 'update_task', selectionKey: 'taskSelection',
  selection: { id: TASK_ID }, label: { title: 'Tent setup', subtitle: 'Wedding · pending' }, ...changes });
const support = (resolve) => ({ definitions: [markAllNotificationsReadDefinition], create: jest.fn(), resolveTarget: jest.fn(resolve) });
const run = (provider, proposalSupport, options = {}) => runReadTurnWithHistory({
  data: { message: 'Mark the tent task done' }, context: actor, provider, proposalSupport, ...options });
const toolNames = (provider, index) => provider.chat.mock.calls[index][0].tools.map((tool) => tool.name);
const toolResults = (provider, index) => provider.chat.mock.calls[index][0].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content).data);

it('offers select_target only when the chat service can resolve targets', async () => {
  const withResolver = model({ text: 'ok' });
  await run(withResolver, support(async () => ({})));
  expect(toolNames(withResolver, 0)).toContain('select_target');
  const without = model({ text: 'ok' });
  await run(without, { definitions: [markAllNotificationsReadDefinition], create: jest.fn() });
  expect(toolNames(without, 0)).not.toContain('select_target');
  const stateless = model({ text: 'ok' });
  await run(stateless, undefined);
  expect(toolNames(stateless, 0)).not.toContain('select_target');
});

it('ends the turn with a server-built selection_request when the user must choose', async () => {
  const proposalSupport = support(async () => ({ kind: 'choose', request: request() }));
  const provider = model({ toolCalls: [call({ purpose: 'update_task', query: 'tent' })] }, { text: 'unreachable' });
  const { reply, history } = await run(provider, proposalSupport);
  expect(proposalSupport.resolveTarget).toHaveBeenCalledWith({ purpose: 'update_task', query: 'tent' });
  expect(reply).toEqual({ text: 'Choose the one you mean.', modelCalls: 1, toolCalls: 2, selection_request: request() });
  expect(provider.chat).toHaveBeenCalledTimes(1);
  // History keeps the visible titles for context but never the selectable identifiers.
  const stored = JSON.stringify(history);
  expect(stored).toContain('Tent setup');
  expect(stored).not.toContain(TASK_ID);
});

it('offers the write tool on the next step after a clear match, for this request only', async () => {
  const original = support(async () => bound());
  const provider = model({ toolCalls: [call({ purpose: 'update_task', query: 'tent' })] }, { text: 'Tell me what to change.' });
  const { reply } = await run(provider, original);
  expect(reply.text).toBe('Tell me what to change.');
  expect(toolNames(provider, 0)).not.toContain('update_task');
  expect(toolNames(provider, 1)).toContain('update_task');
  expect(toolResults(provider, 1).at(-1)).toEqual({ status: 'target_selected', tool: 'update_task',
    target: { title: 'Tent setup', subtitle: 'Wedding · pending' } });
  expect(original).not.toHaveProperty('taskSelection');
  const next = model({ text: 'ok' });
  await run(next, original);
  expect(toolNames(next, 0)).not.toContain('update_task');
});

it('flows a server-resolved task through the existing proposal checks to an approval card in one turn', async () => {
  const snapshot = taskSnapshot();
  const card = { id: randomUUID(), tool: 'update_task', tier: 2, summary: 'Mark the selected task as completed.',
    parameters: { container_id: snapshot.container_id, task_id: snapshot.id, status: 'completed' }, before: snapshot,
    after: { status: 'completed', completion_note: snapshot.completion_note }, expires_at: new Date(Date.now() + 60000).toISOString() };
  const proposalSupport = support(async () => bound({ selection: snapshot, label: { title: snapshot.title, subtitle: null } }));
  proposalSupport.create.mockResolvedValue(card);
  const provider = model({ toolCalls: [call({ purpose: 'update_task', query: 'tent' })] },
    { toolCalls: [call({ status: 'completed' }, 'call_2', 'update_task')] });
  const { reply } = await run(provider, proposalSupport);
  expect(proposalSupport.create).toHaveBeenCalledWith({ name: 'update_task', args: { status: 'completed' },
    turnId: expect.any(String), selection: snapshot });
  expect(reply.proposal).toEqual(card);
  expect(reply.text).toBe('Review the proposal and use its approval control if you want to apply it.');
  expect(provider.chat).toHaveBeenCalledTimes(2);
});

it('does not let a card for a different task pass when the resolved target is another', async () => {
  const snapshot = taskSnapshot();
  const other = { ...snapshot, id: '99999999-9999-4999-8999-999999999999' };
  const card = { id: randomUUID(), tool: 'update_task', tier: 2, summary: 'Mark the selected task as completed.',
    parameters: { container_id: other.container_id, task_id: other.id, status: 'completed' }, before: other,
    after: { status: 'completed', completion_note: other.completion_note }, expires_at: new Date(Date.now() + 60000).toISOString() };
  const proposalSupport = support(async () => bound({ selection: snapshot }));
  proposalSupport.create.mockResolvedValue(card);
  const provider = model({ toolCalls: [call({ purpose: 'update_task', query: 'tent' })] },
    { toolCalls: [call({ status: 'completed' }, 'call_2', 'update_task')] });
  await expect(run(provider, proposalSupport)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});

it.each([
  [{ kind: 'needs_details' }, { status: 'needs_details' }],
  [{ kind: 'not_found', ineligible_matches: 2 }, { status: 'not_found', ineligible_matches: 2 }],
  [{ kind: 'unavailable', reason: 'admin_required' }, { status: 'unavailable', reason: 'admin_required' }],
])('returns %j to the model so it can ask the user, without ending the turn', async (outcome, expected) => {
  const provider = model({ toolCalls: [call({ purpose: 'update_task' })] }, { text: 'Which task do you mean?' });
  const { reply } = await run(provider, support(async () => outcome));
  expect(reply).toEqual({ text: 'Which task do you mean?', modelCalls: 2, toolCalls: 2 });
  expect(toolResults(provider, 1).at(-1)).toEqual(expected);
});

describe('guardrails', () => {
  it.each([
    ['an identifier', { purpose: 'update_task', task_id: TASK_ID }], ['an unknown purpose', { purpose: 'drop_table' }],
    ['a one-character query', { purpose: 'update_task', query: 'a' }],
  ])('rejects %s without searching', async (_label, args) => {
    const proposalSupport = support(async () => ({}));
    await expect(run(model({ toolCalls: [call(args)] }), proposalSupport)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(proposalSupport.resolveTarget).not.toHaveBeenCalled();
  });

  it('requires the request to stand alone', async () => {
    const proposalSupport = support(async () => ({}));
    const reply = { toolCalls: [call({ purpose: 'update_task', query: 'tent' }), call({}, 'call_2', 'get_my_context')] };
    await expect(run(model(reply), proposalSupport)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(proposalSupport.resolveTarget).not.toHaveBeenCalled();
  });

  it('refuses the tool when targets cannot be resolved', async () => {
    await expect(run(model({ toolCalls: [call({ purpose: 'update_task', query: 'tent' })] }), { definitions: [markAllNotificationsReadDefinition], create: jest.fn() }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['a different tool than requested', bound({ tool: 'delete_contact' })],
    ['an admin-only tool for a member', bound({ purpose: 'admin_confirm_task', tool: 'admin_confirm_task' })],
    ['an unknown tool', bound({ tool: 'drop_table' })],
  ])('never offers %s', async (_label, outcome) => {
    const args = { purpose: outcome.purpose === 'admin_confirm_task' ? 'admin_confirm_task' : 'update_task', query: 'tent' };
    await expect(run(model({ toolCalls: [call(args)] }), support(async () => outcome))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows an admin-only tool to be offered to an admin', async () => {
    const provider = model({ toolCalls: [call({ purpose: 'admin_confirm_task', query: 'tent' })] }, { text: 'ok' });
    await run(provider, support(async () => bound({ purpose: 'admin_confirm_task', tool: 'admin_confirm_task', selectionKey: 'taskConfirmationSelection' })),
      { context: admin });
    expect(toolNames(provider, 1)).toContain('admin_confirm_task');
  });

  it('hides resolver failures and rejects malformed outcomes', async () => {
    await expect(run(model({ toolCalls: [call({ purpose: 'update_task', query: 'tent' })] }),
      support(async () => { throw new Error('PRIVATE'); }))).rejects.toMatchObject({ code: 'AGENT_TOOL_FAILED' });
    await expect(run(model({ toolCalls: [call({ purpose: 'update_task', query: 'tent' })] }),
      support(async () => ({ kind: 'surprise' })))).rejects.toMatchObject({ code: 'AGENT_INVALID_TOOL_RESULT' });
    await expect(run(model({ toolCalls: [call({ purpose: 'update_task', query: 'tent' })] }),
      support(async () => ({ kind: 'choose', request: { ...request(), candidates: [] } })))).rejects.toBeDefined();
  });
});

describe('chat composition', () => {
  const mockChat = () => {
    jest.resetModules();
    const captured = {};
    const loop = { runReadTurn: jest.fn(async ({ proposalSupport }) => { captured.support = proposalSupport; return { text: 'ok' }; }), runReadTurnWithHistory: jest.fn() };
    const proposals = { createProposal: jest.fn().mockResolvedValue({ id: 'p' }), getProposalReceipts: jest.fn() };
    const resolver = { resolveTarget: jest.fn().mockResolvedValue({ kind: 'needs_details' }) };
    jest.doMock('../../../src/agent/services/read-loop.service', () => loop);
    jest.doMock('../../../src/agent/services/proposal.service', () => proposals);
    jest.doMock('../../../src/agent/services/target-resolution.service', () => resolver);
    jest.doMock('../../../src/agent/services/budget.service', () => ({ createWorkspaceBudget: jest.fn() }));
    jest.doMock('../../../src/agent/providers/groq.provider', () => ({ createGroqProvider: jest.fn(() => ({ chat: jest.fn() })) }));
    return { captured, proposals, resolver, chat: require('../../../src/agent/services/chat.service') };
  };

  it('resolves targets as the authenticated member and forwards a resolved selection to proposal creation', async () => {
    const { captured, proposals, resolver, chat } = mockChat();
    await chat.runChatTurn({ data: { message: 'Hi' }, context: actor });
    await captured.support.resolveTarget({ purpose: 'update_task', query: 'tent' });
    expect(resolver.resolveTarget).toHaveBeenCalledWith({ context: expect.objectContaining({ userId: actor.userId }), purpose: 'update_task', query: 'tent' });
    await captured.support.create({ name: 'update_task', args: { status: 'completed' }, turnId: 't', selection: { id: TASK_ID } });
    expect(proposals.createProposal).toHaveBeenCalledWith(expect.objectContaining({ tool: 'update_task', selection: { id: TASK_ID } }));
  });
});
