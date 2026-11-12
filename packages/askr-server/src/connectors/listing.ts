import { createHash } from 'node:crypto';
import {
  ANY_OPTION_VALUE,
  type CatalogAttr,
  type CatalogItemInput,
  CatalogItemInputSchema,
  type ConnectorPlatform,
  D_TAG_RE,
  LIMITS,
  RESERVED_ATTRS,
  type Visibility,
} from '@elisym/askr';
import Decimal from 'decimal.js-light';
import { D_HASH_BYTES } from './constants';

const PRICE_AMOUNT_RE = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** One platform variant before the 2.1 caps. `values` may hold `*` (a Woo "Any"). */
export interface DraftVariant {
  id: string;
  /** Decimal string as the platform gave it. */
  price: string;
  available: boolean;
  values: string[];
  sku?: string;
}

export interface DraftOption {
  name: string;
  /** The platform's own value order, used to order the kept values. */
  values: string[];
  /** Woo `attributes[].terms`: what an "Any" (`*`) value stands for. */
  terms?: string[];
}

/** A platform product mapped to Askr terms but not yet fitted to the 2.1 caps. */
export interface ProductDraft {
  platform: ConnectorPlatform;
  sourceId: string;
  title: string;
  summary?: string;
  description: string;
  currency: string;
  images: string[];
  topics: string[];
  url?: string;
  attrs: CatalogAttr[];
  options: DraftOption[];
  variants: DraftVariant[];
  /** Only without variants (Google feed): the item's own price, visibility and id-as-SKU. */
  price?: string;
  visibility?: Visibility;
  sku?: string;
}

export type FitResult =
  | { ok: true; listing: CatalogItemInput; truncated: boolean }
  | { ok: false; sourceId: string; reason: string };

/**
 * `d` for a connector listing (7.4): `{platform}:{id}` when that fits the `d`
 * pattern, else `{platform}:h{base64url(SHA-256(id)[0..12])}`, stable across syncs.
 */
export function connectorD(platform: ConnectorPlatform, sourceId: string): string {
  const plain = `${platform}:${sourceId}`;
  if (D_TAG_RE.test(plain)) {
    return plain;
  }
  const digest = createHash('sha256').update(sourceId, 'utf8').digest().subarray(0, D_HASH_BYTES);
  return `${platform}:h${digest.toString('base64url')}`;
}

