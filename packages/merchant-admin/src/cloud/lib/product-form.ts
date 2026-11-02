/**
 * A product as the console's form edits it (plan `cloud-pricing-and-onboarding.md`
 * 3, Products): its title, USD price, short summary, picture, description and
 * whether it is on sale, written to and read from the PRODUCT.md the node reads. The
 * console writes every value as a JSON string (a YAML double-quoted scalar),
 * one per line; a PRODUCT.md it did not write that way is edited as text.
 */
import Decimal from 'decimal.js-light';
import { PRODUCT_NAME_RE } from './snippet';

export interface ProductFields {
  title: string;
  /** USD, as typed: checked by `priceProblem`. */
  priceUsd: string;
  /** The short line under the title; empty for none. */
  summary: string;
  /** A link to the product's picture (`https://`); empty for none. */
  image: string;
  description: string;
  onSale: boolean;
}

/** The most one product may weigh in a save (cloud-api `MAX_PRODUCT_BYTES`). */
export const MAX_PRODUCT_BYTES = 4096;
/** The node's own price shape: up to 9 whole digits and 6 decimals. */
const PRICE_RE = /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/;
const MAX_TITLE = 200;
const MAX_SUMMARY = 1024;
/** The node's own image rule: an `https://` link, at most a listing tag's length. */
const MAX_IMAGE = 1024;
const SLUG_MAX = 63;

/** The PRODUCT.md for these fields. */
export function productText(fields: ProductFields): string {
  const lines = [
    '---',
    `title: ${JSON.stringify(fields.title.trim())}`,
    `priceUsd: ${JSON.stringify(fields.priceUsd.trim())}`,
    ...(fields.summary.trim() === '' ? [] : [`summary: ${JSON.stringify(fields.summary.trim())}`]),
    ...(fields.image.trim() === '' ? [] : [`image: ${JSON.stringify(fields.image.trim())}`]),
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
    const match = /^(title|priceUsd|summary|image|onSale): (.*)$/.exec(line);
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
    image: fields.get('image') ?? '',
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

/**
 * Why an image link is not one the node takes; undefined when it is, or when
 * there is none (it is optional).
 */
export function imageProblem(image: string): string | undefined {
  const trimmed = image.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!trimmed.startsWith('https://') || !URL.canParse(trimmed)) {
    return 'A link to a picture that starts with https://, such as https://example.com/photo.jpg.';
  }
  if (trimmed.length > MAX_IMAGE) {
    return `A picture link is at most ${MAX_IMAGE} characters.`;
  }
  return undefined;
}

/** The picture link to show for these fields: none when it is empty or not one the node takes. */
export function shownImage(fields: ProductFields): string | undefined {
  const image = fields.image.trim();
  return image === '' || imageProblem(image) !== undefined ? undefined : image;
}

/** Why each field cannot be saved, by the field it is about; empty when all can. */
export interface FieldErrors {
  title?: string;
  price?: string;
  summary?: string;
  image?: string;
}

/** Why each field cannot be saved (a missing title, the price, a length), at its field. */
export function fieldErrors(fields: ProductFields): FieldErrors {
  const errors: FieldErrors = {};
  if (fields.title.trim() === '') {
    errors.title = 'Give the product a title.';
  } else if (fields.title.trim().length > MAX_TITLE) {
    errors.title = `A title is at most ${MAX_TITLE} characters.`;
  }
  const price = priceProblem(fields.priceUsd);
  if (price !== undefined) {
    errors.price = price;
  }
  if (fields.summary.trim().length > MAX_SUMMARY) {
    errors.summary = `A summary is at most ${MAX_SUMMARY} characters.`;
  }
  const image = imageProblem(fields.image);
  if (image !== undefined) {
    errors.image = image;
  }
  return errors;
}

/** Why the fields cannot be saved (the price, a missing title, a length, the image); empty when they can. */
export function fieldProblems(fields: ProductFields): string[] {
  const errors = fieldErrors(fields);
  return [errors.title, errors.price, errors.summary, errors.image].filter(
    (error): error is string => error !== undefined,
  );
}

/** Past this share of the size limit, the room left is said. */
const ROOM_SHOWN_FROM = 0.9;

/**
 * The room left in a product, in bytes, once it is near the limit (past 90%):
 * undefined while there is plenty, negative when it is over.
 */
export function roomLeft(text: string): number | undefined {
  const bytes = productBytes(text);
  return bytes <= MAX_PRODUCT_BYTES * ROOM_SHOWN_FROM ? undefined : MAX_PRODUCT_BYTES - bytes;
}

/** A product's weight in a save, as cloud-api measures it: its text written as a JSON string. */
export function productBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).length;
}

/**
 * About how many more characters like the ones it has fit in a product: the
 * bytes left over its own bytes per character (a letter outside ASCII, or an
 * escaped one, weighs more than one byte).
 */
export function charactersLeft(text: string): number {
  const left = MAX_PRODUCT_BYTES - productBytes(text);
  const characters = [...text].length;
  if (left <= 0 || characters === 0) {
    return Math.max(left, 0);
  }
  return Math.floor((left * characters) / productBytes(text));
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

/**
 * The first of `slug`, `slug-2`, `slug-3`... not taken; a title that gives no
 * slug (no Latin letter or digit) takes the first free `product-N`.
 */
export function freeSlug(title: string, taken: ReadonlySet<string>): string {
  const base = slugOf(title);
  if (base === '') {
    for (let index = 1; ; index += 1) {
      if (!taken.has(`product-${index}`)) {
        return `product-${index}`;
      }
    }
  }
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

/**
 * Why one product cannot be saved, in words (its own fields, its id, its size).
 * A clash of ids is the product's whose id can still change: never a kept one's.
 */
export function productIssues(
  product: ProductDraft,
  draft: readonly ProductDraft[],
  fixed: boolean,
): string[] {
  const issues: string[] = [];
  if (!PRODUCT_NAME_RE.test(product.name)) {
    issues.push('Its button id is lowercase letters, digits and dashes.');
  } else if (
    !fixed &&
    draft.some((other) => other.key !== product.key && other.name === product.name)
  ) {
    issues.push(`Another product has the button id ${product.name}.`);
  }
  if (product.fields !== undefined) {
    issues.push(...fieldProblems(product.fields));
  }
  if (productBytes(draftText(product)) > MAX_PRODUCT_BYTES) {
    issues.push('Too long: shorten the description.');
  }
  return issues;
}
