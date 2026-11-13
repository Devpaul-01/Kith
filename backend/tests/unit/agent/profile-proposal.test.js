jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/auth.service', () => ({
  getProfileForUpdate: jest.fn(), updateProfile: jest.fn(),
}));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));

const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const {
  createProposal, decideProposal, getProposalStatus,
} = require('../../../src/agent/services/proposal.service');
const { ConflictError } = require('../../../src/utils/errors');
const auth = require('../../../src/services/auth.service');
const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const { context, member, OTHER_ID } = require('../../helpers/agent-proposal');

const profile = () => ({
  id: context().userId,
  full_name: 'Adaeze',
  bio: null,
  country_of_residence: 'Nigeria',
  timezone: 'UTC',
  preferred_language: 'en',
  push_enabled: false,
  email_digest_enabled: true,
  updated_at: '2026-11-11T12:00:00.000Z',
});

describe('update_my_profile proposals', () => {
  let redis;
  const create = (args, overrides = {}) => createProposal({
    context: context(), tool: 'update_my_profile', args, turnId: randomUUID(),
    actorCtx: { ipAddress: '127.0.0.1', userAgent: 'test-agent' },
    redisFactory: () => redis, ...overrides,
  });
  const decide = (proposal, overrides = {}) => decideProposal({
    context: context(), proposalId: proposal.id, data: {}, decision: 'approve',
    redisFactory: () => redis, ...overrides,
  });

  beforeEach(() => {
    redis = new Redis();
    members.getActiveMembership.mockReset().mockResolvedValue(member());
    auth.getProfileForUpdate.mockReset().mockResolvedValue(profile());
    auth.updateProfile.mockReset().mockResolvedValue({
      ...profile(), timezone: 'Africa/Lagos', push_enabled: true,
      updated_at: '2026-11-11T12:01:00.000Z',
    });
    audit.log.mockReset().mockResolvedValue();
  });

  afterEach(async () => { await redis.flushall(); await redis.quit(); });

  it('creates an account-wide card with exact changed fields and no write', async () => {
    const proposal = await create({
      full_name: 'Adaeze', timezone: 'Africa/Lagos', push_enabled: true,
    });
    expect(proposal).toMatchObject({
      tool: 'update_my_profile', tier: 2,
      summary: 'Update your Kith account profile: timezone and push notifications.',
      parameters: { timezone: 'Africa/Lagos', push_enabled: true },
      before: { timezone: 'UTC', push_enabled: false, updated_at: profile().updated_at },
      after: { timezone: 'Africa/Lagos', push_enabled: true },
    });
    expect(proposal.before).not.toHaveProperty('full_name');
    expect(auth.updateProfile).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agent.action_proposed', targetType: 'user', targetId: context().userId,
      actorUserId: context().userId,
      metadata: expect.objectContaining({ tool: 'update_my_profile', parameters: proposal.parameters }),
    }));
  });

  it('rejects no-op, avatar and unrecognized profile changes before storing a proposal', async () => {
    await expect(create({ full_name: 'Adaeze' })).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    await expect(create({ avatar_url: 'https://example.com/avatar.png' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(create({ role: 'admin' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(auth.updateProfile).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('rejects an unsupported role before reading the profile', async () => {
    const actor = context();
    actor.member.role = 'viewer';
    await expect(create({ timezone: 'Africa/Lagos' }, { context: actor }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(members.getActiveMembership).not.toHaveBeenCalled();
    expect(auth.getProfileForUpdate).not.toHaveBeenCalled();
    expect(auth.updateProfile).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    ['a changed role', { role: 'admin' }],
    ['inactive membership', { is_active: false }],
  ])('rejects %s before reading the profile or creating a card', async (_label, changes) => {
    members.getActiveMembership.mockResolvedValue({ ...member(), ...changes });
    await expect(create({ timezone: 'Africa/Lagos' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(auth.getProfileForUpdate).not.toHaveBeenCalled();
    expect(auth.updateProfile).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(await redis.keys('kith:agent-proposal:*')).toEqual([]);
  });

  it('conditionally applies once and returns a profile-field receipt', async () => {
    const proposal = await create({ timezone: 'Africa/Lagos', push_enabled: true });
    const first = await decide(proposal);
    expect(await decide(proposal)).toEqual(first);
    expect(first).toEqual({
      proposal_id: proposal.id, status: 'executed',
      result: {
        changes: { timezone: 'Africa/Lagos', push_enabled: true },
        updated_at: '2026-11-11T12:01:00.000Z',
      },
    });
    expect(auth.updateProfile).toHaveBeenCalledTimes(1);
    expect(auth.updateProfile).toHaveBeenCalledWith({
      userId: context().userId,
      data: proposal.parameters,
      expectedValues: { timezone: 'UTC', push_enabled: false },
    });
    await expect(getProposalStatus({
      context: context(), proposalId: proposal.id, redisFactory: () => redis,
    })).resolves.toEqual({
      proposal_id: proposal.id, tool: 'update_my_profile',
      profile_fields: ['timezone', 'push_enabled'], status: 'executed',
      expires_at: proposal.expires_at, checked_at: expect.any(String), result: first.result,
    });
    expect(audit.log.mock.calls.map(([entry]) => entry.action)).toEqual([
      'agent.action_proposed', 'agent.action_approved', 'agent.action_executed',
    ]);
  });

  it('rejects stale profile state before writing', async () => {
    const proposal = await create({ timezone: 'Africa/Lagos' });
    auth.getProfileForUpdate.mockResolvedValueOnce({ ...profile(), timezone: 'Europe/London' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(auth.updateProfile).not.toHaveBeenCalled();
  });

  it('allows activity timestamps and unrelated fields to change after the card was created', async () => {
    const proposal = await create({ timezone: 'Africa/Lagos' });
    auth.getProfileForUpdate.mockResolvedValueOnce({
      ...profile(), full_name: 'Adaeze Okafor', updated_at: '2026-11-11T12:00:30.000Z',
    });
    await expect(decide(proposal)).resolves.toMatchObject({
      status: 'executed', result: { changes: { timezone: 'Africa/Lagos' } },
    });
    expect(auth.updateProfile).toHaveBeenCalledWith({
      userId: context().userId, data: { timezone: 'Africa/Lagos' },
      expectedValues: { timezone: 'UTC' },
    });
  });

  it('makes a conditional update conflict final without retrying the write', async () => {
    const proposal = await create({ timezone: 'Africa/Lagos' });
    auth.updateProfile.mockRejectedValueOnce(new ConflictError('Changed'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(auth.updateProfile).toHaveBeenCalledTimes(1);
  });

  it('keeps an unverified update indeterminate and never repeats the write', async () => {
    const proposal = await create({ timezone: 'Africa/Lagos' });
    auth.updateProfile.mockResolvedValueOnce({
      ...profile(), updated_at: '2026-11-11T12:01:00.000Z',
    });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(auth.updateProfile).toHaveBeenCalledTimes(1);
    const receipt = await getProposalStatus({
      context: context(), proposalId: proposal.id, redisFactory: () => redis,
    });
    expect(receipt.status).toBe('indeterminate');
    expect(receipt).not.toHaveProperty('result');
    expect(audit.log.mock.calls.map(([entry]) => entry.action)).not.toContain('agent.action_executed');
  });

  it('rechecks active membership before approval', async () => {
    const proposal = await create({ timezone: 'Africa/Lagos' });
    members.getActiveMembership.mockResolvedValue({ ...member(), user_id: OTHER_ID });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(auth.updateProfile).not.toHaveBeenCalled();
  });
});
