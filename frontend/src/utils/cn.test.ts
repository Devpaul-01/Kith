// utils/cn.test.ts
//
// Thin wrapper (clsx + tailwind-merge) used in nearly every component in
// src/components/ui/, but the whole point of reaching for tailwind-merge
// instead of plain clsx is its Tailwind-aware conflict resolution (a
// later conflicting class wins instead of both being emitted and the
// browser picking winner by source order) — that's the one behavior
// actually worth pinning down here, since it's easy to accidentally
// regress by swapping tailwind-merge for plain clsx in a refactor.

import { describe, it, expect } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('joins multiple plain class strings', () => {
    expect(cn('px-2', 'py-4')).toBe('px-2 py-4');
  });

  it('drops falsy values (conditional classNames pattern)', () => {
    expect(cn('base', false && 'hidden', null, undefined, 'visible')).toBe('base visible');
  });

  it('resolves a conflicting Tailwind utility by keeping the LAST one, not emitting both', () => {
    // This is the behavior plain clsx does not provide — proves cn is
    // actually using tailwind-merge's conflict resolution, not just
    // concatenating strings.
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('resolves a conflicting text color utility to the last one', () => {
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('leaves non-conflicting classes from different utility groups untouched', () => {
    expect(cn('px-4', 'text-red-500', 'font-bold')).toBe('px-4 text-red-500 font-bold');
  });

  it('supports the conditional-object form', () => {
    expect(cn('base', { active: true, disabled: false })).toBe('base active');
  });
});
