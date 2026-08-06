// tests/unit/utils/crypto.test.js
const { generateToken, generatePublicToken, generateRequestId } = require('../../../src/utils/crypto');

describe('utils/crypto', () => {
  describe('generateToken', () => {
    it('returns a hex string of double the requested byte length by default', () => {
      const token = generateToken();
      expect(token).toMatch(/^[0-9a-f]+$/);
      expect(token).toHaveLength(64); // 32 bytes -> 64 hex chars
    });

    it('honors a custom length argument', () => {
      const token = generateToken(8);
      expect(token).toHaveLength(16); // 8 bytes -> 16 hex chars
    });

    it('returns an empty string for length 0 without throwing', () => {
      expect(() => generateToken(0)).not.toThrow();
      expect(generateToken(0)).toBe('');
    });

    it('produces no duplicates across 1000 calls (statistical sanity check)', () => {
      const tokens = new Set();
      for (let i = 0; i < 1000; i++) tokens.add(generateToken());
      expect(tokens.size).toBe(1000);
    });
  });

  describe('generatePublicToken', () => {
    it('returns a base64url string (no +, /, or = characters)', () => {
      const token = generatePublicToken();
      expect(token).not.toMatch(/[+/=]/);
      expect(token.length).toBeGreaterThan(0);
    });

    it('honors a custom length argument (longer input -> longer output)', () => {
      const short = generatePublicToken(4);
      const long = generatePublicToken(32);
      expect(long.length).toBeGreaterThan(short.length);
    });
  });

  describe('generateRequestId', () => {
    it('matches the expected req_<16 hex chars> format', () => {
      const id = generateRequestId();
      expect(id).toMatch(/^req_[0-9a-f]{16}$/);
    });

    it('produces a different id on each call', () => {
      const a = generateRequestId();
      const b = generateRequestId();
      expect(a).not.toBe(b);
    });
  });
});
