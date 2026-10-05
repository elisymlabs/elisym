import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planHandAnswer } from '../src/hand';
import { emptyLedger } from '../src/ledger';
import {
  DELIVERY_REMOVED,
  type Product,
  type ProductsFs,
  TEMPLATE_BODY,
  TEMPLATE_TITLE,
  intakeProductIds,
  loadProducts,
  parseProductText,
  productTemplateText,
  uneditedProducts,
} from '../src/products';
import { historyRefusal } from '../src/setup-ledger';

function productText(frontmatter: string, body = 'Adds 10 USD to your account.'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

const VALID = productText(
  ['title: Deposit 10 USD', 'priceUsd: "10"', 'summary: Adds 10 USD.'].join('\n'),
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
      description: 'Adds 10 USD to your account.',
    });
    expect(products.get('deposit-10')).not.toHaveProperty('delivery');
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

  it('M29: refuses an unknown or misspelled key', () => {
    for (const key of ['onsale: false', 'on_sale: false', 'pricUsd: "1"']) {
      expect(problemsOf(VALID.replace('summary: Adds 10 USD.', key)).join(' ')).toContain(
        'Unrecognized key',
      );
    }
  });

  it('M1: refuses a leftover delivery by name, with what to do instead', () => {
    const withDelivery = VALID.replace(
      'summary: Adds 10 USD.',
      'delivery:\n  method: access\n  value: https://shop.example/credit',
    );
    expect(problemsOf(withDelivery)).toEqual([DELIVERY_REMOVED]);
    expect(DELIVERY_REMOVED).toContain('order.paid webhook');
    // Even an empty one, and alongside any other problem, each named.
    expect(problemsOf(VALID.replace('summary: Adds 10 USD.', 'delivery:'))).toEqual([
      DELIVERY_REMOVED,
    ]);
    const both = problemsOf(withDelivery.replace('priceUsd: "10"', 'priceUsd: 10'));
    expect(both[0]).toBe(DELIVERY_REMOVED);
    expect(both.join(' ')).toContain('quote it');
  });

  it('refuses a missing title or price', () => {
    for (const line of ['title: Deposit 10 USD', 'priceUsd: "10"']) {
      expect(problemsOf(VALID.replace(line, ''))).toHaveLength(1);
    }
    expect(problemsOf(productText(['title: x', 'priceUsd: "1"'].join('\n')))).toEqual([]);
  });

  it('M34: refuses YAML scalars of the wrong type, never reinterpreted', () => {
    expect(problemsOf(VALID.replace('priceUsd: "10"', 'priceUsd: 10')).join(' ')).toContain(
      'quote it',
    );
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

  it('refuses a duplicate key', () => {
    expect(problemsOf(VALID.replace('summary: Adds 10 USD.', 'title: again'))).toHaveLength(1);
  });

  it('M27: the init template parses, has no delivery, and setup refuses it until edited', () => {
    const text = productTemplateText();
    expect(text).not.toContain('delivery');
    const parsed = parseProductText(text);
    if (!parsed.ok) {
      throw new Error(parsed.problems.join('; '));
    }
    const product: Product = { d: 'my-product', file: 'x', ...parsed.product };
    expect(product).toMatchObject({ title: TEMPLATE_TITLE, description: TEMPLATE_BODY });
    expect(uneditedProducts([product])).toEqual([product]);
    expect(uneditedProducts([{ ...product, title: 'Deposit 10 USD' }])).toEqual([]);
    expect(uneditedProducts([{ ...product, description: 'Adds 10 USD.' }])).toEqual([]);
    // A home a 0.8 init made is still the example too.
    const old = { ...product, description: 'What the buyer gets.' };
    expect(uneditedProducts([old])).toEqual([old]);
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

describe('a hand answer', () => {
  const KEY = `${'b'.repeat(64)}:o-1`;

  it('refuses completing a key already answered as refunded', () => {
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
    expect(planHandAnswer(state, KEY, { kind: 'delivered' })).toEqual({
      ok: false,
      problem: `${KEY} was already answered as refunded: the other answer is refused`,
    });
  });
});
