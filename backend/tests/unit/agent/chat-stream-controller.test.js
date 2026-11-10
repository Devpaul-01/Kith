jest.mock('../../../src/agent/services/chat.service', () => ({ runChatTurn: jest.fn() }));
const express = require('express');
const request = require('supertest');
const { chat } = require('../../../src/agent/controllers/chat.controller');
const { runChatTurn } = require('../../../src/agent/services/chat.service');
const { errorHandler } = require('../../../src/middleware/errorHandler');
const { providerError } = require('../../../src/agent/providers/provider-errors');
const { parseEvents } = require('../../helpers/agent-stream');
const logger = require('../../../src/utils/logger');

const app = express();
app.use(express.json());
app.post('/chat', (req, res, next) => {
  req.user = { id: 'user' };
  req.member = { id: 'member' };
  req.workspace = { id: 'workspace' };
  next();
}, chat);
app.use(errorHandler);
const post = () => request(app).post('/chat').set('Accept', 'text/event-stream').send({ message: 'Hello' });

describe('streaming terminal responses', () => {
  it('keeps budget status and Retry-After before any streamed output', async () => {
    runChatTurn.mockRejectedValueOnce(providerError('AGENT_BUDGET_EXHAUSTED', null, Date.now() + 60000));
    const res = await post();
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body.error.code).toBe('AGENT_BUDGET_EXHAUSTED');
  });

  it('reports a mid-turn budget denial as an SSE error with retry timing', async () => {
    runChatTurn.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ type: 'text_reset', data: { modelCall: 1 } });
      throw providerError('AGENT_BUDGET_EXHAUSTED', null, Date.now() + 60000);
    });
    const res = await post();
    expect(res.status).toBe(200);
    const events = parseEvents(res.text);
    expect(events.map((event) => event.type)).toEqual(['text_reset', 'error']);
    expect(events.at(-1).data).toMatchObject({ error: { code: 'AGENT_BUDGET_EXHAUSTED' }, retry_after: expect.any(Number) });
    expect(events.at(-1).data.retry_after).toBeGreaterThan(0);
  });

  it('redacts unexpected failures after output begins, including in stream logs', async () => {
    runChatTurn.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ type: 'text_delta', data: { delta: 'Draft', modelCall: 1 } });
      throw new Error('PRIVATE_INTERNAL_DETAIL');
    });
    const res = await post();
    expect(parseEvents(res.text).at(-1)).toMatchObject({ type: 'error', data: { error: { code: 'INTERNAL_ERROR' } } });
    expect(res.text).not.toContain('PRIVATE_INTERNAL_DETAIL');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_INTERNAL_DETAIL');
  });
});
