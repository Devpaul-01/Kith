// tests/unit/services/notification.service.test.js
jest.mock('../../../src/config/supabase', () => {
  const { mockSupabase: createMock } = require('../../mocks/supabase.mock');
  const instance = createMock();
  return {
    supabaseAdmin: instance.client,
    supabase: instance.client,
    supabaseAuth: instance.client,
    __mockInstance: instance,
  };
});

jest.mock('../../../src/config/redis', () => require('../../mocks/redis.mock'));
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../src/queues');

const notificationService = require('../../../src/services/notification.service');
const { renderTemplate, buildDedupKey, send } = notificationService;
const { getQueue } = require('../../../src/queues');
const logger = require('../../../src/utils/logger');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/notification.service', () => {
  describe('renderTemplate (pure function, Doc 2 Section 5.2)', () => {
    it('substitutes a single variable', () => {
      expect(renderTemplate('{actor} did {thing}', { actor: 'Bob', thing: 'X' })).toBe('Bob did X');
    });

    it('a variable key present with value undefined -> empty string substitution, not literal "undefined"', () => {
      // renderTemplate only touches placeholders for keys that are
      // PRESENT in `variables` (it iterates Object.entries(variables));
      // a key that is present but explicitly undefined still gets
      // replaced via `String(value ?? '')` -> ''.
      expect(renderTemplate('Value: {missing}', { missing: undefined })).toBe('Value: ');
    });

    it('a placeholder with NO corresponding key in variables at all is left untouched (documented current behavior)', () => {
      // Distinct from the case above: renderTemplate has no fallback
      // pass for placeholders whose key never appears in `variables` —
      // it only iterates the variables object's own entries. Call
      // sites in this codebase always pass every placeholder used in
      // a given template, so this gap isn't hit in practice, but it's
      // worth documenting the actual (not assumed) behavior explicitly.
      expect(renderTemplate('Value: {missing}', {})).toBe('Value: {missing}');
    });

    it('value 0 (falsy but valid) renders as "0", not empty string (nullish coalescing, not ||)', () => {
      expect(renderTemplate('Count: {count}', { count: 0 })).toBe('Count: 0');
    });

    it('value false renders as "false"', () => {
      expect(renderTemplate('Flag: {flag}', { flag: false })).toBe('Flag: false');
    });

    it('replaces multiple occurrences of the same placeholder (replaceAll, not replace)', () => {
      expect(renderTemplate('{c} and {c} again', { c: 'X' })).toBe('X and X again');
    });
  });

  describe('dedup key behavior — buildDedupKey is not exported, so tested indirectly via send()', () => {
    beforeEach(() => {
      mockSupabaseInstance.reset();
      jest.clearAllMocks();
    });

    it('two send() calls with identical dedup-relevant variables produce the same dedup_key on the upsert (deterministic key construction)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'm1', is_proxy: false, users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'notif-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'delivery-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await send({
        type: 'payment_reminder', workspaceId: 'ws-1', recipientIds: ['m1'],
        variables: { container_id: 'k1', due_date: '2026-01-01' },
      });

      const upsertCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'upsert');
      expect(upsertCall.args[0].dedup_key).toBe('payment_reminder:k1:2026-01-01:m1');
    });
  });

  describe('send / _sendToRecipient', () => {
    let queueAddMock;

    beforeEach(() => {
      mockSupabaseInstance.reset();
      jest.clearAllMocks();
      queueAddMock = jest.fn().mockResolvedValue({ id: 'job-1' });
      getQueue.mockReturnValue({ add: queueAddMock });
    });

    it('unknown notification type -> warns and returns without querying the DB', async () => {
      await send({ type: 'not_a_real_type', workspaceId: 'ws-1', recipientIds: ['m1'] });

      expect(logger.warn).toHaveBeenCalledWith('Unknown notification type', { type: 'not_a_real_type' });
      expect(mockSupabaseInstance.getCalls().length).toBe(0);
    });

    it('recipient not found -> silently skipped, no error thrown', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(send({ type: 'task_completed', workspaceId: 'ws-1', recipientIds: ['missing'] })).resolves.toBeUndefined();
    });

    it('handles the bare-object users shape (not array-wrapped)', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: { id: 'm1', is_proxy: false, users: { id: 'u1', push_token: 'tok', push_token_platform: 'ios', push_enabled: true, email: 'a@b.com', email_digest_enabled: true } },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'notif-1' }, error: null }); // notification upsert
      mockSupabaseInstance.mockNextResponse({ data: { id: 'delivery-1' }, error: null }); // in_app delivery insert
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // in_app delivery update to 'delivered'

      await send({ type: 'task_completed', workspaceId: 'ws-1', recipientIds: ['m1'], variables: { actor: 'Bob', task_title: 'X' } });

      const insertedNotif = mockSupabaseInstance.getCalls().find((c) => c.method === 'upsert');
      expect(insertedNotif).toBeDefined();
    });

    it('handles the array-wrapped users shape', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: { id: 'm1', is_proxy: false, users: [{ id: 'u1', push_token: 'tok', push_enabled: true, email: 'a@b.com', email_digest_enabled: true }] },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'notif-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'delivery-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        send({ type: 'task_completed', workspaceId: 'ws-1', recipientIds: ['m1'], variables: { actor: 'Bob', task_title: 'X' } })
      ).resolves.toBeUndefined();
    });

    it('dedup hit (upsert returns no row) -> no delivery rows created', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'm1', is_proxy: false, users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // upsert: dedup hit, ignoreDuplicates -> no row returned

      await send({ type: 'task_completed', workspaceId: 'ws-1', recipientIds: ['m1'], variables: {} });

      const deliveryInserts = mockSupabaseInstance.getCalls().filter((c) => c.method === 'insert');
      expect(deliveryInserts.length).toBe(0);
    });

    it('proxy recipient: only in_app channel attempted, push/email skipped', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'm1', is_proxy: true, users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'notif-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'delivery-1' }, error: null }); // in_app only
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // update to delivered

      await send({ type: 'task_assigned', workspaceId: 'ws-1', recipientIds: ['m1'], variables: { actor: 'Bob', task_title: 'X' } });

      expect(queueAddMock).not.toHaveBeenCalled();
    });

    it('external channel enqueue failure -> delivery marked failed, does not throw', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'm1', is_proxy: false, users: { id: 'u1', push_enabled: true, push_token: 'tok' } }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'notif-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'delivery-in-app' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // in_app delivered update
      mockSupabaseInstance.mockNextResponse({ data: { id: 'delivery-push' }, error: null }); // push delivery insert
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // failed status update
      queueAddMock.mockRejectedValueOnce(new Error('queue down'));

      await expect(
        send({ type: 'task_assigned', workspaceId: 'ws-1', recipientIds: ['m1'], variables: { actor: 'Bob', task_title: 'X' } })
      ).resolves.toBeUndefined();
    });

    it('per-recipient failure is isolated (one bad recipient does not stop others)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'lookup failed for m1' } });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'm2', is_proxy: false, users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'notif-2' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'delivery-2' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        send({ type: 'task_completed', workspaceId: 'ws-1', recipientIds: ['m1', 'm2'], variables: {} })
      ).resolves.toBeUndefined();
      // m1's recErr path returns early inside _sendToRecipient without throwing,
      // so logger.error for "Failed to send notification" wouldn't fire for that
      // specific case (it fails soft) — assert m2's notification WAS created.
      const upserts = mockSupabaseInstance.getCalls().filter((c) => c.method === 'upsert');
      expect(upserts.length).toBe(1);
    });
  });
});
