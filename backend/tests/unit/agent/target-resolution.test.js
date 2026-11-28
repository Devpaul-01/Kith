jest.mock('../../../src/services/search.service');
jest.mock('../../../src/services/auth.service');
jest.mock('../../../src/services/container.service');

const search = require('../../../src/services/search.service');
const auth = require('../../../src/services/auth.service');
const containers = require('../../../src/services/container.service');
const taskProposal = require('../../../src/agent/services/task-proposal.service');
const noteProposal = require('../../../src/agent/services/dispute-note-proposal.service');
const raiseProposal = require('../../../src/agent/services/dispute-raise-proposal.service');
const resolveProposal = require('../../../src/agent/services/dispute-resolve-proposal.service');
const contactProposal = require('../../../src/agent/services/contact-proposal.service');
const confirmProposal = require('../../../src/agent/services/task-confirmation-proposal.service');
const creationProposal = require('../../../src/agent/services/task-creation-proposal.service');
const participantProposal = require('../../../src/agent/services/participant-addition-proposal.service');
const ledgerProposal = require('../../../src/agent/services/ledger-proposal.service');
const ledgerConfirmProposal = require('../../../src/agent/services/ledger-confirmation-proposal.service');
const { resolveTarget } = require('../../../src/agent/services/target-resolution.service');
const { selectTargetArgsSchema, selectionRequestSchema } = require('../../../src/agent/validators/target-resolution.validator');
const { ForbiddenError, BusinessRuleError, AppError } = require('../../../src/utils/errors');
const { context } = require('../../helpers/agent-proposal');

const actor = context();
const admin = { ...actor, member: { ...actor.member, role: 'admin' } };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CONTAINER = id(100);
const task = (n, changes = {}) => ({ id: id(n), container_id: CONTAINER, title: `Task ${n}`, assigned_to: actor.member.id,
  status: 'pending', due_date: '2026-12-03', match_type: 'exact', score: 1, ...changes });
const found = (candidates, changes = {}) => ({ query: 'tent', status: 'ok', candidates, has_more: false, ...changes });
const ineligible = () => new BusinessRuleError('Task is not eligible');

beforeEach(() => {
  jest.resetAllMocks();
  containers.getContainer.mockResolvedValue({ container: { name: 'Wedding' } });
  jest.spyOn(taskProposal, 'selectTask').mockImplementation(async ({ taskId }) => ({ id: taskId, picked: true }));
});
afterEach(() => jest.restoreAllMocks());

