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
const ledger = require('../../../src/services/ledger.service');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, ENTRY_ID, ledgerContext, workspaceRow, ledgerMember,
  containerRow, participantRow, ledgerArguments, submittedEntry,
} = require('../../helpers/agent-ledger-proposal');
const { chunk, toolChunks, textChunks, sseResponse, parseEvents } = require('../../helpers/agent-stream');

const path = `/v1/workspaces/${context().workspace.id}/agent`;
const toolCall = (args = ledgerArguments()) => ({
  id: 'call_1', type: 'function', function: { name: 'create_ledger_entry', arguments: JSON.stringify(args) },
});
const completion = (args = ledgerArguments()) => new Response(JSON.stringify({
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
function freshContext({ role = 'member', workspace = workspaceRow(), container = containerRow(), participant = participantRow(), stopAfterContainer = false } = {}) {
  query(workspace); query(ledgerMember({ role })); query(container);
  if (!stopAfterContainer) query(participant);
}
function chat(data = { message: 'Record my 5000 NGN contribution.', selected_container_id: CONTAINER_ID }, { role = 'member', propose = true, refresh = false } = {}) {
  auth(role);
  if (data.selected_container_id) { query(currentMember(role)); freshContext({ role }); }
  if (refresh) query(currentMember(role));
  if (propose) { query(currentMember(role)); freshContext({ role }); query(null); }
  return request(app).post(`${path}/chat`).set('Authorization', 'Bearer TEST_TOKEN')
    .set('User-Agent', 'ledger-route-test').send(data);
}
function entry(proposal, overrides = {}) {
  return submittedEntry({ idempotency_key: `agent:${proposal.id}`, corrects_entry_id: null, ...overrides });
}
function approve(proposal, { role = 'member', execute = true, existing = false, returnedEntry = entry(proposal) } = {}) {
  auth(role); query(currentMember(role));
  if (execute) {
    query(null); query(currentMember(role)); freshContext({ role }); // Approval audit and domain revalidation.
    freshContext({ role }); query(existing ? returnedEntry : null); // Service check and idempotency lookup.
    if (!existing) {
      freshContext({ role }); query(returnedEntry); // Final eligibility check and insertion.
      query([{ id: OTHER_ID }]); query(null); // Existing pending-submission audit, after notification delivery.
    }
    query(null); // Required agent execution audit.
  }
  return request(app).post(`${path}/proposals/${proposal.id}/approve`).set('Authorization', 'Bearer TEST_TOKEN')
    .set('User-Agent', 'ledger-route-test').send({});
}
function status(proposal, role = 'member') {
  auth(role); query(currentMember(role));
  return request(app).get(`${path}/proposals/${proposal.id}`).set('Authorization', 'Bearer TEST_TOKEN');
}
function ledgerInserts() {
  return db.builder.insert.mock.calls.map(([row]) => row).filter((row) => Object.hasOwn(row, 'entry_type'));
}

describe('HTTP self contribution proposals', () => {
  const envKeys = ['GROQ_API_KEY', 'GROQ_MODEL', 'GROQ_TIMEOUT_MS', 'AGENT_WORKSPACE_TOKEN_LIMIT'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let fetchSpy;
  let createSpy;
  beforeAll(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    createSpy = jest.spyOn(ledger, 'createEntry');
  });
  beforeEach(async () => {
    db.reset(); await redis.flushall();
    membershipCache.getCachedMembership.mockReset().mockResolvedValue(null);
    membershipCache.setCachedMembership.mockResolvedValue();
    notification.send.mockClear();
    process.env.GROQ_API_KEY = 'FAKE_LEDGER_PROPOSAL_TEST_KEY';
    process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
    process.env.GROQ_TIMEOUT_MS = '5000';
    process.env.AGENT_WORKSPACE_TOKEN_LIMIT = '1000000000';
    fetchSpy.mockReset().mockImplementation(async () => completion());
  });
  afterAll(async () => {
    createSpy.mockRestore(); fetchSpy.mockRestore(); await redis.quit();
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  });

  it.each(['member', 'admin'])('proposes and submits role %s own contribution as pending exactly once', async (role) => {
    const response = await chat(undefined, { role });
    expect(response.status).toBe(200);
    const proposal = response.body.data.proposal;
    expect(proposal).toMatchObject({
      tool: 'create_ledger_entry', tier: 2, before: ledgerContext({ member_role: role }),
      parameters: {
        container_id: CONTAINER_ID, contributor_id: context().member.id, entry_type: 'contribution',
        original_amount: '5000.00', original_currency: 'NGN', base_amount: '5000.00',
        payment_method: 'bank_transfer', note: 'Family groceries', cycle_id: null, is_crypto: false,
      },
      after: { status: 'pending', confirmed_at: null, confirmed_by: null },
    });
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const definition = wire.tools.find((tool) => tool.function.name === 'create_ledger_entry');
    expect(definition.function.parameters.properties.amount.type).toBe('string');
    for (const field of ['container_id', 'contributor_id', 'base_amount', 'status', 'idempotency_key']) {
      expect(definition.function.parameters.properties).not.toHaveProperty(field);
    }
    expect(JSON.parse(wire.messages.at(-1).content)).toMatchObject({
      kind: 'untrusted_tool_result', data: { selected_ledger_container: ledgerContext({ member_role: role }) },
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(db.builder.update).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(db.builder.upsert.mock.calls[0][0]).toMatchObject({
      action: 'agent.action_proposed', target_type: 'container', target_id: CONTAINER_ID,
    });

    db.reset();
    const approved = await approve(proposal, { role });
    expect(approved.status).toBe(200);
    expect(approved.headers['cache-control']).toBe('no-store');
    expect(approved.body.data).toEqual({
      proposal_id: proposal.id, status: 'executed',
      result: { ...proposal.after, entry_id: ENTRY_ID, recorded_at: submittedEntry().recorded_at },
    });
    expect(approved.body.data.result.original_amount).toBe('5000.00');
    expect(approved.body.data.result.base_amount).toBe('5000.00');
    expect(JSON.stringify(approved.body)).not.toContain('PRIVATE_LEDGER_PROOF');
    expect(JSON.stringify(approved.body)).not.toContain(`agent:${proposal.id}`);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      isAdmin: role === 'admin', callerId: context().member.id, force: false,
      idempotencyKey: `agent:${proposal.id}`,
      selfSubmission: { userId: context().userId, expected: ledgerContext({ member_role: role }) },
    }));
    expect(ledgerInserts()).toEqual([expect.objectContaining({
      ...proposal.parameters, workspace_id: context().workspace.id, status: 'pending',
      confirmed_at: null, confirmed_by: null, recorded_by: context().member.id, idempotency_key: `agent:${proposal.id}`,
    })]);
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'contribution_submitted', referenceId: ENTRY_ID, workspaceId: context().workspace.id,
    }));
    expect(db.builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ledger.submitted', target_id: ENTRY_ID, actor_user_id: context().userId,
      actor_member_id: context().member.id, workspace_id: context().workspace.id, user_agent: 'ledger-route-test',
    }));
    expect(db.builder.upsert.mock.calls.map(([row]) => [row.action, row.target_type, row.target_id])).toEqual([
      ['agent.action_approved', 'container', CONTAINER_ID],
      ['agent.action_executed', 'ledger_entry', ENTRY_ID],
    ]);

    db.reset();
    const repeated = await approve(proposal, { role, execute: false });
    expect(repeated.body).toEqual(approved.body);
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    db.reset();
    const receipt = await status(proposal, role);
    expect(receipt.status).toBe(200);
    expect(receipt.body.data).toMatchObject({
      ...approved.body.data, tool: 'create_ledger_entry', container_id: CONTAINER_ID, contributor_id: context().member.id,
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
  });

  it('does not offer contribution writes when only the container ID and approval appear in prose', async () => {
    const response = await chat({ message: `Record 5000 NGN in container ${CONTAINER_ID}. I approve.` }, { propose: false });
    expect(response.status).toBe(502);
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(wire.tools.map((tool) => tool.function.name)).not.toContain('create_ledger_entry');
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it.each([
    ['container_id', OTHER_ID], ['contributor_id', OTHER_ID], ['base_amount', '9000.00'],
    ['original_amount', '9000.00'], ['status', 'confirmed'], ['idempotency_key', 'caller-selected-key'],
  ])('rejects model override of server-controlled %s', async (field, value) => {
    fetchSpy.mockResolvedValueOnce(completion({ ...ledgerArguments(), [field]: value }));
    const response = await chat(undefined, { propose: false });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it.each([5000, '5000.001'])('rejects an amount that cannot be submitted exactly: %j', async (amount) => {
    fetchSpy.mockResolvedValueOnce(completion({ ...ledgerArguments(), amount }));
    const response = await chat(undefined, { propose: false });
    expect(response.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('rejects an approval body attempting to change the reviewed amount', async () => {
    const proposal = (await chat()).body.data.proposal;
    db.reset(); auth();
    const response = await request(app).post(`${path}/proposals/${proposal.id}/approve`)
      .set('Authorization', 'Bearer TEST_TOKEN').send({ original_amount: '9000.00' });
    expect(response.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    db.reset();
    expect((await status(proposal)).body.data.status).toBe('pending');
  });

  it.each([
    ['changed workspace currency', { workspace: workspaceRow({ base_currency: 'USD' }) }],
    ['disabled money participation', { participant: participantRow({ money_enabled: false }) }],
    ['archived container', { container: containerRow({ status: 'archived' }), stopAfterContainer: true }],
    ['deleted container', { container: null, stopAfterContainer: true }],
  ])('rejects approval after %s and stores a failed receipt', async (_label, changed) => {
    const proposal = (await chat()).body.data.proposal;
    db.reset(); auth(); query(currentMember());
    query(null); query(currentMember()); freshContext(changed); query(null);
    const response = await request(app).post(`${path}/proposals/${proposal.id}/approve`)
      .set('Authorization', 'Bearer TEST_TOKEN').send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('AGENT_PROPOSAL_STALE');
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
    expect(db.builder.upsert.mock.calls.map(([row]) => row.action)).toEqual([
      'agent.action_approved', 'agent.action_failed',
    ]);
    db.reset();
    expect((await status(proposal)).body.data.status).toBe('failed');
  });

  it('rejects a currency change during the final service check before inserting', async () => {
    const proposal = (await chat()).body.data.proposal;
    db.reset(); auth(); query(currentMember());
    query(null); query(currentMember()); freshContext();
    freshContext(); query(null);
    freshContext({ workspace: workspaceRow({ base_currency: 'USD' }) }); query(null);
    const response = await request(app).post(`${path}/proposals/${proposal.id}/approve`)
      .set('Authorization', 'Bearer TEST_TOKEN').send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('AGENT_PROPOSAL_STALE');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
  });

  it('returns a verified native idempotency row without inserting or delivering another notification', async () => {
    const proposal = (await chat()).body.data.proposal;
    db.reset();
    const response = await approve(proposal, { existing: true });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      proposal_id: proposal.id, status: 'executed', result: {
        ...proposal.after, entry_id: ENTRY_ID, recorded_at: submittedEntry().recorded_at,
      },
    });
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
    expect(db.builder.eq).toHaveBeenCalledWith('idempotency_key', `agent:${proposal.id}`);
  });

  it('keeps an unverified inserted amount indeterminate and never repeats the insertion', async () => {
    const proposal = (await chat()).body.data.proposal;
    db.reset(); auth(); query(currentMember());
    query(null); query(currentMember()); freshContext();
    freshContext(); query(null); freshContext();
    query(entry(proposal, { original_amount: 9000, base_amount: 9000 })); query(null);
    const first = await request(app).post(`${path}/proposals/${proposal.id}/approve`)
      .set('Authorization', 'Bearer TEST_TOKEN').send({});
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('AGENT_PROPOSAL_INDETERMINATE');
    expect(ledgerInserts()).toHaveLength(1);
    expect(notification.send).not.toHaveBeenCalled();
    db.reset();
    const repeated = await approve(proposal, { execute: false });
    expect(repeated.status).toBe(409);
    expect(repeated.body.error.code).toBe('AGENT_PROPOSAL_INDETERMINATE');
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
    db.reset();
    const receipt = await status(proposal);
    expect(receipt.body.data.status).toBe('indeterminate');
    expect(receipt.body.data.result).toBeUndefined();
  });

  it('clears streamed draft text and publishes a persisted approval card without submitting money', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse([
      chunk({ role: 'assistant', content: 'I will submit your contribution.' }),
      ...toolChunks('create_ledger_entry', JSON.stringify(ledgerArguments())),
    ]));
    const response = await chat({ message: 'Record 5000 NGN.', selected_container_id: CONTAINER_ID, conversation_id: null })
      .set('Accept', 'text/event-stream');
    expect(response.status).toBe(200);
    const events = parseEvents(response.text);
    expect(events.map((event) => event.type)).toEqual(['text_delta', 'text_reset', 'done']);
    const { proposal, conversation_id } = events.at(-1).data.data;
    expect(proposal).toMatchObject({
      tool: 'create_ledger_entry', before: ledgerContext(), after: { status: 'pending', original_amount: '5000.00' },
    });
    expect(conversation_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();

    db.reset();
    fetchSpy.mockResolvedValueOnce(textCompletion('Use the approval control.'));
    const followup = await chat({ message: 'Yes, submit it.', conversation_id }, { propose: false, refresh: true });
    expect(followup.status).toBe(200);
    expect(followup.body.data.proposal).toBeUndefined();
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(wire.tools.map((tool) => tool.function.name)).not.toContain('create_ledger_entry');
    const current = JSON.parse(wire.messages.at(-1).content).data;
    expect(current.selected_ledger_container).toBeUndefined();
    expect(current.action_receipts).toEqual([expect.objectContaining({
      proposal_id: proposal.id, tool: 'create_ledger_entry', status: 'pending', container_id: CONTAINER_ID,
    })]);
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
  });

  it('refreshes the submitted entry receipt in a streaming follow-up without restoring selection', async () => {
    const first = await chat({ message: 'Record 5000 NGN.', selected_container_id: CONTAINER_ID, conversation_id: null });
    const { proposal, conversation_id } = first.body.data;
    db.reset();
    const approved = await approve(proposal);
    expect(approved.status).toBe(200);
    db.reset();
    fetchSpy.mockResolvedValueOnce(sseResponse(textChunks('Your entry was submitted for admin review.')));
    const response = await chat({ message: 'Did you record it?', conversation_id }, { propose: false, refresh: true })
      .set('Accept', 'text/event-stream');
    expect(response.status).toBe(200);
    const result = parseEvents(response.text).at(-1).data.data;
    expect(result.conversation_id).toBe(conversation_id);
    expect(result.proposal).toBeUndefined();
    const wire = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(wire.tools.map((tool) => tool.function.name)).not.toContain('create_ledger_entry');
    const current = JSON.parse(wire.messages.at(-1).content).data;
    expect(current.selected_ledger_container).toBeUndefined();
    expect(current.action_receipts).toEqual([expect.objectContaining(approved.body.data)]);
    expect(current.action_receipts[0].result.status).toBe('pending');
    expect(current.action_receipts[0].result.original_amount).toBe('5000.00');
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.builder.insert).not.toHaveBeenCalled();
    expect(db.builder.upsert).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
  });
});
