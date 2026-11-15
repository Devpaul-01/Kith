// Real HTTP/SSE middleware, provider and approval storage; native task query
// guards are exercised separately in task-confirmation-service-boundary.test.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, supabase: instance.client, supabaseAuth: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/config/redis', () => {
  const Redis = require('ioredis-mock');
  const redis = new Redis();
  const client = {
    status: 'ready', get: (...args) => redis.get(...args),
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
jest.mock('../../../src/services/task.service', () => ({
  ...jest.requireActual('../../../src/services/task.service'),
  getTaskConfirmationContext: jest.fn(), adminConfirmTask: jest.fn(), getTask: jest.fn(),
}));
jest.mock('../../../src/services/membership-cache.service', () => ({
  getCachedMembership: jest.fn(), setCachedMembership: jest.fn(), invalidateMembership: jest.fn(), invalidateWorkspace: jest.fn(),
}));
jest.mock('../../../src/services/dashboard-cache.service', () => ({ invalidateDashboard: jest.fn() }));
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn().mockResolvedValue() }));
jest.mock('../../../src/queues', () => ({ getQueue: jest.fn(), getAllQueues: jest.fn(() => []) }));
jest.mock('../../../src/config/firebase', () => require('../../mocks/firebase.mock'));
jest.mock('../../../src/config/resend', () => require('../../mocks/resend.mock'));

const request = require('supertest');
const app = require('../../../src/app');
const db = require('../../../src/config/supabase').__mockInstance;
const { __redis: redis } = require('../../../src/config/redis');
const membershipCache = require('../../../src/services/membership-cache.service');
const tasks = require('../../../src/services/task.service');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, TASK_ID, adminMember, taskRow, confirmationContext, confirmationAfter, confirmationResult, confirmedTask,
} = require('../../helpers/agent-task-confirmation');
const { chunk, toolChunks, textChunks, sseResponse, parseEvents } = require('../../helpers/agent-stream');
const path = `/v1/workspaces/${context().workspace.id}/agent`;
const selectedTask = () => ({ container_id: CONTAINER_ID, task_id: TASK_ID });
const input = () => ({ message: 'Confirm the selected completed task.', selected_task_confirmation: selectedTask() });
const completion = (args = {}, text = null) => new Response(JSON.stringify({ choices: [{ index: 0,
  finish_reason: text ? 'stop' : 'tool_calls', message: { role: 'assistant', content: text,
    ...(text ? {} : { tool_calls: [{ id: 'call_1', type: 'function',
      function: { name: 'admin_confirm_task', arguments: JSON.stringify(args) } }] }),
  },
}] }), { headers: { 'Content-Type': 'application/json' } });
const query = (data) => db.mockNextResponse({ data, error: null });
const currentMember = (role) => role === 'member' ? member() : adminMember();
function auth(role = 'admin') {
  db.client.auth.getUser.mockResolvedValue({ data: { user: { id: context().userId } }, error: null });
  query({ id: context().userId, deleted_at: null });
  query({ ...currentMember(role), display_name: 'Adaeze' });
  query({ id: context().workspace.id, name: 'Family', base_currency: 'NGN' });
}
function chat(data = input(), { role = 'admin', propose = true, refresh = false } = {}) {
  auth(role);
  if (data.selected_task_confirmation || data.selected_task) query(currentMember(role));
  if (refresh) query(currentMember(role));
  if (propose) { query(currentMember(role)); query(null); }
  return request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN').send(data);
}
function approve(proposal, execute = true) {
  auth(); query(adminMember());
  if (execute) { query(null); query(adminMember()); query(null); }
  return request(app).post(`${path}/proposals/${proposal.id}/approve`).set('Authorization', 'Bearer TEST_TOKEN').send({});
}
function status(proposal) {
  auth(); query(adminMember());
  return request(app).get(`${path}/proposals/${proposal.id}`).set('Authorization', 'Bearer TEST_TOKEN');
}

