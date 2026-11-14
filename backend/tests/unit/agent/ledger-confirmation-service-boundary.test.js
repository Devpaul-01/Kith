// Real service queries with scripted Supabase outcomes. Postgres lock races
// and related-row eligibility still require live database integration.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/storage.service', () => ({}));
jest.mock('../../../src/services/export.service', () => ({}));

const ledger = require('../../../src/services/ledger.service');
const notification = require('../../../src/services/notification.service');
const audit = require('../../../src/services/audit.service');
const { ConflictError } = require('../../../src/utils/errors');
const { AUDIT_ACTIONS } = require('../../../src/constants/audit-actions');
const { entryConfirmationSnapshotSchema, entryConfirmationContextSchema } = require('../../../src/validators/ledger.validator');
const { context, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, PARTICIPANT_ID, ENTRY_ID, workspaceRow, ledgerMember, containerRow,
  participantRow, submittedEntry,
} = require('../../helpers/agent-ledger-proposal');
const db = require('../../../src/config/supabase').__mockInstance;
const actor = context();
actor.member.role = 'admin';
const CONTRIBUTOR_ID = OTHER_ID;
const CONTRIBUTOR_USER_ID = '55555555-5555-4555-8555-555555555555';
const DIFFERENT_ID = '66666666-6666-4666-8666-666666666666';
const EXECUTION_TIME = '2026-11-14T13:00:00.000Z';
const actorCtx = {
  workspaceId: actor.workspace.id, actorUserId: actor.userId, actorMemberId: actor.member.id,
  ipAddress: '127.0.0.1', userAgent: 'confirmation-test',
};

function pendingEntry(overrides = {}) {
  return submittedEntry({ contributor_id: CONTRIBUTOR_ID, recorded_by: CONTRIBUTOR_ID, proofs: [], ...overrides });
}
function contributorRow(overrides = {}) {
  return ledgerMember({ id: CONTRIBUTOR_ID, user_id: CONTRIBUTOR_USER_ID,
    role: 'member', display_name: 'Bola', ...overrides });
}
function expectedContext(overrides = {}) {
  return {
    entry_id: ENTRY_ID, workspace_id: actor.workspace.id, container_id: CONTAINER_ID,
    contributor_id: CONTRIBUTOR_ID, entry_type: 'contribution',
    original_amount: '5000.00', original_currency: 'NGN', base_amount: '5000.00',
    payment_method: 'bank_transfer', note: 'Family groceries', cycle_id: null, is_crypto: false,
    proofs: [], status: 'pending', corrects_entry_id: null, recorded_by: CONTRIBUTOR_ID,
    recorded_at: '2026-11-14T12:01:00.000Z', confirmed_at: null, confirmed_by: null,
    base_currency: 'NGN', container_name: 'Family groceries', container_type: 'event',
    container_status: 'active', enable_money: true, container_updated_at: '2026-11-14T12:00:00.000Z',
    actor_member_id: actor.member.id, member_role: 'admin', contributor_display_name: 'Bola',
    contributor_role: 'member', participant_id: PARTICIPANT_ID, money_enabled: true, ...overrides,
  };
}
function caller(overrides = {}) {
  return { workspaceId: actor.workspace.id, containerId: CONTAINER_ID, entryId: ENTRY_ID,
    callerId: actor.member.id, userId: actor.userId, isAdmin: true, ...overrides };
}
function parameters(overrides = {}) {
  return { workspaceId: actor.workspace.id, containerId: CONTAINER_ID, entryId: ENTRY_ID,
    actorMemberId: actor.member.id, actorCtx,
    reviewedConfirmation: { userId: actor.userId, isAdmin: true, expected: expectedContext() }, ...overrides };
}
function confirmedEntry(overrides = {}) {
  return pendingEntry({ status: 'confirmed', confirmed_at: EXECUTION_TIME, confirmed_by: actor.member.id, ...overrides });
}
function contextResponses(changes = {}) {
  const readers = {
    workspace: workspaceRow, actor: (value) => ledgerMember({ role: 'admin', ...value }),
    container: containerRow, entry: pendingEntry, contributor: contributorRow,
    participant: (value) => participantRow({ workspace_member_id: CONTRIBUTOR_ID, ...value }),
  };
  return Object.entries(readers).map(([name, reader]) => ({
    data: changes[name] === null ? null : reader(changes[name]), error: null,
  }));
}
function scriptContext(changes) { db.mockResponses(...contextResponses(changes)); }
function scriptConfirmation({ changes, response = { data: confirmedEntry(), error: null } } = {}) {
  scriptContext(changes);
  db.mockNextResponse(response);
}
function queries(table) {
  const calls = db.getCalls();
  return calls.flatMap((call, start) => {
    if (call.method !== 'from' || call.args[0] !== table) return [];
    const end = calls.findIndex((next, index) => index > start && next.method === 'from');
    return [calls.slice(start, end < 0 ? undefined : end)];
  });
}
function expectNoEffects() {
  expect(notification.send).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
}
function expectNoMutation() {
  expect(db.builder.update).not.toHaveBeenCalled();
  expect(db.builder.insert).not.toHaveBeenCalled();
  expect(db.builder.delete).not.toHaveBeenCalled();
  expect(db.client.rpc).not.toHaveBeenCalled();
  expectNoEffects();
}

