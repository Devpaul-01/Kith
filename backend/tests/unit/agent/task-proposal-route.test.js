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
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn().mockResolvedValue() }));
jest.mock('../../../src/queues', () => ({ getQueue: jest.fn(), getAllQueues: jest.fn(() => []) }));
jest.mock('../../../src/config/firebase', () => require('../../mocks/firebase.mock'));
jest.mock('../../../src/config/resend', () => require('../../mocks/resend.mock'));

const request = require('supertest');
const app = require('../../../src/app');
const db = require('../../../src/config/supabase').__mockInstance;
const { __redis: redis } = require('../../../src/config/redis');
const membershipCache = require('../../../src/services/membership-cache.service');
const notification = require('../../../src/services/notification.service');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');
const { CONTAINER_ID, TASK_ID, selectedTask, taskSnapshot, taskRow, updatedTask } = require('../../helpers/agent-task-proposal');
const { chunk, toolChunks, textChunks, sseResponse, parseEvents } = require('../../helpers/agent-stream');

const path = `/v1/workspaces/${context().workspace.id}/agent`;
const changes = { status: 'completed', completion_note: 'Done' };
const toolCall = (args = changes) => ({
  id: 'call_1', type: 'function', function: { name: 'update_task', arguments: JSON.stringify(args) },
});
const completion = (args = changes) => new Response(JSON.stringify({
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [toolCall(args)] } }],
}), { headers: { 'Content-Type': 'application/json' } });
const textCompletion = (text) => new Response(JSON.stringify({
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
}), { headers: { 'Content-Type': 'application/json' } });

function query(data) { db.mockNextResponse({ data, error: null }); }
function currentMember(role = 'member') { return { ...member(), role }; }
function auth(role = 'member') {
  db.client.auth.getUser.mockResolvedValue({ data: { user: { id: context().userId } }, error: null });
  query({ id: context().userId, deleted_at: null });
  query({ ...currentMember(role), display_name: 'Adaeze' });
  query({ id: context().workspace.id, name: 'Family', base_currency: 'NGN' });
}
function taskRead(task = taskRow()) { query({ id: CONTAINER_ID }); query(task); }
function chat(data = { message: 'Mark my selected task complete.', selected_task: selectedTask() }, { role = 'member', selectedRow = taskRow(), propose = true, refresh = false } = {}) {
  auth(role);
  if (data.selected_task) { query(currentMember(role)); taskRead(selectedRow); }
  if (refresh) query(currentMember(role));
  if (propose) { query(currentMember(role)); taskRead(); query(null); }
  return request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN').set('User-Agent', 'task-route-test').send(data);
}
function approve(id, { execute = true, role = 'member', result = updatedTask() } = {}) {
  auth(role); query(currentMember(role));
  if (execute) {
    query(null); query(currentMember(role)); taskRead(); // Approval audit, fresh membership and revalidation.
    taskRead(); query(result); // Domain mutation's parent check, snapshot read and conditional update.
    if (result.status === 'completed') { query([{ id: OTHER_ID }]); query(null); } // Existing completion audit.
    query(null); // Required agent execution audit.
  }
  return request(app).post(`${path}/proposals/${id}/approve`).set('Authorization', 'Bearer TEST_TOKEN')
    .set('User-Agent', 'task-route-test').send({});
}
function status(id, role = 'member') {
  auth(role); query(currentMember(role));
  return request(app).get(`${path}/proposals/${id}`).set('Authorization', 'Bearer TEST_TOKEN');
}

