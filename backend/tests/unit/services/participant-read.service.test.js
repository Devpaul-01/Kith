jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/config/redis', () => require('../../mocks/redis.mock'));
jest.mock('../../../src/services/audit.service');

const service = require('../../../src/services/participant.service');
const db = require('../../../src/config/supabase').__mockInstance;
const WORKSPACE_ID = 'ws-1';
const CONTAINER_ID = 'c1';
const participant = { id: 'p1', container_id: CONTAINER_ID, workspace_member_id: 'm1', money_enabled: true,
  workspace_members: { display_name: 'Ada', is_proxy: true, role: 'member', is_active: false } };
const pagination = { page: 2, perPage: 10, offset: 10 };
const args = { workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, participantId: 'p1', pagination };
beforeEach(() => { db.reset(); });

it('verifies the workspace container before listing and fetches only current non-cycle targets for the page', async () => {
  db.mockResponses({ data: { id: CONTAINER_ID }, error: null }, { data: [participant], count: 42, error: null },
    { data: [{ id: 't1', container_participant_id: 'p1', workspace_member_id: 'm1', target_amount: '5000.25', target_currency: 'USD', due_date: '2026-11-10' }], error: null });
  const result = await service.listParticipants(args);
  expect(result).toMatchObject({ participants: [{ id: 'p1', display_name: 'Ada', is_proxy: true, is_active: false,
    target_id: 't1', target_amount: '5000.25', target_currency: 'USD' }], count: 42 });
  expect(db.getCalls()).toEqual(expect.arrayContaining([
    { method: 'eq', args: ['workspace_id', WORKSPACE_ID] },
    { method: 'is', args: ['deleted_at', null] },
    { method: 'eq', args: ['workspace_members.workspace_id', WORKSPACE_ID] },
    { method: 'is', args: ['workspace_members.deleted_at', null] },
    { method: 'range', args: [10, 19] },
    { method: 'in', args: ['container_participant_id', ['p1']] },
    { method: 'in', args: ['workspace_member_id', ['m1']] },
    { method: 'eq', args: ['is_current', true] },
    { method: 'is', args: ['cycle_id', null] },
    { method: 'limit', args: [2] },
  ]));
  expect(db.getCalls().filter((call) => call.method === 'select').map((call) => call.args[0]).join(' ')).not.toMatch(/\*|\bnotes\b|added_by|exclude_from_public/);
});

it('does not fetch targets for an empty participant page or invent a zero target for an absent target', async () => {
  db.mockResponses({ data: { id: CONTAINER_ID }, error: null }, { data: [], count: 0, error: null });
  await expect(service.listParticipants(args)).resolves.toEqual({ participants: [], count: 0 });
  expect(db.getCalls().filter((call) => call.method === 'from').map((call) => call.args[0])).toEqual(['containers', 'container_participants']);
  db.reset();
  db.mockResponses({ data: { id: CONTAINER_ID }, error: null }, { data: [participant], count: 1, error: null }, { data: [], error: null });
  const result = await service.listParticipants(args);
  expect(result.participants[0].target_amount).toBeUndefined();
  expect(result.participants[0].target_id).toBeUndefined();
});

it.each([[null, null, 'NOT_FOUND'], [null, { message: 'private details' }, 'PARTICIPANTS_UNAVAILABLE']])('does not query participants after a failed scoped container read', async (data, error, code) => {
  db.mockNextResponse({ data, error });
  await expect(service.listParticipants(args)).rejects.toMatchObject({ code });
  expect(db.getCalls().filter((call) => call.method === 'from')).toEqual([{ method: 'from', args: ['containers'] }]);
});

describe.each(['getTargetHistory', 'getCycleTargets'])('%s participant boundary', (method) => {
  it.each([[null, null, 'NOT_FOUND'], [null, { message: 'private details' }, 'PARTICIPANTS_UNAVAILABLE']])('does not read targets for a missing or failed scoped participant', async (data, error, code) => {
    db.mockNextResponse({ data, error });
    await expect(service[method](args)).rejects.toMatchObject({ code });
    expect(db.getCalls().filter((call) => call.method === 'from')).toEqual([{ method: 'from', args: ['container_participants'] }]);
    expect(db.getCalls()).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', 'p1'] }, { method: 'eq', args: ['container_id', CONTAINER_ID] },
      { method: 'eq', args: ['containers.workspace_id', WORKSPACE_ID] }, { method: 'is', args: ['containers.deleted_at', null] },
      { method: 'eq', args: ['workspace_members.workspace_id', WORKSPACE_ID] }, { method: 'is', args: ['workspace_members.deleted_at', null] },
    ]));
  });
});

describe.each(['listParticipants', 'getTargetHistory', 'getCycleTargets'])('%s exact-count failures', (method) => {
  it.each([null, undefined, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])('rejects invalid or unavailable counts: %j', async (count) => {
    db.mockResponses({ data: method === 'listParticipants' ? { id: CONTAINER_ID } : participant, error: null }, { data: [], count, error: null });
    await expect(service[method](args)).rejects.toMatchObject({ code: 'PARTICIPANTS_UNAVAILABLE' });
  });

  it.each([{ data: null, count: 0, error: null }, { data: [], count: 0, error: { message: 'private database detail' } }])('rejects failed rows instead of inventing an empty page', async (response) => {
    db.mockResponses({ data: method === 'listParticipants' ? { id: CONTAINER_ID } : participant, error: null }, response);
    await expect(service[method](args)).rejects.toMatchObject({ code: 'PARTICIPANTS_UNAVAILABLE' });
  });
});

