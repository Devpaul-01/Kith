const { AppError } = require('../../utils/errors');
const notification = require('./notification-proposal.service');
const profile = require('./profile-proposal.service');
const contact = require('./contact-proposal.service');
const task = require('./task-proposal.service');
const taskConfirmation = require('./task-confirmation-proposal.service');
const taskCreation = require('./task-creation-proposal.service');
const disputeRaise = require('./dispute-raise-proposal.service');
const disputeResolve = require('./dispute-resolve-proposal.service');
const ledger = require('./ledger-proposal.service');
const ledgerConfirmation = require('./ledger-confirmation-proposal.service');
const containerCreation = require('./container-creation-proposal.service');
const memberCreation = require('./member-creation-proposal.service');
const participantAddition = require('./participant-addition-proposal.service');

const domains = Object.freeze([notification, profile, contact, task, taskConfirmation, taskCreation, disputeRaise, disputeResolve, ledger, ledgerConfirmation, containerCreation, memberCreation, participantAddition]);
const definitions = Object.freeze(domains.flatMap((domain) => domain.definitions));
const entries = new Map();
for (const domain of domains) {
  for (const definition of domain.definitions) {
    if (entries.has(definition.name)) {
      throw new AppError(`Duplicate proposal tool: ${definition.name}`, 500, 'AGENT_CONFIGURATION_ERROR');
    }
    entries.set(definition.name, Object.freeze({ definition, domain }));
  }
}

function getDefinition(name) {
  return entries.get(name)?.definition;
}

function getDomain(name) {
  return entries.get(name)?.domain;
}

module.exports = { definitions, getDefinition, getDomain };
