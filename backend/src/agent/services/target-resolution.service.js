const { ValidationError } = require('../../utils/errors');
const { assertAgentContext } = require('./context.service');
const { selectionRequestSchema, TARGET_PURPOSES, COMPOUND_PURPOSES } = require('../validators/target-resolution.validator');

const CANDIDATE_LIMIT = 10;
const PICKER_MAX = 5;
const STRONG = Object.freeze(['exact', 'substring']);

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const join = (...parts) => clip(parts.filter(Boolean).join(' · '), 300) || null;

function describeTask(task, names) {
  return { title: clip(task.title, 200) || 'Untitled task',
    subtitle: join(names.get(task.container_id), task.status, task.due_date && `due ${task.due_date}`) };
}
function describeEntry(entry, names) {
  return { title: clip(`${entry.contributor_name || 'Member'}: ${entry.original_amount} ${entry.original_currency}`, 200),
    subtitle: join(names.get(entry.container_id), entry.status, entry.note) };
}
function describeDispute(dispute) {
  return { title: clip(dispute.reason, 200) || 'Dispute', subtitle: join(dispute.status, dispute.raised_by_name && `raised by ${dispute.raised_by_name}`) };
}
function describeContainer(container) {
  return { title: clip(container.name, 200) || 'Untitled', subtitle: join(container.container_type, container.status) };
}
function describeAssignment({ container, member }) {
  return { title: clip(container.name, 200) || 'Untitled', subtitle: join(member ? `Assign to ${member.display_name}` : 'Unassigned') };
}
function describeParticipant({ container, member }) {
  return { title: clip(`Add ${member.display_name}`, 200), subtitle: join(`to ${container.name}`) };
}
function describeContact(contact) {
  return { title: clip(contact.label || contact.value, 200), subtitle: join(contact.type, contact.label && contact.value) };
}

// Contacts are the member's own and have no ranked search: match on label or value.
async function searchContacts({ context, query }) {
  const auth = require('../../services/auth.service');
  const contacts = await auth.getUserContacts({ userId: context.userId });
  const needle = query?.toLowerCase();
  const candidates = contacts.flatMap((contact) => {
    if (!needle) return [{ ...contact, match_type: null }];
    const fields = [contact.label, contact.value].filter(Boolean).map((value) => value.toLowerCase());
    if (fields.includes(needle)) return [{ ...contact, match_type: 'exact' }];
    return fields.some((value) => value.includes(needle)) ? [{ ...contact, match_type: 'substring' }] : [];
  }).sort((a, b) => Number(b.match_type === 'exact') - Number(a.match_type === 'exact'));
  return { candidates: candidates.slice(0, CANDIDATE_LIMIT), has_more: candidates.length > CANDIDATE_LIMIT, listing: !needle };
}

