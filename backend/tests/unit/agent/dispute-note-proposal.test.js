jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/dispute.service', () => ({ getDisputeNoteContext: jest.fn(), addReviewedDisputeNote: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { ConflictError, NotFoundError, BusinessRuleError, ForbiddenError } = require('../../../src/utils/errors');
const members = require('../../../src/services/member.service');
const disputes = require('../../../src/services/dispute.service');
const audit = require('../../../src/services/audit.service');
const domain = require('../../../src/agent/services/dispute-note-proposal.service');
const { createProposal, decideProposal, getProposalStatus } = require('../../../src/agent/services/proposal.service');
const { executeReadTool } = require('../../../src/agent/services/tool-registry.service');
const { serializeToolDefinitions } = require('../../../src/agent/providers/tool-definitions');
const { proposalSchema, proposalStatusSchema } = require('../../../src/agent/validators/proposal.validator');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');
const { DISPUTE_ID, ENTRY_ID, SESSION_ID, EXECUTION_TIME } = require('../../helpers/agent-dispute-raise');

const actor = context();
const withMember = (changes) => ({ ...context(), member: { ...context().member, ...changes } });
const NOTE = 'I attached the receipt to the group chat.';
const selection = (changes = {}) => ({
  workspace_id: actor.workspace.id, actor_member_id: actor.member.id, member_role: 'member',
  dispute: { dispute_id: DISPUTE_ID, ledger_entry_id: ENTRY_ID, raised_by: actor.member.id,
    reason: 'The recorded amount does not match my contribution.', status: 'open', raised_at: EXECUTION_TIME, ...changes.dispute },
  ...Object.fromEntries(Object.entries(changes).filter(([key]) => key !== 'dispute')),
});
const appended = (changes = {}) => ({ dispute_id: DISPUTE_ID,
  note: { author_id: actor.member.id, note: NOTE, added_at: '2026-11-26T10:00:00.123Z', ...changes } });

let redis;
const create = (overrides = {}) => createProposal({ context: actor, tool: 'add_dispute_note', selection: selection(),
  args: { note: NOTE }, turnId: SESSION_ID, redisFactory: () => redis, ...overrides });
const approve = (proposal) => decideProposal({ context: actor, proposalId: proposal.id, data: {}, decision: 'approve',
  redisFactory: () => redis });

beforeEach(() => {
  redis = new Redis();
  members.getActiveMembership.mockReset().mockResolvedValue(member());
  disputes.getDisputeNoteContext.mockReset().mockResolvedValue(selection());
  disputes.addReviewedDisputeNote.mockReset().mockResolvedValue(appended());
  audit.log.mockReset().mockResolvedValue();
});
afterEach(async () => { await redis.flushall(); await redis.quit(); });