/** Cut to `max` UTF-16 units without leaving half a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** A price amount the 2.1 `price` tag accepts, or undefined. Never a float. */
export function normalizeAmount(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (PRICE_AMOUNT_RE.test(trimmed)) {
    return trimmed;
  }
  try {
    const value = new Decimal(trimmed);
    if (value.isNegative()) {
      return undefined;
    }
    const normalized = value.toFixed();
    return PRICE_AMOUNT_RE.test(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function isHttpsUrl(value: string): boolean {
  if (value.length > LIMITS.TAG_VALUE_CHARS) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** The SKU rule (7.4): one variant, or every variant shares one SKU. */
function sharedSku(variants: readonly DraftVariant[]): string | undefined {
  const distinct = new Set(variants.map((variant) => variant.sku ?? ''));
  const [only] = distinct;
  return distinct.size === 1 && only !== undefined && only !== '' ? only : undefined;
}

interface Fitting {
  truncated: boolean;
}

interface FittedVariants {
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{
    id: string;
    price: string;
    available: boolean;
    values: string[];
  }>;
  price: string;
  visibility: Visibility;
}

/** Variants with a valid id and price, values clipped and padded to one per option. */
function cleanVariants(draft: ProductDraft, fitting: Fitting): DraftVariant[] {
  const seen = new Set<string>();
  const clean: DraftVariant[] = [];
  for (const variant of draft.variants) {
    const price = normalizeAmount(variant.price);
    if (
      price === undefined ||
      variant.id === '' ||
      variant.id.length > LIMITS.ATTR_VALUE_CHARS ||
      seen.has(variant.id)
    ) {
      fitting.truncated = true;
      continue;
    }
    seen.add(variant.id);
    const values = draft.options.map((_option, index) => {
      const value = (variant.values[index] ?? '').trim();
      return value === '' ? ANY_OPTION_VALUE : clip(value, LIMITS.ATTR_VALUE_CHARS);
    });
    clean.push({ ...variant, price, values });
  }
  return clean;
}

function lowest(variants: readonly DraftVariant[]): DraftVariant | undefined {
  let best: DraftVariant | undefined;
  for (const variant of variants) {
    if (!best || new Decimal(variant.price).lessThan(best.price)) {
      best = variant;
    }
  }
  return best;
}

function dropPositions(variants: DraftVariant[], keep: readonly number[]): DraftVariant[] {
  return variants.map((variant) => ({
    ...variant,
    values: keep.map((index) => variant.values[index] ?? ANY_OPTION_VALUE),
  }));
}

/**
 * Steps (1) to (5) of the 7.4 caps order. The price-defining variant (the
 * lowest available, else the lowest) is ordered first and never dropped:
 * the builder requires `price` to equal the lowest kept variant's price, and
 * (1) computes it over all variants, so the variant behind it must survive.
 */
function fitVariants(draft: ProductDraft, fitting: Fitting): FittedVariants | undefined {
  const variants = cleanVariants(draft, fitting);
  const available = variants.filter((variant) => variant.available);
  // (1) price over all variants.
  const anchor = lowest(available.length > 0 ? available : variants);
  if (!anchor) {
    return undefined;
  }
  const visibility: Visibility = available.length > 0 ? 'on-sale' : 'sold-out';
  // (2) up to 100 variants, available first.
  const ordered = [
    anchor,
    ...available.filter((variant) => variant !== anchor),
    ...variants.filter((variant) => !variant.available && variant !== anchor),
  ];
  let kept = ordered.slice(0, LIMITS.MAX_VARIANTS);
  if (kept.length < ordered.length) {
    fitting.truncated = true;
  }
  // (3) at most 5 options, preferring those whose values differ across the kept variants.
  let options = draft.options.map((option) => ({
    name: clip(option.name.trim(), LIMITS.ATTR_NAME_CHARS),
    values: option.values.map((value) => clip(value.trim(), LIMITS.ATTR_VALUE_CHARS)),
    terms: (option.terms ?? []).map((term) => clip(term.trim(), LIMITS.ATTR_VALUE_CHARS)),
  }));
  // An unnamed option, or a second one under the same name, cannot be offered.
  const seenNames = new Set<string>();
  let positions = options.flatMap((option, index) => {
    if (option.name === '' || seenNames.has(option.name)) {
      return [];
    }
    seenNames.add(option.name);
    return [index];
  });
  if (positions.length > LIMITS.MAX_OPTIONS) {
    const differs = (index: number): boolean =>
      new Set(kept.map((variant) => variant.values[index])).size > 1;
    const preferred = [
      ...positions.filter((index) => differs(index)),
      ...positions.filter((index) => !differs(index)),
    ].slice(0, LIMITS.MAX_OPTIONS);
    positions = positions.filter((index) => preferred.includes(index));
  }
  if (positions.length < options.length) {
    fitting.truncated = true;
  }
  options = positions.map((index) => options[index] ?? { name: '', values: [], terms: [] });
  kept = dropPositions(kept, positions);
  const anchorId = anchor.id;

  // (4) option values from what the kept variants use; `*` takes the attribute's terms.
  const valuesFor = (index: number): string[] => {
    const option = options[index];
    const used = uniqueStrings(
      kept
        .map((variant) => variant.values[index] ?? ANY_OPTION_VALUE)
        .filter((value) => value !== ANY_OPTION_VALUE),
    );
    const hasAny = kept.some((variant) => variant.values[index] === ANY_OPTION_VALUE);
    const base = hasAny ? (option?.terms ?? []) : (option?.values ?? []);
    const ordered = uniqueStrings([...base.filter((value) => hasAny || used.includes(value))]);
    return uniqueStrings([...ordered, ...used.filter((value) => !ordered.includes(value))]);
  };
  let optionValues = options.map((_option, index) => valuesFor(index));

  // (5) at most 10 values per option; variants using a cut value are dropped.
  optionValues = optionValues.map((values, index) => {
    if (values.length <= LIMITS.MAX_OPTION_VALUES) {
      return values;
    }
    fitting.truncated = true;
    const keptValues = values.slice(0, LIMITS.MAX_OPTION_VALUES);
    const anchorValue = kept.find((variant) => variant.id === anchorId)?.values[index];
    if (
      anchorValue !== undefined &&
      anchorValue !== ANY_OPTION_VALUE &&
      !keptValues.includes(anchorValue)
    ) {
      keptValues[keptValues.length - 1] = anchorValue;
    }
    const before = kept.length;
    kept = kept.filter((variant) => {
      const value = variant.values[index] ?? ANY_OPTION_VALUE;
      return value === ANY_OPTION_VALUE || keptValues.includes(value);
    });
    if (kept.length < before) {
      fitting.truncated = true;
    }
    return keptValues;
  });
  // Values only the dropped variants used go too (terms behind a `*` stay).
  optionValues = optionValues.map((values, index) => {
    if (kept.some((variant) => variant.values[index] === ANY_OPTION_VALUE)) {
      return values;
    }
    return values.filter((value) => kept.some((variant) => variant.values[index] === value));
  });
  // An option left with no values (only `*`, no terms) cannot be offered: drop it.
  const live = optionValues
    .map((values, index) => ({ values, index }))
    .filter((entry) => entry.values.length > 0);
  if (live.length < optionValues.length) {
    fitting.truncated = true;
    kept = dropPositions(
      kept,
      live.map((entry) => entry.index),
    );
  }
  return {
    options: live.map((entry) => ({
      name: options[entry.index]?.name ?? '',
      values: entry.values,
    })),
    variants: kept.map((variant) => ({
      id: variant.id,
      price: variant.price,
      available: variant.available,
      values: variant.values,
    })),
    price: anchor.price,
    visibility,
  };
}

/** (6) `sku`/`source-id` live in their own fields; the rest capped at 30. */
function fitAttrs(attrs: readonly CatalogAttr[], fitting: Fitting): CatalogAttr[] {
  const seen = new Set<string>();
  const fitted: CatalogAttr[] = [];
  for (const attr of attrs) {
    const name = clip(attr.name.trim(), LIMITS.ATTR_NAME_CHARS);
    const value = clip(attr.value.trim(), LIMITS.ATTR_VALUE_CHARS);
    if (name !== attr.name.trim() || value !== attr.value.trim()) {
      fitting.truncated = true;
    }
    if (name === '' || value === '' || RESERVED_ATTRS.includes(name)) {
      continue;
    }
    const key = `${name}\u0000${value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    fitted.push({ name, value });
  }
  if (fitted.length > LIMITS.MAX_ATTRS) {
    fitting.truncated = true;
  }
  return fitted.slice(0, LIMITS.MAX_ATTRS);
}

function clipped(text: string, max: number, fitting: Fitting): string {
  const cut = clip(text, max);
  if (cut !== text) {
    fitting.truncated = true;
  }
  return cut;
}

/** An identifier that must not be cut: kept whole or left out. */
function wholeOrNothing(value: string | undefined, fitting: Fitting): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value.length > LIMITS.ATTR_VALUE_CHARS) {
    fitting.truncated = true;
    return undefined;
  }
  return value;
}

/**
 * Fit a platform product to the 2.1 caps in the 7.4 order, truncating rather
 * than rejecting, and flag whether anything was cut. A product that cannot be
 * listed at all (no title, no valid price) is refused with a reason.
 */
export function fitDraft(draft: ProductDraft): FitResult {
  const fitting: Fitting = { truncated: false };
  const refuse = (reason: string): FitResult => ({
    ok: false,
    sourceId: draft.sourceId,
    reason,
  });
  const title = draft.title.trim();
  if (title === '') {
    return refuse('no title');
  }
  if (!CURRENCY_RE.test(draft.currency)) {
    return refuse('no valid currency');
  }
  let options: FittedVariants['options'] = [];
  let variants: FittedVariants['variants'] = [];
  let price: string;
  let visibility: Visibility;
  let sku: string | undefined;
  if (draft.variants.length > 0) {
    const fitted = fitVariants(draft, fitting);
    if (!fitted) {
      return refuse('no variant with a valid price');
    }
    ({ options, variants, price, visibility } = fitted);
    sku = sharedSku(draft.variants);
  } else {
    const amount = draft.price === undefined ? undefined : normalizeAmount(draft.price);
    if (amount === undefined) {
      return refuse('no valid price');
    }
    price = amount;
    visibility = draft.visibility ?? 'on-sale';
    sku = draft.sku;
  }

  // (7) extra tags and images cut.
  const images = draft.images.filter((image) => isHttpsUrl(image));
  const keptImages = uniqueStrings(images).slice(0, LIMITS.MAX_IMAGES);
  if (keptImages.length < draft.images.length) {
    fitting.truncated = true;
  }
  const topics = uniqueStrings(
    draft.topics
      .map((topic) => clipped(topic.trim(), LIMITS.TOPIC_CHARS, fitting))
      .filter((topic) => topic !== ''),
  );
  if (topics.length > LIMITS.MAX_TOPICS) {
    fitting.truncated = true;
  }
  const listing: CatalogItemInput = {
    d: connectorD(draft.platform, draft.sourceId),
    title: clipped(title, LIMITS.TAG_VALUE_CHARS, fitting),
    description: clipped(draft.description, LIMITS.DESCRIPTION_CHARS, fitting),
    price: { amount: price, currency: draft.currency },
    images: keptImages,
    topics: topics.slice(0, LIMITS.MAX_TOPICS),
    attrs: fitAttrs(draft.attrs, fitting),
    options,
    variants,
    visibility,
  };
  const summary = draft.summary?.trim();
  if (summary) {
    listing.summary = clipped(summary, LIMITS.TAG_VALUE_CHARS, fitting);
  }
  if (draft.url !== undefined) {
    if (isHttpsUrl(draft.url)) {
      listing.url = draft.url;
    } else {
      fitting.truncated = true;
    }
  }
  const keptSku = wholeOrNothing(sku, fitting);
  if (keptSku !== undefined) {
    listing.sku = keptSku;
  }
  const sourceId = wholeOrNothing(draft.sourceId, fitting);
  if (sourceId !== undefined) {
    listing.sourceId = sourceId;
  }
  const checked = CatalogItemInputSchema.safeParse(listing);
  if (!checked.success) {
    return refuse(`does not fit the listing format: ${checked.error.issues[0]?.message ?? ''}`);
  }
  return { ok: true, listing, truncated: fitting.truncated };
}
