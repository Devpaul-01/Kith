jest.mock('../../../src/services/container.service', () => ({ getContainer: jest.fn() }));
jest.mock('../../../src/services/dashboard.service', () => ({ getDashboardData: jest.fn(), getOverdueSummaryData: jest.fn() }));

const { randomUUID } = require('crypto');
const { runReadTurnWithHistory } = require('../../../src/agent/services/read-loop.service');
const { markAllNotificationsReadDefinition } = require('../../../src/agent/services/notification-proposal.service');
const { archiveContainerDefinition } = require('../../../src/agent/services/container-archive-proposal.service');
const { addDisputeNoteDefinition } = require('../../../src/agent/services/dispute-note-proposal.service');
const {
  containerArchiveAfter, CONTAINER_ARCHIVE_SUMMARY, disputeNoteParametersFromArgs, disputeNoteAfter, DISPUTE_NOTE_SUMMARY,
} = require('../../../src/agent/validators/proposal.validator');
const { context, member } = require('../../helpers/agent-proposal');

const MEMBER_ID = context().member.id;
const WORKSPACE_ID = context().workspace.id;
const CONTAINER_ID = '33333333-3333-4333-8333-333333333333';
const DISPUTE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';
const admin = { ...context(), member: { ...context().member, role: 'admin' } };
const archiveSelection = (changes = {}) => ({ workspace_id: WORKSPACE_ID, actor_member_id: MEMBER_ID, member_role: 'admin',
  container: { container_id: CONTAINER_ID, name: 'Wedding', container_type: 'event', status: 'active', enable_money: true,
    enable_tasks: false, updated_at: '2026-11-26T10:00:00.123456+00:00', ...changes } });
const noteSelection = () => ({ workspace_id: WORKSPACE_ID, actor_member_id: MEMBER_ID, member_role: 'member',
  dispute: { dispute_id: DISPUTE_ID, ledger_entry_id: OTHER_ID, raised_by: MEMBER_ID, reason: 'The amount is wrong',
    status: 'open', raised_at: '2026-11-16T12:03:00.000Z' } });
const expires = () => new Date(Date.now() + 60000).toISOString();
const archiveCard = (before, containerId = CONTAINER_ID) => ({ id: randomUUID(), tool: 'archive_container', tier: 3,
  summary: CONTAINER_ARCHIVE_SUMMARY, parameters: { container_id: containerId }, before, after: containerArchiveAfter(before), expires_at: expires() });
const noteCard = (before, note = 'Receipt sent') => {
  const parameters = disputeNoteParametersFromArgs(before, { note });
  return { id: randomUUID(), tool: 'add_dispute_note', tier: 2, summary: DISPUTE_NOTE_SUMMARY, parameters, before,
    after: disputeNoteAfter(before, parameters), expires_at: expires() };
};
const call = (name, args) => ({ id: 'call_1', name, arguments: JSON.stringify(args) });
const run = (card, tool, args, extra, options = {}) => {
  const chat = jest.fn().mockResolvedValueOnce({ toolCalls: [call(tool.name, args)] });
  const proposalSupport = { definitions: [markAllNotificationsReadDefinition, tool], create: jest.fn().mockResolvedValue(card), ...extra };
  return runReadTurnWithHistory({ data: { message: 'Do it' }, context: options.context || admin, provider: { chat }, proposalSupport });
};

describe('archive_container', () => {
  it('returns the card only when it matches the request selection', async () => {
    const before = archiveSelection();
    const card = archiveCard(before);
    const { reply } = await run(card, archiveContainerDefinition, {}, { containerArchiveSelection: before });
    expect(reply.proposal).toEqual(card);
  });

  it.each([
    ['another container', (before) => archiveCard(archiveSelection({ container_id: OTHER_ID }), OTHER_ID)],
    ['a different version', () => archiveCard(archiveSelection({ updated_at: '2026-11-26T10:30:00.000000+00:00' }))],
    ['a mismatched parameter', (before) => archiveCard(before, OTHER_ID)],
  ])('rejects a card for %s', async (_label, build) => {
    const before = archiveSelection();
    await expect(run(build(before), archiveContainerDefinition, {}, { containerArchiveSelection: before })).rejects.toBeDefined();
  });

  it('offers the selection to the model in get_my_context', async () => {
    const before = archiveSelection();
    const chat = jest.fn().mockResolvedValueOnce({ text: 'ok' });
    await runReadTurnWithHistory({ data: { message: 'Archive it' }, context: admin, provider: { chat },
      proposalSupport: { definitions: [markAllNotificationsReadDefinition, archiveContainerDefinition], create: jest.fn(), containerArchiveSelection: before } });
    const toolMessage = chat.mock.calls[0][0].messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMessage.content).data.selected_container_archive).toEqual(before);
  });
});

describe('add_dispute_note', () => {
  it('returns the card only when it matches the selection and requested note', async () => {
    const before = noteSelection();
    const card = noteCard(before);
    const { reply } = await run(card, addDisputeNoteDefinition, { note: 'Receipt sent' }, { disputeNoteSelection: before }, { context: context() });
    expect(reply.proposal).toEqual(card);
  });

  it.each([
    ['a different note than requested', (before) => noteCard(before, 'Something else')],
    ['another dispute', () => noteCard({ ...noteSelection(), dispute: { ...noteSelection().dispute, dispute_id: OTHER_ID } })],
  ])('rejects a card with %s', async (_label, build) => {
    const before = noteSelection();
    await expect(run(build(before), addDisputeNoteDefinition, { note: 'Receipt sent' }, { disputeNoteSelection: before }, { context: context() }))
      .rejects.toBeDefined();
  });
});
