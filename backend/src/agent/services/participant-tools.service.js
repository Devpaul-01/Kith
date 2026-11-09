const { ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { listParticipantsArgsSchema, targetReadArgsSchema, MAX_PARTICIPANT_PAGE } = require('../validators/participant-tools.validator');

const PARTICIPANT_FIELDS = Object.freeze([
  'id', 'container_id', 'workspace_member_id', 'display_name', 'is_proxy', 'member_role', 'is_active',
  'role', 'money_enabled', 'tasks_enabled', 'added_at',
]);
const TARGET_FIELDS = Object.freeze([
  'id', 'cycle_id', 'target_amount', 'target_currency', 'due_date', 'is_current', 'superseded_by',
  'superseded_at', 'set_by', 'set_by_name', 'set_at',
]);
const fieldsFrom = (row, fields) => Object.fromEntries(fields.map((field) => [field, row[field]]));
function pageMeta(count, page, perPage) {
  const pagination = getPaginationMeta({ total: count, page, perPage });
  return { ...pagination, next_page: page < pagination.total_pages && page < MAX_PARTICIPANT_PAGE ? page + 1 : null };
}

async function listParticipants({ context, args }) {
  // participant.service trusts its caller. Every handler enforces the HTTP admin gate.
  assertAgentContext(context, 'admin');
  const parsed = listParticipantsArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid participant arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = { workspaceId: context.workspace.id, containerId: parsed.data.container_id, pagination: { page, perPage, offset } };
  const participantService = require('../../services/participant.service');
  const { participants, count } = await participantService.listParticipants(parameters);
  return { participants: participants.map((row) => fieldsFrom(row, [...PARTICIPANT_FIELDS, 'target_id', 'target_amount', 'target_currency', 'due_date'])),
    pagination: pageMeta(count, page, perPage) };
}

async function getTargetHistory({ context, args }) {
  assertAgentContext(context, 'admin');
  const parsed = targetReadArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid target arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = { workspaceId: context.workspace.id, containerId: parsed.data.container_id,
    participantId: parsed.data.participant_id, pagination: { page, perPage, offset } };
  const participantService = require('../../services/participant.service');
  const { history, count } = await participantService.getTargetHistory(parameters);
  return { history: history.map((row) => fieldsFrom(row, TARGET_FIELDS)), pagination: pageMeta(count, page, perPage) };
}

async function getCycleTargets({ context, args }) {
  assertAgentContext(context, 'admin');
  const parsed = targetReadArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid target arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = { workspaceId: context.workspace.id, containerId: parsed.data.container_id,
    participantId: parsed.data.participant_id, pagination: { page, perPage, offset } };
  const participantService = require('../../services/participant.service');
  const { participant, cycle_targets, count } = await participantService.getCycleTargets(parameters);
  return {
    participant: fieldsFrom(participant, PARTICIPANT_FIELDS),
    cycle_targets: cycle_targets.map((row) => ({
      cycle: fieldsFrom(row.cycle, ['id', 'cycle_number', 'cycle_start', 'cycle_end', 'status']),
      target: row.target ? fieldsFrom(row.target, ['id', 'amount', 'currency', 'due_date', 'set_at']) : null,
    })),
    pagination: pageMeta(count, page, perPage),
  };
}

module.exports = { listParticipants, getTargetHistory, getCycleTargets };
