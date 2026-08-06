// tests/unit/utils/sorting.test.js
//
// Security-relevant: getSort() is a whitelist boundary preventing an
// unwhitelisted field string from ever reaching a raw `.order()` call.

const { getSort } = require('../../../src/utils/sorting');

describe('utils/sorting — getSort', () => {
  const opts = { allowed: ['name', 'id', 'created_at'], defaultField: 'created_at' };

  it('returns the requested field ascending when no leading dash', () => {
    expect(getSort({ sort: 'name' }, opts)).toEqual({ field: 'name', ascending: true });
  });

  it('returns the requested field descending when leading dash present', () => {
    expect(getSort({ sort: '-created_at' }, opts)).toEqual({ field: 'created_at', ascending: false });
  });

  it('falls back to defaultField ascending when sort is omitted (defaultDescending false)', () => {
    expect(getSort({}, { ...opts, defaultDescending: false })).toEqual({
      field: 'created_at',
      ascending: true,
    });
  });

  it('falls back to defaultField descending when sort is omitted (defaultDescending true)', () => {
    expect(getSort({}, { ...opts, defaultDescending: true })).toEqual({
      field: 'created_at',
      ascending: false,
    });
  });

  it('treats an empty-string sort the same as omitted (falls back to default)', () => {
    expect(getSort({ sort: '' }, opts)).toEqual({ field: 'created_at', ascending: true });
  });

  it('SECURITY: falls back to defaultField for a field not in the allowlist', () => {
    expect(getSort({ sort: 'password_hash' }, opts)).toEqual({
      field: 'created_at',
      ascending: true,
    });
  });

  it.each([
    'id; DROP TABLE users',
    'id--',
    "id' OR '1'='1",
  ])('SECURITY: falls back to defaultField for SQL-injection-flavored input %p', (maliciousField) => {
    const result = getSort({ sort: maliciousField }, opts);
    expect(result.field).toBe('created_at');
  });

  it('computes ascending=false independently of whether the field itself is whitelisted', () => {
    const result = getSort({ sort: '-password_hash' }, opts);
    expect(result.field).toBe('created_at'); // rejected, falls back
    expect(result.ascending).toBe(false); // direction still honored
  });

  it('handles a bare dash with no field name (falls back to default, descending)', () => {
    expect(getSort({ sort: '-' }, opts)).toEqual({ field: 'created_at', ascending: false });
  });

  it('ignores a non-string sort value (e.g. an array from a malformed query string)', () => {
    expect(getSort({ sort: ['name', 'id'] }, opts)).toEqual({ field: 'created_at', ascending: true });
  });
});
