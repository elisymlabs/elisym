import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handDelivery, planHandAnswer } from '../src/hand';
import { emptyLedger } from '../src/ledger';
import {
  PLACEHOLDER_DELIVERY_VALUE,
  type Product,
  type ProductsFs,
  deliveryFor,
  intakeProductIds,
  loadProducts,
  parseProductText,
  productTemplateText,
  uneditedProducts,
} from '../src/products';
import { historyRefusal } from '../src/setup-ledger';

const STORE = 's'.repeat(64);

function productText(frontmatter: string, body = 'What the buyer gets.'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

const VALID = productText(
  [
    'title: Deposit 10 USD',
    'priceUsd: "10"',
    'summary: Adds 10 USD.',
    'delivery:',
    '  method: access',
    '  value: https://shop.example/credit',
  ].join('\n'),
);

/** A products directory holding `entries` (name -> PRODUCT.md text). */
function productsDir(entries: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'merchant-products-')), 'products');
  mkdirSync(dir);
  for (const [name, text] of Object.entries(entries)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'PRODUCT.md'), text);
  }
  return dir;
}

function problemsOf(text: string): string[] {
  const parsed = parseProductText(text);
  return parsed.ok ? [] : parsed.problems;
}

describe('a product directory', () => {
  it('loads with its d taken from the directory name, the body as its description', () => {
    const products = loadProducts(productsDir({ 'deposit-10': VALID }));
    expect([...products.keys()]).toEqual(['deposit-10']);
    expect(products.get('deposit-10')).toMatchObject({
      d: 'deposit-10',
      title: 'Deposit 10 USD',
      priceUsd: '10',
      onSale: true,
      summary: 'Adds 10 USD.',
      description: 'What the buyer gets.',
      delivery: { method: 'access', value: 'https://shop.example/credit' },
    });
  });

  it('reads onSale, and several products, each its own', () => {
    const products = loadProducts(
      productsDir({
        a: VALID,
        b: VALID.replace('priceUsd: "10"', 'priceUsd: "0.50"\nonSale: false'),
      }),
    );
    expect(products.get('a')?.onSale).toBe(true);
    expect(products.get('b')).toMatchObject({ priceUsd: '0.50', onSale: false });
  });

  it('skips hidden entries and files placed directly in products/; a missing directory has none', () => {
    const dir = productsDir({ a: VALID, '.git': 'whatever' });
    writeFileSync(join(dir, '.DS_Store'), '');
    writeFileSync(join(dir, 'EXAMPLE.md'), 'notes');
    expect([...loadProducts(dir).keys()]).toEqual(['a']);
    expect(loadProducts(join(dir, 'missing')).size).toBe(0);
  });

  it('refuses a bad directory name', () => {
    for (const name of ['-x', 'x'.repeat(65), 'has space', 'a+b']) {
      expect(() => loadProducts(productsDir({ [name]: VALID }))).toThrow(
        'a product directory is named',
      );
    }
  });

  it('M32: refuses every product when one is malformed, naming it: it is never skipped', () => {
    expect(() => loadProducts(productsDir({ a: VALID, b: productText('title: x') }))).toThrow(
      'products/b/PRODUCT.md',
    );
  });

  it('refuses a products root that is a link or a file', () => {
    const dir = productsDir({ a: VALID });
    const linked = join(dir, '..', 'linked-products');
    symlinkSync(dir, linked);
    expect(() => loadProducts(linked)).toThrow('products: not a directory (a link is refused)');
    const file = join(dir, '..', 'file-products');
    writeFileSync(file, 'x');
    expect(() => loadProducts(file)).toThrow('products: not a directory (a link is refused)');
  });

  it('refuses a directory without PRODUCT.md', () => {
    const dir = productsDir({ a: VALID });
    mkdirSync(join(dir, 'empty'));
    expect(() => loadProducts(dir)).toThrow('products/empty: has no PRODUCT.md');
  });

  it('M33: refuses a symlinked directory or PRODUCT.md, and a FIFO', () => {
    const dir = productsDir({ a: VALID });
    symlinkSync(join(dir, 'a'), join(dir, 'linked'));
    expect(() => loadProducts(dir)).toThrow('products/linked: not a directory');
    const fileDir = productsDir({});
    mkdirSync(join(fileDir, 'b'));
    symlinkSync(join(dir, 'a', 'PRODUCT.md'), join(fileDir, 'b', 'PRODUCT.md'));
    expect(() => loadProducts(fileDir)).toThrow('products/b/PRODUCT.md: not a plain file');
    const fifoDir = productsDir({});
    mkdirSync(join(fifoDir, 'c'));
    execFileSync('mkfifo', [join(fifoDir, 'c', 'PRODUCT.md')]);
    expect(() => loadProducts(fifoDir)).toThrow('products/c/PRODUCT.md: not a plain file');
  });

  it('M35: keys products by their exact directory name, also on a case-insensitive filesystem', () => {
    // A filesystem where a path answers in any case (default APFS): `Deposit` exists by path.
    const caseless: ProductsFs = {
      existsSync: () => true,
      readdirSync: () => ['deposit'],
      lstatSync: (path) => ({
        isDirectory: () => !path.endsWith('PRODUCT.md'),
        isFile: () => path.endsWith('PRODUCT.md'),
      }),
      readFileSync: () => VALID,
    };
    const products = loadProducts('/home/products', caseless);
    expect([...products.keys()]).toEqual(['deposit']);
    const state = emptyLedger();
    state.listings.Deposit = { hash: 'h', eventId: 'e', createdAt: 1 };
    expect(historyRefusal(state, products)).toContain('restore products/Deposit');
    expect(deliveryFor({ product: `30402:${STORE}:Deposit` }, products)).toBeUndefined();
    expect(handDelivery(state, 'b:o', products, 'Deposit')).toMatchObject({ ok: false });
  });
});

