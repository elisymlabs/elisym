import { PRODUCT_D_RE, PRICE_RE } from '@merchant-product-rules';
import { describe, expect, it } from 'vitest';

describe('the shared product rules alias', () => {
  it('reads merchant-node’s leaf module', () => {
    expect(PRODUCT_D_RE.test('tea-1')).toBe(true);
    expect(PRODUCT_D_RE.test('../x')).toBe(false);
    expect(PRICE_RE.test('0.50')).toBe(true);
  });
});
