const { z } = require('zod');
const { AppError, ValidationError } = require('../../utils/errors');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  contactSnapshotSchema, contactDeletionResultSchema, proposalSchema,
} = require('../validators/proposal.validator');

const deleteContactDefinition = Object.freeze({
  name: 'delete_contact', tier: 2, minRole: 'member',
  description: 'Propose deleting the Kith account contact explicitly selected by the user for this message. Takes no arguments: you cannot choose or change the target. This affects the caller\'s account across workspaces. It only creates an approval card; the separate approval endpoint executes the deletion.',
  parameterSchema: z.object({}).strict(),
});
const definitions = Object.freeze([deleteContactDefinition]);
const contactRowSchema = contactSnapshotSchema.extend({ user_id: z.string().uuid() }).strict();

function getDefinition(name) {
  return definitions.find((definition) => definition.name === name);
}

async function readSelection({ context, contactId }) {
  assertAgentContext(context);
  const id = z.string().uuid().safeParse(contactId);
  if (!id.success) throw new ValidationError('Invalid contact selection');
  const normalizedId = id.data.toLowerCase();
  const auth = require('../../services/auth.service');
  const raw = await auth.getContactForUpdate({ userId: context.userId, contactId: normalizedId });
  const parsed = contactRowSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== normalizedId || parsed.data.user_id !== context.userId) {
    throw new AppError('Contact information is unavailable. Please try again.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  const { user_id, ...snapshot } = parsed.data;
  return snapshot;
}

async function selectContact({ context, contactId }) {
  await assertCurrentActor(context);
  return Object.freeze(await readSelection({ context, contactId }));
}

function parseContactProposal(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== deleteContactDefinition.name) throw new ValidationError('Invalid contact proposal');
  return parsed;
}

async function revalidateOne({ context, snapshot }) {
  const expected = contactSnapshotSchema.parse(snapshot);
  const current = await readSelection({ context, contactId: expected.id });
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The contact changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}

async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  const definition = getDefinition(tool);
  const selected = contactSnapshotSchema.safeParse(selection);
  if (!definition || !definition.parameterSchema.safeParse(args).success || !selected.success) {
    throw new ValidationError('A selected contact and valid proposal arguments are required');
  }
  await assertCurrentActor(context);
  await revalidateOne({ context, snapshot: selected.data });
  return proposalSchema.parse({
    id, tool, tier: 2, summary: 'Delete the selected Kith account contact.',
    parameters: { contact_id: selected.data.id }, before: selected.data,
    after: { deleted: true }, expires_at: expiresAt,
  });
}

async function revalidateProposal({ context, proposal }) {
  const parsed = parseContactProposal(proposal);
  await revalidateOne({ context, snapshot: parsed.before });
}

async function applyProposal({ context, proposal }) {
  assertAgentContext(context);
  const parsed = parseContactProposal(proposal);
  const auth = require('../../services/auth.service');
  const raw = await auth.deleteContact({
    userId: context.userId, contactId: parsed.parameters.contact_id, expectedContact: parsed.before,
  });
  const result = contactDeletionResultSchema.safeParse({ contact_id: raw?.id, deleted: true });
  if (!result.success || result.data.contact_id !== parsed.parameters.contact_id) {
    throw new AppError('The contact deletion result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}

function getAuditTarget(proposal) {
  return { targetType: 'user_contact', targetId: proposal.parameters.contact_id };
}

function getStatusTarget(proposal) {
  return { contact_id: proposal.parameters.contact_id };
}

module.exports = {
  definitions, deleteContactDefinition, getDefinition, selectContact,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget,
};
