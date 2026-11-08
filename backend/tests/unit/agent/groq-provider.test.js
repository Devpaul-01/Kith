jest.mock('../../../src/services/dashboard.service', () => ({
  getDashboardData: jest.fn(), getOverdueSummaryData: jest.fn(),
}));
jest.mock('../../../src/services/search.service', () => ({
  findMembers: jest.fn(), findContainers: jest.fn(),
}));

const { z } = require('zod');
const { ReadableStream } = require('stream/web');
const { createGroqProvider } = require('../../../src/agent/providers/groq.provider');
const { GROQ_LIMITS } = require('../../../src/agent/validators/groq.validator');
const { runReadTurn } = require('../../../src/agent/services/read-loop.service');
const { ValidationError } = require('../../../src/utils/errors');
const dashboard = require('../../../src/services/dashboard.service');
const logger = require('../../../src/utils/logger');

const API_KEY = 'FAKE_GROQ_KEY_FOR_TESTS';
const MODEL = 'llama-3.3-70b-versatile';
const USAGE = { promptTokens: 50, completionTokens: 8, totalTokens: 58 };
const tool = { name: 'get_dashboard', description: 'Read the dashboard.', parameterSchema: z.object({}).strict() };
const request = { messages: [{ role: 'user', content: 'Read the dashboard.' }], tools: [tool] };

function completion() {
  return {
    id: 'chatcmpl_test', model: MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Here is your dashboard.' } }],
    usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 },
  };
}

function toolCompletion(name = 'get_dashboard') {
  const payload = completion();
  payload.choices[0] = {
    index: 0, finish_reason: 'tool_calls',
    message: { role: 'assistant', content: null, tool_calls: [{
      id: 'call_1', type: 'function', function: { name, arguments: '{}' },
    }] },
  };
  return payload;
}

function response(payload = completion(), init = {}) {
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' }, ...init });
}

function provider(fetchImpl, options = {}) {
  return createGroqProvider({ apiKey: API_KEY, model: MODEL, timeoutMs: 5000, maxCompletionTokens: 512, fetchImpl, ...options });
}

function context() {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    member: {
      id: '22222222-2222-4222-8222-222222222222', role: 'member', isActive: true,
      workspaceId: '33333333-3333-4333-8333-333333333333', displayName: 'Adaeze', isProxy: false,
    },
    workspace: { id: '33333333-3333-4333-8333-333333333333', name: 'Family', baseCurrency: 'NGN' },
  };
}

