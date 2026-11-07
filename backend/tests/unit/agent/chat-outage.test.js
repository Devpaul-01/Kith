// Real Express/auth/membership/rate-limit/budget/provider composition. External
// Supabase and Redis transports are mocked; Redis commands deliberately stall.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, supabase: instance.client, supabaseAuth: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/config/redis', () => {
  const client = {
    status: 'reconnecting', call: jest.fn(() => new Promise(() => {})),
    get: jest.fn(() => new Promise(() => {})), eval: jest.fn(() => new Promise(() => {})),
    set: jest.fn().mockResolvedValue(null),
  };
  return { getRedis: () => client, __client: client };
});
jest.mock('../../../src/queues', () => ({ getQueue: jest.fn(), getAllQueues: jest.fn(() => []) }));
jest.mock('../../../src/config/firebase', () => require('../../mocks/firebase.mock'));
jest.mock('../../../src/config/resend', () => require('../../mocks/resend.mock'));

const request = require('supertest');
const app = require('../../../src/app');
const db = require('../../../src/config/supabase').__mockInstance;
const redis = require('../../../src/config/redis').__client;

const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const PATH = `/v1/workspaces/${WORKSPACE_ID}/agent/chat`;

describe('chat availability when Redis is offline', () => {
  const envKeys = ['NODE_ENV', 'GROQ_API_KEY', 'GROQ_MODEL', 'AGENT_BUDGET_TIMEOUT_MS', 'AGENT_WORKSPACE_TOKEN_LIMIT', 'AGENT_BUDGET_PERIOD'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let fetchSpy;
  beforeAll(() => { fetchSpy = jest.spyOn(globalThis, 'fetch'); });
  beforeEach(() => {
    db.reset();
    redis.status = 'reconnecting';
    process.env.NODE_ENV = 'production'; // Exercise every rate limiter.
    process.env.GROQ_API_KEY = 'TEST_KEY';
    process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
    process.env.AGENT_BUDGET_TIMEOUT_MS = '10';
    process.env.AGENT_WORKSPACE_TOKEN_LIMIT = '100000';
    process.env.AGENT_BUDGET_PERIOD = 'day';
    db.client.auth.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    fetchSpy.mockReset().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello.' } }],
    }), { headers: { 'Content-Type': 'application/json' } }));
  });
  afterAll(() => {
    fetchSpy.mockRestore();
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  function post(member = true) {
    db.mockResponses(
      { data: { id: USER_ID, deleted_at: null }, error: null },
      { data: member ? { id: '22222222-2222-4222-8222-222222222222', role: 'member', display_name: 'Ada', is_active: true, workspace_id: WORKSPACE_ID } : null, error: null },
      { data: { id: WORKSPACE_ID, name: 'Family', base_currency: 'NGN' }, error: null },
    );
    return request(app).post(PATH).set('Authorization', 'Bearer TEST_TOKEN').send({ message: 'Hello' });
  }

  it('allows authenticated chat while Redis is reconnecting', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.data.text).toBe('Hello.');
    expect(redis.call).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still requires membership from the database during an outage', async () => {
    const res = await post(false);
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('continues after command deadlines when Redis appears ready but stalls', async () => {
    redis.status = 'ready';
    const res = await post();
    expect(res.status).toBe(200);
    expect(redis.call).toHaveBeenCalled();
    expect(redis.get).toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  }, 20000);
});
