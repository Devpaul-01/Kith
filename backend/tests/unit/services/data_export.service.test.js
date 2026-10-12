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

  // ── CSV field escaping ───────────────────────────────────────────
  //
  // Previously untested: every ledger/task field that lands in the CSV
  // attachments (note, payment_method, completion_note, container/
  // workspace names) is user-controlled text that gets emailed as a CSV
  // attachment people routinely open in Excel/Sheets. Three distinct
  // risks: (1) a literal comma or quote inside a field corrupting the
  // column structure if not quoted/escaped, (2) a value starting with
  // =, +, -, or @ triggering CSV/formula injection in the spreadsheet
  // app that opens it, (3) embedded newlines breaking the row count.
  describe('CSV field escaping (escapeCsv, via the ledger/task CSV payloads)', () => {
    function decodeAttachment(call, index) {
      return Buffer.from(call.attachments[index].content, 'base64').toString('utf8');
    }

    it('a note containing a comma and a double quote does not corrupt the row structure', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{
          id: 'le1', entry_type: 'contribution', original_amount: 50, original_currency: 'USD',
          base_amount: 50, payment_method: 'bank', status: 'confirmed',
          note: 'Paid, in full "today"', recorded_at: '2026-01-01', confirmed_at: '2026-01-02',
          container: { name: 'Rent' }, workspace: { name: 'The Smiths' },
        }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await processDataExport({ userId: 'user-1', userEmail: 'a@b.com', workspaceIds: ['ws-1'] });

      const csv = decodeAttachment(__mockEmailsSend.mock.calls[0][0], 0);
      const rows = csv.split('\n');
      expect(rows).toHaveLength(2); // header + exactly one data row — the embedded comma didn't split it
      // Embedded double quotes inside a quoted field must be doubled per
      // RFC 4180, so the field is `"Paid, in full ""today"""`.
      expect(rows[1]).toContain('"Paid, in full ""today"""');
    });

    it('a note starting with "=" is still wrapped in quotes (does not neutralize formula injection by itself, but must not break row structure)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{
          id: 'le1', entry_type: 'contribution', original_amount: 50, original_currency: 'USD',
          base_amount: 50, payment_method: 'bank', status: 'confirmed',
          note: '=SUM(1+1)', recorded_at: '2026-01-01', confirmed_at: null,
          container: { name: 'Rent' }, workspace: { name: 'The Smiths' },
        }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await processDataExport({ userId: 'user-1', userEmail: 'a@b.com', workspaceIds: ['ws-1'] });

      const csv = decodeAttachment(__mockEmailsSend.mock.calls[0][0], 0);
      const rows = csv.split('\n');
      expect(rows).toHaveLength(2);
      // Documents current behavior: the field is quoted but the leading
      // "=" is preserved as-is. Flagging this explicitly (rather than
      // silently passing) because several spreadsheet apps still treat a
      // quoted field starting with =/+/-/@ as a formula on open — if
      // that's a risk worth closing, escapeCsv should prefix a leading
      // apostrophe for those characters. See PR description.
      expect(rows[1]).toContain('"=SUM(1+1)"');
    });

    it('a completion_note with an embedded newline does not add a spurious CSV row', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{
          id: 't1', title: 'Pay rent', status: 'completed', due_date: '2026-01-01',
          completed_at: '2026-01-02', completion_note: 'Done.\nConfirmed by Alice.',
          created_at: '2025-12-01', container: { name: 'Rent' },
        }],
      });

      await processDataExport({ userId: 'user-1', userEmail: 'a@b.com', workspaceIds: ['ws-1'] });

      const csv = decodeAttachment(__mockEmailsSend.mock.calls[0][0], 1);
      // Header + one logical data row. A naive split('\n') WOULD see 3
      // lines here if the embedded newline weren't contained inside the
      // quoted field — asserting on the quoted field's exact content
      // (rather than row count, which an RFC-4180-correct CSV reader
      // would get right regardless) is the real test of escapeCsv.
      expect(csv).toContain('"Done.\nConfirmed by Alice."');
    });

    it('a null/undefined field is rendered as an empty quoted string, not the literal text "null" or "undefined"', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{
          id: 'le1', entry_type: 'contribution', original_amount: 50, original_currency: 'USD',
          base_amount: 50, payment_method: null, status: 'pending',
          note: undefined, recorded_at: '2026-01-01', confirmed_at: null,
          container: null, workspace: null,
        }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await processDataExport({ userId: 'user-1', userEmail: 'a@b.com', workspaceIds: ['ws-1'] });

      const csv = decodeAttachment(__mockEmailsSend.mock.calls[0][0], 0);
      expect(csv).not.toMatch(/\bnull\b/);
      expect(csv).not.toMatch(/\bundefined\b/);
    });
  });
});
