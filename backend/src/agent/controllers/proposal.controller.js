const { success } = require('../../utils/response');
const audit = require('../../services/audit.service');
const { decideProposal } = require('../services/proposal.service');
const { emptyApprovalSchema, proposalIdSchema } = require('../validators/proposal.validator');

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

module.exports = { approve: decision('approve'), reject: decision('reject') };