it('scopes target history to the verified participant, container and member, with stable paging and preserved currencies', async () => {
  db.mockResponses({ data: participant, error: null }, { data: [{ id: 't1', cycle_id: null, target_amount: '5000.25', target_currency: 'USD', is_current: false,
    set_by_member: { display_name: 'Admin Ada' } }], count: 23, error: null });
  const result = await service.getTargetHistory(args);
  expect(result).toMatchObject({ history: [{ id: 't1', cycle_id: null, target_amount: '5000.25', target_currency: 'USD', is_current: false, set_by_name: 'Admin Ada' }], count: 23 });
  expect(db.getCalls()).toEqual(expect.arrayContaining([
    { method: 'eq', args: ['container_participant_id', 'p1'] }, { method: 'eq', args: ['workspace_member_id', 'm1'] },
    { method: 'eq', args: ['set_by_member.workspace_id', WORKSPACE_ID] },
    { method: 'order', args: ['set_at', { ascending: false }] }, { method: 'order', args: ['id', { ascending: true }] },
    { method: 'range', args: [10, 19] },
  ]));
});

it('reads paginated cycle schedules and original-currency targets without fetching or summing ledger entries', async () => {
  const cycle = { id: 'cy1', cycle_number: 4, cycle_start: '2026-11-01', cycle_end: '2026-11-30', status: 'closed' };
  db.mockResponses({ data: participant, error: null }, { data: [cycle, { ...cycle, id: 'cy2', cycle_number: 5 }], count: 30, error: null },
    { data: [{ id: 't1', cycle_id: 'cy1', target_amount: '5000.25', target_currency: 'USD', due_date: '2026-11-10', set_at: '2026-11-01' }], error: null });
  const result = await service.getCycleTargets(args);
  expect(result).toMatchObject({ cycle_targets: [{ cycle, target: { id: 't1', amount: '5000.25', currency: 'USD' } }, { target: null }], count: 30 });
  expect(result.cycle_targets[0]).not.toHaveProperty('status');
  expect(result.cycle_targets[0]).not.toHaveProperty('confirmed_paid_base');
  expect(db.getCalls()).toEqual(expect.arrayContaining([
    { method: 'eq', args: ['container_participant_id', 'p1'] }, { method: 'eq', args: ['workspace_member_id', 'm1'] },
    { method: 'in', args: ['cycle_id', ['cy1', 'cy2']] }, { method: 'limit', args: [3] },
    { method: 'order', args: ['cycle_number', { ascending: true }] }, { method: 'range', args: [10, 19] },
  ]));
  expect(db.getCalls().filter((call) => call.method === 'from').map((call) => call.args[0])).toEqual(['container_participants', 'container_cycles', 'contributor_targets']);
});

it('does not fetch targets when the cycle page is empty', async () => {
  db.mockResponses({ data: participant, error: null }, { data: [], count: 0, error: null });
  await expect(service.getCycleTargets(args)).resolves.toMatchObject({ cycle_targets: [], count: 0 });
  expect(db.getCalls().filter((call) => call.method === 'from').map((call) => call.args[0])).toEqual(['container_participants', 'container_cycles']);
});

it.each([
  [{ container_participant_id: 'p1', workspace_member_id: 'other-member' }],
  [{ container_participant_id: 'p1', workspace_member_id: 'm1' }, { container_participant_id: 'p1', workspace_member_id: 'm1' }],
])('does not return mismatched or duplicate current non-cycle targets', async (targets) => {
  db.mockResponses({ data: { id: CONTAINER_ID }, error: null }, { data: [participant], count: 1, error: null }, { data: targets, error: null });
  await expect(service.listParticipants(args)).rejects.toMatchObject({ code: 'PARTICIPANTS_UNAVAILABLE' });
});

it.each([[{ cycle_id: 'other-cycle' }], [{ cycle_id: 'cy1' }, { cycle_id: 'cy1' }]])('does not guess between invalid or duplicate cycle targets', async (targets) => {
  db.mockResponses({ data: participant, error: null }, { data: [{ id: 'cy1' }], count: 1, error: null }, { data: targets, error: null });
  await expect(service.getCycleTargets(args)).rejects.toMatchObject({ code: 'PARTICIPANTS_UNAVAILABLE' });
});

it.each(['listParticipants', 'getCycleTargets'])('does not treat a failed target lookup as absence in %s', async (method) => {
  db.mockResponses({ data: method === 'listParticipants' ? { id: CONTAINER_ID } : participant, error: null },
    { data: method === 'listParticipants' ? [participant] : [{ id: 'cy1' }], count: 1, error: null }, { data: null, error: { message: 'private detail' } });
  await expect(service[method](args)).rejects.toMatchObject({ code: 'PARTICIPANTS_UNAVAILABLE' });
});

it('retains the legacy unpaginated target-history response for HTTP callers', async () => {
  db.mockNextResponse({ data: [{ id: 't1', set_by_member: { display_name: 'Ada' } }], error: null });
  await expect(service.getTargetHistory({ participantId: 'p1' })).resolves.toEqual([{ id: 't1', set_by_name: 'Ada', set_by_member: undefined }]);
  expect(db.getCalls().filter((call) => call.method === 'from')).toEqual([{ method: 'from', args: ['contributor_targets'] }]);
});
