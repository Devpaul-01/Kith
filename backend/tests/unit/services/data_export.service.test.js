// tests/unit/services/data_export.service.test.js
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
jest.mock('../../../src/config/resend', () => require('../../mocks/resend.mock'));
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { processDataExport } = require('../../../src/services/data_export.service');
const { __mockEmailsSend } = require('../../mocks/resend.mock');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/data_export.service — processDataExport', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    __mockEmailsSend.mockClear();
  });

  it('sends the export email when a valid membership resolves', async () => {
    mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1', full_name: 'Bob' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await processDataExport({ userId: 'user-1', userEmail: 'a@b.com', workspaceIds: ['ws-1'] });

    expect(__mockEmailsSend).toHaveBeenCalled();
  });

  it('zero memberships -> no ledger/task queries attempted', async () => {
    mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await processDataExport({ userId: 'user-1', userEmail: 'a@b.com', workspaceIds: [] });

    const fromCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'from');
    expect(fromCalls.map((c) => c.args[0])).not.toContain('ledger_entries');
  });

  it('member resolution query error is fail-loud (throws)', async () => {
    mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'member query failed' } });

    await expect(
      processDataExport({ userId: 'user-1', userEmail: 'a@b.com', workspaceIds: ['ws-1'] })
    ).rejects.toThrow('member query failed');
  });

  it('Resend throws -> the promise rejects (BullMQ retry engages)', async () => {
    mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    __mockEmailsSend.mockRejectedValueOnce(new Error('resend down'));

    await expect(
      processDataExport({ userId: 'user-1', userEmail: 'a@b.com', workspaceIds: [] })
    ).rejects.toThrow('resend down');
  });

  it('attaches both CSV files with distinct filenames', async () => {
    mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await processDataExport({ userId: 'user-1', userEmail: 'a@b.com', workspaceIds: ['ws-1'] });

    const call = __mockEmailsSend.mock.calls[0][0];
    expect(call.attachments).toHaveLength(2);
    expect(call.attachments[0].filename).toMatch(/^kith-contributions-/);
    expect(call.attachments[1].filename).toMatch(/^kith-tasks-/);
  });

  it('escapes HTML-unsafe display name in the email body (XSS defense)', async () => {
    mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1', full_name: '<script>alert(1)</script>' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await processDataExport({ userId: 'user-1', userEmail: 'a@b.com', workspaceIds: [] });

    const call = __mockEmailsSend.mock.calls[0][0];
    expect(call.html).not.toContain('<script>alert(1)</script>');
    expect(call.html).toContain('&lt;script&gt;');
  });
});
