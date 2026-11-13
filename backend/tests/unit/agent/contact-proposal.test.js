jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/auth.service', () => ({
  getContactForUpdate: jest.fn(), deleteContact: jest.fn(),
}));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { createProposal, decideProposal, getProposalStatus } = require('../../../src/agent/services/proposal.service');
const { selectContact } = require('../../../src/agent/services/contact-proposal.service');
const { AppError, ConflictError } = require('../../../src/utils/errors');
const auth = require('../../../src/services/auth.service');
const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');
const { CONTACT_ID, contactSnapshot, contactRow } = require('../../helpers/agent-contact');

describe('selected contact deletion proposals', () => {
  let redis;
  const create = (overrides = {}) => createProposal({
    context: context(), tool: 'delete_contact', selection: contactSnapshot(), args: {},
    turnId: randomUUID(), redisFactory: () => redis, ...overrides,
  });
  const decide = (proposal, overrides = {}) => decideProposal({
    context: context(), proposalId: proposal.id, data: {}, decision: 'approve',
    redisFactory: () => redis, ...overrides,
  });
  const status = (proposal) => getProposalStatus({
    context: context(), proposalId: proposal.id, redisFactory: () => redis,
  });

  beforeEach(() => {
    redis = new Redis();
    members.getActiveMembership.mockReset().mockResolvedValue(member());
    auth.getContactForUpdate.mockReset().mockResolvedValue(contactRow());
    auth.deleteContact.mockReset().mockResolvedValue({ id: CONTACT_ID });
    audit.log.mockReset().mockResolvedValue();
  });
  afterEach(async () => { await redis.flushall(); await redis.quit(); });

  it('reads only the selected owned contact and removes account identity from the snapshot', async () => {
    const selected = await selectContact({ context: context(), contactId: CONTACT_ID.toUpperCase() });
    expect(selected).toEqual(contactSnapshot());
    expect(Object.isFrozen(selected)).toBe(true);
    expect(auth.getContactForUpdate).toHaveBeenCalledWith({ userId: context().userId, contactId: CONTACT_ID });
    expect(selected).not.toHaveProperty('user_id');
    expect(auth.deleteContact).not.toHaveBeenCalled();
  });

  it('refuses a contact returned for another account', async () => {
    auth.getContactForUpdate.mockResolvedValue(contactRow({ user_id: OTHER_ID }));
    await expect(selectContact({ context: context(), contactId: CONTACT_ID }))
      .rejects.toMatchObject({ code: 'AGENT_SELECTION_UNAVAILABLE' });
    expect(auth.deleteContact).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'unsupported-role', 'changed-membership'])('denies %s before a contact read or write', async (kind) => {
    const actor = context();
    if (kind === 'inactive') actor.member.isActive = false;
    if (kind === 'unsupported-role') actor.member.role = 'viewer';
    if (kind === 'changed-membership') members.getActiveMembership.mockResolvedValue({ ...member(), role: 'admin' });
    await expect(create({ context: actor })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(auth.getContactForUpdate).not.toHaveBeenCalled();
    expect(auth.deleteContact).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    { selection: undefined },
    { args: { contact_id: OTHER_ID } },
  ])('requires an explicit snapshot and refuses model targets: %j', async (overrides) => {
    await expect(create(overrides)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(auth.getContactForUpdate).not.toHaveBeenCalled();
    expect(auth.deleteContact).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('creates a server-authored card without deleting or copying contact text into audit metadata', async () => {
    const proposal = await create();
    expect(proposal).toMatchObject({
      tool: 'delete_contact', tier: 2, summary: 'Delete the selected Kith account contact.',
      parameters: { contact_id: CONTACT_ID }, before: contactSnapshot(), after: { deleted: true },
    });
    expect(auth.deleteContact).not.toHaveBeenCalled();
    const event = audit.log.mock.calls[0][0];
    expect(event).toMatchObject({
      action: 'agent.action_proposed', targetType: 'user_contact', targetId: CONTACT_ID,
      actorUserId: context().userId,
      metadata: { tool: 'delete_contact', parameters: { contact_id: CONTACT_ID } },
    });
    expect(JSON.stringify(event.metadata)).not.toContain(contactSnapshot().value);
  });

  it('rejects a selection changed before the card was created', async () => {
    auth.getContactForUpdate.mockResolvedValue(contactRow({ label: 'Renamed' }));
    await expect(create()).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(auth.deleteContact).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'Renamed' }, { value: '+2348098765432' }, { is_primary: true },
    { is_verified: true, verified_at: '2026-11-13T12:01:00.000Z' },
  ])('rejects changed reviewed contact data before deletion: %j', async (changes) => {
    const proposal = await create();
    auth.getContactForUpdate.mockResolvedValue(contactRow(changes));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(auth.deleteContact).not.toHaveBeenCalled();
    expect((await status(proposal)).status).toBe('failed');
  });

  it('deletes once using the exact reviewed snapshot and returns scoped receipts on retries', async () => {
    const proposal = await create();
    const first = await decide(proposal);
    expect(await decide(proposal)).toEqual(first);
    expect(first).toEqual({ proposal_id: proposal.id, status: 'executed', result: { contact_id: CONTACT_ID, deleted: true } });
    expect(auth.deleteContact).toHaveBeenCalledTimes(1);
    expect(auth.deleteContact).toHaveBeenCalledWith({
      userId: context().userId, contactId: CONTACT_ID, expectedContact: contactSnapshot(),
    });
    expect(await status(proposal)).toMatchObject({
      tool: 'delete_contact', contact_id: CONTACT_ID, status: 'executed', result: first.result,
    });
    expect(audit.log.mock.calls.map(([event]) => event.action)).toEqual([
      'agent.action_proposed', 'agent.action_approved', 'agent.action_executed',
    ]);
  });

  it('rechecks current membership before approving a saved card', async () => {
    const proposal = await create();
    members.getActiveMembership.mockResolvedValue({ ...member(), is_active: false });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(auth.deleteContact).not.toHaveBeenCalled();
  });

  it('keeps conditional conflicts final and never repeats the delete', async () => {
    const proposal = await create();
    auth.deleteContact.mockRejectedValueOnce(new ConflictError('Changed'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(auth.deleteContact).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown delete outcome indeterminate rather than retrying', async () => {
    const proposal = await create();
    auth.deleteContact.mockRejectedValueOnce(new AppError('Unavailable', 503, 'CONTACT_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(auth.deleteContact).toHaveBeenCalledTimes(1);
    const receipt = await status(proposal);
    expect(receipt.status).toBe('indeterminate');
    expect(receipt).not.toHaveProperty('result');
  });

  it.each([undefined, { id: OTHER_ID }])('does not confirm an unverified deletion result: %j', async (result) => {
    const proposal = await create();
    auth.deleteContact.mockResolvedValueOnce(result);
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect((await status(proposal)).status).toBe('indeterminate');
    expect(auth.deleteContact).toHaveBeenCalledTimes(1);
  });
});