describe('select_target arguments', () => {
  it('carry only a purpose and the user\'s words, never an identifier', () => {
    expect(selectTargetArgsSchema.parse({ purpose: 'update_task', query: '  tent  ' })).toEqual({ purpose: 'update_task', query: 'tent' });
    expect(selectTargetArgsSchema.parse({ purpose: 'update_task' })).toEqual({ purpose: 'update_task' });
    expect(selectTargetArgsSchema.safeParse({ purpose: 'create_task', query: 'wedding', member_query: 'ada' }).success).toBe(true);
    expect(selectTargetArgsSchema.safeParse({ purpose: 'update_task', query: 'tent', member_query: 'ada' }).success).toBe(false);
    for (const bad of [{ purpose: 'update_task', task_id: id(1) }, { purpose: 'update_task', query: 'a' }, { purpose: 'drop_table' },
      { purpose: 'update_task', query: 'x'.repeat(201) }, { purpose: 'update_task', query: 'a\u0000b' }, { query: 'tent' }]) {
      expect(selectTargetArgsSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('automatic binding (Tier 2/3)', () => {
  it('binds a single eligible, top-ranked, strong match through the same selector a client selection uses', async () => {
    search.findTasks.mockResolvedValue(found([task(1)]));
    const result = await resolveTarget({ context: actor, purpose: 'update_task', query: 'tent' });
    expect(result).toMatchObject({ kind: 'bound', tool: 'update_task', selectionKey: 'taskSelection', selection: { id: id(1) },
      label: { title: 'Task 1', subtitle: 'Wedding · pending · due 2026-12-03' } });
    expect(taskProposal.selectTask).toHaveBeenCalledWith({ context: actor, containerId: CONTAINER, taskId: id(1) });
    expect(search.findTasks).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: actor.workspace.id,
      callerId: actor.member.id, isAdmin: false, query: 'tent' }));
  });

  it('binds when other matches exist but are not eligible', async () => {
    search.findTasks.mockResolvedValue(found([task(1), task(2, { match_type: 'fuzzy' })]));
    taskProposal.selectTask.mockImplementation(async ({ taskId }) => { if (taskId === id(2)) throw ineligible(); return { id: taskId }; });
    await expect(resolveTarget({ context: actor, purpose: 'update_task', query: 'tent' })).resolves.toMatchObject({ kind: 'bound' });
  });

  it.each([
    ['a weak fuzzy match', found([task(1, { match_type: 'fuzzy' })])],
    ['more matches than were returned', found([task(1)], { has_more: true })],
    ['an eligible record ranked below an ineligible one', found([task(2), task(1)])],
  ])('shows a picker, not a binding, for %s', async (_label, result) => {
    search.findTasks.mockResolvedValue(result);
    taskProposal.selectTask.mockImplementation(async ({ taskId }) => { if (taskId === id(2)) throw ineligible(); return { id: taskId }; });
    const outcome = await resolveTarget({ context: actor, purpose: 'update_task', query: 'tent' });
    expect(outcome.kind).toBe('choose');
  });

  it('never binds for Tier 4 tools even on a single exact match', async () => {
    search.findLedgerEntries.mockResolvedValue(found([{ id: id(7), container_id: CONTAINER, contributor_name: 'Ada', original_amount: '5000.00',
      original_currency: 'NGN', status: 'confirmed', note: null, match_type: 'exact' }]));
    jest.spyOn(raiseProposal, 'selectDisputeContribution').mockResolvedValue({ picked: true });
    const outcome = await resolveTarget({ context: actor, purpose: 'raise_dispute', query: '5000' });
    expect(outcome).toMatchObject({ kind: 'choose', request: { selected_field: 'selected_dispute_entry', status: 'single_match',
      candidates: [{ selection: { container_id: CONTAINER, entry_id: id(7) }, title: 'Ada: 5000.00 NGN' }] } });
  });

  it('only auto-binds a contact on an exact label or value, since deletion is destructive', async () => {
    const contacts = [{ id: id(20), type: 'email', value: 'ada@example.com', label: 'Ada', country_code: null, is_primary: false }];
    auth.getUserContacts.mockResolvedValue(contacts);
    jest.spyOn(contactProposal, 'selectContact').mockImplementation(async ({ contactId }) => ({ id: contactId }));
    await expect(resolveTarget({ context: actor, purpose: 'delete_contact', query: 'ada' })).resolves.toMatchObject({ kind: 'bound', selectionKey: 'contactSelection' });
    const partial = await resolveTarget({ context: actor, purpose: 'delete_contact', query: 'ad' });
    expect(partial).toMatchObject({ kind: 'choose', request: { selected_field: 'selected_contact_id', candidates: [{ selection: id(20) }] } });
  });
});

describe('picker', () => {
  it('lists eligible matches with container names and the exact selected_* payload', async () => {
    search.findTasks.mockResolvedValue(found([task(1), task(2)]));
    const { kind, request } = await resolveTarget({ context: actor, purpose: 'update_task', query: 'tent' });
    expect(kind).toBe('choose');
    expect(selectionRequestSchema.parse(request)).toEqual(request);
    expect(request).toMatchObject({ purpose: 'update_task', selected_field: 'selected_task', status: 'ambiguous', query: 'tent', has_more: false });
    expect(request.candidates).toEqual([
      { selection: { container_id: CONTAINER, task_id: id(1) }, title: 'Task 1', subtitle: 'Wedding · pending · due 2026-12-03' },
      { selection: { container_id: CONTAINER, task_id: id(2) }, title: 'Task 2', subtitle: 'Wedding · pending · due 2026-12-03' },
    ]);
  });

  it('caps the list at five and says more exist', async () => {
    search.findTasks.mockResolvedValue(found([1, 2, 3, 4, 5, 6, 7].map((n) => task(n))));
    const { request } = await resolveTarget({ context: actor, purpose: 'update_task', query: 'task' });
    expect(request.candidates).toHaveLength(5);
    expect(request.has_more).toBe(true);
  });

  it('survives a failed container-name lookup', async () => {
    containers.getContainer.mockRejectedValue(new Error('down'));
    search.findTasks.mockResolvedValue(found([task(1), task(2)]));
    const { request } = await resolveTarget({ context: actor, purpose: 'update_task', query: 'tent' });
    expect(request.candidates[0].subtitle).toBe('pending · due 2026-12-03');
  });

  it('lists the member\'s own open tasks when no details were given, and never binds', async () => {
    search.listOpenTasksForMember.mockResolvedValue([task(1, { match_type: null }), task(2, { match_type: null })]);
    const { kind, request } = await resolveTarget({ context: actor, purpose: 'update_task' });
    expect(kind).toBe('choose');
    expect(request).toMatchObject({ status: 'listing', query: null });
    expect(search.listOpenTasksForMember).toHaveBeenCalledWith({ memberId: actor.member.id, limit: 10 });
    expect(search.findTasks).not.toHaveBeenCalled();
    search.listOpenTasksForMember.mockResolvedValue([task(1, { match_type: null })]);
    expect((await resolveTarget({ context: actor, purpose: 'update_task' })).kind).toBe('choose');
  });

  it('lists a member\'s contacts when no details were given', async () => {
    auth.getUserContacts.mockResolvedValue([{ id: id(20), type: 'phone', value: '+2348000000000', label: null, country_code: null, is_primary: true }]);
    jest.spyOn(contactProposal, 'selectContact').mockResolvedValue({ picked: true });
    const { request } = await resolveTarget({ context: actor, purpose: 'delete_contact' });
    expect(request).toMatchObject({ status: 'listing', candidates: [{ selection: id(20), title: '+2348000000000' }] });
  });
});

describe('other outcomes', () => {
  it('reports not_found with a count when matches exist but none are actionable', async () => {
    search.findTasks.mockResolvedValue(found([task(1), task(2)]));
    taskProposal.selectTask.mockRejectedValue(ineligible());
    await expect(resolveTarget({ context: actor, purpose: 'update_task', query: 'tent' }))
      .resolves.toEqual({ kind: 'not_found', ineligible_matches: 2 });
    search.findTasks.mockResolvedValue(found([]));
    await expect(resolveTarget({ context: actor, purpose: 'update_task', query: 'zzz' }))
      .resolves.toEqual({ kind: 'not_found', ineligible_matches: 0 });
  });

  it('fails closed when a selector is unavailable instead of hiding the record', async () => {
    search.findTasks.mockResolvedValue(found([task(1), task(2)]));
    taskProposal.selectTask.mockImplementation(async ({ taskId }) => {
      if (taskId === id(1)) throw new AppError('Unavailable', 503, 'AGENT_SELECTION_UNAVAILABLE');
      return { id: taskId };
    });
    await expect(resolveTarget({ context: actor, purpose: 'update_task', query: 'tent' })).rejects.toMatchObject({ statusCode: 503 });
  });

  it.each(['add_dispute_note', 'resolve_dispute', 'raise_dispute', 'confirm_ledger_entry', 'create_ledger_entry', 'admin_confirm_task'])(
    'asks for details instead of listing for %s', async (purpose) => {
      const need = await resolveTarget({ context: admin, purpose });
      expect(need).toEqual({ kind: 'needs_details' });
    });

  it('tells a non-admin an admin-only tool is unavailable without searching', async () => {
    jest.spyOn(resolveProposal, 'selectDisputeResolution');
    jest.spyOn(confirmProposal, 'selectTaskConfirmation');
    await expect(resolveTarget({ context: actor, purpose: 'resolve_dispute', query: 'amount' })).resolves.toEqual({ kind: 'unavailable', reason: 'admin_required' });
    await expect(resolveTarget({ context: actor, purpose: 'admin_confirm_task', query: 'tent' })).resolves.toEqual({ kind: 'unavailable', reason: 'admin_required' });
    expect(search.findDisputes).not.toHaveBeenCalled();
    expect(search.findTasks).not.toHaveBeenCalled();
  });

  it('routes dispute notes through the note selector and a dispute-id payload', async () => {
    search.findDisputes.mockResolvedValue(found([{ id: id(30), ledger_entry_id: id(31), raised_by: actor.member.id, raised_by_name: 'Ada',
      reason: 'Wrong amount recorded', status: 'open', match_type: 'substring' }]));
    jest.spyOn(noteProposal, 'selectDisputeNote').mockImplementation(async ({ disputeId }) => ({ dispute: { dispute_id: disputeId } }));
    await expect(resolveTarget({ context: actor, purpose: 'add_dispute_note', query: 'amount' })).resolves.toMatchObject({
      kind: 'bound', selectionKey: 'disputeNoteSelection', label: { title: 'Wrong amount recorded', subtitle: 'open · raised by Ada' } });
  });

  it('rejects an unknown purpose and an invalid context', async () => {
    await expect(resolveTarget({ context: actor, purpose: 'drop_table', query: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(resolveTarget({ context: null, purpose: 'update_task', query: 'tent' })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('admin and ledger tools', () => {
  const entry = (n, changes = {}) => ({ id: id(n), container_id: CONTAINER, contributor_name: 'Ada', original_amount: '5000.00',
    original_currency: 'NGN', status: 'pending', note: null, match_type: 'exact', ...changes });

  it('binds an admin task confirmation through the confirmation selector', async () => {
    search.findTasks.mockResolvedValue(found([task(1, { status: 'completed' })]));
    jest.spyOn(confirmProposal, 'selectTaskConfirmation').mockImplementation(async ({ taskId }) => ({ task_id: taskId }));
    await expect(resolveTarget({ context: admin, purpose: 'admin_confirm_task', query: 'tent' })).resolves.toMatchObject({
      kind: 'bound', tool: 'admin_confirm_task', selectionKey: 'taskConfirmationSelection' });
    expect(confirmProposal.selectTaskConfirmation).toHaveBeenCalledWith({ context: admin, containerId: CONTAINER, taskId: id(1) });
    expect(search.findTasks).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true }));
  });

  it('binds an admin ledger confirmation with the entry payload', async () => {
    search.findLedgerEntries.mockResolvedValue(found([entry(7)]));
    jest.spyOn(ledgerConfirmProposal, 'selectLedgerEntry').mockImplementation(async ({ entryId }) => ({ entry_id: entryId }));
    await expect(resolveTarget({ context: admin, purpose: 'confirm_ledger_entry', query: '5000' })).resolves.toMatchObject({
      kind: 'bound', selectionKey: 'ledgerEntrySelection', label: { title: 'Ada: 5000.00 NGN', subtitle: 'Wedding · pending' } });
    expect(ledgerConfirmProposal.selectLedgerEntry).toHaveBeenCalledWith({ context: admin, containerId: CONTAINER, entryId: id(7) });
    search.findLedgerEntries.mockResolvedValue(found([entry(7), entry(8)]));
    const { request } = await resolveTarget({ context: admin, purpose: 'confirm_ledger_entry', query: '5000' });
    expect(request).toMatchObject({ selected_field: 'selected_ledger_entry', candidates: [
      { selection: { container_id: CONTAINER, entry_id: id(7) } }, { selection: { container_id: CONTAINER, entry_id: id(8) } }] });
  });

  it('binds a ledger container by exact name and offers a picker on a partial name', async () => {
    const container = (n, name, match_type) => ({ id: id(n), name, container_type: 'event', status: 'active', match_type });
    jest.spyOn(ledgerProposal, 'selectLedgerContainer').mockImplementation(async ({ containerId }) => ({ container_id: containerId }));
    search.findContainers.mockResolvedValue(found([container(40, 'Wedding', 'exact')]));
    await expect(resolveTarget({ context: actor, purpose: 'create_ledger_entry', query: 'Wedding' })).resolves.toMatchObject({
      kind: 'bound', selectionKey: 'ledgerSelection', label: { title: 'Wedding', subtitle: 'event · active' } });
    search.findContainers.mockResolvedValue(found([container(40, 'Wedding', 'substring'), container(41, 'Wedding rehearsal', 'substring')]));
    const { request } = await resolveTarget({ context: actor, purpose: 'create_ledger_entry', query: 'Wedding' });
    expect(request).toMatchObject({ selected_field: 'selected_container_id', candidates: [{ selection: id(40) }, { selection: id(41) }] });
  });
});

describe('compound targets (container and member)', () => {
  const container = (n, name = 'Wedding', match_type = 'exact') => ({ id: id(n), name, container_type: 'event', status: 'active', match_type });
  const member = (n, display_name = 'Ada', match_type = 'exact') => ({ id: id(n), display_name, role: 'member', is_proxy: false, match_type });
  const wire = () => {
    jest.spyOn(creationProposal, 'selectTaskCreation').mockImplementation(async ({ containerId, assigneeId }) => ({ containerId, assigneeId }));
    jest.spyOn(participantProposal, 'selectParticipantAddition').mockImplementation(async ({ containerId, memberId }) => ({ containerId, memberId }));
  };

  it('binds a clear container and assignee through the composed selector', async () => {
    wire();
    search.findContainers.mockResolvedValue(found([container(40)]));
    search.findMembers.mockResolvedValue(found([member(50)]));
    await expect(resolveTarget({ context: admin, purpose: 'create_task', query: 'wedding', memberQuery: 'ada' })).resolves.toMatchObject({
      kind: 'bound', tool: 'create_task', selectionKey: 'taskCreationSelection', label: { title: 'Wedding', subtitle: 'Assign to Ada' } });
    expect(creationProposal.selectTaskCreation).toHaveBeenCalledWith({ context: admin, containerId: id(40), assigneeId: id(50) });
    expect(search.findMembers).toHaveBeenCalledWith({ workspaceId: admin.workspace.id, query: 'ada', limit: 10 });
  });

  it('creates an unassigned task when no assignee was described', async () => {
    wire();
    search.findContainers.mockResolvedValue(found([container(40)]));
    await expect(resolveTarget({ context: admin, purpose: 'create_task', query: 'wedding' })).resolves.toMatchObject({
      kind: 'bound', label: { subtitle: 'Unassigned' } });
    expect(creationProposal.selectTaskCreation).toHaveBeenCalledWith({ context: admin, containerId: id(40), assigneeId: null });
    expect(search.findMembers).not.toHaveBeenCalled();
  });

  it('binds a participant addition and requires the member to be described', async () => {
    wire();
    search.findContainers.mockResolvedValue(found([container(40)]));
    search.findMembers.mockResolvedValue(found([member(50, 'Grace')]));
    await expect(resolveTarget({ context: admin, purpose: 'add_participants', query: 'wedding', memberQuery: 'grace' })).resolves.toMatchObject({
      kind: 'bound', selectionKey: 'participantAdditionSelection', label: { title: 'Add Grace', subtitle: 'to Wedding' } });
    await expect(resolveTarget({ context: admin, purpose: 'add_participants', query: 'wedding' })).resolves.toEqual({ kind: 'needs_details' });
    await expect(resolveTarget({ context: admin, purpose: 'add_participants', memberQuery: 'grace' })).resolves.toEqual({ kind: 'needs_details' });
  });

  it('shows pairs to choose from when either part is ambiguous, with null-safe payloads', async () => {
    wire();
    search.findContainers.mockResolvedValue(found([container(40), container(41, 'Wedding rehearsal', 'substring')]));
    const { request } = await resolveTarget({ context: admin, purpose: 'create_task', query: 'wedding' });
    expect(request).toMatchObject({ selected_field: 'selected_task_creation', status: 'ambiguous', candidates: [
      { selection: { container_id: id(40), assignee_id: null }, title: 'Wedding', subtitle: 'Unassigned' },
      { selection: { container_id: id(41), assignee_id: null }, title: 'Wedding rehearsal', subtitle: 'Unassigned' }] });
    search.findContainers.mockResolvedValue(found([container(40)]));
    search.findMembers.mockResolvedValue(found([member(50), member(51, 'Ada Obi', 'substring')]));
    const pairs = await resolveTarget({ context: admin, purpose: 'add_participants', query: 'wedding', memberQuery: 'ada' });
    expect(pairs.request.candidates.map((c) => c.selection)).toEqual([
      { container_id: id(40), member_id: id(50) }, { container_id: id(40), member_id: id(51) }]);
  });

  it('never binds on a weak or truncated part', async () => {
    wire();
    search.findContainers.mockResolvedValue(found([container(40, 'Wedding', 'fuzzy')]));
    expect((await resolveTarget({ context: admin, purpose: 'create_task', query: 'wedng' })).kind).toBe('choose');
    search.findContainers.mockResolvedValue(found([container(40)]));
    search.findMembers.mockResolvedValue(found([member(50)], { has_more: true }));
    expect((await resolveTarget({ context: admin, purpose: 'create_task', query: 'wedding', memberQuery: 'ada' })).kind).toBe('choose');
  });

  it('keeps ineligible pairs out and reports what was missing', async () => {
    wire();
    search.findContainers.mockResolvedValue(found([container(40)]));
    search.findMembers.mockResolvedValue(found([member(50), member(51, 'Bob')]));
    participantProposal.selectParticipantAddition.mockImplementation(async ({ memberId }) => {
      if (memberId === id(50)) throw new BusinessRuleError('Already a participant');
      return { memberId };
    });
    const bound = await resolveTarget({ context: admin, purpose: 'add_participants', query: 'wedding', memberQuery: 'a' });
    expect(bound.kind).toBe('choose');
    expect(bound.request.candidates).toHaveLength(1);
    search.findMembers.mockResolvedValue(found([]));
    await expect(resolveTarget({ context: admin, purpose: 'add_participants', query: 'wedding', memberQuery: 'zz' }))
      .resolves.toEqual({ kind: 'not_found', ineligible_matches: 0, missing: 'member' });
    search.findContainers.mockResolvedValue(found([]));
    await expect(resolveTarget({ context: admin, purpose: 'create_task', query: 'zzz' }))
      .resolves.toEqual({ kind: 'not_found', ineligible_matches: 0, missing: 'container' });
  });

  it('fails closed on selector outages and is unavailable to members', async () => {
    wire();
    search.findContainers.mockResolvedValue(found([container(40)]));
    creationProposal.selectTaskCreation.mockRejectedValue(new AppError('Unavailable', 503, 'AGENT_SELECTION_UNAVAILABLE'));
    await expect(resolveTarget({ context: admin, purpose: 'create_task', query: 'wedding' })).rejects.toMatchObject({ statusCode: 503 });
    for (const purpose of ['create_task', 'add_participants']) {
      await expect(resolveTarget({ context: actor, purpose, query: 'wedding', memberQuery: 'ada' })).resolves.toEqual({ kind: 'unavailable', reason: 'admin_required' });
    }
  });

  it('rejects a member description on a single-target purpose', async () => {
    await expect(resolveTarget({ context: actor, purpose: 'update_task', query: 'tent', memberQuery: 'ada' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
