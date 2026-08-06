// tests/unit/validators/auth.validator.test.js
const {
  signupSchema,
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  updateProfileSchema,
  contactSchema,
  pushTokenSchema,
  notificationPrefsSchema,
  refreshTokenSchema,
  SUPPORTED_CURRENCIES,
} = require('../../../src/validators/auth.validator');
const { ZodError } = require('zod');

const validSignup = {
  email: 'bob@example.com',
  password: 'Abcdefg1',
  full_name: 'Bob Smith',
  country_of_residence: 'US',
};

describe('validators/auth.validator', () => {
  describe('signupSchema', () => {
    it('accepts a fully valid payload', () => {
      expect(() => signupSchema.parse(validSignup)).not.toThrow();
    });

    it('rejects a password with no uppercase letter', () => {
      expect(() => signupSchema.parse({ ...validSignup, password: 'alllowercase1' })).toThrow(ZodError);
    });

    it('rejects a password with no digit', () => {
      expect(() => signupSchema.parse({ ...validSignup, password: 'NoDigitsHere' })).toThrow(ZodError);
    });

    it('rejects a password shorter than 8 characters', () => {
      expect(() => signupSchema.parse({ ...validSignup, password: 'Ab1' })).toThrow(ZodError);
    });

    it('rejects a password longer than 72 characters', () => {
      const longPw = 'Ab1' + 'x'.repeat(70); // 73 chars total
      expect(() => signupSchema.parse({ ...validSignup, password: longPw })).toThrow(ZodError);
    });

    it.each([
      'not-an-email',
      'missing@domain',
      '@nodomain.com',
    ])('rejects malformed email %p', (badEmail) => {
      expect(() => signupSchema.parse({ ...validSignup, email: badEmail })).toThrow(ZodError);
    });

    it('rejects full_name shorter than 2 characters', () => {
      expect(() => signupSchema.parse({ ...validSignup, full_name: 'B' })).toThrow(ZodError);
    });

    it('rejects full_name longer than 100 characters', () => {
      expect(() => signupSchema.parse({ ...validSignup, full_name: 'B'.repeat(101) })).toThrow(ZodError);
    });

    it('rejects country_of_residence shorter than 2 characters', () => {
      expect(() => signupSchema.parse({ ...validSignup, country_of_residence: 'U' })).toThrow(ZodError);
    });
  });

  describe('loginSchema', () => {
    it('accepts a valid email + non-empty password', () => {
      expect(() => loginSchema.parse({ email: 'a@b.com', password: 'x' })).not.toThrow();
    });

    it('rejects an empty password', () => {
      expect(() => loginSchema.parse({ email: 'a@b.com', password: '' })).toThrow(ZodError);
    });

    it('rejects a malformed email', () => {
      expect(() => loginSchema.parse({ email: 'not-an-email', password: 'x' })).toThrow(ZodError);
    });

    it('does NOT enforce signup-style password complexity — a single character passes', () => {
      // Login checks an EXISTING password; complexity is enforced at
      // signup time, not here. Rejection of a wrong password happens
      // downstream via Supabase auth, not validation. This is easy to
      // break by "helpfully" copying the signup regex into login.
      expect(() => loginSchema.parse({ email: 'a@b.com', password: 'x' })).not.toThrow();
    });
  });

  describe('registerSchema', () => {
    it('accepts an empty object — both fields optional for OAuth users', () => {
      expect(() => registerSchema.parse({})).not.toThrow();
    });

    it('accepts full_name and country_of_residence when provided', () => {
      expect(() => registerSchema.parse({ full_name: 'Bob Smith', country_of_residence: 'US' })).not.toThrow();
    });

    it('still enforces min length when full_name IS provided', () => {
      expect(() => registerSchema.parse({ full_name: 'B' })).toThrow(ZodError);
    });
  });

  describe('forgotPasswordSchema', () => {
    it('accepts a valid email', () => {
      expect(() => forgotPasswordSchema.parse({ email: 'a@b.com' })).not.toThrow();
    });

    it('rejects a malformed email', () => {
      expect(() => forgotPasswordSchema.parse({ email: 'nope' })).toThrow(ZodError);
    });
  });

  describe('resetPasswordSchema', () => {
    it('accepts a strong password', () => {
      expect(() => resetPasswordSchema.parse({ password: 'Abcdefg1' })).not.toThrow();
    });

    it('rejects a weak password (same complexity rules as signup)', () => {
      expect(() => resetPasswordSchema.parse({ password: 'weak' })).toThrow(ZodError);
    });
  });

  describe('changePasswordSchema', () => {
    it('accepts a non-empty current_password and a strong new_password', () => {
      expect(() =>
        changePasswordSchema.parse({ current_password: 'old', new_password: 'Abcdefg1' })
      ).not.toThrow();
    });

    it('rejects an empty current_password', () => {
      expect(() =>
        changePasswordSchema.parse({ current_password: '', new_password: 'Abcdefg1' })
      ).toThrow(ZodError);
    });

    it('rejects a weak new_password', () => {
      expect(() =>
        changePasswordSchema.parse({ current_password: 'old', new_password: 'weak' })
      ).toThrow(ZodError);
    });
  });

  describe('updateProfileSchema', () => {
    it('accepts an empty object — every field optional', () => {
      expect(() => updateProfileSchema.parse({})).not.toThrow();
    });

    it('rejects an invalid avatar_url', () => {
      expect(() => updateProfileSchema.parse({ avatar_url: 'not-a-url' })).toThrow(ZodError);
    });

    it('rejects a bio longer than 500 characters', () => {
      expect(() => updateProfileSchema.parse({ bio: 'x'.repeat(501) })).toThrow(ZodError);
    });

    it('accepts boolean preference fields', () => {
      expect(() =>
        updateProfileSchema.parse({ push_enabled: true, email_digest_enabled: false })
      ).not.toThrow();
    });
  });

  describe('contactSchema', () => {
    const validTypes = [
      'email_secondary','whatsapp','phone','telegram',
      'signal','instagram','facebook','twitter','linkedin','custom',
    ];

    it.each(validTypes)('accepts contact type %p', (type) => {
      expect(() =>
        contactSchema.parse({ contacts: [{ type, value: 'some-value' }] })
      ).not.toThrow();
    });

    it('rejects an unknown contact type', () => {
      expect(() =>
        contactSchema.parse({ contacts: [{ type: 'myspace', value: 'x' }] })
      ).toThrow(ZodError);
    });

    it('rejects an empty contacts array', () => {
      expect(() => contactSchema.parse({ contacts: [] })).toThrow(ZodError);
    });

    it('defaults is_primary to false when omitted', () => {
      const result = contactSchema.parse({ contacts: [{ type: 'phone', value: '555-1234' }] });
      expect(result.contacts[0].is_primary).toBe(false);
    });

    it('respects an explicit is_primary: true', () => {
      const result = contactSchema.parse({
        contacts: [{ type: 'phone', value: '555-1234', is_primary: true }],
      });
      expect(result.contacts[0].is_primary).toBe(true);
    });
  });

  describe('pushTokenSchema', () => {
    it.each(['web', 'ios', 'android'])('accepts platform %p', (platform) => {
      expect(() => pushTokenSchema.parse({ token: '1234567890', platform })).not.toThrow();
    });

    it('rejects an unsupported platform', () => {
      expect(() => pushTokenSchema.parse({ token: '1234567890', platform: 'windows' })).toThrow(ZodError);
    });

    it('rejects a token shorter than 10 characters', () => {
      expect(() => pushTokenSchema.parse({ token: 'short', platform: 'web' })).toThrow(ZodError);
    });
  });

  describe('notificationPrefsSchema', () => {
    it('accepts an empty object', () => {
      expect(() => notificationPrefsSchema.parse({})).not.toThrow();
    });

    it('accepts partial updates', () => {
      expect(() => notificationPrefsSchema.parse({ push_enabled: false })).not.toThrow();
    });
  });

  describe('refreshTokenSchema', () => {
    // Exported and part of the public contract even though the
    // controller currently reads req.cookies.refresh_token directly
    // rather than calling this schema's .parse() — tested in isolation
    // regardless of call-site usage.
    it('accepts a non-empty refresh_token', () => {
      expect(() => refreshTokenSchema.parse({ refresh_token: 'abc123' })).not.toThrow();
    });

    it('rejects a missing refresh_token', () => {
      expect(() => refreshTokenSchema.parse({})).toThrow(ZodError);
    });

    it('rejects an empty-string refresh_token', () => {
      expect(() => refreshTokenSchema.parse({ refresh_token: '' })).toThrow(ZodError);
    });
  });

  describe('SUPPORTED_CURRENCIES', () => {
    it('is a non-empty array of 3-letter currency codes', () => {
      expect(Array.isArray(SUPPORTED_CURRENCIES)).toBe(true);
      expect(SUPPORTED_CURRENCIES.length).toBeGreaterThan(0);
      SUPPORTED_CURRENCIES.forEach((c) => expect(c).toMatch(/^[A-Z]{3}$/));
    });
  });
});
