// Exercise the real ledger service with scripted Supabase responses. Native
// uniqueness and transaction races still need separate database integration.
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
const {
  selfLedgerAmountSchema, normalizeSelfLedgerAmount, selfLedgerSubmissionDataSchema,
} = require('../../../src/validators/ledger.validator');
const { context, OTHER_ID } = require('../../helpers/agent-proposal');
const {
  CONTAINER_ID, PARTICIPANT_ID, ledgerContext, workspaceRow, ledgerMember,
  containerRow, participantRow, ledgerArguments, submittedEntry,
} = require('../../helpers/agent-ledger-proposal');
const db = require('../../../src/config/supabase').__mockInstance;
const actor = context();
const KEY = 'agent:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actorCtx = {
  workspaceId: actor.workspace.id, actorUserId: actor.userId,
  actorMemberId: actor.member.id, ipAddress: '127.0.0.1', userAgent: 'unit-test',
};

function submissionData(overrides = {}) {
  const args = ledgerArguments();
  return {
    entry_type: 'contribution', contributor_id: actor.member.id,
    original_amount: args.amount, original_currency: args.currency, base_amount: args.amount,
    payment_method: args.payment_method, note: args.note, cycle_id: null, is_crypto: false,
    ...overrides,
  };
}

function parameters(overrides = {}) {
  const isAdmin = overrides.isAdmin === true;
  return {
    workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
    data: submissionData(), isAdmin, callerId: actor.member.id,
    force: false, idempotencyKey: KEY, actorDisplayName: actor.member.displayName, actorCtx,
    selfSubmission: { userId: actor.userId, expected: ledgerContext({ member_role: isAdmin ? 'admin' : 'member' }) },
    ...overrides,
  };
}

function callerParameters(isAdmin = false) {
  return { workspaceId: actor.workspace.id, containerId: CONTAINER_ID,
    callerId: actor.member.id, userId: actor.userId, isAdmin };
}

function contextResponses({ workspace = {}, member = {}, container = {}, participant = {} } = {}) {
  return [workspaceRow(workspace), ledgerMember(member), containerRow(container), participantRow(participant)]
    .map((data) => ({ data, error: null }));
}

function scriptContext(overrides) {
  db.mockResponses(...contextResponses(overrides));
}

function storedEntry(overrides = {}) {
  return submittedEntry({ idempotency_key: KEY, corrects_entry_id: null, ...overrides });
}

