const { ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { listCyclesArgsSchema, MAX_CYCLE_PAGE } = require('../validators/cycle-tools.validator');

async function listCycles({ context, args }) {
  // Match the existing cycles route, including when called without the registry.
  assertAgentContext(context, 'admin');
  const parsed = listCyclesArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid cycle arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = {
    workspaceId: context.workspace.id,
    containerId: parsed.data.container_id,
    statusFilter: parsed.data.status,
    page, perPage, offset,
  };
  const containerService = require('../../services/container.service');
  const { cycles, count } = await containerService.listCycles(parameters);
  const pagination = getPaginationMeta({ total: count, page, perPage });

  return {
    // Stored total_expected/total_collected are not maintained by the current
    // lifecycle jobs. Expose scheduling fields, without inferring money totals.
    cycles: cycles.map((cycle) => ({
      id: cycle.id,
      container_id: cycle.container_id,
      cycle_number: cycle.cycle_number,
      cycle_start: cycle.cycle_start,
      cycle_end: cycle.cycle_end,
      status: cycle.status,
      created_at: cycle.created_at,
      closed_at: cycle.closed_at,
    })),
    pagination: {
      ...pagination,
      next_page: page < pagination.total_pages && page < MAX_CYCLE_PAGE ? page + 1 : null,
    },
  };
}

module.exports = { listCycles };
