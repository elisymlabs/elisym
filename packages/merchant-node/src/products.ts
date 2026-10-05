/**
 * The store's products: one directory per product under `<home>/products`,
 * `<d>/PRODUCT.md` in the same shape as a CLI skill (YAML frontmatter between
 * `---` lines, a markdown body). Unlike a skill, a malformed product is refused,
 * never skipped: a product that silently dropped out could leave its paid
 * orders with no delivery.
 */
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { DELIVERY_METHODS, LIMITS } from '@elisym/commerce';
import Decimal from 'decimal.js-light';
import YAML from 'yaml';
import { z } from 'zod';
import type { MerchantOrder } from './ledger';
import type { Delivery } from './reply';

/** The file of a product, in its directory. */
export const PRODUCT_FILE = 'PRODUCT.md';

/** What `init` writes as the delivery: `setup` refuses a product still delivering it. */
export const PLACEHOLDER_DELIVERY_VALUE = 'https://example.com/<the link the buyer gets>';

/** A product id is its directory name: a letter or digit, then letters, digits, dots, dashes, underscores. */
const PRODUCT_D_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const PRICE_RE = /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/;

/** A byte order mark an editor may put before the first line. */
const BOM = String.fromCharCode(0xfeff);

export interface Product {
  /** The directory name: the listing's `d`. */
  d: string;
  title: string;
  /** The markdown body: the listing's description. */
  description: string;
  summary?: string;
  /** USD, e.g. `"1"` or `"49.00"`: paid 1:1 in a USD coin. */
  priceUsd: string;
  /** `false`: the listing is republished sold out, and its terms retire. */
  onSale: boolean;
  /** What the buyer gets once paid: a link (a Blossom URL is one) or text. */
  delivery: Delivery;
  /** The file it was read from, for messages. */
  file: string;
}

/** The part of `node:fs` the products are read with (replaceable in tests). */
export interface ProductsFs {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  lstatSync(path: string): { isDirectory(): boolean; isFile(): boolean };
  readFileSync(path: string, encoding: 'utf8'): string;
}

const QUOTE_IT = 'must be a quoted string (quote it: a bare number is read as a number)';

const frontmatterSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    priceUsd: z
      .string({ invalid_type_error: `${QUOTE_IT}, such as "49" or "0.50"` })
      .refine((value) => PRICE_RE.test(value) && new Decimal(value).gt(0), {
        message: 'must be a USD amount above 0, such as "49" or "0.50"',
      }),
    onSale: z.boolean().optional(),
    summary: z.string().max(LIMITS.MAX_TAG_VALUE_LENGTH).optional(),
    delivery: z
      .object({
        method: z.enum(DELIVERY_METHODS),
        value: z.string({ invalid_type_error: QUOTE_IT }).min(1).max(LIMITS.MAX_TAG_VALUE_LENGTH),
      })
      .strict(),
  })
  .strict();

type Parsed =
  | { ok: true; product: Omit<Product, 'd' | 'file'> }
  | { ok: false; problems: string[] };

/**
 * The frontmatter and body of a PRODUCT.md. The first line must be the opening
 * `---` (after a BOM): text before it would be dropped without a word. A CRLF
 * file reads the same as an LF one.
 */
