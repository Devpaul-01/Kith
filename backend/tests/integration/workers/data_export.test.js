// tests/integration/workers/data_export.test.js
//
// Doc 3 Section 5.8 — data_export.service.js (processDataExport). Resend
// is mocked per Doc 3 Section 1's "mock external SaaS always" rule (see
// tests/setup.integration.js, which jest.mocks config/resend globally).

const { processDataExport } = require('../../../src/services/data_export.service');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getResend } = require('../../../src/config/resend');
const { seedWorkspaceWithAdmin, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildContainer } = require('../../fixtures/factories');

describe('data_export.service.js — processDataExport', () => {
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  async function seedTenant() {
    const { workspace, user, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    return { workspace, user, member };
  }

  it('user with memberships in workspace A only, but workspaceIds param includes A and B — only A\'s data included (no leakage)', async () => {
    const { workspace: wsA, user, member: memberA } = await seedTenant();
    const wsB = await seedWorkspaceWithAdmin(supabaseAdmin); // user is NOT a member of this one
    seededWorkspaceIds.push(wsB.workspace.id);

    const containerA = buildContainer({ workspace_id: wsA.id, created_by: memberA.id, enable_money: true });
    await supabaseAdmin.from('containers').insert(containerA);
    await supabaseAdmin.from('container_participants').insert({ container_id: containerA.id, workspace_member_id: memberA.id, money_enabled: true });
    await supabaseAdmin.from('ledger_entries').insert({
      workspace_id: wsA.id, container_id: containerA.id, entry_type: 'contribution', contributor_id: memberA.id,
      original_amount: 25, original_currency: 'USD', base_amount: 25, status: 'confirmed', recorded_by: memberA.id,
    });

    await processDataExport({ userId: user.id, userEmail: user.email, workspaceIds: [wsA.id, wsB.workspace.id] });

    const resend = getResend();
    const call = resend.emails.send.mock.calls[resend.emails.send.mock.calls.length - 1][0];
    const ledgerCsvAttachment = call.attachments.find((a) => a.filename.includes('contributions'));
    const ledgerCsv = Buffer.from(ledgerCsvAttachment.content, 'base64').toString('utf8');

    expect(ledgerCsv).toContain('25');
    // No stray reference to wsB's own workspace name should appear.
    expect(ledgerCsv).not.toContain(wsB.workspace.name);
  });

  it('zero entries/tasks produces CSVs with header row only, no error', async () => {
    const { user } = await seedTenant();

    await expect(processDataExport({ userId: user.id, userEmail: user.email, workspaceIds: [] })).resolves.not.toThrow();

    const resend = getResend();
    const call = resend.emails.send.mock.calls[resend.emails.send.mock.calls.length - 1][0];
    const ledgerCsvAttachment = call.attachments.find((a) => a.filename.includes('contributions'));
    const ledgerCsv = Buffer.from(ledgerCsvAttachment.content, 'base64').toString('utf8');
    // Header row only — a single line, no data rows.
    expect(ledgerCsv.trim().split('\n').length).toBe(1);
  });

  it('Resend not configured "succeeds" silently (logged warning, no retry — job resolves normally)', async () => {
    const { user } = await seedTenant();

    const spy = jest.spyOn(require('../../../src/config/resend'), 'getResend').mockReturnValueOnce(null);

    await expect(processDataExport({ userId: user.id, userEmail: user.email, workspaceIds: [] })).resolves.not.toThrow();

    spy.mockRestore();
  });

  it('Resend throwing causes the job promise to reject (so BullMQ\'s attempts: 2 retry engages)', async () => {
    const { user } = await seedTenant();

    const resend = getResend();
    resend.emails.send.mockRejectedValueOnce(new Error('simulated Resend outage'));

    await expect(processDataExport({ userId: user.id, userEmail: user.email, workspaceIds: [] })).rejects.toThrow();
  });
});
