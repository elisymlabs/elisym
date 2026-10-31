/**
 * A product as the console's form edits it (plan `cloud-pricing-and-onboarding.md`
 * 3, Products): its title, USD price, short summary, description and whether it
 * is on sale, written to and read from the PRODUCT.md the node reads. The
 * console writes every value as a JSON string (a YAML double-quoted scalar),
 * one per line; a PRODUCT.md it did not write that way is edited as text.
 */
import Decimal from 'decimal.js-light';

export interface ProductFields {
  title: string;
  /** USD, as typed: checked by `priceProblem`. */
  priceUsd: string;
  /** The short line under the title; empty for none. */
  summary: string;
  description: string;
  onSale: boolean;
}

/** The most one product may weigh in a save (cloud-api `MAX_PRODUCT_BYTES`). */
export const MAX_PRODUCT_BYTES = 4096;
/** The node's own price shape: up to 9 whole digits and 6 decimals. */
const PRICE_RE = /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/;
const MAX_TITLE = 200;
const MAX_SUMMARY = 1024;
const SLUG_MAX = 63;

/** The PRODUCT.md for these fields. */
export function productText(fields: ProductFields): string {
  const lines = [
    '---',
    `title: ${JSON.stringify(fields.title.trim())}`,
    `priceUsd: ${JSON.stringify(fields.priceUsd.trim())}`,
    ...(fields.summary.trim() === '' ? [] : [`summary: ${JSON.stringify(fields.summary.trim())}`]),
    ...(fields.onSale ? [] : ['onSale: false']),
    '---',
    '',
    fields.description.trim(),
    '',
  ];
  return lines.join('\n');
}

function jsonString(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The fields of a PRODUCT.md written as `productText` writes it; undefined
 * for any other (it is then edited as text, never rewritten unseen).
 */
export function productFields(text: string): ProductFields | undefined {
  const lines = text.split('\n');
  if (lines[0] !== '---') {
    return undefined;
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    return undefined;
  }
  const fields = new Map<string, string>();
  let onSale = true;
  for (const line of lines.slice(1, end)) {
    const match = /^(title|priceUsd|summary|onSale): (.*)$/.exec(line);
    const key = match?.[1];
    const raw = match?.[2] ?? '';
    // A key twice, or a line the console does not write: edited as text.
    if (key === undefined || fields.has(key)) {
      return undefined;
    }
    if (key === 'onSale') {
      if (raw !== 'true' && raw !== 'false') {
        return undefined;
      }
      fields.set(key, raw);
      onSale = raw === 'true';
      continue;
    }
    const value = jsonString(raw);
    if (value === undefined) {
      return undefined;
    }
    fields.set(key, value);
  }
  const title = fields.get('title');
  const priceUsd = fields.get('priceUsd');
  if (title === undefined || priceUsd === undefined) {
    return undefined;
  }
  return {
    title,
    priceUsd,
    summary: fields.get('summary') ?? '',
    description: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
    onSale,
  };
}

/** Why a price is not one the node takes; undefined when it is. */
export function priceProblem(price: string): string | undefined {
  const trimmed = price.trim();
  if (!PRICE_RE.test(trimmed) || !new Decimal(trimmed).gt(0)) {
    return 'A price in USD above 0, with up to 6 decimals, such as 49 or 0.50.';
  }
  return undefined;
}

/** Why the fields cannot be saved (the price, a missing title, a length); empty when they can. */
export function fieldProblems(fields: ProductFields): string[] {
  const problems: string[] = [];
  if (fields.title.trim() === '') {
    problems.push('Give the product a title.');
  } else if (fields.title.trim().length > MAX_TITLE) {
    problems.push(`A title is at most ${MAX_TITLE} characters.`);
  }
  const price = priceProblem(fields.priceUsd);
  if (price !== undefined) {
    problems.push(price);
  }
  if (fields.summary.trim().length > MAX_SUMMARY) {
    problems.push(`A summary is at most ${MAX_SUMMARY} characters.`);
  }
  return problems;
}

/** A product's weight in a save, as cloud-api measures it: its text written as a JSON string. */
export function productBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).length;
}

/** A product name (its id) from its title: lowercase letters, digits and dashes. */
export function slugOf(title: string): string {
  return (
    title
      .normalize('NFKD')
      // The accents split off: "é" is "e".
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX)
      .replace(/-+$/, '')
  );
}

/** The first of `slug`, `slug-2`, `slug-3`... not taken (`product` when the title gives none). */
export function freeSlug(title: string, taken: ReadonlySet<string>): string {
  const base = slugOf(title) || 'product';
  if (!taken.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** A product as the draft holds it: its fields, or its text when the console did not write it. */
export interface ProductDraft {
  /** A stable key for the page (its name may still change). */
  key: string;
  name: string;
  /** The merchant typed the id: the title no longer names it. */
  nameTouched: boolean;
  fields: ProductFields | undefined;
  /** The text as kept; edited as such when `fields` is undefined. */
  text: string;
}

/** The PRODUCT.md a draft product saves. */
export function draftText(product: ProductDraft): string {
  return product.fields === undefined ? product.text : productText(product.fields);
}

/** A kept product as the draft starts it (`key` from its name). */
export function draftOf(name: string, text: string): ProductDraft {
  const fields = productFields(text);
  // Only a text the form writes back byte for byte is edited as fields: an unchanged one stays unchanged.
  const exact = fields !== undefined && productText(fields) === text;
  return { key: `kept-${name}`, name, nameTouched: true, fields: exact ? fields : undefined, text };
}

/** The set a draft saves: name -> PRODUCT.md. */
export function draftSet(products: readonly ProductDraft[]): Record<string, string> {
  const set: Record<string, string> = {};
  for (const product of products) {
    set[product.name] = draftText(product);
  }
  return set;
}

/** How many products differ between two sets: added, removed or changed. */
export function changedCount(
  from: Readonly<Record<string, string>>,
  to: Readonly<Record<string, string>>,
): number {
  const names = new Set([...Object.keys(from), ...Object.keys(to)]);
  return [...names].filter((name) => from[name] !== to[name]).length;
}