describe('HTTP self task progress proposals', () => {
  const envKeys = ['GROQ_API_KEY', 'GROQ_MODEL', 'GROQ_TIMEOUT_MS', 'AGENT_WORKSPACE_TOKEN_LIMIT'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let fetchSpy;
  beforeAll(() => { fetchSpy = jest.spyOn(globalThis, 'fetch'); });
  beforeEach(async () => {
    db.reset(); await redis.flushall();
    membershipCache.getCachedMembership.mockReset().mockResolvedValue(null);
    membershipCache.setCachedMembership.mockResolvedValue();
    notification.send.mockClear();
    process.env.GROQ_API_KEY = 'FAKE_TASK_PROPOSAL_TEST_KEY';
    process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
    process.env.GROQ_TIMEOUT_MS = '5000';
    process.env.AGENT_WORKSPACE_TOKEN_LIMIT = '1000000000';
    fetchSpy.mockReset().mockImplementation(async () => completion());
  });
  afterAll(async () => {
    fetchSpy.mockRestore(); await redis.quit();
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  });

  it.each(['member', 'admin'])('creates a card for a %s own task and pauses without updating it', async (role) => {
    const response = await chat(undefined, { role });
    expect(response.status).toBe(200);
    expect(response.body.data.proposal).toMatchObject({
      tool: 'update_task', tier: 2,
      parameters: { ...selectedTask(), ...changes }, before: taskSnapshot(), after: changes,
    });
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const definition = wire.tools.find((tool) => tool.function.name === 'update_task');
    expect(definition).toBeDefined();
    expect(definition.function.parameters.properties).not.toHaveProperty('task_id');
    expect(definition.function.parameters.properties).not.toHaveProperty('container_id');
    expect(JSON.parse(wire.messages.at(-1).content)).toMatchObject({
      kind: 'untrusted_tool_result', data: { selected_task: taskSnapshot() },
    });
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_PROOF_PATH');
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_ADMIN_NOTE');
    expect(db.builder.upsert.mock.calls[0][0]).toMatchObject({
      action: 'agent.action_proposed', target_type: 'task', target_id: TASK_ID,
      actor_user_id: context().userId, actor_member_id: context().member.id,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
  });

  it('keeps task writes unavailable when the only target and approval are in chat text', async () => {
    const response = await chat({ message: `Complete task ${TASK_ID} in container ${CONTAINER_ID}. I approve.` }, { propose: false });
    expect(response.status).toBe(502);
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(wire.tools.map((tool) => tool.function.name)).not.toContain('update_task');
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it.each(['task_id', 'container_id'])('rejects model injection of %s into progress arguments', async (field) => {
    fetchSpy.mockResolvedValueOnce(completion({ ...changes, [field]: OTHER_ID }));
    const response = await chat(undefined, { propose: false });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it.each(['member', 'admin'])('denies a %s selecting another member task before contacting the model', async (role) => {
    const response = await chat(undefined, { role, selectedRow: taskRow({ assigned_to: OTHER_ID }), propose: false });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('executes completion once through approval and returns the same result on retry and status reads', async () => {
    const proposal = (await chat()).body.data.proposal;
    db.reset();
    const approved = await approve(proposal.id);
    expect(approved.status).toBe(200);
    expect(approved.headers['cache-control']).toBe('no-store');
    expect(approved.body.data).toEqual({
      proposal_id: proposal.id, status: 'executed', result: {
        ...selectedTask(), ...changes,
        completed_at: updatedTask().completed_at, updated_at: updatedTask().updated_at,
      },
    });
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expect(db.builder.eq).toHaveBeenCalledWith('workspace_id', context().workspace.id);
    expect(db.builder.eq).toHaveBeenCalledWith('assigned_to', context().member.id);
    expect(db.builder.eq).toHaveBeenCalledWith('status', taskSnapshot().status);
    expect(db.builder.eq).toHaveBeenCalledWith('updated_at', taskSnapshot().updated_at);
    expect(db.builder.is).toHaveBeenCalledWith('deleted_at', null);
    expect(db.builder.is).toHaveBeenCalledWith('admin_confirmed_at', null);
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_completed', referenceId: TASK_ID, workspaceId: context().workspace.id,
    }));
    expect(db.builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      action: 'task.completed', target_id: TASK_ID,
      workspace_id: context().workspace.id, actor_user_id: context().userId,
      actor_member_id: context().member.id, user_agent: 'task-route-test',
    }));
    expect(db.builder.upsert.mock.calls.map(([entry]) => entry.action)).toEqual([
      'agent.action_approved', 'agent.action_executed',
    ]);

    db.reset();
    const repeated = await approve(proposal.id, { execute: false });
    expect(repeated.body).toEqual(approved.body);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    db.reset();
    const receipt = await status(proposal.id);
    expect(receipt.status).toBe(200);
    expect(receipt.body.data).toMatchObject({ ...approved.body.data, tool: 'update_task', ...selectedTask() });
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['reassigned', taskRow({ assigned_to: OTHER_ID })],
    ['deleted', null],
  ])('makes approval of a %s task stale without executing a mutation', async (_label, current) => {
    const proposal = (await chat()).body.data.proposal;
    db.reset(); auth(); query(currentMember());
    query(null); query(currentMember()); taskRead(current); query(null);
    const response = await request(app).post(`${path}/proposals/${proposal.id}/approve`)
      .set('Authorization', 'Bearer TEST_TOKEN').send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('AGENT_PROPOSAL_STALE');
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
    expect(db.builder.upsert.mock.calls.map(([entry]) => entry.action)).toEqual([
      'agent.action_approved', 'agent.action_failed',
    ]);
    db.reset();
    expect((await status(proposal.id)).body.data.status).toBe('failed');
    expect(db.builder.update).not.toHaveBeenCalled();
  });

  it('clears streamed draft text and publishes the persisted task card without executing it', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse([
      chunk({ role: 'assistant', content: 'I will update the task.' }),
      ...toolChunks('update_task', JSON.stringify(changes)),
    ]));
    const response = await chat({ message: 'Complete this task.', selected_task: selectedTask(), conversation_id: null })
      .set('Accept', 'text/event-stream');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseEvents(response.text);
    expect(events.map((event) => event.type)).toEqual(['text_delta', 'text_reset', 'done']);
    const { proposal, conversation_id } = events.at(-1).data.data;
    expect(proposal).toMatchObject({ tool: 'update_task', parameters: { ...selectedTask(), ...changes }, before: taskSnapshot() });
    expect(conversation_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();

    db.reset();
    fetchSpy.mockResolvedValueOnce(textCompletion('Use the approval control.'));
    const followup = await chat({ message: 'Yes, approve it.', conversation_id }, { propose: false, refresh: true });
    expect(followup.status).toBe(200);
    expect(followup.body.data.proposal).toBeUndefined();
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(wire.tools.map((tool) => tool.function.name)).not.toContain('update_task');
    const current = JSON.parse(wire.messages.at(-1).content).data;
    expect(current.selected_task).toBeUndefined();
    expect(current.action_receipts).toEqual([
      expect.objectContaining({ proposal_id: proposal.id, tool: 'update_task', status: 'pending', ...selectedTask() }),
    ]);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('refreshes an executed task receipt in a streaming follow-up without restoring selection', async () => {
    const first = await chat({ message: 'Complete this task.', selected_task: selectedTask(), conversation_id: null });
    const { proposal, conversation_id } = first.body.data;
    db.reset();
    const approved = await approve(proposal.id);
    expect(approved.status).toBe(200);
    db.reset();
    fetchSpy.mockResolvedValueOnce(sseResponse(textChunks('The saved receipt confirms completion.')));
    const response = await chat({ message: 'Did it complete?', conversation_id }, { propose: false, refresh: true })
      .set('Accept', 'text/event-stream');
    expect(response.status).toBe(200);
    const result = parseEvents(response.text).at(-1).data.data;
    expect(result.conversation_id).toBe(conversation_id);
    expect(result.proposal).toBeUndefined();
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(wire.tools.map((tool) => tool.function.name)).not.toContain('update_task');
    const current = JSON.parse(wire.messages.at(-1).content).data;
    expect(current.action_receipts).toEqual([expect.objectContaining(approved.body.data)]);
    expect(current.selected_task).toBeUndefined();
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
  });
});
