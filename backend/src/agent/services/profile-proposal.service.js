const { z } = require('zod');
const { AppError, ValidationError, BusinessRuleError } = require('../../utils/errors');
const { profileSnapshotFieldsSchema } = require('../../validators/auth.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROFILE_UPDATE_FIELDS,
  profileUpdateParametersSchema,
  profileUpdateResultSchema,
  profileProposalSummary,
  proposalSchema,
} = require('../validators/proposal.validator');

const updateMyProfileDefinition = Object.freeze({
  name: 'update_my_profile', tier: 2, minRole: 'member',
  description: 'Propose updating the authenticated user\'s Kith account profile. Include only fields the user explicitly asked to change. This is account-wide across workspaces. Avatar and file changes are unavailable. The tool creates an approval card only; it never updates the profile until the separate approval endpoint is used.',
  parameterSchema: profileUpdateParametersSchema,
});
const definitions = Object.freeze([updateMyProfileDefinition]);

const profileRowSchema = profileSnapshotFieldsSchema.extend({
  id: z.string().uuid(),
  updated_at: z.string().datetime({ offset: true }),
}).strict();

function getDefinition(name) {
  return definitions.find((definition) => definition.name === name);
}

async function readProfile(context, errorCode = 'AGENT_PROPOSAL_UNAVAILABLE') {
  assertAgentContext(context);
  const auth = require('../../services/auth.service');
  const raw = await auth.getProfileForUpdate({ userId: context.userId });
  const parsed = profileRowSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== context.userId) {
    throw new AppError('Profile information is unavailable. Please try again.', 503, errorCode);
  }
  return parsed.data;
}

function parseProfileProposal(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== updateMyProfileDefinition.name) {
    throw new ValidationError('Invalid profile proposal');
  }
  return parsed;
}

async function createProposalDraft({ context, tool, args, id, expiresAt }) {
  const definition = getDefinition(tool);
  const requested = definition?.parameterSchema.safeParse(args);
  if (!definition || !requested?.success) throw new ValidationError('Invalid profile proposal');

  await assertCurrentActor(context);
  const current = await readProfile(context, 'AGENT_SELECTION_UNAVAILABLE');
  const parameters = {};
  const before = { updated_at: current.updated_at };
  for (const field of PROFILE_UPDATE_FIELDS) {
    if (Object.hasOwn(requested.data, field) && !Object.is(requested.data[field], current[field])) {
      parameters[field] = requested.data[field];
      before[field] = current[field];
    }
  }
  if (Object.keys(parameters).length === 0) {
    throw new BusinessRuleError('Your profile already has those values.');
  }

  return proposalSchema.parse({
    id, tool, tier: 2, summary: profileProposalSummary(parameters),
    parameters, before, after: parameters, expires_at: expiresAt,
  });
}

async function revalidateProposal({ context, proposal }) {
  const parsed = parseProfileProposal(proposal);
  const current = await readProfile(context);
  const fields = PROFILE_UPDATE_FIELDS.filter((field) => Object.hasOwn(parsed.parameters, field));
  if (fields.some((field) => !Object.is(current[field], parsed.before[field]))) {
    throw new AppError('The user profile changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}

async function applyProposal({ context, proposal }) {
  assertAgentContext(context);
  const parsed = parseProfileProposal(proposal);
  const auth = require('../../services/auth.service');
  const raw = await auth.updateProfile({
    userId: context.userId,
    data: parsed.parameters,
    expectedValues: Object.fromEntries(Object.keys(parsed.parameters)
      .map((field) => [field, parsed.before[field]])),
  });
  const updated = profileRowSchema.safeParse(raw);
  const result = profileUpdateResultSchema.safeParse({
    changes: parsed.parameters,
    updated_at: updated.success ? updated.data.updated_at : undefined,
  });
  if (!updated.success || updated.data.id !== context.userId || !result.success
      || PROFILE_UPDATE_FIELDS.some((field) => Object.hasOwn(parsed.parameters, field)
        && !Object.is(updated.data[field], parsed.parameters[field]))) {
    throw new AppError('The profile update result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}

function getAuditTarget(_proposal, context) {
  return { targetType: 'user', targetId: context.userId };
}

function getStatusTarget(proposal) {
  return {
    profile_fields: PROFILE_UPDATE_FIELDS.filter((field) => Object.hasOwn(proposal.parameters, field)),
  };
}

module.exports = {
  definition: updateMyProfileDefinition,
  definitions,
  updateMyProfileDefinition,
  getDefinition,
  createProposalDraft,
  revalidateProposal,
  applyProposal,
  getAuditTarget,
  getStatusTarget,
};
