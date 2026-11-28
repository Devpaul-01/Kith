const { assertAgentContext } = require('./context.service');
const { getViewedContainerContext } = require('./read-tools.service');
const { ValidationError } = require('../../utils/errors');
const { chatInputSchema } = require('../validators/read-turn.validator');
const { runReadTurn, runReadTurnWithHistory } = require('./read-loop.service');
const { runConversationTurn } = require('./conversation.service');
const { createGroqProvider } = require('../providers/groq.provider');
const { createWorkspaceBudget } = require('./budget.service');
const {
  selectNotification, markNotificationReadDefinition, markAllNotificationsReadDefinition,
} = require('./notification-proposal.service');
const { updateMyProfileDefinition } = require('./profile-proposal.service');
const { selectContact, deleteContactDefinition } = require('./contact-proposal.service');
const { selectTask, updateTaskDefinition } = require('./task-proposal.service');
const { selectTaskConfirmation, adminConfirmTaskDefinition } = require('./task-confirmation-proposal.service');
const { selectTaskCreation, createTaskDefinition } = require('./task-creation-proposal.service');
const { selectLedgerContainer, createLedgerEntryDefinition } = require('./ledger-proposal.service');
const { selectLedgerEntry, confirmLedgerEntryDefinition } = require('./ledger-confirmation-proposal.service');
const { selectDisputeContribution, raiseDisputeDefinition } = require('./dispute-raise-proposal.service');
const { selectDisputeResolution, resolveDisputeDefinition } = require('./dispute-resolve-proposal.service');
const { selectDisputeNote, addDisputeNoteDefinition } = require('./dispute-note-proposal.service');
const { createContainerDefinition } = require('./container-creation-proposal.service');
const { createMemberDefinition } = require('./member-creation-proposal.service');
const { selectParticipantAddition, addParticipantsDefinition } = require('./participant-addition-proposal.service');
const { createProposal, getProposalReceipts } = require('./proposal.service');
const { resolveTarget } = require('./target-resolution.service');
const { extractProposalReferences } = require('./proposal-history.service');

