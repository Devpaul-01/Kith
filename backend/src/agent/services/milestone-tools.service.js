const { ValidationError } = require('../../utils/errors');
const { assertAgentContext } = require('./context.service');
const { getTimelineArgsSchema, getMilestoneArgsSchema } = require('../validators/milestone-tools.validator');

const fieldsFrom = (row, fields) => Object.fromEntries(fields.map((field) => [field, row[field]]));
const cursorFields = (cursor) => cursor ? fieldsFrom(cursor, ['date', 'id']) : null;

async function getTimeline({ context, args }) {
  assertAgentContext(context);
  const parsed = getTimelineArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid timeline arguments', null, parsed.error.issues);
  const parameters = { workspaceId: context.workspace.id, limit: parsed.data.limit, cursor: parsed.data.cursor || null, metadataOnly: true };
  const milestoneService = require('../../services/milestone.service');
  const { items, next_cursor, has_more } = await milestoneService.getTimeline(parameters);
  return {
    items: items.map((row) => fieldsFrom(row, ['type', 'date', 'title', 'description', 'reference_id', 'reference_type'])),
    next_cursor: next_cursor ? { before_container: cursorFields(next_cursor.before_container), before_milestone: cursorFields(next_cursor.before_milestone) } : null,
    has_more,
  };
}

async function getMilestone({ context, args }) {
  assertAgentContext(context);
  const parsed = getMilestoneArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid milestone arguments', null, parsed.error.issues);
  const parameters = { workspaceId: context.workspace.id, milestoneId: parsed.data.milestone_id, metadataOnly: true };
  const milestoneService = require('../../services/milestone.service');
  const milestone = await milestoneService.getMilestone(parameters);
  return { milestone: fieldsFrom(milestone, ['id', 'title', 'description', 'milestone_date', 'milestone_type', 'created_at', 'updated_at']) };
}

module.exports = { getTimeline, getMilestone };
