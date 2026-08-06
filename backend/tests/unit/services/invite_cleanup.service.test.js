// tests/unit/services/invite_cleanup.service.test.js
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
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { runInviteCleanup } = require('../../../src/services/invite_cleanup.service');
const logger = require('../../../src/utils/logger');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/invite_cleanup.service — runInviteCleanup', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
  });

  it('deletes expired, unused invites and logs the count', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'i1' }, { id: 'i2' }], error: null });

    await runInviteCleanup();

    expect(logger.info).toHaveBeenCalledWith('Invite cleanup complete', { deleted: 2 });
  });

  it('filters by expires_at < now AND used_at IS NULL (expired-but-used invites are NOT deleted)', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await runInviteCleanup();

    const ltCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'lt' && c.args[0] === 'expires_at');
    const isCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'is' && c.args[0] === 'used_at');
    expect(ltCall).toBeDefined();
    expect(isCall.args[1]).toBeNull();
  });

  it('logs 0 when nothing is deleted', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await runInviteCleanup();

    expect(logger.info).toHaveBeenCalledWith('Invite cleanup complete', { deleted: 0 });
  });

  it('throws a plain Error when the delete query errors (fail loud, not silently swallowed)', async () => {
    mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'delete failed' } });

    await expect(runInviteCleanup()).rejects.toThrow('delete failed');
  });
});
