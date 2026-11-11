import {
  ANY_OPTION_VALUE,
  type CatalogItem,
  type CatalogOption,
  type CatalogVariant,
  type StoreConfig,
  determinedVariant,
} from '@elisym/comcore';

/** What the host's `window.ComCore.onAddToCart` hook receives (6). */
export interface AddToCartDetail {
  /** The listing's `d` exactly as published. */
  d: string;
  /** The merchant's SKU from `["attr", "sku", ...]`, when the listing has one. */
  sku?: string;
  /** The `variant` tag id, only when the pick determines one variant. */
  variant?: string;
  /** `{ [option name]: value }` whenever any selector is set. */
  options?: Record<string, string>;
}

export type AddToCartHook = (detail: AddToCartDetail) => unknown;

/** The visitor's selection: option name to the picked value. */
export type OptionPick = Readonly<Record<string, string>>;

type VariantFields = Readonly<Pick<CatalogItem, 'options' | 'variants'>>;

/**
 * The selectors a card shows: one per option, offering the values of that
 * option tag. A listing with exactly one variant and no `*` in it needs none
 * (this hides Shopify's "Default Title").
 */
export function selectorsFor(item: VariantFields): CatalogOption[] {
  const [only] = item.variants;
  if (item.variants.length === 1 && only && !only.values.includes(ANY_OPTION_VALUE)) {
    return [];
  }
  return item.options.filter((option) => option.values.length > 0);
}

/** The pick restricted to the card's selectors and the values they offer. */
function cleanPick(selectors: readonly CatalogOption[], pick: OptionPick): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const selector of selectors) {
    const value = pick[selector.name];
    if (value !== undefined && selector.values.includes(value)) {
      cleaned[selector.name] = value;
    }
  }
  return cleaned;
}

export interface PickState {
  selectors: CatalogOption[];
  /** Every selector is set (or there are none). */
  complete: boolean;
  /** The one variant the pick determines (never one with a `*`), or none. */
  variant?: CatalogVariant;
  /** The picked values, when any selector is set. */
  options?: Record<string, string>;
  /** The listing is `sold-out`, or the determined variant is unavailable. */
  soldOut: boolean;
}

export function pickState(
  item: VariantFields & Pick<CatalogItem, 'visibility'>,
  pick: OptionPick,
): PickState {
  const selectors = selectorsFor(item);
  const picked = cleanPick(selectors, pick);
  const complete = selectors.every((selector) => picked[selector.name] !== undefined);
  const variant = determinedVariant(item, picked);
  const state: PickState = {
    selectors,
    complete,
    soldOut: item.visibility === 'sold-out' || variant?.available === false,
  };
  if (variant) {
    state.variant = variant;
  }
  if (Object.keys(picked).length > 0) {
    state.options = picked;
  }
  return state;
}

/** The hook's argument for a card in a given pick state (6). */
export function addToCartDetail(
  item: Pick<CatalogItem, 'd' | 'sku'>,
  state: Pick<PickState, 'variant' | 'options'>,
): AddToCartDetail {
  const detail: AddToCartDetail = { d: item.d };
  if (item.sku !== undefined) {
    detail.sku = item.sku;
  }
  if (state.variant) {
    detail.variant = state.variant.id;
  }
  if (state.options) {
    detail.options = { ...state.options };
  }
  return detail;
}

/**
 * The host page's hook, read at click time (the host may set it after the
 * widget loaded): `window.ComCore.onAddToCart`, when it is a function.
 */
export function hostAddToCartHook(scope: object = globalThis): AddToCartHook | undefined {
  const namespace: unknown = Reflect.get(scope, 'ComCore');
  if (typeof namespace !== 'object' || namespace === null) {
    return undefined;
  }
  const hook: unknown = Reflect.get(namespace, 'onAddToCart');
  if (typeof hook !== 'function') {
    return undefined;
  }
  return (detail) => Reflect.apply(hook, namespace, [detail]);
}

/**
 * PHASE 3 STUB. Native add-to-cart on connector platforms (7.4: Shopify
 * `POST /cart/add.js`, Woo `?add-to-cart=`) needs the connected domain
 * verified first, which arrives with the connectors; until then no card offers
 * it, so the precedence below falls through to "no button".
 */
export function nativeAddToCartAvailable(
  _config: Pick<StoreConfig, 'source'>,
  _pageOrigin: string | undefined,
): boolean {
  return false;
}

/** PHASE 3 STUB: performs native add-to-cart for a determined variant; never called in phase 2. */
export function nativeAddToCartPhase3Stub(_variant: CatalogVariant): Promise<boolean> {
  return Promise.resolve(false);
}

export type CartButton =
  /** Sold out: a label instead of any add-to-cart button; the product-page link stays. */
  | { kind: 'sold-out' }
  /** The host's hook: enabled once every selector is set. */
  | { kind: 'hook'; enabled: boolean; detail: AddToCartDetail }
  /** Native add-to-cart once the pick determines a variant; until then it opens the product page. */
  | { kind: 'native'; variant?: CatalogVariant }
  | { kind: 'none' };

/**
 * The add-to-cart button, in order of precedence (6): the host's hook if it
 * set one, else native add-to-cart on connector platforms, else no button.
 */
export function cartButton(
  item: Pick<CatalogItem, 'd' | 'sku'>,
  state: PickState,
  environment: { hook: AddToCartHook | undefined; nativeAvailable: boolean },
): CartButton {
  if (state.soldOut) {
    return { kind: 'sold-out' };
  }
  if (environment.hook) {
    return { kind: 'hook', enabled: state.complete, detail: addToCartDetail(item, state) };
  }
  if (environment.nativeAvailable) {
    return state.variant ? { kind: 'native', variant: state.variant } : { kind: 'native' };
  }
  return { kind: 'none' };
}
