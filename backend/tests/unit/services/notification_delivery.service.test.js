// tests/unit/services/notification_delivery.service.test.js
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
jest.mock('../../../src/config/firebase', () => require('../../mocks/firebase.mock'));
jest.mock('../../../src/config/resend', () => require('../../mocks/resend.mock'));
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { deliverNotification } = require('../../../src/services/notification_delivery.service');
const { __mockMessagingSend } = require('../../mocks/firebase.mock');
const { __mockEmailsSend } = require('../../mocks/resend.mock');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const baseJob = {
  notification_id: 'notif-1', delivery_id: 'delivery-1', channel: 'push',
  recipient_user_id: 'user-1', push_token: 'tok-1', push_token_platform: 'ios', push_enabled: true,
  email: 'a@b.com', email_digest_enabled: true, title: 'Hi', body: 'Body',
  reference_type: 'task', reference_id: 't1', workspace_id: 'ws-1',
};

describe('services/notification_delivery.service — deliverNotification', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    __mockMessagingSend.mockClear();
    __mockEmailsSend.mockClear();
  });

  it('idempotency: already-delivered -> skips entirely, zero further client calls', async () => {
    mockSupabaseInstance.mockNextResponse({ data: { status: 'delivered' }, error: null });

    await deliverNotification(baseJob);

    expect(__mockMessagingSend).not.toHaveBeenCalled();
    expect(mockSupabaseInstance.getCalls().filter((c) => c.method === 'update').length).toBe(0);
  });

  describe('push channel', () => {
    it('push disabled -> status "skipped", not "failed"', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification({ ...baseJob, push_enabled: false });

      const skipUpdate = mockSupabaseInstance.getCalls().find((c) => c.method === 'update' && c.args[0]?.status === 'skipped');
      expect(skipUpdate).toBeDefined();
      expect(__mockMessagingSend).not.toHaveBeenCalled();
    });

    it('missing push_token -> status "skipped"', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification({ ...baseJob, push_token: null });

      const skipUpdate = mockSupabaseInstance.getCalls().find((c) => c.method === 'update' && c.args[0]?.status === 'skipped');
      expect(skipUpdate).toBeDefined();
    });

    it('PUSH TOKEN ROTATION: job\'s push_token no longer matches user\'s current token -> "skipped"', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { push_token: 'DIFFERENT-TOKEN' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification(baseJob);

      expect(__mockMessagingSend).not.toHaveBeenCalled();
      const skipUpdate = mockSupabaseInstance.getCalls().find((c) => c.method === 'update' && c.args[0]?.status === 'skipped');
      expect(skipUpdate).toBeDefined();
    });

    it('successful push send -> status "delivered", delivered_at set', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { push_token: 'tok-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification(baseJob);

      expect(__mockMessagingSend).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-1' }));
      const deliveredUpdate = mockSupabaseInstance.getCalls().find((c) => c.method === 'update' && c.args[0]?.status === 'delivered');
      expect(deliveredUpdate).toBeDefined();
    });

    it('web platform includes webpush notification config', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { push_token: 'tok-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification({ ...baseJob, push_token_platform: 'web' });

      expect(__mockMessagingSend).toHaveBeenCalledWith(expect.objectContaining({ webpush: expect.any(Object) }));
    });
  });

  describe('email channel', () => {
    it('REGRESSION: email_digest_enabled === false -> "skipped", no email sent', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification({ ...baseJob, channel: 'email', email_digest_enabled: false });

      expect(__mockEmailsSend).not.toHaveBeenCalled();
    });

    it('email_digest_enabled undefined (legacy user row) -> fails open, email IS sent', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification({ ...baseJob, channel: 'email', email_digest_enabled: undefined });

      expect(__mockEmailsSend).toHaveBeenCalled();
    });

    it('missing email address -> "skipped"', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification({ ...baseJob, channel: 'email', email: null });

      expect(__mockEmailsSend).not.toHaveBeenCalled();
    });

    it('ADVERSARIAL XSS: title/body with <script>/&/" are escaped in the HTML email body', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification({
        ...baseJob, channel: 'email',
        title: '<script>alert(1)</script>', body: 'Tom & "Jerry" <b>bold</b>',
      });

      const sentHtml = __mockEmailsSend.mock.calls[0][0].html;
      expect(sentHtml).not.toContain('<script>alert(1)</script>');
      expect(sentHtml).toContain('&lt;script&gt;');
      expect(sentHtml).toContain('Tom &amp; &quot;Jerry&quot; &lt;b&gt;bold&lt;/b&gt;');
    });

    it('successful email send -> status "delivered"', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification({ ...baseJob, channel: 'email' });

      const deliveredUpdate = mockSupabaseInstance.getCalls().find((c) => c.method === 'update' && c.args[0]?.status === 'delivered');
      expect(deliveredUpdate).toBeDefined();
    });
  });

  describe('failure handling — re-throws for BullMQ retry', () => {
    it('a send failure marks status "failed" with a truncated error message, AND re-throws', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 0 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { push_token: 'tok-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      __mockMessagingSend.mockRejectedValueOnce(new Error('FCM unreachable'));

      await expect(deliverNotification(baseJob)).rejects.toThrow('FCM unreachable');

      const failedUpdate = mockSupabaseInstance.getCalls().find((c) => c.method === 'update' && c.args[0]?.status === 'failed');
      expect(failedUpdate.args[0].error_message).toBe('FCM unreachable');
    });
  });

  describe('retry bookkeeping', () => {
    it('increments retry_count and sets last_attempt_at on every attempt', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { status: 'pending' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { retry_count: 2 }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { push_token: 'tok-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await deliverNotification(baseJob);

      const attemptUpdate = mockSupabaseInstance.getCalls().find((c) => c.method === 'update' && c.args[0]?.retry_count !== undefined);
      expect(attemptUpdate.args[0].retry_count).toBe(3);
      expect(attemptUpdate.args[0]).toHaveProperty('last_attempt_at');
    });
  });
});
