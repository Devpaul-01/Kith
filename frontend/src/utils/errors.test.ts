// utils/errors.test.ts
//
// parseApiError is the single chokepoint every API error in the app
// passes through before being shown to a user (toasts, form field
// errors, etc.) — previously untested despite having several distinct
// branches (axios error with a structured backend body, axios error
// with no response at all i.e. network failure, a plain JS Error, and a
// totally unknown thrown value).

import { describe, it, expect } from 'vitest';
import { parseApiError, getErrorMessage } from './errors';

function makeAxiosError(status: number, data: unknown) {
  return {
    isAxiosError: true,
    response: { status, data },
    message: 'Request failed',
  };
}

describe('parseApiError', () => {
  it('extracts code/message/field from the backend\'s { error: {...} } envelope', () => {
    const err = makeAxiosError(400, {
      error: { code: 'VALIDATION_FAILED', message: 'Email is invalid', field: 'email' },
    });

    const result = parseApiError(err);

    expect(result).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Email is invalid',
      field: 'email',
      data: undefined,
    });
  });

  it('carries error.details through as the data field', () => {
    const err = makeAxiosError(400, {
      error: { code: 'VALIDATION_FAILED', message: 'Bad input', details: [{ field: 'email', message: 'Invalid' }] },
    });

    const result = parseApiError(err);

    expect(result.data).toEqual([{ field: 'email', message: 'Invalid' }]);
  });

  it('falls back to a top-level message when error.message is absent', () => {
    const err = makeAxiosError(500, { message: 'Something broke' });

    const result = parseApiError(err);

    expect(result.message).toBe('Something broke');
    expect(result.code).toBe('UNKNOWN');
  });

  it('falls back to a generic message when the response body has neither error.message nor a top-level message', () => {
    const err = makeAxiosError(500, {});

    const result = parseApiError(err);

    expect(result.message).toBe('An error occurred');
    expect(result.code).toBe('UNKNOWN');
  });

  it('a network error (axios error with NO response at all) maps to a distinct NETWORK_ERROR code', () => {
    const err = { isAxiosError: true, message: 'Network Error' }; // no .response

    const result = parseApiError(err);

    expect(result).toEqual({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Network error — please check your connection.',
    });
  });

  it('a plain JS Error (not from axios) is mapped to a CLIENT_ERROR using its own message', () => {
    const result = parseApiError(new Error('Something unexpected in render'));

    expect(result).toEqual({
      status: 500,
      code: 'CLIENT_ERROR',
      message: 'Something unexpected in render',
    });
  });

  it('a totally unknown thrown value (string, undefined, etc.) falls back to a generic UNKNOWN error', () => {
    expect(parseApiError('just a string')).toEqual({
      status: 500,
      code: 'UNKNOWN',
      message: 'An unexpected error occurred.',
    });
    expect(parseApiError(undefined)).toEqual({
      status: 500,
      code: 'UNKNOWN',
      message: 'An unexpected error occurred.',
    });
  });
});

describe('getErrorMessage', () => {
  it('returns just the message string from parseApiError\'s result', () => {
    const err = makeAxiosError(404, { error: { code: 'NOT_FOUND', message: 'Container not found' } });
    expect(getErrorMessage(err)).toBe('Container not found');
  });

  it('works for a plain Error too', () => {
    expect(getErrorMessage(new Error('oops'))).toBe('oops');
  });
});