function table() {
  const search = require('../../services/search.service');
  const { selectTask } = require('./task-proposal.service');
  const { selectTaskConfirmation } = require('./task-confirmation-proposal.service');
  const { selectContact } = require('./contact-proposal.service');
  const { selectLedgerContainer } = require('./ledger-proposal.service');
  const { selectTaskCreation } = require('./task-creation-proposal.service');
  const { selectParticipantAddition } = require('./participant-addition-proposal.service');
  const { selectLedgerEntry } = require('./ledger-confirmation-proposal.service');
  const { selectDisputeContribution } = require('./dispute-raise-proposal.service');
  const { selectDisputeResolution } = require('./dispute-resolve-proposal.service');
  const { selectDisputeNote } = require('./dispute-note-proposal.service');
  const { selectContainerArchive } = require('./container-archive-proposal.service');
  const { definitions } = require('./proposal-registry.service');
  const tool = (name) => definitions.find((definition) => definition.name === name);
  const caller = (context) => ({ workspaceId: context.workspace.id, callerId: context.member.id,
    isAdmin: context.member.role === 'admin', limit: CANDIDATE_LIMIT });
  const tasks = async ({ context, query }) => (query
    ? search.findTasks({ ...caller(context), query })
    : { candidates: await search.listOpenTasksForMember({ memberId: context.member.id, limit: CANDIDATE_LIMIT }), has_more: false, listing: true });
  const entries = ({ context, query }) => search.findLedgerEntries({ ...caller(context), query });
  const taskPayload = (task) => ({ container_id: task.container_id, task_id: task.id });
  const entryPayload = (entry) => ({ container_id: entry.container_id, entry_id: entry.id });
  const disputePayload = (dispute) => ({ dispute_id: dispute.id });

  const containerSearch = ({ context, query }) => search.findContainers({ ...caller(context), query });
  const memberSearch = ({ context, query }) => search.findMembers({ workspaceId: context.workspace.id, query, limit: CANDIDATE_LIMIT });

  // autoBind is true only for Tier 2/3 tools. Tier 4 always needs an explicit tap.
  return {
    create_task: { tool: tool('create_task'), field: 'selected_task_creation', key: 'taskCreationSelection', autoBind: true,
      primary: containerSearch, secondary: memberSearch, secondaryRequired: false,
      select: (context, container, member) => selectTaskCreation({ context, containerId: container.id, assigneeId: member?.id ?? null }),
      payload: (container, member) => ({ container_id: container.id, assignee_id: member?.id ?? null }), describe: describeAssignment },
    add_participants: { tool: tool('add_participants'), field: 'selected_participant_addition', key: 'participantAdditionSelection', autoBind: true,
      primary: containerSearch, secondary: memberSearch, secondaryRequired: true,
      select: (context, container, member) => selectParticipantAddition({ context, containerId: container.id, memberId: member.id }),
      payload: (container, member) => ({ container_id: container.id, member_id: member.id }), describe: describeParticipant },
    update_task: { tool: tool('update_task'), field: 'selected_task', key: 'taskSelection', autoBind: true, list: true,
      search: tasks, select: (context, c) => selectTask({ context, containerId: c.container_id, taskId: c.id }),
      payload: taskPayload, describe: describeTask },
    admin_confirm_task: { tool: tool('admin_confirm_task'), field: 'selected_task_confirmation', key: 'taskConfirmationSelection', autoBind: true,
      search: tasks, select: (context, c) => selectTaskConfirmation({ context, containerId: c.container_id, taskId: c.id }),
      payload: taskPayload, describe: describeTask },
    delete_contact: { tool: tool('delete_contact'), field: 'selected_contact_id', key: 'contactSelection', autoBind: true, list: true,
      strong: ['exact'], search: searchContacts, select: (context, c) => selectContact({ context, contactId: c.id }),
      payload: (c) => c.id, describe: describeContact },
    add_dispute_note: { tool: tool('add_dispute_note'), field: 'selected_dispute_note', key: 'disputeNoteSelection', autoBind: true,
      search: ({ context, query }) => search.findDisputes({ ...caller(context), query }),
      select: (context, c) => selectDisputeNote({ context, disputeId: c.id }), payload: disputePayload, describe: describeDispute },
    resolve_dispute: { tool: tool('resolve_dispute'), field: 'selected_dispute_resolution', key: 'disputeResolutionSelection', autoBind: false,
      search: ({ context, query }) => search.findDisputes({ ...caller(context), query }),
      select: (context, c) => selectDisputeResolution({ context, disputeId: c.id }), payload: disputePayload, describe: describeDispute },
    raise_dispute: { tool: tool('raise_dispute'), field: 'selected_dispute_entry', key: 'disputeSelection', autoBind: false,
      search: entries, select: (context, c) => selectDisputeContribution({ context, containerId: c.container_id, entryId: c.id }),
      payload: entryPayload, describe: describeEntry },
    confirm_ledger_entry: { tool: tool('confirm_ledger_entry'), field: 'selected_ledger_entry', key: 'ledgerEntrySelection', autoBind: true,
      search: entries, select: (context, c) => selectLedgerEntry({ context, containerId: c.container_id, entryId: c.id }),
      payload: entryPayload, describe: describeEntry },
    // Archiving is hard to undo, so only an exact name binds automatically.
    archive_container: { tool: tool('archive_container'), field: 'selected_container_archive', key: 'containerArchiveSelection', autoBind: true,
      strong: ['exact'], search: containerSearch, select: (context, c) => selectContainerArchive({ context, containerId: c.id }),
      payload: (c) => ({ container_id: c.id }), describe: describeContainer },
    create_ledger_entry: { tool: tool('create_ledger_entry'), field: 'selected_container_id', key: 'ledgerSelection', autoBind: true,
      search: ({ context, query }) => search.findContainers({ ...caller(context), query }),
      select: (context, c) => selectLedgerContainer({ context, containerId: c.id }), payload: (c) => c.id, describe: describeContainer },
  };
}

// Best effort: names make same-titled records distinguishable in a picker.
async function containerNames(context, ids) {
  const containers = require('../../services/container.service');
  const names = new Map();
  await Promise.all([...new Set(ids.filter(Boolean))].map(async (id) => {
    try {
      const { container } = await containers.getContainer({ workspaceId: context.workspace.id, containerId: id,
        callerMemberId: context.member.id, metadataOnly: true });
      names.set(id, container?.name ?? null);
    } catch { names.set(id, null); }
  }));
  return names;
}


const COMPOUND_PARTS = 3;

/**
 * Container plus member. Every container-and-member pair is validated by the same
 * composed selector a client selection uses, so the pair as a whole is eligible.
 */
