// utils/statusColor.test.ts
//
// A lookup table used across ledger/task/container badges throughout the
// app. Not exhaustively testing every one of the ~16 mapped statuses —
// that would just restate the source file — but pinning down the
// fallback behavior (the one branch with actual logic) and a
// representative sample of each domain (ledger, task, container status).

import { describe, it, expect } from 'vitest';
import { getStatusStyle } from './statusColor';

describe('getStatusStyle', () => {
  it('returns the fallback gray style for an unrecognized status', () => {
    expect(getStatusStyle('some_future_status_not_yet_added')).toBe('bg-gray-100 text-gray-500');
  });

  it('returns the fallback style for an empty string', () => {
    expect(getStatusStyle('')).toBe('bg-gray-100 text-gray-500');
  });

  it('maps a known ledger status (confirmed) to a distinct, non-fallback style', () => {
    const style = getStatusStyle('confirmed');
    expect(style).toBe('bg-green-100 text-green-700');
    expect(style).not.toBe(getStatusStyle('nonexistent_status'));
  });

  it('maps "disputed" and "overdue" to the same red styling', () => {
    expect(getStatusStyle('disputed')).toBe('bg-red-100 text-red-700');
    expect(getStatusStyle('overdue')).toBe('bg-red-100 text-red-700');
  });

  it('distinguishes "admin" and "member" role styles from each other', () => {
    expect(getStatusStyle('admin')).not.toBe(getStatusStyle('member'));
  });

  it('is case-sensitive — an uppercase variant of a known status falls back rather than matching', () => {
    // Documents current behavior: if a caller ever passes a
    // differently-cased status (e.g. from an inconsistent API response),
    // it silently falls back to gray instead of matching.
    expect(getStatusStyle('CONFIRMED')).toBe('bg-gray-100 text-gray-500');
  });
});
