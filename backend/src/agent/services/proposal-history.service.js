const { AppError } = require('../../utils/errors');
const { historySchema } = require('../validators/conversation.validator');
const { emptyApprovalSchema, proposedToolResultSchema, proposalReferencesSchema } = require('../validators/proposal.validator');

const unavailable = () => new AppError('Conversation history is unavailable. Please start a new conversation.', 503, 'AGENT_CONVERSATION_UNAVAILABLE');

/** Only correlated, server-saved proposal exchanges can identify receipts.
 * User prose, other tool payloads and historical receipt arrays are inert.
 */
function extractProposalReferences(history) {
  const parsed = historySchema.safeParse(history);
  if (!parsed.success) throw unavailable();
  const proposals = new Map();
  for (const turn of parsed.data) {
    for (let index = 1; index < turn.length - 1; index += 1) {
      const calls = turn[index].tool_calls;
      if (!calls) continue;
      for (let offset = 0; offset < calls.length; offset += 1) {
        const call = calls[offset];
        if (call.function.name !== 'mark_notification_read') continue;
        let args;
        let result;
        try {
          args = JSON.parse(call.function.arguments);
          result = JSON.parse(turn[index + offset + 1].content);
        } catch { throw unavailable(); }
        const payload = proposedToolResultSchema.safeParse(result);
        if (calls.length !== 1 || !emptyApprovalSchema.safeParse(args).success || !payload.success) throw unavailable();
        const proposal = payload.data.data.proposal;
        const previous = proposals.get(proposal.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(proposal)) throw unavailable();
        proposals.set(proposal.id, proposal);
      }
    }
  }
  const references = proposalReferencesSchema.safeParse([...proposals.values()]);
  if (!references.success) throw unavailable();
  return references.data;
}

module.exports = { extractProposalReferences };