async function resolveCompound({ context, purpose, config, query, memberQuery }) {
  if (!query || (config.secondaryRequired && !memberQuery)) return { kind: 'needs_details' };
  const [containers, members] = await Promise.all([
    config.primary({ context, query }),
    memberQuery ? config.secondary({ context, query: memberQuery }) : { candidates: [null], has_more: false },
  ]);
  const primaries = containers.candidates.slice(0, COMPOUND_PARTS);
  const secondaries = members.candidates.slice(0, COMPOUND_PARTS);
  const pairs = primaries.flatMap((container, containerIndex) => secondaries.map((member, memberIndex) => ({
    container, member, containerIndex, memberIndex })));
  const outcomes = await Promise.allSettled(pairs.map(({ container, member }) => config.select(context, container, member)));
  const eligible = [];
  let ineligible = 0;
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === 'fulfilled') eligible.push({ ...pairs[index], selection: outcome.value });
    else if (isIneligible(outcome.reason)) ineligible += 1;
    else throw outcome.reason;
  }
  if (eligible.length === 0) {
    return { kind: 'not_found', ineligible_matches: ineligible,
      ...(containers.candidates.length === 0 ? { missing: 'container' } : secondaries.length === 0 ? { missing: 'member' } : {}) };
  }
  const [top] = eligible;
  const strong = (candidate) => candidate === null || STRONG.includes(candidate.match_type);
  const truncated = containers.candidates.length > COMPOUND_PARTS || members.candidates.length > COMPOUND_PARTS;
  if (config.autoBind && eligible.length === 1 && top.containerIndex === 0 && top.memberIndex === 0
      && !containers.has_more && !members.has_more && !truncated && strong(top.container) && strong(top.member)) {
    return { kind: 'bound', purpose, tool: config.tool.name, selectionKey: config.key, selection: top.selection,
      label: config.describe(top) };
  }
  const shown = eligible.slice(0, PICKER_MAX);
  const request = selectionRequestSchema.parse({
    purpose, selected_field: config.field, query, status: shown.length === 1 ? 'single_match' : 'ambiguous',
    candidates: shown.map((pair) => ({ selection: config.payload(pair.container, pair.member), ...config.describe(pair) })),
    has_more: Boolean(containers.has_more || members.has_more) || truncated || eligible.length > PICKER_MAX,
  });
  return { kind: 'choose', request };
}

const isIneligible = (err) => Number.isInteger(err?.statusCode) && err.statusCode < 500;

/**
 * Turn the user's description into a server-validated target. The model never
 * supplies an ID; every candidate passes the same selector a client selection
 * would. Results:
 *  - bound:         one clear, eligible, top-ranked match on a Tier 2/3 tool
 *  - choose:        a picker the client renders (the user's tap is the selection)
 *  - needs_details: nothing to search or list yet
 *  - not_found:     nothing the user may act on matched
 *  - unavailable:   the user's role cannot use the tool
 */
async function resolveTarget({ context, purpose, query, memberQuery }) {
  assertAgentContext(context);
  const config = TARGET_PURPOSES.includes(purpose) ? table()[purpose] : undefined;
  if (!config?.tool) throw new ValidationError('Unsupported target purpose');
  if (config.tool.minRole === 'admin' && context.member.role !== 'admin') return { kind: 'unavailable', reason: 'admin_required' };
  if (COMPOUND_PURPOSES.includes(purpose)) return resolveCompound({ context, purpose, config, query, memberQuery });
  if (memberQuery) throw new ValidationError('member_query only applies to compound purposes');
  if (!query && !config.list) return { kind: 'needs_details' };

  const found = await config.search({ context, query });
  const outcomes = await Promise.allSettled(found.candidates.map((candidate) => config.select(context, candidate)));
  const eligible = [];
  let ineligible = 0;
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === 'fulfilled') eligible.push({ index, candidate: found.candidates[index], selection: outcome.value });
    else if (isIneligible(outcome.reason)) ineligible += 1;
    else throw outcome.reason;
  }
  if (eligible.length === 0) return { kind: 'not_found', ineligible_matches: ineligible };

  const [top] = eligible;
  const strong = config.strong || STRONG;
  if (config.autoBind && query && eligible.length === 1 && top.index === 0 && !found.has_more
      && strong.includes(top.candidate.match_type)) {
    return { kind: 'bound', purpose, tool: config.tool.name, selectionKey: config.key, selection: top.selection,
      label: config.describe(top.candidate, await containerNames(context, [top.candidate.container_id])) };
  }
  const shown = eligible.slice(0, PICKER_MAX);
  const names = await containerNames(context, shown.map(({ candidate }) => candidate.container_id));
  const request = selectionRequestSchema.parse({
    purpose, selected_field: config.field, query: query ?? null,
    status: found.listing ? 'listing' : shown.length === 1 ? 'single_match' : 'ambiguous',
    candidates: shown.map(({ candidate }) => ({ selection: config.payload(candidate), ...config.describe(candidate, names) })),
    has_more: Boolean(found.has_more) || eligible.length > PICKER_MAX,
  });
  return { kind: 'choose', request };
}

module.exports = { resolveTarget, CANDIDATE_LIMIT, PICKER_MAX };
