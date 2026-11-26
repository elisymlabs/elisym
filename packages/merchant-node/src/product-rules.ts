/**
 * The rules a product must meet, shared by merchant-node (PRODUCT.md), the
 * PayCore server (products as JSON) and the hosted admin (in the browser).
 * A leaf module: no `node:*` and no `yaml`, so a browser bundle can import it.
 */
import Decimal from 'decimal.js-light';
import * as z from 'zod';

/** A product id is its directory name: a letter or digit, then letters, digits, dots, dashes, underscores. */
export const PRODUCT_D_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A USD price: up to 9 integer digits and 6 decimals, no sign, no leading zeros. */
export const PRICE_RE = /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/;

/** The longest product title. */
export const MAX_PRODUCT_TITLE = 200;
/** The longest summary or link (a listing tag value). */
export const MAX_PRODUCT_TAG_VALUE = 1024;
/** The longest description (the listing's content). */
export const MAX_PRODUCT_DESCRIPTION = 64 * 1024;

const NUL = String.fromCharCode(0);
const LONE_SURROGATE_RE = /\p{Cs}/u;

/** Why a text is refused by {@link isStorable}. */
export const NOT_STORABLE = 'holds a character that cannot be stored (NUL or a lone surrogate)';

/** Postgres `text` holds no NUL, and a lone surrogate is no UTF-8: refused, never stored half. */
export function isStorable(value: string): boolean {
  return !value.includes(NUL) && !LONE_SURROGATE_RE.test(value);
}

/** A string of at most `max` characters that {@link isStorable} accepts. */
export function storableString(max: number) {
  return z.string().max(max).refine(isStorable, { message: NOT_STORABLE });
}

/** A USD amount above 0 in the {@link PRICE_RE} shape. */
export function isPriceUsd(value: string): boolean {
  return PRICE_RE.test(value) && new Decimal(value).gt(0);
}

export const PRICE_PROBLEM = 'must be a USD amount above 0, such as "49" or "0.50"';

export function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === 'https:';
}

/** A product as JSON (the PayCore server's admin API and import, the hosted admin). */
export const ProductInputSchema = z
  .object({
    title: storableString(MAX_PRODUCT_TITLE)
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, { message: 'is empty' }),
    description: storableString(MAX_PRODUCT_DESCRIPTION).transform((value) => value.trim()),
    summary: storableString(MAX_PRODUCT_TAG_VALUE).optional(),
    url: storableString(MAX_PRODUCT_TAG_VALUE)
      .refine(isHttpsUrl, { message: 'must be an https link' })
      .optional(),
    priceUsd: z.string().refine(isPriceUsd, { message: PRICE_PROBLEM }),
    onSale: z.boolean().optional(),
  })
  .strict();

export type ProductInput = z.infer<typeof ProductInputSchema>;
