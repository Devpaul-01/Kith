const { z } = require('zod');
const { ReadableStream } = require('stream/web');
const { createGroqProvider } = require('../../../src/agent/providers/groq.provider');
const { GROQ_LIMITS } = require('../../../src/agent/validators/groq.validator');
const { READ_TURN_LIMITS } = require('../../../src/agent/validators/read-turn.validator');
const { usage, chunk, frame, textChunks, toolChunks, sseResponse } = require('../../helpers/agent-stream');
const logger = require('../../../src/utils/logger');

const normalizedUsage = { promptTokens: 50, completionTokens: 8, totalTokens: 58 };
const request = {
  messages: [{ role: 'user', content: 'Read the dashboard.' }],
  tools: [{ name: 'get_dashboard', description: 'Read the dashboard.', parameterSchema: z.object({}).strict() }],
};
const provider = (fetchImpl, options = {}) => createGroqProvider({
  apiKey: 'FAKE_STREAM_TEST_KEY', model: 'llama-3.3-70b-versatile', timeoutMs: 5000, fetchImpl, ...options,
});
const chat = (events, options = {}) => provider(jest.fn().mockResolvedValue(sseResponse(events, options)))
  .chat(request, { onText: jest.fn() });

describe('Groq streaming transport', () => {
  afterEach(() => jest.useRealTimers());

  it.each(['\n', '\r\n', '\r'])('decodes UTF-8 and SSE across individual bytes with %j separators', async (newline) => {
    const onText = jest.fn();
    const fetchImpl = jest.fn().mockResolvedValue(sseResponse(textChunks('₦123.40 — Adaeze 🙂'), { split: 1, newline }));
    const result = await provider(fetchImpl).chat(request, { onText });
    expect(result).toEqual({ text: '₦123.40 — Adaeze 🙂', toolCalls: [], usage: normalizedUsage });
    expect(onText).toHaveBeenCalledWith('₦123.40 — Adaeze 🙂');
    const wire = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(wire).toMatchObject({ stream: true, n: 1, disable_tool_validation: false });
    expect(wire).not.toHaveProperty('onText');
  });

  it('delivers text before completion and waits for the consumer before reading more', async () => {
    let source;
    let release;
    const consumed = new Promise((resolve) => { release = resolve; });
    let notified;
    const first = new Promise((resolve) => { notified = resolve; });
    const body = new ReadableStream({ start(controller) { source = controller; } });
    const onText = jest.fn(async () => { notified(); await consumed; });
    const fetchImpl = jest.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    let finished = false;
    const pending = provider(fetchImpl).chat(request, { onText }).then((result) => { finished = true; return result; });
    source.enqueue(Buffer.from(frame(chunk({ content: 'First' }))));
    await first;
    source.enqueue(Buffer.from(frame(chunk({ content: ' second' })) + frame(chunk({}, 'stop')) + frame('[DONE]')));
    source.close();
    expect(finished).toBe(false);
    expect(onText).toHaveBeenCalledTimes(1);
    release();
    expect((await pending).text).toBe('First second');
    expect(onText).toHaveBeenCalledTimes(2);
  });

  it('reassembles interleaved calls and does not expose their names or arguments as text', async () => {
    const onText = jest.fn();
    const events = [
      chunk({ tool_calls: [
        { index: 0, id: 'call_a', type: 'function', function: { name: 'get_', arguments: '{' } },
        { index: 1, id: 'call_b', type: 'function', function: { name: 'get_dashboard', arguments: '' } },
      ] }),
      chunk({ tool_calls: [
        { index: 1, function: { arguments: '{}' } },
        { index: 0, function: { name: 'dashboard', arguments: '}' } },
      ] }),
      chunk({}, 'tool_calls'), '[DONE]',
    ];
    const result = await provider(jest.fn().mockResolvedValue(sseResponse(events))).chat(request, { onText });
    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'get_dashboard', arguments: '{}' },
      { id: 'call_b', name: 'get_dashboard', arguments: '{}' },
    ]);
    expect(onText).not.toHaveBeenCalled();
  });

  it('accepts compatibility usage-only chunks after completion', async () => {
    const result = await chat([chunk({ content: 'Hello.' }, 'stop'), { choices: [], usage }, '[DONE]']);
    expect(result.usage).toEqual(normalizedUsage);
  });

  it('drops reasoning and private metadata while streaming refusal text', async () => {
    const onText = jest.fn();
    const fetchImpl = jest.fn().mockResolvedValue(sseResponse([
      chunk({ refusal: 'Unavailable.', reasoning: 'PRIVATE_REASONING' }),
      { ...chunk({}, 'stop'), x_groq: { id: 'PRIVATE_ID', debug: 'PRIVATE_DEBUG', usage: { ...usage, private: 'PRIVATE_USAGE' } } },
      '[DONE]',
    ]));
    expect((await provider(fetchImpl).chat(request, { onText })).text).toBe('Unavailable.');
    expect(onText.mock.calls).toEqual([['Unavailable.']]);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('PRIVATE_');
  });

  it.each([
    ['missing done', [chunk({ content: 'Partial' }, 'stop')]],
    ['missing finish', [chunk({ content: 'Partial' }), '[DONE]']],
    ['done only', ['[DONE]']],
    ['empty reply', [chunk({}, 'stop'), '[DONE]']],
    ['invalid JSON', ['{private nonsense']],
    ['wrong choice index', [{ choices: [{ index: 1, delta: { content: 'Bad' }, finish_reason: 'stop' }] }, '[DONE]']],
    ['multiple choices', [{ choices: [chunk().choices[0], chunk().choices[0]] }]],
    ['system role', [chunk({ role: 'system', content: 'Bad' }), '[DONE]']],
    ['provider execution', [chunk({ executed_tools: [{ name: 'PRIVATE_TOOL' }] })]],
    ['root execution', [{ ...chunk(), executed_tools: [{ name: 'PRIVATE_TOOL' }] }]],
    ['deprecated calls', [chunk({ function_call: { name: 'PRIVATE_TOOL' } })]],
    ['upstream error', [{ error: { message: 'PRIVATE_ERROR' } }]],
    ['Groq error', [{ ...chunk({}, 'stop'), x_groq: { error: 'PRIVATE_ERROR' } }, '[DONE]']],
    ['content after finish', [chunk({ content: 'One' }, 'stop'), chunk({ content: 'Two' }), '[DONE]']],
    ['mixed refusal and content', [chunk({ content: 'Yes', refusal: 'No' }, 'stop'), '[DONE]']],
    ['tool finish without call', [chunk({ content: 'Bad' }, 'tool_calls'), '[DONE]']],
    ['hidden write call', toolChunks('delete_container')],
    ['unknown tool', toolChunks('other_read')],
    ['call index gap', [chunk({ tool_calls: [{ index: 2, id: 'call_a', type: 'function', function: { name: 'get_dashboard' } }] })]],
    ['duplicate fragment', [chunk({ tool_calls: [
      { index: 0, id: 'call_a', type: 'function', function: { name: 'get_dashboard' } },
      { index: 0, function: { arguments: '{}' } },
    ] })]],
    ['changed call identity', [
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_dashboard' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'call_b', function: { arguments: '{}' } }] }),
    ]],
    ['duplicate call IDs', [chunk({ tool_calls: [
      { index: 0, id: 'same', type: 'function', function: { name: 'get_dashboard', arguments: '{}' } },
      { index: 1, id: 'same', type: 'function', function: { name: 'get_dashboard', arguments: '{}' } },
    ] }, 'tool_calls'), '[DONE]']],
  ])('rejects %s without leaking provider details', async (name, events) => {
    const error = await chat(events).catch((err) => err);
    expect(error.code).toBe('AGENT_INVALID_RESPONSE');
    expect(JSON.stringify(error)).not.toContain('PRIVATE_');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_');
  });

  it('keeps usage on truncated replies and reconciles it once', async () => {
    const budget = { reserve: jest.fn().mockResolvedValue({ id: 'reservation' }), settle: jest.fn().mockResolvedValue({}) };
    const fetchImpl = jest.fn().mockResolvedValue(sseResponse([
      chunk({ content: 'Partial' }), { ...chunk({}, 'length'), x_groq: { usage } }, '[DONE]',
    ]));
    await expect(provider(fetchImpl, { budget }).chat(request, { onText: jest.fn() }))
      .rejects.toMatchObject({ code: 'AGENT_RESPONSE_TRUNCATED', usage: normalizedUsage });
    expect(budget.settle).toHaveBeenCalledTimes(1);
    expect(budget.settle).toHaveBeenCalledWith({ reservation: { id: 'reservation' }, usage: normalizedUsage });
  });

  it('rejects contradictory or invalid token reports', async () => {
    await expect(chat([
      { ...chunk({ content: 'Hello' }, 'stop'), usage },
      { choices: [], usage: { ...usage, total_tokens: 59, completion_tokens: 9 } }, '[DONE]',
    ])).rejects.toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
    await expect(chat([{ ...chunk({ content: 'Hello' }, 'stop'), usage: { ...usage, total_tokens: -1 } }, '[DONE]']))
      .rejects.toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
  });

  it.each([
    [chunk({ content: 'x'.repeat(READ_TURN_LIMITS.replyChars) }), chunk({ content: 'x' }), chunk({}, 'stop'), '[DONE]'],
    toolChunks('get_dashboard', 'x'.repeat(READ_TURN_LIMITS.argumentChars + 1)),
    [chunk({ reasoning: 'x'.repeat(GROQ_LIMITS.responseBytes) })],
  ])('bounds text, arguments and individual SSE frames: %#', async (...events) => {
    await expect(chat(events)).rejects.toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
  });

  it('bounds total wire bytes including comments and rejects invalid UTF-8', async () => {
    const body = Buffer.from(`:${' '.repeat(1000)}\n\n`.repeat(2200));
    for (const bytes of [body, Buffer.from([0xff, 0xfe])]) {
      const fetchImpl = jest.fn().mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'text/event-stream' } }));
      await expect(provider(fetchImpl).chat(request, { onText: jest.fn() })).rejects.toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
    }
  });

  it('requires the SSE media type', async () => {
    await expect(chat(textChunks(), { headers: { 'Content-Type': 'application/json' } })).rejects.toMatchObject({ code: 'AGENT_INVALID_RESPONSE' });
  });

  it('cancels a stalled body, keeps unreported tokens reserved, and removes abort listeners', async () => {
    let notified;
    const first = new Promise((resolve) => { notified = resolve; });
    const cancel = jest.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(frame(chunk({ content: 'Partial' })))); }, cancel });
    const fetchImpl = jest.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const budget = { reserve: jest.fn().mockResolvedValue({ id: 'reservation' }), settle: jest.fn().mockResolvedValue({}) };
    const controller = new AbortController();
    const pending = provider(fetchImpl, { budget }).chat(request, { signal: controller.signal, onText: async () => { notified(); controller.abort(); } });
    await first;
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_REQUEST_CANCELLED' });
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(budget.settle).toHaveBeenCalledWith({ reservation: { id: 'reservation' }, usage: null });
  });

  it('does not reserve or call the provider for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = jest.fn();
    const budget = { reserve: jest.fn(), settle: jest.fn() };
    await expect(provider(fetchImpl, { budget }).chat(request, { signal: controller.signal, onText: jest.fn() }))
      .rejects.toMatchObject({ code: 'AGENT_REQUEST_CANCELLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it('times out during an unfinished stream', async () => {
    jest.useFakeTimers();
    const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(frame(chunk({ content: 'Partial' })))); } });
    const fetchImpl = jest.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const pending = provider(fetchImpl, { timeoutMs: 50 }).chat(request, { onText: jest.fn() });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(50);
    await assertion;
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
