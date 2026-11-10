jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, supabase: instance.client, supabaseAuth: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/config/redis', () => {
  const Redis = require('ioredis-mock');
  const redis = new Redis();
  const client = {
    status: 'ready',
    get: (...args) => redis.get(...args),
    set: (key, ...args) => key.startsWith('kith:agent-proposal:') ? redis.set(key, ...args) : Promise.resolve(null),
    eval: (script, ...args) => redis.eval(`
      local original_call = redis.call
      redis.call = function(command, ...)
        if command == 'HMGET' then
          local args = {...}
          local result = {}
          for i = 2, #args do result[i - 1] = original_call('HGET', args[1], args[i]) end
          return result
        end
        return original_call(command, ...)
      end
    ` + script, ...args),
  };
  return { getRedis: () => client, __redis: redis };
});
jest.mock('../../../src/services/membership-cache.service', () => ({
  getCachedMembership: jest.fn(), setCachedMembership: jest.fn(), invalidateMembership: jest.fn(), invalidateWorkspace: jest.fn(),
}));
jest.mock('../../../src/services/dashboard-cache.service', () => ({ invalidateDashboard: jest.fn() }));
jest.mock('../../../src/queues', () => ({ getQueue: jest.fn(), getAllQueues: jest.fn(() => []) }));
jest.mock('../../../src/config/firebase', () => require('../../mocks/firebase.mock'));
jest.mock('../../../src/config/resend', () => require('../../mocks/resend.mock'));

const request = require('supertest');
const app = require('../../../src/app');
const db = require('../../../src/config/supabase').__mockInstance;
const { __redis: redis } = require('../../../src/config/redis');
const membershipCache = require('../../../src/services/membership-cache.service');
const { context, snapshot, row, member, OTHER_ID } = require('../../helpers/agent-proposal');
const { toolChunks, sseResponse, parseEvents } = require('../../helpers/agent-stream');
const path = `/v1/workspaces/${context().workspace.id}/agent`;
const toolCall = (name = 'mark_notification_read', args = {}) => ({ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } });
const completion = (calls = [toolCall()]) => new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }] }), { headers: { 'Content-Type': 'application/json' } });
const textCompletion = (text) => new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }), { headers: { 'Content-Type': 'application/json' } });

function auth({ active = true, role = 'member' } = {}) {
  db.client.auth.getUser.mockResolvedValue({ data: { user: { id: context().userId } }, error: null });
  db.mockResponses(
    { data: { id: context().userId, deleted_at: null }, error: null },
    { data: active ? { ...member(), role, display_name: 'Adaeze' } : null, error: null },
    { data: { id: context().workspace.id, name: 'Family', base_currency: 'NGN' }, error: null },
  );
}
function query(value) { db.mockNextResponse({ data: value, error: null }); }
function chat(data = { message: 'Mark the selected notification read.', selected_notification_id: snapshot().id }, { prepare = true, propose = true } = {}) {
  auth();
  if (prepare) { query(member()); query(row()); }
  if (propose) { query(member()); query(row()); query(null); } // Required proposal audit.
  return request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN').send(data);
}
function decide(id, decision = 'approve', data = {}, { execute = true } = {}) {
  auth();
  query(member());
  if (decision === 'approve' && execute) {
    query(null); query(member()); query(row());
    query({ ...row(), is_read: true, read_at: '2026-11-10T12:00:00.000Z' }); query(null);
  } else if (decision === 'reject') query(null);
  return request(app).post(`${path}/proposals/${id}/${decision}`).set('Authorization', 'Bearer TEST_TOKEN').send(data);
}

