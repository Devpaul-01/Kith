// utils/date.test.ts
//
// formatDate/timeAgo are used throughout the ledger and task UIs and
// both handle a null/undefined/malformed input by design (a "—"
// placeholder rather than throwing or rendering "Invalid Date") — that
// fallback path is exactly the kind of thing that's easy to silently
// break in a refactor without a test catching it.

import { describe, it, expect } from 'vitest';
import { formatDate, formatDateShort, formatDateTime, timeAgo, daysUntil } from './date';

describe('formatDate', () => {
  it('formats a valid ISO date string with the default format', () => {
    expect(formatDate('2026-03-15')).toBe('Mar 15, 2026');
  });

  it('formats a valid ISO datetime string (date portion only, default format)', () => {
    expect(formatDate('2026-03-15T10:30:00Z')).toBe('Mar 15, 2026');
  });

  it('returns the em-dash placeholder for undefined', () => {
    expect(formatDate(undefined)).toBe('—');
  });

  it('returns the em-dash placeholder for null', () => {
    expect(formatDate(null)).toBe('—');
  });

  it('returns the em-dash placeholder for an empty string', () => {
    expect(formatDate('')).toBe('—');
  });

  it('returns the em-dash placeholder for a malformed date string rather than "Invalid Date"', () => {
    expect(formatDate('not-a-date')).toBe('—');
  });

  it('honors a custom format string', () => {
    expect(formatDate('2026-03-15', 'yyyy-MM-dd')).toBe('2026-03-15');
  });
});

describe('formatDateShort', () => {
  it('formats without the year', () => {
    expect(formatDateShort('2026-03-15')).toBe('Mar 15');
  });

  it('returns the em-dash placeholder for a null date', () => {
    expect(formatDateShort(null)).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('includes both date and time', () => {
    // parseISO + format interpret the Z-less local time; asserting on
    // the date portion and format shape avoids this test being
    // timezone-dependent on CI while still catching a broken format string.
    const result = formatDateTime('2026-03-15T14:30:00');
    expect(result).toMatch(/^Mar 15, 2026 \d{1,2}:\d{2} (AM|PM)$/);
  });

  it('returns the em-dash placeholder for a null date', () => {
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('timeAgo', () => {
  it('returns the em-dash placeholder for a null date', () => {
    expect(timeAgo(null)).toBe('—');
  });

  it('returns the em-dash placeholder for a malformed date', () => {
    expect(timeAgo('garbage')).toBe('—');
  });

  it('returns a relative-time string with a suffix for a recent valid date', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(timeAgo(fiveMinutesAgo)).toMatch(/ago$/);
  });

  it('uses a future-tense suffix for a date in the future', () => {
    const inFiveMinutes = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    expect(timeAgo(inFiveMinutes)).toMatch(/^in /);
  });
});

describe('daysUntil', () => {
  it('returns 0 for today (same calendar day, time-of-day ignored)', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(daysUntil(today)).toBe(0);
  });

  it('returns a positive count for a future date', () => {
    const future = new Date();
    future.setDate(future.getDate() + 10);
    const futureStr = future.toISOString().split('T')[0];
    expect(daysUntil(futureStr)).toBe(10);
  });

  it('returns a negative count for a past date (overdue)', () => {
    const past = new Date();
    past.setDate(past.getDate() - 3);
    const pastStr = past.toISOString().split('T')[0];
    expect(daysUntil(pastStr)).toBe(-3);
  });
});
