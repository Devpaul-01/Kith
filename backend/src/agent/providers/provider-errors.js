const { AppError } = require('../../utils/errors');
const { tokenUsageSchema } = require('../validators/provider-metadata.validator');

const ERRORS = Object.freeze({
  AGENT_PROVIDER_CONFIGURATION: [503, 'The agent provider is not configured correctly.'],
  AGENT_PROVIDER_UNAVAILABLE: [503, 'The agent provider is unavailable. Please try again.'],
  AGENT_PROVIDER_TIMEOUT: [504, 'The agent provider timed out. Please try again.'],
  AGENT_PROVIDER_RATE_LIMITED: [503, 'The agent provider is busy. Please try again later.'],
  AGENT_INVALID_RESPONSE: [502, 'The agent provider returned an invalid response.'],
  AGENT_RESPONSE_TRUNCATED: [502, 'The agent response was incomplete. Please narrow the request.'],
  AGENT_CONTEXT_LIMIT: [422, 'This request contains too much information. Please narrow it down.'],
  AGENT_BUDGET_CONFIGURATION: [503, 'The workspace agent allowance is not configured correctly.'],
  AGENT_BUDGET_UNAVAILABLE: [503, 'The workspace agent allowance could not be checked. Please try again.'],
  AGENT_BUDGET_EXHAUSTED: [429, 'This workspace has reached its agent token allowance. Try again after it resets.'],
  AGENT_BUDGET_REQUEST_TOO_LARGE: [422, 'This request needs more tokens than the workspace allowance permits. Please narrow it down.'],
});

function providerError(code = 'AGENT_PROVIDER_UNAVAILABLE', usage, resetAtMs) {
  const known = Object.hasOwn(ERRORS, code) ? code : 'AGENT_PROVIDER_UNAVAILABLE';
  const [status, message] = ERRORS[known];
  const error = new AppError(message, status, known);
  const parsed = tokenUsageSchema.safeParse(usage);
  if (parsed.success) {
    // Internal metadata, separate from client-facing error details.
    Object.defineProperty(error, 'usage', { value: Object.freeze(parsed.data) });
  }
  if (known === 'AGENT_BUDGET_EXHAUSTED' && Number.isSafeInteger(resetAtMs)
      && resetAtMs > 0 && resetAtMs <= 8640000000000000) {
    Object.defineProperty(error, 'resetAtMs', { value: resetAtMs });
  }
  return error;
}

// Keep known error codes across the loop boundary, but never trust a provider's
// message/details: they may include response bodies, prompts, or credentials.
function normalizeProviderError(error) {
  return providerError(
    error instanceof AppError ? error.code : undefined,
    error instanceof AppError ? error.usage : undefined,
    error instanceof AppError ? error.resetAtMs : undefined,
  );
}

module.exports = { providerError, normalizeProviderError };
