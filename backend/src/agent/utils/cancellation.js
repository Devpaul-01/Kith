const { providerError } = require('../providers/provider-errors');

function assertNotCancelled(signal) {
  if (signal?.aborted) throw providerError('AGENT_REQUEST_CANCELLED');
}

module.exports = { assertNotCancelled };