beforeEach(() => {
  db.reset();
  notification.send.mockResolvedValue();
  audit.log.mockResolvedValue();
  jest.useFakeTimers();
  jest.setSystemTime(new Date(EXECUTION_TIME));
});
afterEach(() => jest.useRealTimers());

describe('reviewed confirmation shared schemas', () => {
  it('retains strict ZodObject projection and canonical decimal text', () => {
    const parsed = entryConfirmationContextSchema.parse(expectedContext({ original_amount: '005000', base_amount: '5000.0' }));
    expect(parsed).toEqual(expectedContext());
    expect(entryConfirmationSnapshotSchema.pick({ entry_id: true }).parse({ entry_id: ENTRY_ID }))
      .toEqual({ entry_id: ENTRY_ID });
    expect(entryConfirmationContextSchema.safeParse({ ...expectedContext(), idempotency_key: 'PRIVATE_KEY' }).success).toBe(false);
  });

  it.each([['numeric amount', { original_amount: 5000 }], ['admin role', { member_role: 'member' }],
    ['proof', { proofs: [{ path: 'PRIVATE_PROOF' }] }], ['missing confirmation', { confirmed_by: undefined }],
    ['nonpending', { status: 'confirmed' }]])('rejects unsupported %s', (_label, changes) => {
    expect(entryConfirmationContextSchema.safeParse(expectedContext(changes)).success).toBe(false);
  });

  it('accepts nullable and empty optional text from ordinary HTTP submissions', () => {
    expect(entryConfirmationContextSchema.parse(expectedContext({ note: '', payment_method: null })))
      .toEqual(expectedContext({ note: '', payment_method: null }));
  });
});

