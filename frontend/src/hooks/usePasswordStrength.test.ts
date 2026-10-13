// hooks/usePasswordStrength.test.ts
//
// Drives the signup/change-password strength meter. Testing
// getPasswordStrength directly (plain function, no hook machinery
// needed) covers the real logic; one render-based test at the end
// confirms the hook wrapper actually returns it.

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { getPasswordStrength, usePasswordStrength } from './usePasswordStrength';

describe('getPasswordStrength', () => {
  it('empty string is weak', () => {
    expect(getPasswordStrength('')).toBe('weak');
  });

  it('short password with upper+number is still weak (length requirement not met)', () => {
    expect(getPasswordStrength('Ab1')).toBe('weak');
  });

  it('long lowercase-only password is weak (no upper, no number)', () => {
    expect(getPasswordStrength('lowercaseonly')).toBe('weak');
  });

  it('8+ chars with EITHER upper or number (not both) is medium', () => {
    expect(getPasswordStrength('abcdefgh1')).toBe('medium'); // length + number, no upper
    expect(getPasswordStrength('Abcdefgh')).toBe('medium');  // length + upper, no number
  });

  it('8+ chars with BOTH upper and number is strong', () => {
    expect(getPasswordStrength('Abcdefg1')).toBe('strong');
  });

  it('7 characters (one under the length boundary) is weak even with both upper and number present', () => {
    // hasLength gates both the medium and strong branches, so missing
    // it by even one character falls all the way through to weak
    // regardless of character variety — worth pinning down since it's
    // the one boundary condition in this function.
    expect(getPasswordStrength('Abcdef1')).toBe('weak');
  });

  it('exactly 8 characters with both upper and number meets the boundary and is strong', () => {
    expect(getPasswordStrength('Abcdefg1')).toBe('strong');
  });

  it('a long password with neither upper nor number is weak regardless of length', () => {
    expect(getPasswordStrength('thisisaverylongpasswordindeed')).toBe('weak');
  });
});

describe('usePasswordStrength (hook)', () => {
  it('returns the same classification as the plain function for a given input', () => {
    const { result } = renderHook(() => usePasswordStrength('Abcdefg1'));
    expect(result.current).toBe('strong');
  });

  it('re-renders with a new classification when the input changes', () => {
    const { result, rerender } = renderHook(({ pw }) => usePasswordStrength(pw), {
      initialProps: { pw: 'weak' },
    });
    expect(result.current).toBe('weak');

    rerender({ pw: 'Abcdefg1' });
    expect(result.current).toBe('strong');
  });
});