function scriptInsert({ isAdmin = false, response = { data: storedEntry(), error: null }, admins = { data: [{ id: OTHER_ID }], error: null } } = {}) {
  const member = { role: isAdmin ? 'admin' : 'member' };
  scriptContext({ member });
  db.mockNextResponse({ data: null, error: null });
  scriptContext({ member });
  db.mockResponses(response, admins);
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

function expectNoWrite() {
  expect(db.builder.insert).not.toHaveBeenCalled();
  expect(db.client.rpc).not.toHaveBeenCalled();
  expectNoEffects();
}

beforeEach(() => {
  db.reset();
  notification.send.mockResolvedValue();
  audit.log.mockResolvedValue();
});

describe('self contribution decimal contract', () => {
  it.each([
    ['1', '1.00'], ['10.5', '10.50'], ['0.01', '0.01'],
    ['0010.50', '10.50'], ['0000000000000.01', '0.01'],
    ['9999999999999.99', '9999999999999.99'],
  ])('normalizes %s to %s without rounding', (input, expected) => {
    expect(selfLedgerAmountSchema.parse(input)).toBe(expected);
  });

  it.each([
    ['zero', '0'], ['zero cents', '00.00'], ['negative', '-1'], ['signed', '+1'],
    ['space', ' 1'], ['trailing space', '1 '], ['newline', '1\n'],
    ['scientific', '1e3'], ['comma', '1,000'], ['symbol', '₦10'],
    ['missing integer', '.50'], ['missing fraction', '1.'], ['too precise', '1.001'],
    ['overflow', '10000000000000'], ['too many raw digits', '00000000000001'],
    ['numeric input', 10], ['infinite input', Infinity], ['missing', undefined],
  ])('rejects %s', (_label, input) => {
    expect(selfLedgerAmountSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    [10, '10.00'], ['10.0', '10.00'], [0.01, '0.01'], ['0010.50', '10.50'],
    [Infinity, null], [NaN, null], [null, null], [{}, null], ['1.001', null],
    [0.1 + 0.2, null], ['1\n', null],
  ])('normalizes a DB value safely: %s', (value, expected) => {
    expect(normalizeSelfLedgerAmount(value)).toBe(expected);
  });

  it('retains a ZodObject with nullable defaults and canonical amounts', () => {
    const data = selfLedgerSubmissionDataSchema.parse({
      entry_type: 'contribution', contributor_id: actor.member.id,
      original_amount: '005000', original_currency: 'NGN', base_amount: '5000.0',
    });
    expect(data).toEqual(submissionData({ payment_method: null, note: null }));
    expect(selfLedgerSubmissionDataSchema.pick({ original_amount: true }).parse({ original_amount: '10' }))
      .toEqual({ original_amount: '10.00' });
  });
});

describe('self contribution eligibility service boundary', () => {
  it.each([false, true])('reads and returns only the real caller\'s eligible context with isAdmin=%s', async (isAdmin) => {
    scriptContext({
      member: { role: isAdmin ? 'admin' : 'member', admin_notes: 'PRIVATE_MEMBER_DATA' },
      container: { public_token: 'PRIVATE_TOKEN' }, participant: { notes: 'PRIVATE_PARTICIPANT_DATA' },
    });
    await expect(ledger.getSelfSubmissionContext(callerParameters(isAdmin)))
      .resolves.toEqual(ledgerContext({ member_role: isAdmin ? 'admin' : 'member' }));
    expect(db.client.from.mock.calls).toEqual([
      ['workspaces'], ['workspace_members'], ['containers'], ['container_participants'],
    ]);
    expect(queries('workspaces')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', actor.workspace.id] }, { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('workspace_members')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', actor.member.id] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['user_id', actor.userId] }, { method: 'eq', args: ['is_active', true] },
      { method: 'eq', args: ['is_proxy', false] }, { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('containers')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', CONTAINER_ID] }, { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queries('container_participants')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['container_id', CONTAINER_ID] },
      { method: 'eq', args: ['workspace_member_id', actor.member.id] },
    ]));
    expectNoWrite();
  });

  it.each([
    ['workspace', 0, 'NOT_FOUND'], ['member', 1, 'FORBIDDEN'],
    ['container', 2, 'NOT_FOUND'], ['participant', 3, 'BUSINESS_RULE_VIOLATION'],
  ])('stops when the scoped %s is missing', async (_label, index, code) => {
    const responses = contextResponses().slice(0, index + 1);
    responses[index] = { data: null, error: null };
    db.mockResponses(...responses);
    await expect(ledger.getSelfSubmissionContext(callerParameters())).rejects.toMatchObject({ code });
    expect(db.client.from).toHaveBeenCalledTimes(index + 1);
    expectNoWrite();
  });

  it.each([0, 1, 2, 3])('fails safely on context read %s errors despite partial data', async (index) => {
    const responses = contextResponses().slice(0, index + 1);
    responses[index].error = { message: 'PRIVATE_DATABASE_ERROR' };
    db.mockResponses(...responses);
    await expect(ledger.getSelfSubmissionContext(callerParameters())).rejects.toMatchObject({
      code: 'LEDGER_UNAVAILABLE', statusCode: 503, message: 'Ledger submissions are unavailable. Please try again.',
    });
    expect(db.client.from).toHaveBeenCalledTimes(index + 1);
    expectNoWrite();
  });

  it.each([0, 1, 2, 3])('rejects malformed context row %s', async (index) => {
    const responses = contextResponses().slice(0, index + 1);
    responses[index] = { data: { id: actor.workspace.id }, error: null };
    db.mockResponses(...responses);
    await expect(ledger.getSelfSubmissionContext(callerParameters())).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' });
    expectNoWrite();
  });

  it.each([
    ['inactive', { is_active: false }], ['proxy', { is_proxy: true }],
    ['wrong user', { user_id: OTHER_ID }], ['wrong workspace', { workspace_id: OTHER_ID }],
    ['wrong member', { id: OTHER_ID }], ['changed role', { role: 'admin' }],
  ])('denies a %s member before reading containers', async (_label, member) => {
    scriptContext({ member });
    await expect(ledger.getSelfSubmissionContext(callerParameters())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from.mock.calls).toEqual([['workspaces'], ['workspace_members']]);
    expectNoWrite();
  });

  it.each([
    ['recurring', { container_type: 'recurring' }], ['completed', { status: 'completed' }],
    ['archived', { status: 'archived' }], ['money disabled', { enable_money: false }],
  ])('rejects a %s container', async (_label, container) => {
    scriptContext({ container });
    await expect(ledger.getSelfSubmissionContext(callerParameters())).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(queries('container_participants')).toEqual([]);
    expectNoWrite();
  });

  it('rejects money-disabled participation', async () => {
    scriptContext({ participant: { money_enabled: false } });
    await expect(ledger.getSelfSubmissionContext(callerParameters())).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expectNoWrite();
  });

  it('normalizes thrown transport errors to a safe typed read error', async () => {
    db.builder.maybeSingle.mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT_ERROR'));
    await expect(ledger.getSelfSubmissionContext(callerParameters())).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE', statusCode: 503 });
    expectNoWrite();
  });
});