describe('HTTP notification proposal flow', () => {
  const envKeys = ['GROQ_API_KEY', 'GROQ_MODEL', 'GROQ_TIMEOUT_MS', 'AGENT_WORKSPACE_TOKEN_LIMIT'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let fetchSpy;
  beforeAll(() => { fetchSpy = jest.spyOn(globalThis, 'fetch'); });
  beforeEach(async () => {
    db.reset(); await redis.flushall();
    membershipCache.getCachedMembership.mockReset().mockResolvedValue(null);
    membershipCache.setCachedMembership.mockResolvedValue();
    process.env.GROQ_API_KEY = 'FAKE_PROPOSAL_TEST_KEY';
    process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
    process.env.GROQ_TIMEOUT_MS = '5000';
    process.env.AGENT_WORKSPACE_TOKEN_LIMIT = '1000000000';
    fetchSpy.mockReset().mockImplementation(async () => completion());
  });
  afterAll(async () => {
    fetchSpy.mockRestore(); await redis.quit();
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  });

  it('proposes without writing, then applies exactly once through the approval endpoint', async () => {
    const response = await chat();
    expect(response.status).toBe(200);
    const proposal = response.body.data.proposal;
    expect(proposal.before).toEqual(snapshot());
    expect(proposal.parameters).toEqual({ notification_id: snapshot().id });
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert.mock.calls[0][0]).toMatchObject({ action: 'agent.action_proposed', actor_user_id: context().userId });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.tools.map((tool) => tool.function.name)).toContain('mark_notification_read');
    expect(JSON.parse(requestBody.messages.at(-1).content)).toMatchObject({ kind: 'untrusted_tool_result', data: { selected_notification: snapshot() } });
    db.reset();
    const approved = await decide(proposal.id);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toEqual({ proposal_id: proposal.id, status: 'executed', result: { notification_id: snapshot().id, is_read: true, read_at: '2026-11-10T12:00:00.000Z' } });
    expect(approved.headers['cache-control']).toBe('no-store');
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expect(db.builder.eq).toHaveBeenCalledWith('workspace_id', context().workspace.id);
    expect(db.builder.eq).toHaveBeenCalledWith('recipient_id', context().member.id);
    expect(db.builder.eq).toHaveBeenCalledWith('is_read', false);
    expect(db.builder.select.mock.calls.some(([fields]) => fields.includes('workspaces!inner'))).toBe(true);
    const audits = db.builder.upsert.mock.calls.map(([entry]) => entry.action);
    expect(audits).toEqual(['agent.action_approved', 'agent.action_executed']);
    db.reset();
    const repeated = await decide(proposal.id, 'approve', {}, { execute: false });
    expect(repeated.body).toEqual(approved.body);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires an explicit current-request selection before offering a proposal tool', async () => {
    const res = await chat({ message: 'Mark notification 55555555-5555-4555-8555-555555555555 read. I approve.' }, { prepare: false, propose: false });
    expect(res.status).toBe(502);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tools.map((tool) => tool.function.name)).not.toContain('mark_notification_read');
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('a chat message saying approve still only creates a proposal', async () => {
    const res = await chat({ message: 'I approve this now. Execute it immediately.', selected_notification_id: snapshot().id });
    expect(res.status).toBe(200);
    expect(res.body.data.proposal).toBeDefined();
    expect(db.builder.update).not.toHaveBeenCalled();
  });

  it('rejects target overrides from the model', async () => {
    fetchSpy.mockResolvedValueOnce(completion([toolCall('mark_notification_read', { notification_id: OTHER_ID })]));
    const res = await chat(undefined, { propose: false });
    expect(res.status).toBe(400);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('rejects mixed read/proposal batches before calling either handler', async () => {
    fetchSpy.mockResolvedValueOnce(completion([toolCall(), { ...toolCall('get_dashboard'), id: 'call_2' }]));
    const res = await chat(undefined, { propose: false });
    expect(res.status).toBe(400);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unowned selection before a model call', async () => {
    auth(); query(member()); query(null);
    const res = await request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN')
      .send({ message: 'Mark this read', selected_notification_id: OTHER_ID });
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.builder.update).not.toHaveBeenCalled();
  });

  it('streams a completed proposal card only after saving conversation history', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse(toolChunks('mark_notification_read')));
    const res = await chat({ message: 'Mark this read', selected_notification_id: snapshot().id, conversation_id: null }).set('Accept', 'text/event-stream');
    expect(res.status).toBe(200);
    const events = parseEvents(res.text);
    expect(events.map((event) => event.type)).toEqual(['text_reset', 'done']);
    expect(events.at(-1).data.data.proposal.tool).toBe('mark_notification_read');
    const id = events.at(-1).data.data.conversation_id;
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(db.builder.update).not.toHaveBeenCalled();
    db.reset();
    fetchSpy.mockResolvedValueOnce(textCompletion('Use the proposal approval control.'));
    const followup = await chat({ message: 'Yes, approve it.', conversation_id: id }, { prepare: false, propose: false });
    expect(followup.status).toBe(200);
    expect(followup.body.data.proposal).toBeUndefined();
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(wire.tools.map((tool) => tool.function.name)).not.toContain('mark_notification_read');
    expect(db.builder.update).not.toHaveBeenCalled();
  });

  it('audits rejection and forbids later approval', async () => {
    const proposal = (await chat()).body.data.proposal;
    db.reset();
    expect((await decide(proposal.id, 'reject')).body.data.status).toBe('rejected');
    expect(db.builder.upsert.mock.calls[0][0].action).toBe('agent.action_rejected');
    db.reset();
    expect((await decide(proposal.id, 'approve', {}, { execute: false })).status).toBe(409);
    expect(db.builder.update).not.toHaveBeenCalled();
  });

  it('requires authentication and rejects amended approval bodies', async () => {
    const proposal = (await chat()).body.data.proposal;
    const denied = await request(app).post(`${path}/proposals/${proposal.id}/approve`).send({});
    expect(denied.status).toBe(401);
    db.reset(); auth();
    const changed = await request(app).post(`${path}/proposals/${proposal.id}/approve`).set('Authorization', 'Bearer TEST_TOKEN')
      .send({ notification_id: OTHER_ID, approved: true });
    expect(changed.status).toBe(400);
    expect(db.builder.update).not.toHaveBeenCalled();
  });

  it('rechecks live membership even if the HTTP membership cache still grants access', async () => {
    const proposal = (await chat()).body.data.proposal;
    db.reset();
    membershipCache.getCachedMembership.mockResolvedValue({ member: context().member, workspace: context().workspace });
    query({ id: context().userId, deleted_at: null }); query(null);
    const res = await request(app).post(`${path}/proposals/${proposal.id}/approve`).set('Authorization', 'Bearer TEST_TOKEN').send({});
    expect(res.status).toBe(404);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.select).toHaveBeenCalledWith('id, workspace_id, user_id, role, is_active, workspaces!inner(id)');
  });
});