describe('the PRODUCT.md file', () => {
  it('M36: refuses text before the opening fence; accepts a BOM before it', () => {
    expect(problemsOf(`a stray line\n${VALID}`)).toEqual([
      'must start with a --- line, the frontmatter fence',
    ]);
    expect(problemsOf(`${String.fromCharCode(0xfeff)}${VALID}`)).toEqual([]);
  });

  it('M40: accepts a CRLF file', () => {
    expect(problemsOf(VALID.replaceAll('\n', '\r\n'))).toEqual([]);
  });

  it('refuses no fences, no closing fence, and a frontmatter that is not a mapping', () => {
    expect(problemsOf('title: x\n')).toHaveLength(1);
    expect(problemsOf('---\ntitle: x\n')).toEqual([
      'has no closing --- line after the frontmatter',
    ]);
    expect(problemsOf(productText('- a list'))).toEqual(['frontmatter must be a YAML mapping']);
    expect(problemsOf(productText('just a string'))).toEqual([
      'frontmatter must be a YAML mapping',
    ]);
  });

  it('M29: refuses an unknown or misspelled key, also inside delivery', () => {
    for (const key of ['onsale: false', 'on_sale: false', 'pricUsd: "1"']) {
      expect(problemsOf(VALID.replace('summary: Adds 10 USD.', key)).join(' ')).toContain(
        'Unrecognized key',
      );
    }
    expect(
      problemsOf(
        VALID.replace('  value: https://shop.example/credit', '  value: x\n  extra: y'),
      ).join(' '),
    ).toContain('Unrecognized key');
  });

  it('refuses a missing title, price or delivery', () => {
    for (const line of ['title: Deposit 10 USD', 'priceUsd: "10"']) {
      expect(problemsOf(VALID.replace(line, ''))).toHaveLength(1);
    }
    expect(problemsOf(productText(['title: x', 'priceUsd: "1"'].join('\n')))).toEqual([
      'delivery: Required',
    ]);
  });

  it('M34: refuses YAML scalars of the wrong type, never reinterpreted', () => {
    expect(problemsOf(VALID.replace('priceUsd: "10"', 'priceUsd: 10')).join(' ')).toContain(
      'quote it',
    );
    expect(
      problemsOf(VALID.replace('  value: https://shop.example/credit', '  value: 012345')).join(
        ' ',
      ),
    ).toContain('quote it');
    expect(
      problemsOf(VALID.replace('  value: https://shop.example/credit', '  value: "012345"')),
    ).toEqual([]);
    expect(problemsOf(VALID.replace('summary: Adds 10 USD.', 'onSale: no')).join(' ')).toContain(
      'onSale',
    );
    expect(problemsOf(VALID.replace('priceUsd: "10"', 'priceUsd: "0"'))).toHaveLength(1);
    expect(problemsOf(VALID.replace('priceUsd: "10"', 'priceUsd: "1e3"'))).toHaveLength(1);
  });

  it('refuses a price with a leading zero, which the listing would refuse', () => {
    for (const price of ['010', '00.5', '01']) {
      expect(problemsOf(VALID.replace('priceUsd: "10"', `priceUsd: "${price}"`))).toHaveLength(1);
    }
    expect(problemsOf(VALID.replace('priceUsd: "10"', 'priceUsd: "0.5"'))).toEqual([]);
  });

  it('refuses a duplicate key and a bad delivery method', () => {
    expect(problemsOf(VALID.replace('summary: Adds 10 USD.', 'title: again'))).toHaveLength(1);
    expect(problemsOf(VALID.replace('method: access', 'method: email'))).toHaveLength(1);
  });

  it('M37: the init template is still the placeholder, which setup refuses', () => {
    const parsed = parseProductText(productTemplateText());
    expect(parsed.ok).toBe(true);
    const product: Product = {
      d: 'my-product',
      file: 'x',
      ...(parsed.ok
        ? parsed.product
        : {
            title: '',
            description: '',
            priceUsd: '1',
            onSale: true,
            delivery: { method: 'access', value: '' },
          }),
    };
    expect(product.delivery.value).toBe(PLACEHOLDER_DELIVERY_VALUE);
    expect(uneditedProducts([product])).toEqual([product]);
    expect(
      uneditedProducts([
        { ...product, delivery: { method: 'access', value: 'https://shop.example/x' } },
      ]),
    ).toEqual([]);
  });
});

