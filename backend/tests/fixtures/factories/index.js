// tests/fixtures/factories/index.js
//
// Barrel export so test files can do:
//   const { buildWorkspace, buildMember, buildContainer } = require('../../fixtures/factories');
// instead of importing each factory file individually.

module.exports = {
  ...require('./workspace.factory'),
  ...require('./user.factory'),
  ...require('./member.factory'),
  ...require('./container.factory'),
  ...require('./participant.factory'),
  ...require('./ledgerEntry.factory'),
  ...require('./task.factory'),
  ...require('./dispute.factory'),
  ...require('./group.factory'),
  ...require('./milestone.factory'),
  ...require('./notification.factory'),
  ...require('./inviteLink.factory'),
};
