// utils/currency.test.ts
//
// Previously untested (and, with the frontend having no test runner at
// all, untested by anything). Money formatting is the kind of pure
// function where a one-character mistake (wrong symbol, wrong decimal
// handling) is cheap to introduce and easy to miss in review, so it's a
// good first thing to lock down.

import { describe, it, expect } from 'vitest';
import { formatCurrency } from './currency';

describe('formatCurrency', () => {
  it('prefixes the currency symbol for a known currency', () => {
    expect(formatCurrency(100, 'USD')).toBe('$100');
  });

  it('falls back to the raw currency code when the symbol is unknown', () => {
    expect(formatCurrency(50, 'XYZ')).toBe('XYZ50');
  });

  it('formats a whole number with no decimal places', () => {
    expect(formatCurrency(1000, 'USD')).toBe('$1,000');
  });

  it('formats a fractional amount with up to 2 decimal places', () => {
    expect(formatCurrency(99.5, 'USD')).toBe('$99.5');
  });

  it('rounds to a maximum of 2 decimal places rather than truncating or erroring', () => {
    // Intl.NumberFormat rounds (half-away-from-zero by default), it does
    // not reject extra precision — this pins that expectation down.
    expect(formatCurrency(99.999, 'USD')).toBe('$100');
  });

  it('handles zero without a stray sign or NaN', () => {
    expect(formatCurrency(0, 'USD')).toBe('$0');
  });

  it('handles a negative amount, keeping the symbol ahead of the sign', () => {
    // Documents current behavior: the symbol is a plain string prefix,
    // so a negative amount renders as "$-50" rather than "-$50". If the
    // UI ever displays negative balances (e.g. an overpayment or a debt
    // carried forward), this is worth a second look.
    expect(formatCurrency(-50, 'USD')).toBe('$-50');
  });

  it('uses a currency-specific symbol, not just USD\'s', () => {
    expect(formatCurrency(500, 'NGN')).toBe('₦500');
    expect(formatCurrency(20, 'EUR')).toBe('€20');
    expect(formatCurrency(20, 'GBP')).toBe('£20');
  });

  it('formats large amounts with thousands separators', () => {
    expect(formatCurrency(1234567, 'USD')).toBe('$1,234,567');
  });
});