/** Compose the read loop with server-owned provider configuration per turn. */
async function runChatTurn({ data, context, onEvent, signal, actorCtx } = {}) {
  assertAgentContext(context);
  const input = chatInputSchema.safeParse(data);
  if (!input.success) throw new ValidationError('Invalid agent message', null, input.error.issues);
  // Freeze identity before awaiting Redis, not only when the model loop starts.
  const actorContext = Object.freeze({
    userId: context.userId, requestId: context.requestId,
    member: Object.freeze({ ...context.member }), workspace: Object.freeze({ ...context.workspace }),
  });
  // Initialize lazily: an unconfigured provider must not prevent API startup.
  const budget = createWorkspaceBudget({
    context: actorContext,
    limit: process.env.AGENT_WORKSPACE_TOKEN_LIMIT ?? 100000,
    period: process.env.AGENT_BUDGET_PERIOD ?? 'day',
    timeoutMs: process.env.AGENT_BUDGET_TIMEOUT_MS ?? 3000,
  });
  const provider = createGroqProvider({ budget });
  const turnData = { message: input.data.message };
  const viewedContainer = input.data.viewed_container_id === undefined ? undefined
    : await getViewedContainerContext({ context: actorContext, containerId: input.data.viewed_container_id });
  // Viewport context is informational only and is not an action selection.
  // Selection is explicit client input, validated through domain services. It
  // is scoped to this request and never restored from conversation history.
  const selection = input.data.selected_notification_id === undefined ? undefined
    : await selectNotification({ context: actorContext, notificationId: input.data.selected_notification_id });
  const contactSelection = input.data.selected_contact_id === undefined ? undefined
    : await selectContact({ context: actorContext, contactId: input.data.selected_contact_id });
  const taskSelection = input.data.selected_task === undefined ? undefined
    : await selectTask({ context: actorContext,
      containerId: input.data.selected_task.container_id, taskId: input.data.selected_task.task_id });
  const taskConfirmationSelection = input.data.selected_task_confirmation === undefined ? undefined
    : await selectTaskConfirmation({ context: actorContext,
      containerId: input.data.selected_task_confirmation.container_id, taskId: input.data.selected_task_confirmation.task_id });
  const taskCreationSelection = input.data.selected_task_creation === undefined ? undefined
    : await selectTaskCreation({ context: actorContext,
      containerId: input.data.selected_task_creation.container_id, assigneeId: input.data.selected_task_creation.assignee_id });
  const participantAdditionSelection = input.data.selected_participant_addition === undefined ? undefined
    : await selectParticipantAddition({ context: actorContext,
      containerId: input.data.selected_participant_addition.container_id, memberId: input.data.selected_participant_addition.member_id });
  const ledgerSelection = input.data.selected_container_id === undefined ? undefined
    : await selectLedgerContainer({ context: actorContext, containerId: input.data.selected_container_id });
  const ledgerEntrySelection = input.data.selected_ledger_entry === undefined ? undefined
    : await selectLedgerEntry({ context: actorContext,
      containerId: input.data.selected_ledger_entry.container_id, entryId: input.data.selected_ledger_entry.entry_id });
  const disputeSelection = input.data.selected_dispute_entry === undefined ? undefined
    : await selectDisputeContribution({ context: actorContext,
      containerId: input.data.selected_dispute_entry.container_id, entryId: input.data.selected_dispute_entry.entry_id });
  const disputeResolutionSelection = input.data.selected_dispute_resolution === undefined ? undefined
    : await selectDisputeResolution({ context: actorContext, disputeId: input.data.selected_dispute_resolution.dispute_id });
  const disputeNoteSelection = input.data.selected_dispute_note === undefined ? undefined
    : await selectDisputeNote({ context: actorContext, disputeId: input.data.selected_dispute_note.dispute_id });
  let proposalConversationId = null;
  const proposalSupport = {
    definitions: Object.freeze([
      ...(selection ? [markNotificationReadDefinition] : []),
      markAllNotificationsReadDefinition,
      updateMyProfileDefinition,
      ...(contactSelection ? [deleteContactDefinition] : []),
      ...(taskSelection ? [updateTaskDefinition] : []),
      ...(taskConfirmationSelection ? [adminConfirmTaskDefinition] : []),
      ...(taskCreationSelection ? [createTaskDefinition] : []),
      ...(participantAdditionSelection ? [addParticipantsDefinition] : []),
      ...(ledgerSelection ? [createLedgerEntryDefinition] : []),
      ...(ledgerEntrySelection ? [confirmLedgerEntryDefinition] : []),
      ...(disputeSelection ? [raiseDisputeDefinition] : []),
      ...(disputeResolutionSelection ? [resolveDisputeDefinition] : []),
      ...(disputeNoteSelection ? [addDisputeNoteDefinition] : []),
      createContainerDefinition,
      createMemberDefinition,
    ].filter((definition) => definition.minRole === 'member'
      || (definition.minRole === 'admin' && actorContext.member.role === 'admin'))),
    ...(selection ? { selection } : {}),
    ...(contactSelection ? { contactSelection } : {}),
    ...(taskSelection ? { taskSelection } : {}),
    ...(taskConfirmationSelection ? { taskConfirmationSelection } : {}),
    ...(taskCreationSelection ? { taskCreationSelection } : {}),
    ...(participantAdditionSelection ? { participantAdditionSelection } : {}),
    ...(ledgerSelection ? { ledgerSelection } : {}),
    ...(ledgerEntrySelection ? { ledgerEntrySelection } : {}),
    ...(disputeSelection ? { disputeSelection } : {}),
    ...(disputeResolutionSelection ? { disputeResolutionSelection } : {}),
    ...(disputeNoteSelection ? { disputeNoteSelection } : {}),
    resolveTarget: ({ purpose, query, member_query: memberQuery }) => resolveTarget({ context: actorContext, purpose, query, memberQuery }),
    create: ({ name, args, turnId, selection: resolved }) => createProposal({
      context: actorContext, tool: name,
      selection: resolved !== undefined ? resolved
        : [createContainerDefinition.name, createMemberDefinition.name].includes(name) ? undefined
        : name === confirmLedgerEntryDefinition.name ? ledgerEntrySelection
        : name === raiseDisputeDefinition.name ? disputeSelection
        : name === resolveDisputeDefinition.name ? disputeResolutionSelection
        : name === addDisputeNoteDefinition.name ? disputeNoteSelection
        : name === createLedgerEntryDefinition.name ? ledgerSelection
        : name === updateTaskDefinition.name ? taskSelection
        : name === adminConfirmTaskDefinition.name ? taskConfirmationSelection
        : name === createTaskDefinition.name ? taskCreationSelection
        : name === addParticipantsDefinition.name ? participantAdditionSelection
        : name === deleteContactDefinition.name ? contactSelection : selection,
      args, turnId, actorCtx, signal,
      ...([raiseDisputeDefinition.name, resolveDisputeDefinition.name].includes(name)
        ? { conversationId: proposalConversationId } : {}),
    }),
  };
  const loadActionReceipts = ({ history }) => getProposalReceipts({
    context: actorContext, proposals: extractProposalReferences(history), signal,
  });
  if (input.data.conversation_id === undefined) {
    return runReadTurn({ data: turnData, context: actorContext, provider, onEvent, signal, proposalSupport, loadActionReceipts, viewedContainer });
  }
  return runConversationTurn({
    context: actorContext, conversationId: input.data.conversation_id,
    signal,
    runTurn: ({ history, conversationId }) => {
      proposalConversationId = conversationId;
      return runReadTurnWithHistory({ data: turnData, context: actorContext, provider, history, onEvent, signal, proposalSupport, loadActionReceipts, viewedContainer });
    },
  });
}

module.exports = { runChatTurn };
