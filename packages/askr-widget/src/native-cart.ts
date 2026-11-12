import {
  ANY_OPTION_VALUE,
  type CatalogVariant,
  type ConnectorPlatform,
  type StoreConfig,
} from '@elisym/askr';

/** The connector platforms whose storefront takes a cart add from the page itself (7.4). */
export type NativeCartPlatform = Extract<ConnectorPlatform, 'shopify' | 'woocommerce'>;

/** A cart add that has not answered within this long counts as failed. */
export const NATIVE_CART_TIMEOUT_MS = 15_000;

const VARIANT_ID_RE = /^\d+$/;
const HTTP_STATUS_OK_MIN = 200;
const HTTP_STATUS_REDIRECT_MAX = 399;

/**
 * Native add-to-cart applies only on a Shopify or WooCommerce connector store,
 * and only when the widget runs on the connected domain (one of the config's
 * `origin` entries), since the cart lives in that domain's session (7.4).
 */
export function nativeCartPlatform(
  config: Pick<StoreConfig, 'source' | 'origins'>,
  pageOrigin: string | undefined,
): NativeCartPlatform | undefined {
  if (config.source.kind !== 'connector' || pageOrigin === undefined) {
    return undefined;
  }
  if (!config.origins.includes(pageOrigin)) {
    return undefined;
  }
  const platform = config.source.platform;
  return platform === 'shopify' || platform === 'woocommerce' ? platform : undefined;
}

/**
 * The platform's numeric variant id, or none: a `*` variant (a Woo "Any"
 * variation needs attribute values the cart URL cannot carry) or a non-numeric
 * id never reaches the cart endpoints.
 */
export function nativeCartVariantId(
  variant: Pick<CatalogVariant, 'id' | 'values'>,
): string | undefined {
  if (variant.values.includes(ANY_OPTION_VALUE)) {
    return undefined;
  }
  return VARIANT_ID_RE.test(variant.id) ? variant.id : undefined;
}

function shopifyRequest(origin: string, variantId: string): [string, RequestInit] {
  return [
    `${origin}/cart/add.js`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: Number(variantId), quantity: 1 }] }),
    },
  ];
}

/**
 * WooCommerce adds `?add-to-cart={id}` to the session cart on any front-end
 * request, so a background GET keeps the visitor on the page instead of
 * navigating away. Trade-off: Woo answers 2xx/3xx even when it refused the add
 * (it queues a notice for the next page view instead), so success here means
 * the request went through, not that the cart surely holds the item.
 */
function wooRequest(origin: string, variantId: string): [string, RequestInit] {
  return [`${origin}/?add-to-cart=${variantId}`, { method: 'GET', credentials: 'same-origin' }];
}

function succeeded(platform: NativeCartPlatform, response: Response): boolean {
  if (platform === 'shopify') {
    return response.ok;
  }
  return response.status >= HTTP_STATUS_OK_MIN && response.status <= HTTP_STATUS_REDIRECT_MAX;
}

/**
 * Add one unit of a determined variant to the host store's cart. Resolves
 * `false` on any refusal, network error or timeout; the caller then hands off
 * to the product page.
 */
export async function nativeAddToCart(
  platform: NativeCartPlatform,
  origin: string,
  variant: Pick<CatalogVariant, 'id' | 'values'>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const variantId = nativeCartVariantId(variant);
  if (variantId === undefined) {
    return false;
  }
  const [url, init] =
    platform === 'shopify' ? shopifyRequest(origin, variantId) : wooRequest(origin, variantId);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(NATIVE_CART_TIMEOUT_MS),
    });
    return succeeded(platform, response);
  } catch {
    return false;
  }
}
