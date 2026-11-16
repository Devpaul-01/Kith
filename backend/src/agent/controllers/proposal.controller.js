const { success } = require('../../utils/response');
const audit = require('../../services/audit.service');
const { decideProposal, confirmProposal, getProposalStatus } = require('../services/proposal.service');
const { emptyApprovalSchema, secondaryConfirmationSchema, proposalIdSchema } = require('../validators/proposal.validator');

const decision = (action) => async (req, res, next) => {
  try {
    const result = await decideProposal({
      context: { userId: req.user.id, member: req.member, workspace: req.workspace, requestId: req.requestId },
      proposalId: proposalIdSchema.parse(req.params.proposalId), data: emptyApprovalSchema.parse(req.body),
      decision: action, actorCtx: audit.fromReq(req),
    });
    res.set('Cache-Control', 'no-store');
    success(res, result);
  } catch (err) { next(err); }
};

async function status(req, res, next) {
  try {
    const result = await getProposalStatus({
      context: { userId: req.user.id, member: req.member, workspace: req.workspace, requestId: req.requestId },
      proposalId: proposalIdSchema.parse(req.params.proposalId),
    });
    res.set('Cache-Control', 'no-store');
    success(res, result);
  } catch (err) { next(err); }
}

async function confirm(req, res, next) {
  try {
    const result = await confirmProposal({
      context: { userId: req.user.id, member: req.member, workspace: req.workspace, requestId: req.requestId },
      proposalId: proposalIdSchema.parse(req.params.proposalId), data: secondaryConfirmationSchema.parse(req.body),
      actorCtx: audit.fromReq(req),
    });
    res.set('Cache-Control', 'no-store');
    success(res, result);
  } catch (err) { next(err); }
}

module.exports = { approve: decision('approve'), reject: decision('reject'), confirm, status };
