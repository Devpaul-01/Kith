// tests/unit/utils/pagination.test.js
const { getPagination } = require('../../../src/utils/pagination');

describe('utils/pagination — getPagination', () => {
  it('computes page/perPage/offset for a valid query', () => {
    expect(getPagination({ page: 2, per_page: 10 })).toEqual({
      page: 2,
      perPage: 10,
      offset: 10,
    });
  });

  it('defaults to page 1 / perPage 20 / offset 0 when query is empty', () => {
    expect(getPagination({})).toEqual({ page: 1, perPage: 20, offset: 0 });
  });

  it('treats per_page: 0 as falsy and falls back to the default of 20 (not clamped to 1)', () => {
    // `parseInt(query.per_page) || 20` — 0 is falsy in JS, so this hits
    // the `|| 20` fallback rather than surviving through to the
    // Math.max(1, ...) clamp. This is current, intentional behavior to
    // lock in, not a bug in this test: the Math.max(1, ...) clamp is
    // only reachable via a non-zero, sub-1 value (e.g. negative).
    expect(getPagination({ per_page: 0 })).toEqual({ page: 1, perPage: 20, offset: 0 });
  });

  it('clamps a negative per_page up to a minimum of 1', () => {
    expect(getPagination({ per_page: -5 })).toEqual({ page: 1, perPage: 1, offset: 0 });
  });

  it('clamps per_page: 500 down to a maximum of 100', () => {
    expect(getPagination({ per_page: 500 })).toEqual({ page: 1, perPage: 100, offset: 0 });
  });

  it('clamps page: 0 up to a minimum of 1', () => {
    expect(getPagination({ page: 0 })).toEqual({ page: 1, perPage: 20, offset: 0 });
  });

  it('clamps a negative page up to a minimum of 1', () => {
    expect(getPagination({ page: -5 })).toEqual({ page: 1, perPage: 20, offset: 0 });
  });

  it('falls back to page 1 when page is non-numeric (NaN || 1, not NaN ?? 1)', () => {
    // parseInt('abc') is NaN; NaN || 1 === 1. This explicitly locks in
    // the `||` fallback — replacing it with `??` would break this case,
    // since NaN ?? 1 is NaN, not 1.
    expect(getPagination({ page: 'abc' }).page).toBe(1);
  });

  it('falls back to perPage 20 when per_page is non-numeric', () => {
    expect(getPagination({ per_page: 'abc' }).perPage).toBe(20);
  });

  it('does NOT cap page itself — documents current (unbounded) behavior as a known gap', () => {
    // See Doc 1 Bug Review Finding #1: an arbitrarily large `page` is
    // not rejected. This test intentionally asserts the current
    // behavior so any future fix is a deliberate, visible test change.
    const result = getPagination({ page: 999999999 });
    expect(result.page).toBe(999999999);
    expect(result.offset).toBe((999999999 - 1) * 20);
  });

  it('accepts string-typed page/per_page (as they arrive from req.query)', () => {
    expect(getPagination({ page: '3', per_page: '15' })).toEqual({
      page: 3,
      perPage: 15,
      offset: 30,
    });
  });
});
