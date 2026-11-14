const { assertAgentContext } = require('./context.service');
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
const { selectLedgerContainer, createLedgerEntryDefinition } = require('./ledger-proposal.service');
const { selectLedgerEntry, confirmLedgerEntryDefinition } = require('./ledger-confirmation-proposal.service');
const { createProposal, getProposalReceipts } = require('./proposal.service');
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
  // Selection is explicit client input, validated through domain services. It
  // is scoped to this request and never restored from conversation history.
  const selection = input.data.selected_notification_id === undefined ? undefined
    : await selectNotification({ context: actorContext, notificationId: input.data.selected_notification_id });
  const contactSelection = input.data.selected_contact_id === undefined ? undefined
    : await selectContact({ context: actorContext, contactId: input.data.selected_contact_id });
  const taskSelection = input.data.selected_task === undefined ? undefined
    : await selectTask({ context: actorContext,
      containerId: input.data.selected_task.container_id, taskId: input.data.selected_task.task_id });
  const ledgerSelection = input.data.selected_container_id === undefined ? undefined
    : await selectLedgerContainer({ context: actorContext, containerId: input.data.selected_container_id });
  const ledgerEntrySelection = input.data.selected_ledger_entry === undefined ? undefined
    : await selectLedgerEntry({ context: actorContext,
      containerId: input.data.selected_ledger_entry.container_id, entryId: input.data.selected_ledger_entry.entry_id });
  const proposalSupport = {
    definitions: Object.freeze([
      ...(selection ? [markNotificationReadDefinition] : []),
      markAllNotificationsReadDefinition,
      updateMyProfileDefinition,
      ...(contactSelection ? [deleteContactDefinition] : []),
      ...(taskSelection ? [updateTaskDefinition] : []),
      ...(ledgerSelection ? [createLedgerEntryDefinition] : []),
      ...(ledgerEntrySelection ? [confirmLedgerEntryDefinition] : []),
    ].filter((definition) => definition.minRole === 'member'
      || (definition.minRole === 'admin' && actorContext.member.role === 'admin'))),
    ...(selection ? { selection } : {}),
    ...(contactSelection ? { contactSelection } : {}),
    ...(taskSelection ? { taskSelection } : {}),
    ...(ledgerSelection ? { ledgerSelection } : {}),
    ...(ledgerEntrySelection ? { ledgerEntrySelection } : {}),
    create: ({ name, args, turnId }) => createProposal({
      context: actorContext, tool: name,
      selection: name === confirmLedgerEntryDefinition.name ? ledgerEntrySelection
        : name === createLedgerEntryDefinition.name ? ledgerSelection
        : name === updateTaskDefinition.name ? taskSelection
        : name === deleteContactDefinition.name ? contactSelection : selection,
      args, turnId, actorCtx, signal,
    }),
  };
  const loadActionReceipts = ({ history }) => getProposalReceipts({
    context: actorContext, proposals: extractProposalReferences(history), signal,
  });
  if (input.data.conversation_id === undefined) {
    return runReadTurn({ data: turnData, context: actorContext, provider, onEvent, signal, proposalSupport, loadActionReceipts });
  }
  return runConversationTurn({
    context: actorContext, conversationId: input.data.conversation_id,
    signal,
    runTurn: ({ history }) => runReadTurnWithHistory({ data: turnData, context: actorContext, provider, history, onEvent, signal, proposalSupport, loadActionReceipts }),
  });
}

module.exports = { runChatTurn };
