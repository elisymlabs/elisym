import { createHash } from 'node:crypto';
import {
  CatalogItemInputSchema,
  D_TAG_RE,
  buildCatalogItemEvent,
  parseCatalogItem,
} from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import {
  type DraftVariant,
  type FitResult,
  type ProductDraft,
  clip,
  connectorD,
  fitDraft,
  normalizeAmount,
} from '../../src/connectors/listing';

function draft(overrides: Partial<ProductDraft> = {}): ProductDraft {
  return {
    platform: 'shopify',
    sourceId: '1001',
    title: 'Wool jacket',
    description: 'Warm.',
    currency: 'USD',
    images: ['https://cdn.example/1.jpg'],
    topics: ['outerwear'],
    url: 'https://shop.example/products/wool-jacket',
    attrs: [{ name: 'brand', value: 'Acme' }],
    options: [],
    variants: [{ id: 'v1', price: '120.00', available: true, values: [] }],
    ...overrides,
  };
}

function fitted(result: FitResult): Extract<FitResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected a listing, got: ${result.reason}`);
  }
  // Every fitted listing must be accepted by the builder and read back by the reader.
  expect(CatalogItemInputSchema.safeParse(result.listing).success).toBe(true);
  const event = {
    ...buildCatalogItemEvent(result.listing),
    pubkey: 'a'.repeat(64),
  };
  expect(parseCatalogItem(event, { role: 'catalog', now: 1 })).toBeDefined();
  return result;
}

function variant(
  id: string,
  price: string,
  available: boolean,
  values: string[] = [],
  sku?: string,
): DraftVariant {
  return sku === undefined
    ? { id, price, available, values }
    : { id, price, available, values, sku };
}

describe('connectorD', () => {
  it('is {platform}:{id} when that fits the d pattern', () => {
    expect(connectorD('shopify', '6635123015735')).toBe('shopify:6635123015735');
    expect(connectorD('google', 'SKU-1.a_b:c')).toBe('google:SKU-1.a_b:c');
  });

  it('falls back to a stable hash for free-Unicode or long ids', () => {
    const unicode = connectorD('google', 'chaussure rouge été');
    const expected = createHash('sha256')
      .update('chaussure rouge été', 'utf8')
      .digest()
      .subarray(0, 12)
      .toString('base64url');
    expect(unicode).toBe(`google:h${expected}`);
    expect(unicode).toHaveLength('google:h'.length + 16);
    expect(D_TAG_RE.test(unicode)).toBe(true);
    expect(connectorD('google', 'chaussure rouge été')).toBe(unicode);

    const long = 'x'.repeat(125);
    expect(D_TAG_RE.test(`google:${long}`)).toBe(false);
    expect(connectorD('google', long)).toMatch(/^google:h[A-Za-z0-9_-]{16}$/u);
    const fits = 'x'.repeat(121);
    expect(connectorD('google', fits)).toBe(`google:${fits}`);
  });
});

describe('clip and normalizeAmount', () => {
  it('never leaves half a surrogate pair', () => {
    expect(clip('ab\u{1F600}', 3)).toBe('ab');
    expect(clip('abc', 3)).toBe('abc');
  });

  it('keeps valid amounts as written and normalizes the rest without floats', () => {
    expect(normalizeAmount('15.00')).toBe('15.00');
    expect(normalizeAmount('015.50')).toBe('15.5');
    expect(normalizeAmount('1e2')).toBe('100');
    expect(normalizeAmount('-1')).toBeUndefined();
    expect(normalizeAmount('12,50')).toBeUndefined();
    expect(normalizeAmount('')).toBeUndefined();
  });
});

describe('fitDraft basics', () => {
  it('maps a clean product without flagging it truncated', () => {
    const result = fitted(fitDraft(draft()));
    expect(result.truncated).toBe(false);
    expect(result.listing).toMatchObject({
      d: 'shopify:1001',
      sourceId: '1001',
      price: { amount: '120.00', currency: 'USD' },
      visibility: 'on-sale',
      url: 'https://shop.example/products/wool-jacket',
      variants: [{ id: 'v1', price: '120.00', available: true, values: [] }],
    });
  });

  it('refuses a product without title, currency or any valid price', () => {
    expect(fitDraft(draft({ title: '  ' })).ok).toBe(false);
    expect(fitDraft(draft({ currency: 'usd' })).ok).toBe(false);
    expect(fitDraft(draft({ variants: [variant('v1', 'free', true)] })).ok).toBe(false);
    expect(fitDraft(draft({ variants: [], price: undefined })).ok).toBe(false);
  });

  it('drops a variant with an invalid price and flags it', () => {
    const result = fitted(
      fitDraft(draft({ variants: [variant('v1', '10', true), variant('v2', 'n/a', true)] })),
    );
    expect(result.listing.variants?.map((entry) => entry.id)).toEqual(['v1']);
    expect(result.truncated).toBe(true);
  });
});

describe('sku rule', () => {
  it('one variant: its SKU', () => {
    expect(
      fitted(fitDraft(draft({ variants: [variant('v1', '5', true, [], 'A1')] }))).listing.sku,
    ).toBe('A1');
  });

  it('several variants sharing one SKU: that SKU', () => {
    const options = [{ name: 'Size', values: ['S', 'M'] }];
    const variants = [variant('v1', '5', true, ['S'], 'A1'), variant('v2', '5', true, ['M'], 'A1')];
    expect(fitted(fitDraft(draft({ options, variants }))).listing.sku).toBe('A1');
  });

  it('differing or missing SKUs: none', () => {
    const options = [{ name: 'Size', values: ['S', 'M'] }];
    const differing = [
      variant('v1', '5', true, ['S'], 'A1'),
      variant('v2', '5', true, ['M'], 'A2'),
    ];
    expect(fitted(fitDraft(draft({ options, variants: differing }))).listing.sku).toBeUndefined();
    const partial = [variant('v1', '5', true, ['S'], 'A1'), variant('v2', '5', true, ['M'])];
    expect(fitted(fitDraft(draft({ options, variants: partial }))).listing.sku).toBeUndefined();
    expect(
      fitted(fitDraft(draft({ variants: [variant('v1', '5', true, [], '')] }))).listing.sku,
    ).toBeUndefined();
  });

  it('a SKU or source id over 128 characters is left out whole, never cut', () => {
    const result = fitted(
      fitDraft(
        draft({
          sourceId: 'y'.repeat(129),
          variants: [variant('v1', '5', true, [], 'z'.repeat(129))],
        }),
      ),
    );
    expect(result.listing.sku).toBeUndefined();
    expect(result.listing.sourceId).toBeUndefined();
    expect(result.truncated).toBe(true);
  });
});

describe('(1) price and visibility over all variants', () => {
  const options = [{ name: 'Size', values: ['S', 'M', 'L'] }];

  it('is the lowest available price; differing prices give price-from', () => {
    const result = fitted(
      fitDraft(
        draft({
          options,
          variants: [
            variant('s', '10', false, ['S']),
            variant('m', '30', true, ['M']),
            variant('l', '20', true, ['L']),
          ],
        }),
      ),
    );
    expect(result.listing.price.amount).toBe('20');
    expect(result.listing.visibility).toBe('on-sale');
    expect(buildCatalogItemEvent(result.listing).tags).toContainEqual(['price-from', '1']);
  });

  it('sold-out: the lowest variant price, and not on sale', () => {
    const result = fitted(
      fitDraft(
        draft({
          options,
          variants: [variant('s', '30', false, ['S']), variant('m', '25.5', false, ['M'])],
        }),
      ),
    );
    expect(result.listing.price.amount).toBe('25.5');
    expect(result.listing.visibility).toBe('sold-out');
  });
});

describe('(2) at most 100 variants, available first', () => {
  it('keeps available ones first and the price-defining one always', () => {
    const options = [{ name: 'N', values: [] }];
    const variants: DraftVariant[] = [];
    for (let index = 0; index < 150; index++) {
      // 0..99 unavailable, 100..149 available; the cheapest available is the last one.
      variants.push(
        variant(`v${index}`, String(index < 100 ? 1 : 500 - index), index >= 100, ['x']),
      );
    }
    const result = fitted(fitDraft(draft({ options, variants })));
    const kept = result.listing.variants ?? [];
    expect(kept).toHaveLength(100);
    expect(kept[0]?.id).toBe('v149');
    expect(kept.filter((entry) => entry.available)).toHaveLength(50);
    expect(result.listing.price.amount).toBe('351');
    expect(result.truncated).toBe(true);
  });
});

describe('(3) at most 5 options, preferring those that differ', () => {
  it('drops constant options first and removes their positions from variants', () => {
    const options = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => ({ name, values: [] }));
    // A, C, E, F, G differ across variants; B and D are constant.
    const result = fitted(
      fitDraft(
        draft({
          options,
          variants: [
            variant('v1', '5', true, ['a1', 'b', 'c1', 'd', 'e1', 'f1', 'g1']),
            variant('v2', '5', true, ['a2', 'b', 'c2', 'd', 'e2', 'f2', 'g2']),
          ],
        }),
      ),
    );
    expect(result.listing.options?.map((option) => option.name)).toEqual(['A', 'C', 'E', 'F', 'G']);
    expect(result.listing.variants?.[0]?.values).toEqual(['a1', 'c1', 'e1', 'f1', 'g1']);
    expect(result.truncated).toBe(true);
  });

  it('keeps the first five in order when more than five differ', () => {
    const options = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({ name, values: [] }));
    const result = fitted(
      fitDraft(
        draft({
          options,
          variants: [
            variant('v1', '5', true, ['1', '1', '1', '1', '1', '1']),
            variant('v2', '5', true, ['2', '2', '2', '2', '2', '2']),
          ],
        }),
      ),
    );
    expect(result.listing.options?.map((option) => option.name)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
  it('drops an unnamed option or a repeated option name', () => {
    const result = fitted(
      fitDraft(
        draft({
          options: [
            { name: 'Size', values: ['S'] },
            { name: '', values: ['x'] },
            { name: 'Size', values: ['M'] },
          ],
          variants: [variant('v1', '5', true, ['S', 'x', 'M'])],
        }),
      ),
    );
    expect(result.listing.options).toEqual([{ name: 'Size', values: ['S'] }]);
    expect(result.listing.variants?.[0]?.values).toEqual(['S']);
    expect(result.truncated).toBe(true);
  });
});

describe('(4) option values from the kept variants', () => {
  it('keeps platform order and only the values kept variants use', () => {
    const result = fitted(
      fitDraft(
        draft({
          options: [{ name: 'Size', values: ['XS', 'S', 'M', 'L'] }],
          variants: [variant('l', '5', true, ['L']), variant('s', '5', true, ['S'])],
        }),
      ),
    );
    expect(result.listing.options).toEqual([{ name: 'Size', values: ['S', 'L'] }]);
  });

  it('writes an "Any" value as * and takes that option values from the attribute terms', () => {
    const result = fitted(
      fitDraft(
        draft({
          platform: 'woocommerce',
          options: [
            { name: 'Size', values: ['S', 'M', 'L'], terms: ['S', 'M', 'L'] },
            { name: 'Color', values: ['Black', 'Red', 'White'], terms: ['Black', 'Red', 'White'] },
          ],
          variants: [
            variant('1', '10', true, ['', 'Black']),
            variant('2', '12', true, ['', 'Red']),
          ],
        }),
      ),
    );
    expect(result.listing.options).toEqual([
      { name: 'Size', values: ['S', 'M', 'L'] },
      { name: 'Color', values: ['Black', 'Red'] },
    ]);
    expect(result.listing.variants?.map((entry) => entry.values)).toEqual([
      ['*', 'Black'],
      ['*', 'Red'],
    ]);
  });

  it('drops an option that is only * with no terms to offer', () => {
    const result = fitted(
      fitDraft(
        draft({
          options: [
            { name: 'Engraving', values: [] },
            { name: 'Color', values: ['Black'] },
          ],
          variants: [variant('1', '10', true, ['', 'Black'])],
        }),
      ),
    );
    expect(result.listing.options).toEqual([{ name: 'Color', values: ['Black'] }]);
    expect(result.listing.variants?.[0]?.values).toEqual(['Black']);
    expect(result.truncated).toBe(true);
  });
});

describe('(5) at most 10 values per option', () => {
  const sizes = Array.from({ length: 13 }, (_unused, index) => String(index + 1));

  it('keeps the first 10 values and drops the variants using the others', () => {
    const result = fitted(
      fitDraft(
        draft({
          options: [{ name: 'Size', values: sizes }],
          variants: sizes.map((size) => variant(`v${size}`, '50', true, [size])),
        }),
      ),
    );
    expect(result.listing.options?.[0]?.values).toEqual(sizes.slice(0, 10));
    expect(result.listing.variants?.map((entry) => entry.id)).toEqual(
      sizes.slice(0, 10).map((size) => `v${size}`),
    );
    expect(result.truncated).toBe(true);
  });

  it('keeps the price-defining variant value among the 10 (no variant lost to the cut)', () => {
    // Only size 13 is available: it defines the price and must survive.
    const result = fitted(
      fitDraft(
        draft({
          options: [{ name: 'Size', values: sizes }],
          variants: sizes.map((size) => variant(`v${size}`, '50', size === '13', [size])),
        }),
      ),
    );
    const values = result.listing.options?.[0]?.values ?? [];
    expect(values).toHaveLength(10);
    expect(values).toContain('13');
    expect(result.listing.variants?.[0]?.id).toBe('v13');
    expect(result.listing.visibility).toBe('on-sale');
  });

  it('never drops every variant: the first (price-defining) one survives every cut', () => {
    // Two options of 11 values; the cheapest variant uses the 11th value of both.
    const letters = 'abcdefghijk'.split('');
    const numbers = Array.from({ length: 11 }, (_unused, index) => String(index));
    const variants = letters.map((letter, index) =>
      variant(`v${index}`, index === 10 ? '1' : '50', true, [letter, numbers[index] ?? '0']),
    );
    const result = fitted(
      fitDraft(
        draft({
          options: [
            { name: 'L', values: letters },
            { name: 'N', values: numbers },
          ],
          variants,
        }),
      ),
    );
    const kept = result.listing.variants ?? [];
    expect(kept[0]?.id).toBe('v10');
    expect(result.listing.options?.[0]?.values).toContain('k');
    expect(result.listing.options?.[1]?.values).toContain('10');
    expect(result.listing.price.amount).toBe('1');
    expect(kept.map((entry) => entry.id)).not.toContain('v9');
  });
});

describe('(6) attrs', () => {
  it('keeps sku and source-id outside the cap, removes reserved names, cuts the rest to 30', () => {
    const attrs = [
      { name: 'sku', value: 'spoof' },
      { name: 'source-id', value: 'spoof' },
      ...Array.from({ length: 40 }, (_unused, index) => ({ name: `a${index}`, value: 'v' })),
    ];
    const result = fitted(
      fitDraft(draft({ attrs, variants: [variant('v1', '5', true, [], 'S1')] })),
    );
    expect(result.listing.attrs).toHaveLength(30);
    expect(result.listing.attrs?.[0]).toEqual({ name: 'a0', value: 'v' });
    expect(result.listing.sku).toBe('S1');
    expect(result.listing.sourceId).toBe('1001');
    expect(result.truncated).toBe(true);
  });

  it('clips long names and values', () => {
    const result = fitted(
      fitDraft(draft({ attrs: [{ name: 'n'.repeat(40), value: 'v'.repeat(200) }] })),
    );
    expect(result.listing.attrs).toEqual([{ name: 'n'.repeat(32), value: 'v'.repeat(128) }]);
    expect(result.truncated).toBe(true);
  });
});

describe('(7) extra tags and images', () => {
  it('cuts images to 8 (https only), topics to 20 of 64 characters, and long texts', () => {
    const result = fitted(
      fitDraft(
        draft({
          title: 'T'.repeat(2_000),
          summary: 'S'.repeat(2_000),
          description: 'D'.repeat(70 * 1024),
          images: [
            'http://cdn.example/insecure.jpg',
            ...Array.from({ length: 10 }, (_unused, index) => `https://cdn.example/${index}.jpg`),
          ],
          topics: [...Array.from({ length: 25 }, (_unused, index) => `t${index}`), 'x'.repeat(80)],
          url: 'javascript:alert(1)',
        }),
      ),
    );
    expect(result.listing.images).toHaveLength(8);
    expect(result.listing.images?.[0]).toBe('https://cdn.example/0.jpg');
    expect(result.listing.topics).toHaveLength(20);
    expect(result.listing.title).toHaveLength(1024);
    expect(result.listing.summary).toHaveLength(1024);
    expect(result.listing.description).toHaveLength(64 * 1024);
    expect(result.listing.url).toBeUndefined();
    expect(result.truncated).toBe(true);
  });
});

describe('feed items (no variants)', () => {
  it('takes the item price, visibility and SKU', () => {
    const result = fitted(
      fitDraft(
        draft({
          platform: 'google',
          variants: [],
          price: '9.99',
          visibility: 'pre-order',
          sku: 'G-1',
        }),
      ),
    );
    expect(result.listing).toMatchObject({
      price: { amount: '9.99' },
      visibility: 'pre-order',
      sku: 'G-1',
      variants: [],
    });
  });
});