describe('confirmation authorization and scoped eligibility', () => {
  it('denies a declared non-admin before making any database call', async () => {
    await expect(ledger.getEntryConfirmationContext(caller({ isAdmin: false }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(ledger.confirmEntry(parameters({ reviewedConfirmation: {
      userId: actor.userId, isAdmin: false, expected: expectedContext(),
    } }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoMutation();
  });

  it.each([
    ['member role', { role: 'member' }], ['inactive', { is_active: false }], ['proxy', { is_proxy: true }],
    ['wrong user', { user_id: DIFFERENT_ID }], ['wrong member', { id: DIFFERENT_ID }],
    ['wrong workspace', { workspace_id: DIFFERENT_ID }],
  ])('rejects actual admin membership with %s before reading a target', async (_label, change) => {
    scriptContext({ actor: change });
    await expect(ledger.getEntryConfirmationContext(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members']]);
    expectNoMutation();
  });

  it.each([
    ['workspace', { workspaceId: 'bad-id' }], ['container', { containerId: 'bad-id' }],
    ['entry', { entryId: 'bad-id' }], ['caller', { callerId: 'bad-id' }],
    ['user', { userId: 'bad-id' }], ['role', { isAdmin: 'true' }],
  ])('validates %s before querying', async (_label, change) => {
    await expect(ledger.getEntryConfirmationContext(caller(change))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoMutation();
  });

  it('returns only the exact reviewed fields and scopes every service-role read', async () => {
    scriptContext({
      entry: { idempotency_key: 'PRIVATE_LEDGER_KEY', private_column: 'PRIVATE_DATA' },
      contributor: { admin_notes: 'PRIVATE_MEMBER_NOTES' }, container: { public_token: 'PRIVATE_TOKEN' },
    });
    await expect(ledger.getEntryConfirmationContext(caller())).resolves.toEqual(expectedContext());
    expect(db.client.from.mock.calls).toEqual([
      ['workspaces'], ['workspace_members'], ['containers'], ['ledger_entries'], ['workspace_members'], ['container_participants'],
    ]);
    expect(queries('workspaces')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', actor.workspace.id] }, { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('workspace_members')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', actor.member.id] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['user_id', actor.userId] }, { method: 'eq', args: ['role', 'admin'] },
      { method: 'eq', args: ['is_active', true] }, { method: 'eq', args: ['is_proxy', false] },
      { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('ledger_entries')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', ENTRY_ID] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['container_id', CONTAINER_ID] },
    ]));
    expect(queries('workspace_members')[1]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', CONTRIBUTOR_ID] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['is_active', true] }, { method: 'eq', args: ['is_proxy', false] },
      { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('container_participants')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['container_id', CONTAINER_ID] }, { method: 'eq', args: ['workspace_member_id', CONTRIBUTOR_ID] },
    ]));
    expectNoMutation();
  });

  it.each([
    ['workspace', 0, 'NOT_FOUND'], ['actor', 1, 'FORBIDDEN'], ['container', 2, 'NOT_FOUND'],
    ['entry', 3, 'NOT_FOUND'], ['contributor', 4, 'BUSINESS_RULE_VIOLATION'], ['participant', 5, 'BUSINESS_RULE_VIOLATION'],
  ])('stops when scoped %s is missing', async (_label, index, code) => {
    const responses = contextResponses().slice(0, index + 1);
    responses[index] = { data: null, error: null };
    db.mockResponses(...responses);
    await expect(ledger.getEntryConfirmationContext(caller())).rejects.toMatchObject({ code });
    expect(db.client.from).toHaveBeenCalledTimes(index + 1);
    expectNoMutation();
  });

  it.each([0, 1, 2, 3, 4, 5])('fails closed on read %s errors even with partial data', async (index) => {
    const responses = contextResponses().slice(0, index + 1);
    responses[index].error = { message: 'PRIVATE_DATABASE_ERROR' };
    db.mockResponses(...responses);
    await expect(ledger.getEntryConfirmationContext(caller())).rejects.toMatchObject({
      code: 'LEDGER_CONFIRMATION_UNAVAILABLE', statusCode: 503,
      message: 'Ledger confirmations are unavailable. Please try again.',
    });
    expect(db.client.from).toHaveBeenCalledTimes(index + 1);
    expectNoMutation();
  });

  it.each([0, 1, 2, 3, 4, 5])('rejects malformed scoped row %s', async (index) => {
    const responses = contextResponses().slice(0, index + 1);
    responses[index] = { data: { id: DIFFERENT_ID }, error: null };
    db.mockResponses(...responses);
    await expect(ledger.getEntryConfirmationContext(caller())).rejects.toMatchObject({ code: 'LEDGER_CONFIRMATION_UNAVAILABLE' });
    expectNoMutation();
  });

  it.each([
    ['recurring', { container_type: 'recurring' }], ['archived', { status: 'archived' }],
    ['completed', { status: 'completed' }], ['disabled money', { enable_money: false }],
  ])('excludes a container with %s', async (_label, container) => {
    scriptContext({ container });
    await expect(ledger.getEntryConfirmationContext(caller())).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(queries('ledger_entries')).toEqual([]);
    expectNoMutation();
  });

  it.each([
    ['expense', { entry_type: 'expense' }], ['correction', { entry_type: 'correction' }],
    ['confirmed', { status: 'confirmed' }], ['proof-uploaded', { status: 'proof_uploaded' }],
    ['disputed', { status: 'disputed' }], ['proof', { proofs: [{ path: 'PRIVATE_PROOF' }] }],
    ['cycle', { cycle_id: DIFFERENT_ID }], ['crypto flag', { is_crypto: true }],
    ['crypto method', { payment_method: 'crypto' }], ['correction link', { corrects_entry_id: DIFFERENT_ID }],
    ['foreign currency', { original_currency: 'USD' }], ['converted amount', { base_amount: 5001 }],
    ['zero', { original_amount: 0, base_amount: 0 }], ['excess precision', { original_amount: '5000.001' }],
    ['confirmation time', { confirmed_at: EXECUTION_TIME }], ['confirmer', { confirmed_by: actor.member.id }],
    ['missing contributor', { contributor_id: null }], ['missing recorder', { recorded_by: null }],
  ])('rejects unsupported %s entries before reading contributor details', async (_label, entry) => {
    scriptContext({ entry });
    await expect(ledger.getEntryConfirmationContext(caller())).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(queries('workspace_members')).toHaveLength(1);
    expectNoMutation();
  });

  it.each([['proxy', { is_proxy: true }], ['inactive', { is_active: false }]])('denies %s contributors', async (_label, contributor) => {
    scriptContext({ contributor });
    await expect(ledger.getEntryConfirmationContext(caller())).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(queries('container_participants')).toEqual([]);
    expectNoMutation();
  });

  it.each([
    ['wrong entry workspace', { entry: { workspace_id: DIFFERENT_ID } }],
    ['wrong entry container', { entry: { container_id: DIFFERENT_ID } }],
    ['wrong contributor', { contributor: { id: DIFFERENT_ID } }],
    ['wrong contributor workspace', { contributor: { workspace_id: DIFFERENT_ID } }],
    ['wrong participation', { participant: { workspace_member_id: DIFFERENT_ID } }],
    ['wrong participation container', { participant: { container_id: DIFFERENT_ID } }],
  ])('fails closed for %s even if a service-role query returns the wrong row', async (_label, changes) => {
    scriptContext(changes);
    await expect(ledger.getEntryConfirmationContext(caller())).rejects.toMatchObject({ code: 'LEDGER_CONFIRMATION_UNAVAILABLE' });
    expectNoMutation();
  });

  it('requires money-enabled participation', async () => {
    scriptContext({ participant: { money_enabled: false } });
    await expect(ledger.getEntryConfirmationContext(caller())).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expectNoMutation();
  });

  it('normalizes thrown read transport errors without leaking them', async () => {
    db.builder.maybeSingle.mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT_ERROR'));
    await expect(ledger.getEntryConfirmationContext(caller())).rejects.toMatchObject({ code: 'LEDGER_CONFIRMATION_UNAVAILABLE' });
    expectNoMutation();
  });
});

describe('reviewed confirmation preconditions and stale cards', () => {
  it.each([
    ['workspace', { workspace_id: DIFFERENT_ID }], ['container', { container_id: DIFFERENT_ID }],
    ['entry', { entry_id: DIFFERENT_ID }], ['actor', { actor_member_id: DIFFERENT_ID }],
  ])('rejects a mismatched reviewed %s before reading', async (_label, change) => {
    await expect(ledger.confirmEntry(parameters({ reviewedConfirmation: {
      userId: actor.userId, isAdmin: true, expected: expectedContext(change),
    } }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoMutation();
  });

  it.each([
    ['missing user', { isAdmin: true, expected: expectedContext() }],
    ['unknown force', { userId: actor.userId, isAdmin: true, expected: expectedContext(), force: true }],
    ['private key', { userId: actor.userId, isAdmin: true, expected: expectedContext({ idempotency_key: 'PRIVATE_KEY' }) }],
  ])('rejects malformed %s options', async (_label, reviewedConfirmation) => {
    await expect(ledger.confirmEntry(parameters({ reviewedConfirmation }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoMutation();
  });

  it.each([
    ['reviewed currency', { original_currency: 'USD' }], ['reviewed conversion', { base_amount: '5001.00' }],
  ])('rejects %s without a lookup', async (_label, change) => {
    await expect(ledger.confirmEntry(parameters({ reviewedConfirmation: {
      userId: actor.userId, isAdmin: true, expected: expectedContext(change),
    } }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoMutation();
  });

  it.each([
    ['currency', { workspace: { base_currency: 'USD' } }],
    ['container name', { container: { name: 'Renamed event' } }],
    ['container version', { container: { updated_at: EXECUTION_TIME } }],
    ['amount', { entry: { original_amount: 5001, base_amount: 5001 } }],
    ['note', { entry: { note: 'Changed note' } }], ['payment', { entry: { payment_method: 'cash' } }],
    ['recorder', { entry: { recorded_by: DIFFERENT_ID } }],
    ['recorded time', { entry: { recorded_at: EXECUTION_TIME } }],
    ['contributor name', { contributor: { display_name: 'Changed member' } }],
    ['contributor role', { contributor: { role: 'admin' } }],
    ['participation identity', { participant: { id: DIFFERENT_ID } }],
    ['membership loss', { actor: null }], ['dispute', { entry: { status: 'disputed' } }],
  ])('rejects changed %s before UPDATE and side effects', async (_label, changes) => {
    scriptContext(changes);
    await expect(ledger.confirmEntry(parameters())).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expectNoMutation();
  });
});

describe('confirmation atomic row predicates and outcomes', () => {
  it('conditionally confirms the exact pending row at execution time and keeps domain effects', async () => {
    scriptConfirmation();
    await expect(ledger.confirmEntry(parameters())).resolves.toEqual(confirmedEntry());
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expect(db.builder.update).toHaveBeenCalledWith({ status: 'confirmed', confirmed_at: EXECUTION_TIME, confirmed_by: actor.member.id });
    expect(queries('ledger_entries')[1]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', ENTRY_ID] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['container_id', CONTAINER_ID] }, { method: 'eq', args: ['contributor_id', CONTRIBUTOR_ID] },
      { method: 'eq', args: ['entry_type', 'contribution'] }, { method: 'eq', args: ['original_amount', '5000.00'] },
      { method: 'eq', args: ['base_amount', '5000.00'] }, { method: 'eq', args: ['original_currency', 'NGN'] },
      { method: 'eq', args: ['payment_method', 'bank_transfer'] }, { method: 'eq', args: ['note', 'Family groceries'] },
      { method: 'eq', args: ['proofs', '[]'] }, { method: 'eq', args: ['status', 'pending'] },
      { method: 'eq', args: ['is_crypto', false] }, { method: 'is', args: ['cycle_id', null] },
      { method: 'is', args: ['corrects_entry_id', null] }, { method: 'is', args: ['confirmed_at', null] },
      { method: 'is', args: ['confirmed_by', null] }, { method: 'eq', args: ['recorded_by', CONTRIBUTOR_ID] },
      { method: 'eq', args: ['recorded_at', '2026-11-14T12:01:00.000Z'] },
    ]));
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledWith({ type: 'contribution_confirmed', workspaceId: actor.workspace.id,
      recipientIds: [CONTRIBUTOR_ID], referenceType: 'ledger_entry', referenceId: ENTRY_ID,
      variables: { amount: '5000.00 NGN', container: CONTAINER_ID } });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith({ ...actorCtx, action: AUDIT_ACTIONS.LEDGER_CONFIRMED,
      targetType: 'ledger_entry', targetId: ENTRY_ID });
    expect(db.client.rpc).not.toHaveBeenCalled();
  });

  it('matches nullable fields with IS NULL and accepts Postgres timestamp formatting', async () => {
    const changes = { entry: { note: null, payment_method: null } };
    const entry = confirmedEntry({ note: null, payment_method: null, confirmed_at: '2026-11-14T13:00:00+00:00' });
    scriptConfirmation({ changes, response: { data: entry, error: null } });
    await expect(ledger.confirmEntry(parameters({ reviewedConfirmation: {
      userId: actor.userId, isAdmin: true, expected: expectedContext({ note: null, payment_method: null }),
    } }))).resolves.toEqual(entry);
    expect(queries('ledger_entries')[1]).toEqual(expect.arrayContaining([
      { method: 'is', args: ['note', null] }, { method: 'is', args: ['payment_method', null] },
    ]));
  });

  it('permits confirmation of the admin own pending contribution and binds audit identities', async () => {
    const overrides = { contributor_id: actor.member.id, recorded_by: actor.member.id };
    scriptConfirmation({ changes: {
      entry: overrides, contributor: { id: actor.member.id, user_id: actor.userId, role: 'admin', display_name: actor.member.displayName },
      participant: { workspace_member_id: actor.member.id },
    }, response: { data: confirmedEntry(overrides), error: null } });
    await expect(ledger.confirmEntry(parameters({ actorCtx: { ...actorCtx, workspaceId: DIFFERENT_ID,
      actorUserId: DIFFERENT_ID, actorMemberId: DIFFERENT_ID }, reviewedConfirmation: {
      userId: actor.userId, isAdmin: true, expected: expectedContext({ ...overrides,
        contributor_role: 'admin', contributor_display_name: actor.member.displayName }),
    } }))).resolves.toEqual(confirmedEntry(overrides));
    expect(audit.log).toHaveBeenCalledWith({ ...actorCtx, action: AUDIT_ACTIONS.LEDGER_CONFIRMED,
      targetType: 'ledger_entry', targetId: ENTRY_ID });
    expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ recipientIds: [actor.member.id] }));
  });

  it('reports an explicit empty CAS as not applied without notifications or audit', async () => {
    scriptConfirmation({ response: { data: null, error: null } });
    await expect(ledger.confirmEntry(parameters())).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });

  it('does not repeat confirmation when a later card sees the first completed write', async () => {
    scriptContext({ entry: { status: 'confirmed', confirmed_at: EXECUTION_TIME, confirmed_by: actor.member.id } });
    await expect(ledger.confirmEntry(parameters())).rejects.toMatchObject({ code: 'CONFLICT' });
    expectNoMutation();
  });

  it.each([
    ['partial query failure', { data: confirmedEntry(), error: { code: 'CONFLICT', message: 'PRIVATE_UPDATE_ERROR' } }],
    ['missing result property', { error: null }], ['undefined error', { data: null, error: undefined }],
    ['array result', { data: [], error: null }], ['malformed result', { data: {}, error: null }],
  ])('keeps %s uncertain after UPDATE rather than a safe conflict', async (_label, response) => {
    scriptConfirmation({ response });
    await expect(ledger.confirmEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_CONFIRMATION_UNAVAILABLE', statusCode: 503 });
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });

  it.each([
    ['identity', { id: DIFFERENT_ID }], ['workspace', { workspace_id: DIFFERENT_ID }],
    ['container', { container_id: DIFFERENT_ID }], ['contributor', { contributor_id: DIFFERENT_ID }],
    ['amount', { original_amount: 5001 }], ['base amount', { base_amount: 5001 }],
    ['currency', { original_currency: 'USD' }], ['note', { note: 'Unreviewed change' }],
    ['method', { payment_method: 'cash' }], ['proofs', { proofs: [{ path: 'PRIVATE_PROOF' }] }],
    ['status', { status: 'pending' }], ['confirmer', { confirmed_by: DIFFERENT_ID }],
    ['missing time', { confirmed_at: null }], ['changed time', { confirmed_at: '2026-11-14T13:00:01.000Z' }],
    ['invalid time offset', { confirmed_at: '2026-11-14T13:00:00+99:00' }],
  ])('rejects unexpected returned %s as indeterminate without side effects', async (_label, changes) => {
    scriptConfirmation({ response: { data: confirmedEntry(changes), error: null } });
    await expect(ledger.confirmEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_CONFIRMATION_UNAVAILABLE' });
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });

  it('normalizes a thrown UPDATE transport failure as uncertainty', async () => {
    scriptContext();
    for (const response of contextResponses()) db.builder.maybeSingle.mockResolvedValueOnce(response);
    db.builder.maybeSingle.mockRejectedValueOnce(new ConflictError('PRIVATE_TRANSPORT_ERROR'));
    await expect(ledger.confirmEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_CONFIRMATION_UNAVAILABLE' });
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });

  it('never treats a notification conflict as evidence that UPDATE did not apply', async () => {
    scriptConfirmation();
    notification.send.mockRejectedValueOnce(new ConflictError('PRIVATE_NOTIFICATION_ERROR'));
    await expect(ledger.confirmEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_CONFIRMATION_UNAVAILABLE' });
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('keeps a domain audit conflict uncertain after the write and notification', async () => {
    scriptConfirmation();
    audit.log.mockRejectedValueOnce(new ConflictError('PRIVATE_AUDIT_ERROR'));
    await expect(ledger.confirmEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_CONFIRMATION_UNAVAILABLE' });
    expect(db.builder.update).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary HTTP confirmation of proof_uploaded entries without the opt-in branch', async () => {
    const entry = pendingEntry({ status: 'proof_uploaded', proofs: [{ path: 'HTTP_PROOF' }] });
    const updated = confirmedEntry({ proofs: entry.proofs });
    db.mockResponses({ data: entry, error: null }, { data: updated, error: null });
    await expect(ledger.confirmEntry(parameters({ reviewedConfirmation: undefined }))).resolves.toEqual(updated);
    expect(db.client.from.mock.calls).toEqual([['ledger_entries'], ['ledger_entries']]);
    expect(db.builder.update).toHaveBeenCalledWith({ status: 'confirmed', confirmed_at: EXECUTION_TIME, confirmed_by: actor.member.id });
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });
});
