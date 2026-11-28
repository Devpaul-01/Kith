// The actual service is exercised; PostgreSQL row matching is integration coverage.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, supabase: instance.client, supabaseAuth: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/config/redis', () => require('../../mocks/redis.mock'));
jest.mock('../../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../src/services/notification.service');
jest.mock('../../../src/services/audit.service');
jest.mock('../../../src/services/storage.service');
jest.mock('../../../src/queues');

const containers = require('../../../src/services/container.service');
const audit = require('../../../src/services/audit.service');
const { ConflictError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const { context, member } = require('../../helpers/agent-dispute-raise');
const { OTHER_ID } = require('../../helpers/agent-proposal');
const db = require('../../../src/config/supabase').__mockInstance;

const actor = context();
const CONTAINER_ID = '33333333-3333-4333-8333-333333333333';
const UPDATED_AT = '2026-11-26T10:00:00.123456+00:00';
const unavailable = { code: 'CONTAINER_ARCHIVE_UNAVAILABLE', statusCode: 503 };
const caller = (changes = {}) => ({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID, callerId: actor.member.id, userId: actor.userId, ...changes });
const row = (changes = {}) => ({ id: CONTAINER_ID, workspace_id: actor.workspace.id, name: 'Wedding', container_type: 'event',
  status: 'active', enable_money: true, enable_tasks: false, updated_at: UPDATED_AT, deleted_at: null, public_token: 'never-selected', ...changes });
const response = (data) => ({ data, error: null });
const admin = (changes = {}) => member({ role: 'admin', ...changes });
const script = ({ actorRow = admin(), container = row() } = {}) => db.mockResponses(response(actorRow), response(container));
const reviewed = (changes = {}) => ({ workspace_id: actor.workspace.id, actor_member_id: actor.member.id, member_role: 'admin',
  container: { container_id: CONTAINER_ID, name: 'Wedding', container_type: 'event', status: 'active', enable_money: true,
    enable_tasks: false, updated_at: UPDATED_AT, ...changes } });
const ACTOR_CTX = { workspaceId: actor.workspace.id, actorUserId: actor.userId, actorMemberId: actor.member.id, ipAddress: null, userAgent: null };
const archive = (changes = {}) => containers.archiveReviewedContainer({ workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
  expected: reviewed(), actorCtx: ACTOR_CTX, proposalId: OTHER_ID, ...changes });
const archivedRow = (changes = {}) => ({ id: CONTAINER_ID, status: 'archived', updated_at: '2026-11-26T11:00:00.000000+00:00', ...changes });

beforeEach(() => { db.reset(); jest.clearAllMocks(); audit.log.mockResolvedValue(); });

describe('getContainerArchiveContext', () => {
  it('returns only the reviewed identity and version, scoped to the admin, workspace and non-deleted container', async () => {
    script();
    await expect(containers.getContainerArchiveContext(caller())).resolves.toEqual(reviewed());
    expect(db.client.from.mock.calls).toEqual([['workspace_members'], ['containers']]);
    expect(db.builder.select.mock.calls.map(([value]) => value).join(' ')).not.toMatch(/\*|public_token/);
    expect(db.getCalls()).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['user_id', actor.userId] }, { method: 'eq', args: ['is_proxy', false] },
      { method: 'eq', args: ['id', CONTAINER_ID] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'is', args: ['deleted_at', null] },
    ]));
    for (const method of ['insert', 'update', 'delete', 'upsert']) expect(db.builder[method]).not.toHaveBeenCalled();
  });

  it('allows a completed container', async () => {
    script({ container: row({ status: 'completed' }) });
    await expect(containers.getContainerArchiveContext(caller())).resolves.toMatchObject({ container: { status: 'completed' } });
  });

  it.each(['workspaceId', 'containerId', 'callerId', 'userId'])('rejects malformed %s before reading', async (field) => {
    await expect(containers.getContainerArchiveContext(caller({ [field]: 'invalid' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
  });

  it.each([
    [{ actorRow: null }, 'FORBIDDEN'], [{ actorRow: admin({ role: 'member' }) }, 'FORBIDDEN'],
    [{ actorRow: admin({ id: OTHER_ID }) }, 'FORBIDDEN'], [{ actorRow: admin({ is_active: false }) }, 'FORBIDDEN'],
    [{ container: null }, 'NOT_FOUND'], [{ container: row({ status: 'archived' }) }, 'BUSINESS_RULE_VIOLATION'],
    [{ container: row({ status: 'cancelled' }) }, 'BUSINESS_RULE_VIOLATION'],
  ])('fails closed on missing or ineligible rows %j', async (changes, code) => {
    script(changes);
    await expect(containers.getContainerArchiveContext(caller())).rejects.toMatchObject({ code });
  });

  it.each([
    [{ container: row({ id: OTHER_ID }) }], [{ container: row({ workspace_id: OTHER_ID }) }], [{ container: row({ name: '' }) }],
    [{ container: row({ updated_at: 'not-a-time' }) }], [{ container: row({ container_type: 'other' }) }],
    [{ container: row({ deleted_at: UPDATED_AT }) }], [{ actorRow: admin({ role: 'owner' }) }],
  ])('keeps malformed or unscoped rows unavailable %j', async (changes) => {
    script(changes);
    await expect(containers.getContainerArchiveContext(caller())).rejects.toMatchObject(unavailable);
  });

  it.each([{ error: null }, { data: [], error: null }, { data: row(), error: { message: 'PRIVATE_READ_ERROR' } }])(
    'normalizes a failed read without exposing details %j', async (result) => {
      db.mockResponses(result);
      await expect(containers.getContainerArchiveContext(caller())).rejects.toMatchObject(unavailable);
    });
});

describe('archiveReviewedContainer', () => {
  it('updates only the reviewed version with one conditional write, then audits as agent-initiated', async () => {
    db.mockResponses(response(archivedRow()));
    await expect(archive()).resolves.toEqual({ container_id: CONTAINER_ID, status: 'archived', updated_at: '2026-11-26T11:00:00.000000+00:00' });
    expect(db.client.from.mock.calls).toEqual([['containers']]);
    expect(db.getCalls().find((c) => c.method === 'update').args[0]).toMatchObject({ status: 'archived' });
    expect(db.getCalls()).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', CONTAINER_ID] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['status', 'active'] }, { method: 'eq', args: ['updated_at', UPDATED_AT] },
      { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ ...ACTOR_CTX, action: AUDIT_ACTIONS.CONTAINER_ARCHIVED, targetType: 'container',
      targetId: CONTAINER_ID, required: true, metadata: { agent_initiated: true, proposal_id: OTHER_ID } }));
  });

  it('treats zero matched rows as a definite conflict and writes no audit', async () => {
    db.mockResponses(response(null));
    await expect(archive()).rejects.toBeInstanceOf(ConflictError);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    ['a database error', { data: null, error: { message: 'PRIVATE_ERROR' } }], ['no response data key', { error: null }],
    ['a malformed row', response({ id: CONTAINER_ID })], ['a wrong status', response(archivedRow({ status: 'active' }))],
    ['a different container', response(archivedRow({ id: OTHER_ID }))],
    ['a row alongside an error', { data: archivedRow(), error: { message: 'PRIVATE_ERROR' } }],
  ])('keeps %s uncertain', async (_label, result) => {
    db.mockResponses(result);
    await expect(archive()).rejects.toMatchObject(unavailable);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('normalizes a thrown write as uncertain', async () => {
    db.builder.maybeSingle.mockImplementationOnce(() => { throw new Error('PRIVATE'); });
    await expect(archive()).rejects.toMatchObject(unavailable);
  });

  it('keeps a failed required audit uncertain because the row was already archived', async () => {
    db.mockResponses(response(archivedRow()));
    audit.log.mockRejectedValue(new Error('audit down'));
    await expect(archive()).rejects.toMatchObject(unavailable);
  });

  it.each([
    [{ expected: { ...reviewed(), workspace_id: OTHER_ID } }], [{ containerId: OTHER_ID }], [{ expected: { member_role: 'admin' } }],
    [{ expected: reviewed({ status: 'archived' }) }],
  ])('rejects mismatched reviewed details before writing %j', async (changes) => {
    await expect(archive(changes)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
  });
});
