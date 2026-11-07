const { AppError } = require('../../utils/errors');

const ERRORS = Object.freeze({
  AGENT_PROVIDER_CONFIGURATION: [503, 'The agent provider is not configured correctly.'],
  AGENT_PROVIDER_UNAVAILABLE: [503, 'The agent provider is unavailable. Please try again.'],
  AGENT_PROVIDER_TIMEOUT: [504, 'The agent provider timed out. Please try again.'],
  AGENT_PROVIDER_RATE_LIMITED: [503, 'The agent provider is busy. Please try again later.'],
  AGENT_INVALID_RESPONSE: [502, 'The agent provider returned an invalid response.'],
  AGENT_RESPONSE_TRUNCATED: [502, 'The agent response was incomplete. Please narrow the request.'],
  AGENT_CONTEXT_LIMIT: [422, 'This request contains too much information. Please narrow it down.'],
});

function providerError(code = 'AGENT_PROVIDER_UNAVAILABLE') {
  const known = Object.hasOwn(ERRORS, code) ? code : 'AGENT_PROVIDER_UNAVAILABLE';
  const [status, message] = ERRORS[known];
  return new AppError(message, status, known);
}

// Keep known error codes across the loop boundary, but never trust a provider's
// message/details: they may include response bodies, prompts, or credentials.
function normalizeProviderError(error) {
  return providerError(error instanceof AppError ? error.code : undefined);
}

module.exports = { providerError, normalizeProviderError };