it('registers a member Tier 2 proposal that exposes only the note and has no immediate executor', async () => {
  expect(domain.addDisputeNoteDefinition).toMatchObject({ name: 'add_dispute_note', tier: 2, minRole: 'member' });
  const { name, description, parameterSchema } = domain.addDisputeNoteDefinition;
  const [tool] = serializeToolDefinitions([{ name, description, parameterSchema }]);
  expect(Object.keys(tool.function.parameters.properties)).toEqual(['note']);
  expect(tool.function.parameters).toMatchObject({ required: ['note'], additionalProperties: false });
  await expect(executeReadTool({ name: 'add_dispute_note', args: { note: NOTE }, context: actor })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(disputes.addReviewedDisputeNote).not.toHaveBeenCalled();
});

it('selects a dispute with the authenticated member identity and returns a frozen snapshot', async () => {
  const selected = await domain.selectDisputeNote({ context: actor, disputeId: DISPUTE_ID.toUpperCase() });
  expect(disputes.getDisputeNoteContext).toHaveBeenCalledWith({ workspaceId: actor.workspace.id, disputeId: DISPUTE_ID,
    callerId: actor.member.id, userId: actor.userId });
  expect(selected).toEqual(selection());
  expect(Object.isFrozen(selected) && Object.isFrozen(selected.dispute)).toBe(true);
});

it.each([null, withMember({ isActive: false })])('denies an invalid context before reading disputes: %j', async (invalid) => {
  await expect(domain.selectDisputeNote({ context: invalid, disputeId: DISPUTE_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(disputes.getDisputeNoteContext).not.toHaveBeenCalled();
});

it('creates the exact Tier 2 card: trimmed note, server-recorded author and time, no secondary confirmation', async () => {
  const proposal = await create({ args: { note: `  ${NOTE}  ` } });
  expect(proposalSchema.parse(proposal)).toEqual(proposal);
  expect(proposal).toMatchObject({ tool: 'add_dispute_note', tier: 2, summary: 'Add a note to the selected open dispute.',
    parameters: { dispute_id: DISPUTE_ID, note: NOTE }, before: selection(),
    after: { dispute_id: DISPUTE_ID, note: { author_id: actor.member.id, note: NOTE, added_at: 'on_execution' } } });
  expect(proposal).not.toHaveProperty('secondary_confirmation');
  expect(disputes.addReviewedDisputeNote).not.toHaveBeenCalled();
});

it.each([{}, { note: '' }, { note: '    ' }, { note: 'x'.repeat(1001) }, { note: 5 }, { note: 'Note\u0000text' },
  { note: 'Note\uD800text' }, { note: NOTE, dispute_id: OTHER_ID }])('rejects invalid arguments %j before any proposal', async (args) => {
  await expect(create({ args })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await redis.keys('*')).toEqual([]);
});

it.each([
  [{ actor_member_id: OTHER_ID }], [{ workspace_id: OTHER_ID }], [{ member_role: 'admin' }],
  [{ dispute: { raised_by: OTHER_ID } }],
])('refuses a selection that is not the authenticated member or raiser %j', async (changes) => {
  await expect(create({ selection: selection(changes) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(await redis.keys('*')).toEqual([]);
});

it('lets an admin who did not raise the dispute add a note', async () => {
  const admin = withMember({ role: 'admin' });
  members.getActiveMembership.mockResolvedValue({ ...member(), role: 'admin' });
  const adminSelection = selection({ member_role: 'admin', dispute: { raised_by: OTHER_ID } });
  disputes.getDisputeNoteContext.mockResolvedValue(adminSelection);
  const proposal = await create({ context: admin, selection: adminSelection });
  expect(proposal.before).toEqual(adminSelection);
});

it('executes after approval through the atomic service with the authenticated author and returns a receipt', async () => {
  const proposal = await create();
  const reply = await approve(proposal);
  expect(disputes.addReviewedDisputeNote).toHaveBeenCalledTimes(1);
  expect(disputes.addReviewedDisputeNote).toHaveBeenCalledWith({ workspaceId: actor.workspace.id,
    disputeId: DISPUTE_ID, note: NOTE, authorMemberId: actor.member.id });
  expect(reply).toMatchObject({ status: 'executed', result: appended() });
  const receipt = await getProposalStatus({ context: actor, proposalId: proposal.id, redisFactory: () => redis });
  expect(proposalStatusSchema.parse(receipt)).toMatchObject({ proposal_id: proposal.id, status: 'executed',
    tool: 'add_dispute_note', dispute_id: DISPUTE_ID, result: appended() });
  expect(audit.log.mock.calls.map(([entry]) => entry.targetId)).toEqual(Array(audit.log.mock.calls.length).fill(DISPUTE_ID));
});

it.each([
  ['not found', new NotFoundError('Dispute not found')], ['no longer open', new BusinessRuleError('Notes can only be added to open disputes')],
  ['no longer permitted', new ForbiddenError('Access denied')],
])('treats a dispute that is %s at approval as stale and writes nothing', async (_label, error) => {
  const proposal = await create();
  disputes.getDisputeNoteContext.mockRejectedValue(error);
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect(disputes.addReviewedDisputeNote).not.toHaveBeenCalled();
});

it('treats a changed selection at approval as stale', async () => {
  const proposal = await create();
  disputes.getDisputeNoteContext.mockResolvedValue(selection({ dispute: { reason: 'Reason changed' } }));
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
  expect(disputes.addReviewedDisputeNote).not.toHaveBeenCalled();
});

it('maps the atomic append rejection to stale and never retries it', async () => {
  const proposal = await create();
  disputes.addReviewedDisputeNote.mockRejectedValue(new ConflictError('The dispute can no longer receive this note'));
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE', statusCode: 409 });
  await expect(approve(proposal)).rejects.toBeDefined();
  expect(disputes.addReviewedDisputeNote).toHaveBeenCalledTimes(1);
});

it.each([
  ['an unexpected service failure', () => { disputes.addReviewedDisputeNote.mockRejectedValue(new Error('PRIVATE')); }],
  ['a different author', () => { disputes.addReviewedDisputeNote.mockResolvedValue(appended({ author_id: OTHER_ID })); }],
  ['different note text', () => { disputes.addReviewedDisputeNote.mockResolvedValue(appended({ note: 'Different text' })); }],
  ['a different dispute', () => { disputes.addReviewedDisputeNote.mockResolvedValue({ ...appended(), dispute_id: OTHER_ID }); }],
  ['a malformed result', () => { disputes.addReviewedDisputeNote.mockResolvedValue({ dispute_id: DISPUTE_ID }); }],
])('keeps %s uncertain and blocks a second mutation', async (_label, script) => {
  const proposal = await create();
  script();
  await expect(approve(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
  await expect(approve(proposal)).rejects.toBeDefined();
  expect(disputes.addReviewedDisputeNote).toHaveBeenCalledTimes(1);
});