describe('the delivery of an order', () => {
  const products = loadProducts(
    productsDir({
      a: VALID,
      b: VALID.replace('https://shop.example/credit', 'https://shop.example/b'),
    }),
  );

  it("is its own product's, never another's (M6)", () => {
    expect(deliveryFor({ product: `30402:${STORE}:a` }, products)?.value).toBe(
      'https://shop.example/credit',
    );
    expect(deliveryFor({ product: `30402:${STORE}:b` }, products)?.value).toBe(
      'https://shop.example/b',
    );
    expect(deliveryFor({ product: `30402:${STORE}:gone` }, products)).toBeUndefined();
  });
});

describe('the products intake takes orders for', () => {
  it('M7: are every product, stopped ones included', () => {
    const products = loadProducts(
      productsDir({
        a: VALID,
        b: VALID.replace('priceUsd: "10"', 'priceUsd: "10"\nonSale: false'),
      }),
    );
    expect(intakeProductIds(products)).toEqual(['a', 'b']);
  });
});

describe('a hand delivery', () => {
  const products = loadProducts(
    productsDir({
      a: VALID,
      b: VALID.replace('https://shop.example/credit', 'https://shop.example/b'),
    }),
  );
  const KEY = `${'b'.repeat(64)}:o-1`;

  function held(d: string) {
    const state = emptyLedger();
    state.orders[KEY] = {
      key: KEY,
      buyerPubkey: 'b'.repeat(64),
      orderId: 'o-1',
      rumorId: 'r',
      createdAt: 1,
      reference: 'x',
      product: `30402:${STORE}:${d}`,
      reportedTxs: [],
    };
    return state;
  }

  it("of a held order is its own product's, and a differing --product is refused", () => {
    expect(handDelivery(held('b'), KEY, products, undefined)).toEqual({
      ok: true,
      delivery: { method: 'access', value: 'https://shop.example/b' },
    });
    expect(handDelivery(held('b'), KEY, products, 'b')).toMatchObject({ ok: true });
    expect(handDelivery(held('b'), KEY, products, 'a')).toMatchObject({ ok: false });
    expect(handDelivery(held('b'), KEY, products, 'nope')).toMatchObject({ ok: false });
  });

  it('M6: of an order whose product has no directory is refused, never another product', () => {
    expect(handDelivery(held('gone'), KEY, products, undefined)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('restore products/gone'),
    });
  });

  it('M20: of a pruned order needs --product when the store has several products', () => {
    const state = emptyLedger();
    state.closedOrders = { [KEY]: true };
    expect(handDelivery(state, KEY, products, undefined)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('--product'),
    });
    expect(handDelivery(state, KEY, products, 'a')).toEqual({
      ok: true,
      delivery: { method: 'access', value: 'https://shop.example/credit' },
    });
    const one = loadProducts(productsDir({ only: VALID }));
    expect(handDelivery(state, KEY, one, undefined)).toMatchObject({ ok: true });
  });

  it('refuses a key already answered as refunded, whatever the products', () => {
    const state = emptyLedger();
    state.closedOrders = { [KEY]: true };
    state.answeredByHand = {
      [KEY]: {
        kind: 'refunded',
        tx: 'x',
        amount: '1',
        reportedTxs: [],
        refusedTxs: [],
        noLegTxs: [],
      },
    };
    const refusal = {
      ok: false,
      problem: `${KEY} was already answered as refunded: the other answer is refused`,
    };
    expect(handDelivery(state, KEY, products, undefined)).toEqual(refusal);
    expect(handDelivery(state, KEY, products, 'a')).toEqual(refusal);
    // The same wording planHandAnswer gives.
    expect(
      planHandAnswer(state, KEY, {
        kind: 'delivered',
        delivery: { method: 'access', value: 'https://shop.example/b' },
      }),
    ).toEqual(refusal);
  });

  it('M24: a rerun needs no --product, and refuses one whose delivery differs', () => {
    const state = emptyLedger();
    state.answeredByHand = {
      [KEY]: {
        kind: 'delivered',
        delivery: { method: 'access', value: 'https://shop.example/b' },
        reportedTxs: [],
        refusedTxs: [],
        noLegTxs: [],
      },
    };
    expect(handDelivery(state, KEY, products, undefined)).toEqual({
      ok: true,
      delivery: { method: 'access', value: 'https://shop.example/b' },
    });
    expect(handDelivery(state, KEY, products, 'b')).toMatchObject({ ok: true });
    expect(handDelivery(state, KEY, products, 'a')).toMatchObject({ ok: false });
  });
});