export function parseProductText(text: string): Parsed {
  const lines = (text.startsWith(BOM) ? text.slice(1) : text)
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines[0] !== '---') {
    return { ok: false, problems: ['must start with a --- line, the frontmatter fence'] };
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    return { ok: false, problems: ['has no closing --- line after the frontmatter'] };
  }
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(lines.slice(1, end).join('\n'));
  } catch (error) {
    return {
      ok: false,
      problems: [
        `frontmatter is not YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      ],
    };
  }
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return { ok: false, problems: ['frontmatter must be a YAML mapping'] };
  }
  const parsed = frontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) =>
          `${issue.path.length === 0 ? 'frontmatter' : issue.path.join('.')}: ${issue.message}`,
      ),
    };
  }
  const description = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  if (description.length > LIMITS.MAX_CONTENT_LENGTH) {
    return { ok: false, problems: [`the body is longer than ${LIMITS.MAX_CONTENT_LENGTH}`] };
  }
  const { title, priceUsd, onSale, summary, delivery } = parsed.data;
  return {
    ok: true,
    product: {
      title,
      description,
      ...(summary === undefined ? {} : { summary }),
      priceUsd,
      onSale: onSale ?? true,
      delivery,
    },
  };
}

/**
 * Read every product under `dir`, keyed by its exact directory name. Entries
 * starting with `.` are never products and are skipped, as are files placed
 * directly in `dir`; every other problem refuses the lot, naming each file. A
 * missing `dir` holds no products.
 */
export function loadProducts(dir: string, fs: ProductsFs = nodeFs): Map<string, Product> {
  const products = new Map<string, Product>();
  if (!fs.existsSync(dir)) {
    return products;
  }
  if (!fs.lstatSync(dir).isDirectory()) {
    throw new Error('products: not a directory (a link is refused)');
  }
  const problems: string[] = [];
  for (const name of [...fs.readdirSync(dir)].sort()) {
    if (name.startsWith('.')) {
      continue;
    }
    const entry = join(dir, name);
    const where = `products/${name}`;
    // lstat: a symlink is neither a directory nor a file here, so it is refused.
    const stat = fs.lstatSync(entry);
    if (!stat.isDirectory()) {
      if (!stat.isFile()) {
        problems.push(`${where}: not a directory (a link, pipe or device is refused)`);
      }
      continue;
    }
    if (!PRODUCT_D_RE.test(name)) {
      problems.push(
        `${where}: a product directory is named 1-64 letters, digits, dots, dashes or underscores, starting with a letter or digit`,
      );
      continue;
    }
    const file = join(entry, PRODUCT_FILE);
    if (!fs.existsSync(file)) {
      problems.push(`${where}: has no ${PRODUCT_FILE}`);
      continue;
    }
    if (!fs.lstatSync(file).isFile()) {
      problems.push(
        `${where}/${PRODUCT_FILE}: not a plain file (a link, pipe or device is refused)`,
      );
      continue;
    }
    const parsed = parseProductText(fs.readFileSync(file, 'utf8'));
    if (!parsed.ok) {
      problems.push(...parsed.problems.map((problem) => `${where}/${PRODUCT_FILE}: ${problem}`));
      continue;
    }
    products.set(name, { d: name, ...parsed.product, file });
  }
  if (problems.length > 0) {
    throw new Error(`the products are not usable:\n- ${problems.join('\n- ')}`);
  }
  return products;
}

/** The `d` of a product address `30402:<store>:<d>`. */
export function productDOf(address: string): string {
  const [, , ...rest] = address.split(':');
  return rest.join(':');
}

/** The `d` of the product an order named: every order carries one (intake sets it). */
export function orderProductD(order: Pick<MerchantOrder, 'product'>): string {
  return productDOf(order.product);
}

/**
 * The delivery of the order's own product, or `undefined` when no product
 * directory has that exact name: never another product's.
 */
export function deliveryFor(
  order: Pick<MerchantOrder, 'product'>,
  products: ReadonlyMap<string, Product>,
): Delivery | undefined {
  return products.get(orderProductD(order))?.delivery;
}

/**
 * The products intake takes orders for: every directory, stopped ones
 * included. A buyer pays without waiting for an acknowledgement, so an order
 * backfilled after a stop still needs its record; what a stopped product
 * accepts is bounded by its retired terms and the window.
 */
export function intakeProductIds(products: ReadonlyMap<string, Product>): string[] {
  return [...products.keys()];
}

/** The products still delivering `init`'s example link: setup refuses to publish them. */
export function uneditedProducts(products: Iterable<Product>): Product[] {
  return [...products].filter((product) => product.delivery.value === PLACEHOLDER_DELIVERY_VALUE);
}

/** The PRODUCT.md `init` scaffolds: `setup` refuses it until its delivery is real. */
export function productTemplateText(): string {
  return [
    '---',
    'title: My product',
    'priceUsd: "10"',
    'delivery:',
    '  method: access',
    `  value: ${PLACEHOLDER_DELIVERY_VALUE}`,
    '---',
    '',
    'What the buyer gets.',
    '',
  ].join('\n');
}