describe('self contribution creation guards', () => {
  it.each([
    ['numeric amount', { data: submissionData({ original_amount: 5000 }) }],
    ['too precise', { data: submissionData({ original_amount: '5000.001' }) }],
    ['overflow', { data: submissionData({ original_amount: '10000000000000' }) }],
    ['foreign currency', { data: submissionData({ original_currency: 'USD' }) }],
    ['converted base amount', { data: submissionData({ base_amount: '5100.00' }) }],
    ['expense', { data: submissionData({ entry_type: 'expense' }) }],
    ['cycle', { data: submissionData({ cycle_id: OTHER_ID }) }],
    ['crypto flag', { data: submissionData({ is_crypto: true }) }],
    ['crypto payment', { data: submissionData({ payment_method: 'crypto' }) }],
    ['model status', { data: submissionData({ status: 'confirmed' }) }],
    ['empty note', { data: submissionData({ note: '' }) }],
    ['force', { force: true }], ['invalid force', { force: 'false' }],
    ['missing key', { idempotencyKey: undefined }], ['ordinary key', { idempotencyKey: 'http-key' }],
    ['newline key', { idempotencyKey: `${KEY}\n` }],
    ['missing user', { selfSubmission: { expected: ledgerContext() } }],
    ['null options', { selfSubmission: null }],
    ['extra options', { selfSubmission: { userId: actor.userId, expected: ledgerContext(), force: true } }],
  ])('rejects %s before any key or eligibility lookup', async (_label, overrides) => {
    await expect(ledger.createEntry(parameters(overrides))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([false, true])('denies an on-behalf contributor with isAdmin=%s before any query', async (isAdmin) => {
    await expect(ledger.createEntry(parameters({ isAdmin, data: submissionData({ contributor_id: OTHER_ID }) })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([
    ['workspace', { workspace_id: OTHER_ID }], ['container', { container_id: OTHER_ID }],
    ['caller', { contributor_id: OTHER_ID }], ['role', { member_role: 'admin' }],
  ])('denies a mismatched expected %s before any query', async (_label, changes) => {
    await expect(ledger.createEntry(parameters({ selfSubmission: { userId: actor.userId, expected: ledgerContext(changes) } })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it('fails closed on disabled native idempotency without the legacy RPC fallback', async () => {
    const previous = process.env.IDEMPOTENCY_ENABLED;
    let isolatedLedger;
    let isolatedDb;
    try {
      process.env.IDEMPOTENCY_ENABLED = 'false';
      jest.isolateModules(() => {
        isolatedLedger = require('../../../src/services/ledger.service');
        isolatedDb = require('../../../src/config/supabase').__mockInstance;
      });
      await expect(isolatedLedger.createEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE', statusCode: 503 });
      expect(isolatedDb.client.from).not.toHaveBeenCalled();
      expect(isolatedDb.client.rpc).not.toHaveBeenCalled();
      expect(isolatedDb.builder.insert).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.IDEMPOTENCY_ENABLED;
      else process.env.IDEMPOTENCY_ENABLED = previous;
    }
  });
});

describe('self contribution approval snapshot and native idempotency', () => {
  it.each([
    ['currency', { workspace: { base_currency: 'USD' } }],
    ['container label', { container: { name: 'Renamed pool' } }],
    ['container version', { container: { updated_at: '2026-11-14T12:01:00.000Z' } }],
    ['participant identity', { participant: { id: OTHER_ID } }],
  ])('rejects a changed %s before reading the idempotency key', async (_label, changes) => {
    scriptContext(changes);
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(queries('ledger_entries')).toEqual([]);
    expectNoWrite();
  });

  it('checks context again immediately before insertion and stops a changed currency', async () => {
    scriptContext();
    db.mockNextResponse({ data: null, error: null });
    scriptContext({ workspace: { base_currency: 'USD' } });
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(db.client.from.mock.calls).toEqual([
      ['workspaces'], ['workspace_members'], ['containers'], ['container_participants'], ['ledger_entries'],
      ['workspaces'], ['workspace_members'], ['containers'], ['container_participants'],
    ]);
    expectNoWrite();
  });

  it('checks the caller before returning a native replay', async () => {
    scriptContext({ member: { is_active: false } });
    db.mockNextResponse({ data: storedEntry(), error: null });
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(queries('ledger_entries')).toEqual([]);
    expectNoWrite();
  });

  it('returns a matching native replay without insert, notifications or domain audit', async () => {
    scriptContext();
    const entry = storedEntry({ original_amount: '5000.00', base_amount: 5000 });
    db.mockNextResponse({ data: entry, error: null });
    await expect(ledger.createEntry(parameters())).resolves.toEqual({ entry, idempotent: true });
    expect(queries('ledger_entries')[0]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['idempotency_key', KEY] },
    ]));
    expectNoWrite();
  });

  it.each([
    ['workspace', { workspace_id: OTHER_ID }], ['container', { container_id: OTHER_ID }],
    ['contributor', { contributor_id: OTHER_ID }], ['recorder', { recorded_by: OTHER_ID }],
    ['type', { entry_type: 'expense' }], ['currency', { original_currency: 'USD' }],
    ['amount', { original_amount: '5000.01' }], ['base amount', { base_amount: '5000.01' }],
    ['payment type', { payment_method: 'cash' }], ['note', { note: 'Changed note' }],
    ['cycle', { cycle_id: OTHER_ID }], ['crypto', { is_crypto: true }],
    ['status', { status: 'confirmed' }], ['confirmation date', { confirmed_at: '2026-11-14T12:01:00.000Z' }],
    ['confirmer', { confirmed_by: OTHER_ID }], ['correction', { corrects_entry_id: OTHER_ID }],
    ['key', { idempotency_key: 'another-key' }], ['entry identity', { id: 'invalid-id' }],
    ['entry date', { recorded_at: undefined }], ['missing note', { note: undefined }],
  ])('rejects a mismatched replay %s without returning the raw row', async (_label, changes) => {
    scriptContext();
    db.mockNextResponse({ data: storedEntry(changes), error: null });
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expectNoWrite();
  });

  it('does not accept partial native replay data accompanied by a query error', async () => {
    scriptContext();
    db.mockNextResponse({ data: storedEntry(), error: { message: 'PRIVATE_LOOKUP_ERROR' } });
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE', statusCode: 503 });
    expectNoWrite();
  });

  it('validates and returns the native unique-constraint winner without repeating effects', async () => {
    scriptContext();
    db.mockNextResponse({ data: null, error: null });
    scriptContext();
    const entry = storedEntry();
    db.mockResponses(
      { data: null, error: { code: '23505', message: 'PRIVATE_UNIQUE_ERROR' } },
      { data: entry, error: null },
    );
    await expect(ledger.createEntry(parameters())).resolves.toEqual({ entry, idempotent: true });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(queries('ledger_entries')[2]).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['workspace_id', actor.workspace.id] },
      { method: 'eq', args: ['idempotency_key', KEY] },
    ]));
    expect(db.client.rpc).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it('rejects a different native race winner without leaking its row', async () => {
    scriptContext();
    db.mockNextResponse({ data: null, error: null });
    scriptContext();
    db.mockResponses(
      { data: null, error: { code: '23505', message: 'PRIVATE_UNIQUE_ERROR' } },
      { data: storedEntry({ recorded_by: OTHER_ID }), error: null },
    );
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });
});

describe('self contribution insertion and post-insert outcomes', () => {
  it.each([false, true])('inserts pending for the real caller with isAdmin=%s and preserves existing domain effects', async (isAdmin) => {
    scriptInsert({ isAdmin });
    const entry = storedEntry();
    await expect(ledger.createEntry(parameters({ isAdmin }))).resolves.toEqual({ entry, idempotent: false });
    expect(db.builder.insert).toHaveBeenCalledWith({
      ...submissionData(), workspace_id: actor.workspace.id, container_id: CONTAINER_ID,
      idempotency_key: KEY, status: 'pending', recorded_by: actor.member.id,
      confirmed_at: null, confirmed_by: null,
    });
    expect(db.client.from.mock.calls).toEqual([
      ['workspaces'], ['workspace_members'], ['containers'], ['container_participants'], ['ledger_entries'],
      ['workspaces'], ['workspace_members'], ['containers'], ['container_participants'],
      ['ledger_entries'], ['workspace_members'],
    ]);
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledWith({
      type: 'contribution_submitted', workspaceId: actor.workspace.id, recipientIds: [OTHER_ID],
      referenceType: 'ledger_entry', referenceId: entry.id,
      variables: { actor: actor.member.displayName, amount: '5000.00 NGN', container: CONTAINER_ID },
    });
    expect(audit.log).toHaveBeenCalledWith({ ...actorCtx, action: AUDIT_ACTIONS.LEDGER_SUBMITTED,
      targetType: 'ledger_entry', targetId: entry.id });
    expect(db.client.rpc).not.toHaveBeenCalled();
  });

  it('keeps ordinary admin HTTP submissions confirmed with their existing key behavior', async () => {
    const entry = storedEntry({ status: 'confirmed', confirmed_by: actor.member.id,
      confirmed_at: '2026-11-14T12:01:00.000Z' });
    db.mockResponses(
      { data: null, error: null }, { data: participantRow(), error: null },
      { data: { is_proxy: false }, error: null }, { data: entry, error: null },
    );
    await expect(ledger.createEntry(parameters({
      isAdmin: true, selfSubmission: undefined, idempotencyKey: 'http-key',
      data: submissionData({ original_amount: 5000, base_amount: 5000 }),
    }))).resolves.toEqual({ entry, idempotent: false });
    expect(db.builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'confirmed', confirmed_by: actor.member.id, confirmed_at: expect.any(String),
      idempotency_key: 'http-key',
    }));
    expect(queries('workspaces')).toEqual([]);
    expect(notification.send).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.LEDGER_CONFIRMED }));
  });

  it.each([
    ['missing result', null], ['different amount', storedEntry({ original_amount: 5001 })],
    ['unexpected confirmation', storedEntry({ status: 'confirmed' })],
    ['wrong recorder', storedEntry({ recorded_by: OTHER_ID })],
  ])('keeps %s after INSERT uncertain rather than reporting no mutation', async (_label, data) => {
    scriptInsert({ response: { data, error: null } });
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({
      code: 'LEDGER_SUBMISSION_INDETERMINATE', statusCode: 503,
    });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });

  it('returns a safe non-conflict error after an INSERT database error', async () => {
    scriptInsert({ response: { data: storedEntry(), error: { message: 'PRIVATE_INSERT_ERROR', code: 'XX000' } } });
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({
      code: 'LEDGER_UNAVAILABLE', statusCode: 503, message: 'Ledger submissions are unavailable. Please try again.',
    });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });

  it('normalizes a thrown INSERT transport failure without retrying', async () => {
    scriptContext();
    db.mockNextResponse({ data: null, error: null });
    scriptContext();
    db.builder.single.mockRejectedValueOnce(new Error('PRIVATE_INSERT_TRANSPORT_ERROR'));
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE', statusCode: 503 });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });

  it('keeps a failed post-insert admin lookup uncertain despite partial data', async () => {
    scriptInsert({ admins: { data: [{ id: OTHER_ID }], error: { message: 'PRIVATE_ADMIN_QUERY_ERROR' } } });
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE', statusCode: 503 });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });

  it('never reports a notification conflict as proof that the preceding INSERT did not apply', async () => {
    scriptInsert();
    notification.send.mockRejectedValueOnce(new ConflictError('PRIVATE_NOTIFICATION_ERROR'));
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE', statusCode: 503 });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('keeps an audit failure after insertion uncertain and does not repeat effects', async () => {
    scriptInsert();
    audit.log.mockRejectedValueOnce(new ConflictError('PRIVATE_AUDIT_ERROR'));
    await expect(ledger.createEntry(parameters())).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE', statusCode: 503 });
    expect(db.builder.insert).toHaveBeenCalledTimes(1);
    expect(notification.send).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });
});