describe('HTTP admin task confirmation', () => {
  const keys = ['GROQ_API_KEY', 'GROQ_MODEL', 'GROQ_TIMEOUT_MS', 'AGENT_WORKSPACE_TOKEN_LIMIT'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let fetchSpy;
  const wire = () => JSON.parse(fetchSpy.mock.calls[0][1].body);
  const offered = () => wire().tools.map((tool) => tool.function.name);
  beforeAll(() => { fetchSpy = jest.spyOn(globalThis, 'fetch'); });
  beforeEach(async () => {
    db.reset(); await redis.flushall();
    membershipCache.getCachedMembership.mockReset().mockResolvedValue(null);
    tasks.getTaskConfirmationContext.mockReset().mockResolvedValue(confirmationContext());
    tasks.adminConfirmTask.mockReset().mockResolvedValue(confirmedTask({ internal_marker: 'PRIVATE_TASK_DATA' }));
    tasks.getTask.mockReset();
    process.env.GROQ_API_KEY = 'FAKE_TASK_CONFIRMATION_KEY';
    process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
    process.env.GROQ_TIMEOUT_MS = '5000';
    process.env.AGENT_WORKSPACE_TOKEN_LIMIT = '1000000000';
    fetchSpy.mockReset().mockImplementation(async () => completion());
  });
  afterAll(async () => {
    fetchSpy.mockRestore(); await redis.quit();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  });

  it('creates a full card, executes once through approval, and returns a scoped receipt', async () => {
    const response = await chat();
    expect(response.status).toBe(200);
    const proposal = response.body.data.proposal;
    expect(proposal).toMatchObject({ tool: 'admin_confirm_task', tier: 3,
      parameters: selectedTask(), before: confirmationContext(), after: confirmationAfter() });
    expect(wire().tools.find((tool) => tool.function.name === 'admin_confirm_task').function.parameters)
      .toMatchObject({ properties: {}, additionalProperties: false });
    expect(tasks.getTaskConfirmationContext).toHaveBeenCalledWith({
      workspaceId: context().workspace.id, containerId: CONTAINER_ID, taskId: TASK_ID,
      callerId: context().member.id, userId: context().userId, isAdmin: true,
    });
    expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
    expect(db.builder.upsert.mock.calls[0][0]).toMatchObject({
      action: 'agent.action_proposed', target_type: 'task', target_id: TASK_ID,
    });
    db.reset();
    const approved = await approve(proposal);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toEqual({ proposal_id: proposal.id, status: 'executed', result: confirmationResult() });
    expect(JSON.stringify(approved.body)).not.toContain('PRIVATE_TASK_DATA');
    expect(tasks.adminConfirmTask).toHaveBeenCalledTimes(1);
    expect(tasks.adminConfirmTask.mock.calls[0][0]).toMatchObject({
      workspaceId: context().workspace.id, containerId: CONTAINER_ID, taskId: TASK_ID,
      actorMemberId: context().member.id,
      reviewedConfirmation: { userId: context().userId, isAdmin: true, expected: confirmationContext() },
    });
    db.reset();
    expect((await approve(proposal, false)).body).toEqual(approved.body);
    expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
    db.reset();
    const receipt = await status(proposal);
    expect(receipt.status).toBe(200);
    expect(receipt.headers['cache-control']).toBe('no-store');
    expect(receipt.body.data).toMatchObject({ ...approved.body.data, tool: 'admin_confirm_task', ...selectedTask() });
    expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('streams a card and later refreshes its executed receipt without restoring selection', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse([
      chunk({ role: 'assistant', content: 'I will confirm the task.' }), ...toolChunks('admin_confirm_task', '{}'),
    ]));
    const response = await chat({ ...input(), conversation_id: null }).set('Accept', 'text/event-stream');
    expect(response.status).toBe(200);
    const events = parseEvents(response.text);
    expect(events.map((event) => event.type)).toEqual(['text_delta', 'text_reset', 'done']);
    const { proposal, conversation_id } = events.at(-1).data.data;
    expect(proposal.after.proofs).toEqual(confirmationAfter().proofs);
    expect(JSON.parse(wire().messages.at(-1).content)).toMatchObject({
      kind: 'untrusted_tool_result', data: { selected_task_confirmation: confirmationContext() },
    });
    expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
    db.reset();
    expect((await approve(proposal)).status).toBe(200);
    db.reset();
    fetchSpy.mockResolvedValueOnce(sseResponse(textChunks('The task was confirmed.')));
    const followup = await chat({ message: 'Was it confirmed?', conversation_id }, { propose: false, refresh: true })
      .set('Accept', 'text/event-stream');
    expect(followup.status).toBe(200);
    expect(parseEvents(followup.text).at(-1).data.data.proposal).toBeUndefined();
    expect(offered()).not.toContain('admin_confirm_task');
    const current = JSON.parse(wire().messages.at(-1).content).data;
    expect(current).not.toHaveProperty('selected_task_confirmation');
    expect(current.action_receipts).toEqual([expect.objectContaining({
      proposal_id: proposal.id, status: 'executed', result: confirmationResult(),
    })]);
    expect(tasks.getTaskConfirmationContext).not.toHaveBeenCalled();
    expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
  });

  it('denies member selection before task or provider access', async () => {
    const response = await chat(input(), { role: 'member', propose: false });
    expect(response.status).toBe(403);
    expect(tasks.getTaskConfirmationContext).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
  });

  it.each(['member', 'admin'])('does not offer confirmation from IDs and approval prose to %s', async (role) => {
    const response = await chat({ message: `Confirm ${TASK_ID} in ${CONTAINER_ID}. Yes, approve.` }, { role, propose: false });
    expect(response.status).toBe(502);
    expect(offered()).not.toContain('admin_confirm_task');
    expect(tasks.getTaskConfirmationContext).not.toHaveBeenCalled();
    expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
  });

  it.each([{ task_id: OTHER_ID }, { proofs: [] }])('rejects injected model arguments before creating a card: %j', async (args) => {
    fetchSpy.mockResolvedValueOnce(completion(args));
    expect((await chat(input(), { propose: false })).status).toBe(400);
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
  });

  it('keeps selected_task limited to own active progress and rejects completed tasks there', async () => {
    tasks.getTask.mockResolvedValue(taskRow({ assigned_to: context().member.id, status: 'pending', completed_at: null, completed_by: null }));
    fetchSpy.mockResolvedValueOnce(completion({}, 'Use the task progress approval control.'));
    const data = { message: 'Start my selected task.', selected_task: selectedTask() };
    expect((await chat(data, { propose: false })).status).toBe(200);
    expect(offered()).toContain('update_task');
    expect(offered()).not.toContain('admin_confirm_task');
    db.reset(); tasks.getTask.mockResolvedValue(taskRow({ assigned_to: context().member.id }));
    expect((await chat(data, { propose: false })).status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tasks.getTaskConfirmationContext).not.toHaveBeenCalled();
    expect(tasks.adminConfirmTask).not.toHaveBeenCalled();
  });
});