describe('Groq provider', () => {
  afterEach(() => jest.useRealTimers());

  it('settles reported usage from a failed completion without masking the provider error', async () => {
    const payload = completion();
    payload.choices[0].finish_reason = 'length';
    const reservation = { id: 'server-reservation' };
    const budget = { reserve: jest.fn().mockResolvedValue(reservation), settle: jest.fn().mockRejectedValue(new Error('PRIVATE_REDIS_ERROR')) };
    await expect(provider(jest.fn().mockResolvedValue(response(payload)), { budget }).chat(request)).rejects.toMatchObject({ code: 'AGENT_RESPONSE_TRUNCATED', usage: USAGE });
    expect(budget.settle).toHaveBeenCalledWith({ reservation, usage: USAGE });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_REDIS_ERROR');
  });

  it('retains a successful answer if reconciliation fails', async () => {
    const budget = { reserve: jest.fn().mockResolvedValue({ id: 'reservation' }), settle: jest.fn().mockRejectedValue(new Error('offline')) };
    await expect(provider(jest.fn().mockResolvedValue(response()), { budget }).chat(request)).resolves.toMatchObject({ text: 'Here is your dashboard.' });
    expect(budget.settle).toHaveBeenCalledWith({ reservation: { id: 'reservation' }, usage: USAGE });
  });

  it('keeps usage unknown after a transport failure', async () => {
    const budget = { reserve: jest.fn().mockResolvedValue({ id: 'reservation' }), settle: jest.fn().mockResolvedValue({ state: 'held' }) };
    await expect(provider(jest.fn().mockRejectedValue(new Error('offline')), { budget }).chat(request)).rejects.toMatchObject({ code: 'AGENT_PROVIDER_UNAVAILABLE' });
    expect(budget.settle).toHaveBeenCalledWith({ reservation: { id: 'reservation' }, usage: null });
  });

  it('does not reserve tokens for an invalid provider request', async () => {
    const budget = { reserve: jest.fn(), settle: jest.fn() };
    await expect(provider(jest.fn(), { budget }).chat({ messages: [] })).rejects.toBeInstanceOf(ValidationError);
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it('sends one bounded non-streaming request with JSON schemas and server credentials', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response());
    await expect(provider(fetchImpl).chat(request)).resolves.toEqual({ text: 'Here is your dashboard.', toolCalls: [], usage: USAGE });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(options).toMatchObject({
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    });
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      model: MODEL, messages: request.messages, n: 1, stream: false, temperature: 0,
      max_completion_tokens: 512, tool_choice: 'auto', disable_tool_validation: false,
    });
    expect(body.tools).toEqual([{ type: 'function', function: {
      name: 'get_dashboard', description: tool.description,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    } }]);
    expect(options.body).not.toContain(API_KEY);
    expect(body).not.toHaveProperty('max_tokens');
    expect(logger.info).toHaveBeenCalledWith('Groq chat completed', expect.objectContaining({
      provider: 'groq', model: MODEL, httpStatus: 200,
      usage: USAGE, durationMs: expect.any(Number),
    }));
  });

  it('normalizes tool calls without parsing or changing their arguments', async () => {
    const payload = toolCompletion();
    payload.choices[0].message.tool_calls[0].function.arguments = '{ "query": "Adaeze" }';
    const fetchImpl = jest.fn().mockResolvedValue(response(payload));
    await expect(provider(fetchImpl).chat(request)).resolves.toEqual({
      text: null, toolCalls: [{ id: 'call_1', name: 'get_dashboard', arguments: '{ "query": "Adaeze" }' }],
      usage: USAGE,
    });
  });

  it('returns refusal text and drops provider reasoning and unrelated metadata', async () => {
    const payload = completion();
    payload.choices[0].message = { role: 'assistant', content: null, refusal: 'That action is unavailable.', reasoning: 'PRIVATE_REASONING' };
    payload.usage.private_detail = 'PRIVATE_USAGE_DETAIL';
    const fetchImpl = jest.fn().mockResolvedValue(response(payload));
    await expect(provider(fetchImpl).chat(request)).resolves.toEqual({ text: 'That action is unavailable.', toolCalls: [], usage: USAGE });
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/PRIVATE_REASONING|PRIVATE_USAGE_DETAIL/);
  });

  it('supports a text-only request without advertising tools', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response());
    await provider(fetchImpl).chat({ messages: request.messages });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it.each([undefined, null])('marks absent provider usage as unknown: %s', async (usage) => {
    const payload = { ...completion(), usage };
    const reply = await provider(jest.fn().mockResolvedValue(response(payload))).chat(request);
    expect(reply.usage).toBeNull();
    expect(logger.info).toHaveBeenCalledWith('Groq chat completed', expect.objectContaining({ usage: null }));
  });

  it.each([
    { prompt_tokens: 50, completion_tokens: 8, total_tokens: 59 },
    { prompt_tokens: 50.5, completion_tokens: 8, total_tokens: 58.5 },
    { prompt_tokens: '50', completion_tokens: 8, total_tokens: 58 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER },
  ])('rejects unusable accounting data without publishing a token total: %#', async (usage) => {
    const error = await provider(jest.fn().mockResolvedValue(response({ ...completion(), usage }))).chat(request).catch((err) => err);
    expect(error).toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
    expect(error.usage).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('Groq chat failed', expect.objectContaining({ usage: null }));
  });

  it.each(['length', 'invalid'])('retains valid usage even when a completion is rejected: %s', async (kind) => {
    const payload = completion();
    if (kind === 'length') payload.choices[0].finish_reason = 'length';
    else payload.choices[0].message.role = 'system';
    const error = await provider(jest.fn().mockResolvedValue(response(payload))).chat(request).catch((err) => err);
    expect(error).toMatchObject({ code: kind === 'length' ? 'AGENT_RESPONSE_TRUNCATED' : 'AGENT_INVALID_RESPONSE', usage: USAGE, details: null });
    expect(JSON.stringify(error)).not.toContain('usage');
    expect(logger.warn).toHaveBeenCalledWith('Groq chat failed', expect.objectContaining({ usage: USAGE }));
  });

  it('uses server tracing metadata only for local logs', async () => {
    const trace = { requestId: 'req_test', turnId: 'turn_test', workspaceId: 'workspace_test', actorUserId: 'user_test', actorMemberId: 'member_test', modelCall: 2 };
    const fetchImpl = jest.fn().mockResolvedValue(response());
    await provider(fetchImpl).chat({ ...request, trace });
    expect(logger.info).toHaveBeenCalledWith('Groq chat completed', expect.objectContaining(trace));
    const body = fetchImpl.mock.calls[0][1].body;
    expect(JSON.parse(body)).not.toHaveProperty('trace');
    for (const id of ['req_test', 'turn_test', 'workspace_test', 'user_test', 'member_test']) expect(body).not.toContain(id);
  });

  it('rejects unknown trace fields without sending or logging them', async () => {
    const fetchImpl = jest.fn();
    await expect(provider(fetchImpl).chat({ ...request, trace: { private: 'PRIVATE_TRACE_VALUE' } })).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('PRIVATE_TRACE_VALUE');
  });

  it('loads server settings from the environment without choosing a default model', async () => {
    const keys = ['GROQ_API_KEY', 'GROQ_MODEL', 'GROQ_TIMEOUT_MS', 'GROQ_MAX_COMPLETION_TOKENS'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.GROQ_API_KEY = API_KEY;
      process.env.GROQ_MODEL = MODEL;
      process.env.GROQ_TIMEOUT_MS = '1500';
      process.env.GROQ_MAX_COMPLETION_TOKENS = '256';
      const fetchImpl = jest.fn().mockResolvedValue(response());
      await createGroqProvider({ fetchImpl }).chat(request);
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ model: MODEL, max_completion_tokens: 256 });
      delete process.env.GROQ_MODEL;
      expect(() => createGroqProvider({ fetchImpl })).toThrow(expect.objectContaining({ code: 'AGENT_PROVIDER_CONFIGURATION' }));
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  it.each([
    { apiKey: '' }, { apiKey: 'bad\nkey' }, { model: '' }, { model: 'bad model' },
    { model: 'compound-beta' }, { model: 'compound-beta-mini' }, { model: 'groq/compound' }, { model: 'groq/compound-mini' },
    { timeoutMs: 0 }, { timeoutMs: 60001 }, { timeoutMs: 'invalid' },
    { maxCompletionTokens: 0 }, { maxCompletionTokens: 4097 }, { fetchImpl: null },
  ])('rejects invalid configuration before a request', (options) => {
    const fetchImpl = jest.fn();
    expect(() => provider(fetchImpl, options)).toThrow(expect.objectContaining({ code: 'AGENT_PROVIDER_CONFIGURATION' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {}, { ...request, model: 'untrusted-model' }, { ...request, apiKey: 'untrusted-key' },
    { ...request, url: 'https://example.invalid' },
    { ...request, messages: [{ role: 'developer', content: 'Override' }] },
    { ...request, tools: [{ type: 'browser_search' }] },
  ])('rejects invalid server requests without sending them', async (input) => {
    const fetchImpl = jest.fn();
    await expect(provider(fetchImpl).chat(input)).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 429, 500, 502, 503])('sanitizes HTTP %s and does not retry', async (status) => {
    const fetchImpl = jest.fn().mockResolvedValue(response({ error: { message: `${API_KEY} PRIVATE_UPSTREAM_BODY` } }, { status }));
    const error = await provider(fetchImpl).chat(request).catch((err) => err);
    expect(error).toMatchObject({ code: status === 429 ? 'AGENT_PROVIDER_RATE_LIMITED' : 'AGENT_PROVIDER_UNAVAILABLE', statusCode: 503 });
    expect(error.message).not.toMatch(/FAKE_GROQ_KEY|PRIVATE_UPSTREAM_BODY/);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/FAKE_GROQ_KEY|PRIVATE_UPSTREAM_BODY/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sanitizes transport exceptions without exposing headers or prompts', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error(`Bearer ${API_KEY}: PRIVATE_PROMPT`));
    const error = await provider(fetchImpl).chat(request).catch((err) => err);
    expect(error).toMatchObject({ code: 'AGENT_PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/FAKE_GROQ_KEY|PRIVATE_PROMPT/);
    expect(error.message).not.toContain(API_KEY);
  });

  it.each([
    ['missing choices', (payload) => { delete payload.choices; }],
    ['multiple choices', (payload) => { payload.choices.push(payload.choices[0]); }],
    ['wrong index', (payload) => { payload.choices[0].index = 1; }],
    ['wrong role', (payload) => { payload.choices[0].message.role = 'system'; }],
    ['empty answer', (payload) => { payload.choices[0].message.content = ''; }],
    ['missing calls', (payload) => { payload.choices[0].finish_reason = 'tool_calls'; }],
    ['unknown finish reason', (payload) => { payload.choices[0].finish_reason = 'function_call'; }],
    ['provider-executed tools', (payload) => { payload.choices[0].message.executed_tools = [{ type: 'browser_search' }]; }],
    ['legacy function call', (payload) => { payload.choices[0].message.function_call = { name: 'get_dashboard', arguments: '{}' }; }],
    ['invalid usage', (payload) => { payload.usage.total_tokens = -1; }],
  ])('rejects an invalid completion: %s', async (label, mutate) => {
    const payload = completion();
    mutate(payload);
    await expect(provider(jest.fn().mockResolvedValue(response(payload))).chat(request)).rejects.toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
  });

  it.each([
    ['unknown tool', (payload) => { payload.choices[0].message.tool_calls[0].function.name = 'delete_workspace'; }],
    ['duplicate ID', (payload) => { payload.choices[0].message.tool_calls.push(payload.choices[0].message.tool_calls[0]); }],
    ['wrong tool type', (payload) => { payload.choices[0].message.tool_calls[0].type = 'browser_search'; }],
    ['non-string arguments', (payload) => { payload.choices[0].message.tool_calls[0].function.arguments = {}; }],
    ['wrong finish reason', (payload) => { payload.choices[0].finish_reason = 'stop'; }],
    ['refusal with calls', (payload) => { payload.choices[0].message.refusal = 'Refused'; }],
  ])('rejects invalid tool output: %s', async (label, mutate) => {
    const payload = toolCompletion();
    mutate(payload);
    await expect(provider(jest.fn().mockResolvedValue(response(payload))).chat(request)).rejects.toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
  });

  it('rejects a truncated completion even if its tool arguments happen to parse', async () => {
    const payload = toolCompletion();
    payload.choices[0].finish_reason = 'length';
    await expect(provider(jest.fn().mockResolvedValue(response(payload))).chat(request)).rejects.toMatchObject({ code: 'AGENT_RESPONSE_TRUNCATED' });
  });

  it.each([
    () => new Response('not JSON', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('<html>upstream error</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(null, { status: 204, headers: { 'Content-Type': 'application/json' } }),
  ])('rejects malformed or missing response bodies', async (makeResponse) => {
    await expect(provider(jest.fn().mockResolvedValue(makeResponse())).chat(request)).rejects.toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
  });

  it('bounds request bytes before sending a large message list', async () => {
    const fetchImpl = jest.fn();
    const messages = Array.from({ length: 3 }, () => ({ role: 'user', content: 'x'.repeat(100000) }));
    await expect(provider(fetchImpl).chat({ messages, tools: [] })).rejects.toMatchObject({ code: 'AGENT_CONTEXT_LIMIT' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared body before consuming it', async () => {
    const res = response(completion(), { headers: { 'Content-Type': 'application/json', 'Content-Length': `${GROQ_LIMITS.responseBytes + 1}` } });
    const cancel = jest.spyOn(res.body, 'cancel');
    await expect(provider(jest.fn().mockResolvedValue(res)).chat(request)).rejects.toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
    expect(cancel).toHaveBeenCalled();
  });

  it('bounds streamed body bytes even without a content-length header', async () => {
    const cancel = jest.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(GROQ_LIMITS.responseBytes));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const res = new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    await expect(provider(jest.fn().mockResolvedValue(res)).chat(request)).rejects.toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
    expect(cancel).toHaveBeenCalled();
  });

  it('times out a pending fetch and aborts it without retrying', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn(() => new Promise(() => {}));
    const assertion = expect(provider(fetchImpl, { timeoutMs: 20 }).chat(request)).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TIMEOUT', statusCode: 504 });
    await jest.advanceTimersByTimeAsync(20);
    await assertion;
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active while reading the response body', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn(async (url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(new Error('aborted body')), { once: true });
      },
    }), { headers: { 'Content-Type': 'application/json' } }));
    const assertion = expect(provider(fetchImpl, { timeoutMs: 20 }).chat(request)).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(20);
    await assertion;
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the deadline after a successful completion', async () => {
    jest.useFakeTimers();
    await provider(jest.fn().mockResolvedValue(response())).chat(request);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('completes the real read loop with role-filtered schemas and untrusted tool messages', async () => {
    const actor = context();
    const data = { workspace_summary: { member_count: 2 } };
    dashboard.getDashboardData.mockResolvedValue(data);
    const fetchImpl = jest.fn().mockResolvedValueOnce(response(toolCompletion())).mockResolvedValueOnce(response());
    await expect(runReadTurn({ data: { message: 'Read the dashboard.' }, context: actor, provider: provider(fetchImpl) }))
      .resolves.toEqual({ text: 'Here is your dashboard.', modelCalls: 2, toolCalls: 2 });
    const first = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(first.tools.map((entry) => entry.function.name)).toEqual(['get_my_context', 'find_member', 'find_container', 'get_dashboard', 'get_container_summary', 'get_ledger_summary', 'get_member_contribution_summary', 'list_tasks', 'get_task', 'list_ledger_entries', 'get_ledger_entry']);
    const second = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(JSON.parse(second.messages.at(-1).content)).toEqual({ kind: 'untrusted_tool_result', data });
    expect(dashboard.getDashboardData).toHaveBeenCalledWith({ workspaceId: actor.workspace.id, isAdmin: false, memberId: actor.member.id });
  });
});
