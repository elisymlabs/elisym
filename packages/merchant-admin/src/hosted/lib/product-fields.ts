/**
 * A product as the merchant types it (the editor) or lists it (a CSV row),
 * checked in the browser with the shared product rules before anything is
 * sent. Problems are fixed sentences by field (A15), never a rule's own text.
 */
import { NOT_STORABLE, PRODUCT_D_RE, ProductInputSchema } from '@merchant-product-rules';
import type { ProductInput } from './types';

export type ProductField = 'd' | 'title' | 'priceUsd' | 'summary' | 'url' | 'description';

/** What the merchant entered, every field as text. */
export interface ProductDraft {
  d: string;
  title: string;
  priceUsd: string;
  summary: string;
  url: string;
  description: string;
  onSale: boolean;
}

export const FIELD_PROBLEMS: Readonly<Record<ProductField, string>> = {
  d: 'Enter a product id: a letter or digit, then up to 63 letters, digits, dots, dashes or underscores.',
  title: 'Enter a title of at most 200 characters.',
  priceUsd: 'Enter a USD price above 0 with at most 6 decimals, such as 49 or 0.50.',
  summary: 'Keep the summary to at most 1024 characters.',
  url: 'Enter an https link of at most 1024 characters, or leave it empty.',
  description: 'Keep the description to at most 65536 characters.',
};

/** A field that holds NUL or a lone surrogate (pasted binary): said apart from its length rule. */
export const NOT_STORABLE_PROBLEM =
  'This field holds a character that cannot be stored. Retype it as plain text.';

export type ProductProblems = Partial<Record<ProductField, string>>;

const FIELDS: readonly ProductField[] = ['d', 'title', 'priceUsd', 'summary', 'url', 'description'];

function fieldOf(key: PropertyKey | undefined): ProductField | undefined {
  return FIELDS.find((field) => field === key);
}

/** The input the server takes: optional texts left out when empty. */
export function productInput(draft: ProductDraft): ProductInput {
  const summary = draft.summary.trim();
  const url = draft.url.trim();
  return {
    title: draft.title,
    description: draft.description,
    priceUsd: draft.priceUsd.trim(),
    onSale: draft.onSale,
    ...(summary === '' ? {} : { summary }),
    ...(url === '' ? {} : { url }),
  };
}

export type CheckedProduct =
  | { ok: true; d: string; input: ProductInput }
  | { ok: false; problems: ProductProblems };

/** The draft against the shared rules: the input to send, or a fixed sentence per field. */
export function checkProduct(draft: ProductDraft): CheckedProduct {
  const problems: ProductProblems = {};
  const d = draft.d.trim();
  if (!PRODUCT_D_RE.test(d)) {
    problems.d = FIELD_PROBLEMS.d;
  }
  const parsed = ProductInputSchema.safeParse(productInput(draft));
  if (parsed.success && problems.d === undefined) {
    return { ok: true, d, input: parsed.data };
  }
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldOf(issue.path[0]);
      // Every issue the schema raises names one of its fields (a test pins its shape).
      if (field !== undefined && problems[field] === undefined) {
        problems[field] =
          issue.message === NOT_STORABLE ? NOT_STORABLE_PROBLEM : FIELD_PROBLEMS[field];
      }
    }
  }
  return { ok: false, problems };
}
