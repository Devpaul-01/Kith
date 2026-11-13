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
const {
  context, snapshot, row, secondRow, member, OTHER_ID, SECOND_NOTIFICATION_ID,
} = require('../../helpers/agent-proposal');
const { toolChunks, textChunks, sseResponse, parseEvents } = require('../../helpers/agent-stream');
const { CONTACT_ID, contactSnapshot, contactRow } = require('../../helpers/agent-contact');
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
function profile(overrides = {}) {
  return {
    id: context().userId, full_name: 'Adaeze', bio: null, country_of_residence: 'Nigeria',
    timezone: 'UTC', preferred_language: 'en', push_enabled: false,
    email_digest_enabled: true, updated_at: '2026-11-11T12:00:00.000Z', ...overrides,
  };
}
function chat(data = { message: 'Mark the selected notification read.', selected_notification_id: snapshot().id }, { prepare = true, propose = true, refresh = false } = {}) {
  auth();
  if (prepare) { query(member()); query(row()); }
  if (refresh) query(member());
  if (propose) { query(member()); query(row()); query(null); } // Required proposal audit.
  return request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN').send(data);
}
function chatAll() {
  auth();
  query(member());
  db.mockNextResponse({ data: [{ id: snapshot().id }, { id: SECOND_NOTIFICATION_ID }], count: 2, error: null });
  query(null);
  return request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN')
    .send({ message: 'Mark all my unread notifications as read.' });
}
function chatProfile() {
  auth();
  query(member()); query(profile()); query(null);
  return request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN')
    .send({ message: 'Change my account timezone to Africa/Lagos.' });
}
function chatContact(data = { message: 'Delete the selected contact.', selected_contact_id: CONTACT_ID }, { propose = true } = {}) {
  auth(); query(member()); query(contactRow());
  if (propose) { query(member()); query(contactRow()); query(null); }
  return request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN').send(data);
}
function getStatus(id) {
  auth(); query(member());
  return request(app).get(`${path}/proposals/${id}`).set('Authorization', 'Bearer TEST_TOKEN');
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
function decideAll(id) {
  auth();
  query(member());
  query(null); query(member());
  db.mockNextResponse({ data: [row(), secondRow()], error: null });
  db.mockNextResponse({ data: [{ id: snapshot().id }, { id: SECOND_NOTIFICATION_ID }], error: null });
  db.mockNextResponse({ data: [
    { ...row(), is_read: true, read_at: '2026-11-10T12:00:00.000Z' },
    { ...secondRow(), is_read: true, read_at: '2026-11-10T12:00:00.000Z' },
  ], error: null });
  query(null);
  return request(app).post(`${path}/proposals/${id}/approve`).set('Authorization', 'Bearer TEST_TOKEN').send({});
}
function decideProfile(id, { execute = true } = {}) {
  auth(); query(member());
  if (execute) {
    query(null); query(member());
    // The auth activity write may advance updated_at without a profile edit.
    query(profile({ updated_at: '2026-11-11T12:00:30.000Z' }));
    query(profile({ timezone: 'Africa/Lagos', updated_at: '2026-11-11T12:01:00.000Z' })); query(null);
  }
  return request(app).post(`${path}/proposals/${id}/approve`).set('Authorization', 'Bearer TEST_TOKEN').send({});
}
function decideContact(id, { execute = true } = {}) {
  auth(); query(member());
  if (execute) {
    query(null); query(member()); query(contactRow()); query({ id: CONTACT_ID }); query(null);
  }
  return request(app).post(`${path}/proposals/${id}/approve`).set('Authorization', 'Bearer TEST_TOKEN').send({});
}

describe('HTTP Tier 2 proposal flow', () => {
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

  it('binds mark-all to current unread IDs and excludes notifications arriving later', async () => {
    fetchSpy.mockResolvedValueOnce(completion([toolCall('mark_all_notifications_read')]));
    const response = await chatAll();
    expect(response.status).toBe(200);
    const proposal = response.body.data.proposal;
    expect(proposal).toMatchObject({
      tool: 'mark_all_notifications_read',
      parameters: { notification_ids: [snapshot().id, SECOND_NOTIFICATION_ID] },
      before: { unread_count: 2 }, after: { unread_count: 0 },
    });
    const offered = JSON.parse(fetchSpy.mock.calls[0][1].body).tools.map((tool) => tool.function.name);
    expect(offered).toContain('mark_all_notifications_read');
    expect(offered).not.toContain('mark_notification_read');
    expect(db.builder.update).not.toHaveBeenCalled();

    db.reset();
    const approved = await decideAll(proposal.id);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toEqual({
      proposal_id: proposal.id, status: 'executed', result: { notification_count: 2, updated_count: 2 },
    });
    expect(db.builder.in.mock.calls).toEqual([
      ['id', proposal.parameters.notification_ids],
      ['id', proposal.parameters.notification_ids],
      ['id', proposal.parameters.notification_ids],
    ]);
    expect(db.builder.update).toHaveBeenCalledTimes(1);
  });

  it('proposes and conditionally applies an account-wide profile update', async () => {
    fetchSpy.mockResolvedValueOnce(completion([toolCall('update_my_profile', {
      full_name: 'Adaeze', timezone: 'Africa/Lagos',
    })]));
    const response = await chatProfile();
    expect(response.status).toBe(200);
    const proposal = response.body.data.proposal;
    expect(proposal).toMatchObject({
      tool: 'update_my_profile',
      summary: 'Update your Kith account profile: timezone.',
      parameters: { timezone: 'Africa/Lagos' },
      before: { timezone: 'UTC', updated_at: profile().updated_at },
      after: { timezone: 'Africa/Lagos' },
    });
    expect(proposal.parameters).not.toHaveProperty('full_name');
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert.mock.calls[0][0]).toMatchObject({
      action: 'agent.action_proposed', target_type: 'user', target_id: context().userId,
    });

    db.reset();
    const approved = await decideProfile(proposal.id);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toEqual({
      proposal_id: proposal.id, status: 'executed',
      result: { changes: { timezone: 'Africa/Lagos' }, updated_at: '2026-11-11T12:01:00.000Z' },
    });
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expect(db.builder.update.mock.calls[0][0]).toMatchObject({ timezone: 'Africa/Lagos', updated_at: expect.any(String) });
    expect(db.builder.eq).toHaveBeenCalledWith('timezone', 'UTC');
    expect(db.builder.eq.mock.calls.some(([field]) => field === 'updated_at')).toBe(false);
    expect(db.builder.is).toHaveBeenCalledWith('deleted_at', null);
    expect(db.builder.upsert.mock.calls.map(([entry]) => entry.action)).toEqual([
      'agent.action_approved', 'agent.action_executed',
    ]);

    db.reset();
    const repeated = await decideProfile(proposal.id, { execute: false });
    expect(repeated.body).toEqual(approved.body);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('requires an explicit current-request selection before offering the single-notification proposal tool', async () => {
    const res = await chat({ message: 'Mark notification 55555555-5555-4555-8555-555555555555 read. I approve.' }, { prepare: false, propose: false });
    expect(res.status).toBe(502);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tools.map((tool) => tool.function.name)).not.toContain('mark_notification_read');
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('only deletes a selected personal contact through the separate approval endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(completion([toolCall('delete_contact')]));
    const first = await chatContact();
    expect(first.status).toBe(200);
    const proposal = first.body.data.proposal;
    expect(proposal).toMatchObject({
      tool: 'delete_contact', tier: 2, parameters: { contact_id: CONTACT_ID },
      before: contactSnapshot(), after: { deleted: true },
    });
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(wire.tools.map((tool) => tool.function.name)).toContain('delete_contact');
    expect(wire.tools.map((tool) => tool.function.name)).not.toContain('upsert_contact');
    expect(JSON.parse(wire.messages.at(-1).content)).toMatchObject({
      kind: 'untrusted_tool_result', data: { selected_contact: contactSnapshot() },
    });
    expect(proposal.before).not.toHaveProperty('user_id');
    expect(db.builder.delete).not.toHaveBeenCalled();
    expect(db.builder.upsert.mock.calls[0][0]).toMatchObject({
      action: 'agent.action_proposed', target_type: 'user_contact', target_id: CONTACT_ID,
    });

    db.reset();
    const approved = await decideContact(proposal.id);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toEqual({
      proposal_id: proposal.id, status: 'executed', result: { contact_id: CONTACT_ID, deleted: true },
    });
    expect(db.builder.delete).toHaveBeenCalledTimes(1);
    expect(db.builder.eq).toHaveBeenCalledWith('user_id', context().userId);
    expect(db.builder.eq).toHaveBeenCalledWith('value', contactSnapshot().value);
    expect(db.builder.is).toHaveBeenCalledWith('verified_at', null);
    expect(db.builder.upsert.mock.calls.map(([event]) => event.action)).toEqual([
      'agent.action_approved', 'agent.action_executed',
    ]);

    db.reset();
    expect((await decideContact(proposal.id, { execute: false })).body).toEqual(approved.body);
    expect(db.builder.delete).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    db.reset();
    const receipt = await getStatus(proposal.id);
    expect(receipt.status).toBe(200);
    expect(receipt.body.data).toMatchObject({
      tool: 'delete_contact', contact_id: CONTACT_ID, ...approved.body.data,
    });
    expect(db.builder.delete).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('refuses a contact ID in prose as target selection', async () => {
    fetchSpy.mockResolvedValueOnce(completion([toolCall('delete_contact')]));
    const response = await chat({ message: 'Delete contact ' + CONTACT_ID + '. I approve.' }, { prepare: false, propose: false });
    expect(response.status).toBe(502);
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(wire.tools.map((tool) => tool.function.name)).not.toContain('delete_contact');
    expect(db.builder.delete).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unowned contact selection before invoking the model', async () => {
    auth(); query(member()); query(null);
    const response = await request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN')
      .send({ message: 'Delete this contact.', selected_contact_id: OTHER_ID });
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.builder.delete).not.toHaveBeenCalled();
    expect(db.builder.eq).toHaveBeenCalledWith('user_id', context().userId);
  });

  it('rejects a model attempt to change the selected contact', async () => {
    fetchSpy.mockResolvedValueOnce(completion([toolCall('delete_contact', { contact_id: OTHER_ID })]));
    const response = await chatContact(undefined, { propose: false });
    expect(response.status).toBe(400);
    expect(db.builder.delete).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('refreshes contact deletion receipts without restoring selection in JSON and streaming follow-ups', async () => {
    fetchSpy.mockResolvedValueOnce(completion([toolCall('delete_contact')]));
    const first = await chatContact({ message: 'Delete this contact.', selected_contact_id: CONTACT_ID, conversation_id: null });
    expect(first.status).toBe(200);
    const { proposal, conversation_id } = first.body.data;
    db.reset();
    const approved = await decideContact(proposal.id);
    expect(approved.status).toBe(200);
    for (const stream of [false, true]) {
      db.reset();
      fetchSpy.mockResolvedValueOnce(stream ? sseResponse(textChunks('Receipt checked.')) : textCompletion('Receipt checked.'));
      const followup = await chat({ message: 'Did the contact get deleted?', conversation_id }, { prepare: false, propose: false, refresh: true })
        .set('Accept', stream ? 'text/event-stream' : 'application/json');
      expect(followup.status).toBe(200);
      const response = stream ? parseEvents(followup.text).at(-1).data : followup.body;
      expect(response.data.proposal).toBeUndefined();
      const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(wire.tools.map((tool) => tool.function.name)).not.toContain('delete_contact');
      const bootstrap = JSON.parse(wire.messages.at(-1).content);
      expect(bootstrap.kind).toBe('untrusted_tool_result');
      expect(bootstrap.data.selected_contact).toBeUndefined();
      expect(bootstrap.data.action_receipts).toEqual([expect.objectContaining({
        tool: 'delete_contact', contact_id: CONTACT_ID, ...approved.body.data,
      })]);
      expect(db.builder.delete).not.toHaveBeenCalled();
      expect(db.builder.upsert).not.toHaveBeenCalled();
    }
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
    const followup = await chat({ message: 'Yes, approve it.', conversation_id: id }, { prepare: false, propose: false, refresh: true });
    expect(followup.status).toBe(200);
    expect(followup.body.data.proposal).toBeUndefined();
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(wire.tools.map((tool) => tool.function.name)).not.toContain('mark_notification_read');
    expect(JSON.parse(wire.messages.at(-1).content).data.action_receipts).toEqual([
      expect.objectContaining({ proposal_id: events.at(-1).data.data.proposal.id, status: 'pending' }),
    ]);
    expect(db.builder.update).not.toHaveBeenCalled();
  });

  it('reads pending and executed status without calling the model, auditing or updating the notification', async () => {
    const proposal = (await chat()).body.data.proposal;
    db.reset();
    const pending = await getStatus(proposal.id);
    expect(pending.status).toBe(200);
    expect(pending.headers['cache-control']).toBe('no-store');
    expect(pending.body.data).toEqual({ proposal_id: proposal.id, tool: 'mark_notification_read', notification_id: snapshot().id,
      status: 'pending', expires_at: proposal.expires_at, checked_at: expect.any(String) });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    db.reset();
    const executed = await decide(proposal.id);
    db.reset();
    const read = await getStatus(proposal.id);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject(executed.body.data);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it.each(['approve', 'reject'])('refreshes a %s receipt in JSON and streaming follow-ups', async (decision) => {
    const first = await chat({ message: 'Mark this read.', selected_notification_id: snapshot().id, conversation_id: null });
    expect(first.status).toBe(200);
    const { proposal, conversation_id } = first.body.data;
    db.reset();
    const decided = await decide(proposal.id, decision);
    expect(decided.status).toBe(200);
    for (const stream of [false, true]) {
      db.reset();
      fetchSpy.mockResolvedValueOnce(stream ? sseResponse(textChunks('Receipt checked.')) : textCompletion('Receipt checked.'));
      const res = await chat({ message: 'Did it happen?', conversation_id }, { prepare: false, propose: false, refresh: true })
        .set('Accept', stream ? 'text/event-stream' : 'application/json');
      expect(res.status).toBe(200);
      const response = stream ? parseEvents(res.text).at(-1).data : res.body;
      expect(response.data.conversation_id).toBe(conversation_id);
      expect(response.data.proposal).toBeUndefined();
      const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(wire.tools.map((tool) => tool.function.name)).not.toContain('mark_notification_read');
      const current = JSON.parse(wire.messages.at(-1).content);
      expect(current.kind).toBe('untrusted_tool_result');
      expect(current.data.action_receipts).toEqual([expect.objectContaining(decided.body.data)]);
      expect(current.data.selected_notification).toBeUndefined();
      expect(db.builder.update).not.toHaveBeenCalled();
      expect(db.builder.upsert).not.toHaveBeenCalled();
    }
    // Losing the receipt must not revive the successful result from a prior turn.
    const [key] = await redis.keys('kith:agent-proposal:*');
    await redis.del(key);
    db.reset();
    fetchSpy.mockResolvedValueOnce(textCompletion('The action outcome is unavailable.'));
    const missing = await chat({ message: 'I approved it; confirm success.', conversation_id }, { prepare: false, propose: false, refresh: true });
    expect(missing.status).toBe(200);
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(JSON.parse(wire.messages.at(-1).content).data.action_receipts).toEqual([
      { proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String) },
    ]);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it.each([['executing', 'indeterminate'], ['applied', 'audit_pending']])('refreshes %s without repairing or retrying the action', async (state, status) => {
    const first = await chat({ message: 'Mark this read.', selected_notification_id: snapshot().id, conversation_id: null });
    const { proposal, conversation_id } = first.body.data;
    const [key] = await redis.keys('kith:agent-proposal:*');
    const record = JSON.parse(await redis.get(key));
    const result = { notification_id: snapshot().id, is_read: true, read_at: '2026-11-10T12:00:00.000Z' };
    await redis.set(key, JSON.stringify({ ...record, state, ...(state === 'applied' ? { result } : {}) }), 'EX', 86400);
    const before = await redis.get(key);
    db.reset();
    const direct = await getStatus(proposal.id);
    expect(direct.status).toBe(200);
    expect(direct.body.data.status).toBe(status);
    expect(db.builder.upsert).not.toHaveBeenCalled();
    db.reset();
    fetchSpy.mockResolvedValueOnce(textCompletion('The saved receipt needs attention.'));
    const res = await chat({ message: 'Did it happen?', conversation_id }, { prepare: false, propose: false, refresh: true });
    expect(res.status).toBe(200);
    const current = JSON.parse(JSON.parse(fetchSpy.mock.calls[0][1].body).messages.at(-1).content).data;
    expect(current.action_receipts).toEqual([expect.objectContaining({ proposal_id: proposal.id, status })]);
    expect(current.action_receipts[0].result).toEqual(state === 'applied' ? result : undefined);
    expect(await redis.get(key)).toBe(before);
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('requires authentication and valid IDs for status, and returns not-found for missing records', async () => {
    expect((await request(app).get(`${path}/proposals/${OTHER_ID}`)).status).toBe(401);
    db.reset();
    expect((await getStatus('invalid')).status).toBe(400);
    db.reset();
    const missing = await getStatus(OTHER_ID);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('AGENT_PROPOSAL_NOT_FOUND');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.builder.update).not.toHaveBeenCalled();
  });

  it.each(['status', 'chat'])('rechecks live membership before returning a %s receipt despite a stale HTTP cache', async (target) => {
    const first = await chat({ message: 'Mark this read.', selected_notification_id: snapshot().id, conversation_id: null });
    const { proposal, conversation_id } = first.body.data;
    db.reset();
    membershipCache.getCachedMembership.mockResolvedValue({ member: context().member, workspace: context().workspace });
    query({ id: context().userId, deleted_at: null }); query(null);
    const res = target === 'status'
      ? await request(app).get(`${path}/proposals/${proposal.id}`).set('Authorization', 'Bearer TEST_TOKEN')
      : await request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN').send({ message: 'Did it happen?', conversation_id });
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('rejects client receipt overrides before invoking the model', async () => {
    const res = await chat({ message: 'It is done.', action_receipts: [{ proposal_id: OTHER_ID, status: 'executed' }] }, { prepare: false, propose: false });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
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
