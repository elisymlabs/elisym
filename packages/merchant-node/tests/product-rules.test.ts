import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_PRODUCT_DESCRIPTION,
  MAX_PRODUCT_TAG_VALUE,
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

  it('takes each text at its limit and refuses one character more', () => {
    const base = { title: 'Socks', description: '', priceUsd: '5' };
    const link = (length: number) => `https://shop.example/${'a'.repeat(length - 21)}`;
    expect(MAX_PRODUCT_TITLE).toBe(200);
    expect(MAX_PRODUCT_TAG_VALUE).toBe(1024);
    expect(MAX_PRODUCT_DESCRIPTION).toBe(64 * 1024);
    expect(link(100).length).toBe(100);
    for (const [field, value, limit] of [
      ['title', (length: number) => 't'.repeat(length), MAX_PRODUCT_TITLE],
      ['summary', (length: number) => 's'.repeat(length), MAX_PRODUCT_TAG_VALUE],
      ['url', link, MAX_PRODUCT_TAG_VALUE],
      ['description', (length: number) => 'd'.repeat(length), MAX_PRODUCT_DESCRIPTION],
    ] as const) {
      expect(ProductInputSchema.safeParse({ ...base, [field]: value(limit) }).success, field).toBe(
        true,
      );
      expect(
        ProductInputSchema.safeParse({ ...base, [field]: value(limit + 1) }).success,
        field,
      ).toBe(false);
    }
  });

  it('refuses unstorable text in every text field, and a non-boolean onSale', () => {
    const base = { title: 'Socks', description: '', priceUsd: '5' };
    for (const field of ['title', 'description', 'summary', 'url']) {
      for (const bad of ['a\u0000', '\ud800']) {
        const value = field === 'url' ? `https://shop.example/${bad}` : bad;
        expect(
          ProductInputSchema.safeParse({ ...base, [field]: value }).success,
          `${field} ${JSON.stringify(value)}`,
        ).toBe(false);
      }
    }
    expect(ProductInputSchema.safeParse({ ...base, onSale: false }).data?.onSale).toBe(false);
    for (const onSale of ['true', 1, null]) {
      expect(ProductInputSchema.safeParse({ ...base, onSale }).success, String(onSale)).toBe(false);
    }
  });
});
