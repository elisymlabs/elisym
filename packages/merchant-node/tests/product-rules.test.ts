import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_PRODUCT_TITLE,
  PRICE_RE,
  PRODUCT_D_RE,
  ProductInputSchema,
  isPriceUsd,
  isStorable,
} from '../src/product-rules';
import * as products from '../src/products';

describe('product rules (shared with the PayCore server and the hosted admin)', () => {
  it('is a leaf a browser bundle can import: no node built-ins, no yaml, no local modules', () => {
    const source = readFileSync(new URL('../src/product-rules.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports).toEqual(['decimal.js-light', 'zod']);
  });

  it('is what products.ts re-exports and reads PRODUCT.md with', () => {
    expect(products.PRICE_RE).toBe(PRICE_RE);
    expect(products.PRODUCT_D_RE).toBe(PRODUCT_D_RE);
    const parsed = products.parseProductText(
      ['---', `title: "${'t'.repeat(MAX_PRODUCT_TITLE + 1)}"`, 'priceUsd: "0"', '---', ''].join(
        '\n',
      ),
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.join('\n')).toMatch(
      /title[\s\S]*priceUsd: must be a USD amount above 0/,
    );
  });

  it('checks prices, ids and storable text', () => {
    expect(['1', '0.5', '49.000001', '999999999'].map(isPriceUsd)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['0', '0.0', '01', '1.1234567', '-1', '1e3', '1000000000'].map(isPriceUsd)).toEqual(
      Array(7).fill(false),
    );
    expect(PRODUCT_D_RE.test('socks_2.v-1')).toBe(true);
    expect(PRODUCT_D_RE.test('.hidden')).toBe(false);
    expect(PRODUCT_D_RE.test('a'.repeat(65))).toBe(false);
    expect(isStorable('ok')).toBe(true);
    expect(isStorable('a\u0000')).toBe(false);
    expect(isStorable('\ud800')).toBe(false);
  });

  it('parses a product as JSON: trimmed title and description, https link, strict keys', () => {
    expect(
      ProductInputSchema.parse({ title: ' Socks ', description: ' Warm. ', priceUsd: '5' }),
    ).toEqual({ title: 'Socks', description: 'Warm.', priceUsd: '5' });
    for (const bad of [
      { title: '  ', description: '', priceUsd: '5' },
      { title: 'a\u0000', description: '', priceUsd: '5' },
      { title: 'Socks', description: '', priceUsd: 5 },
      { title: 'Socks', description: '', priceUsd: '5', url: 'http://shop.example' },
      { title: 'Socks', description: '', priceUsd: '5', extra: true },
      { title: 't'.repeat(MAX_PRODUCT_TITLE + 1), description: '', priceUsd: '5' },
    ]) {
      expect(ProductInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
