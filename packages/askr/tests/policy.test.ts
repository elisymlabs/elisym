import { describe, expect, it } from 'vitest';
import { LIMITS, policiesInUse } from '../src';

const slugs = (list: readonly string[]) => list.map((slug) => ({ slug }));

describe('policiesInUse', () => {
  it('puts the slugs a Shopify import brings first, in their own order, then the rest by character order', () => {
    const ordered = policiesInUse(
      slugs(['zeta', 'terms', 'a-b', 'returns', 'a1', 'aB', 'shipping']),
    );
    expect(ordered.map((policy) => policy.slug)).toEqual([
      'returns',
      'shipping',
      'terms',
      'a-b',
      'a1',
      'aB',
      'zeta',
    ]);
  });

  it('keeps at most MAX_POLICIES and leaves the input as it was', () => {
    const many = slugs(
      Array.from({ length: LIMITS.MAX_POLICIES + 3 }, (_unused, index) => `p${index}`),
    );
    const before = many.map((policy) => policy.slug);
    expect(policiesInUse(many)).toHaveLength(LIMITS.MAX_POLICIES);
    expect(many.map((policy) => policy.slug)).toEqual(before);
    expect(policiesInUse([])).toEqual([]);
  });
});
