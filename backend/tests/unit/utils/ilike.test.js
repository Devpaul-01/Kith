// tests/unit/utils/ilike.test.js
//
// Security-relevant escaping function (ILIKE wildcard injection —
// SUPPORTED_CURRENCIES-adjacent audit finding referenced in the docs).
// Shared by search.service.js and member.service.js, so a regression
// here silently reintroduces the original bug in two call sites at once.

const { escapeIlike, containsPattern } = require('../../../src/utils/ilike');

describe('utils/ilike', () => {
  describe('escapeIlike', () => {
    it('escapes a bare percent sign (ILIKE wildcard)', () => {
      expect(escapeIlike('50%')).toBe('50\\%');
    });

    it('escapes a bare underscore (ILIKE single-char wildcard)', () => {
      expect(escapeIlike('a_b')).toBe('a\\_b');
    });

    it('escapes a literal backslash so later escapes do not double-escape it', () => {
      // Input: a \ b  (one literal backslash)
      // Expected: a \\ b (backslash itself escaped, char-for-char)
      expect(escapeIlike('a\\b')).toBe('a\\\\b');
    });

    it('escapes all three special characters together, each independently, in original order', () => {
      expect(escapeIlike('%_\\')).toBe('\\%\\_\\\\');
    });

    it('returns an empty string for null without throwing', () => {
      expect(() => escapeIlike(null)).not.toThrow();
      expect(escapeIlike(null)).toBe('');
    });

    it('returns an empty string for undefined without throwing', () => {
      expect(() => escapeIlike(undefined)).not.toThrow();
      expect(escapeIlike(undefined)).toBe('');
    });

    it('coerces non-string input to a string without throwing', () => {
      expect(escapeIlike(123)).toBe('123');
    });

    it('leaves ordinary characters untouched', () => {
      expect(escapeIlike('bob smith')).toBe('bob smith');
    });
  });

  describe('containsPattern', () => {
    it('wraps a plain string in %...%', () => {
      expect(containsPattern('bob')).toBe('%bob%');
    });

    it('wraps the ESCAPED result, not the raw input (proves it calls through escapeIlike)', () => {
      expect(containsPattern('50%')).toBe('%50\\%%');
    });

    it('handles null/undefined input the same way escapeIlike does', () => {
      expect(containsPattern(null)).toBe('%%');
      expect(containsPattern(undefined)).toBe('%%');
    });
  });
});
