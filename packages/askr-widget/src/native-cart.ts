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

/** At most 15 digits: always below 2^53, so `Number` in the Shopify body keeps it exact. */
const VARIANT_ID_RE = /^\d{1,15}$/;
const HTTP_STATUS_OK_MIN = 200;
const HTTP_STATUS_REDIRECT_MAX = 399;

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Native add-to-cart applies only on a Shopify or WooCommerce connector store
 * whose config names the connected shop (`source` shop URL), and only when the
 * widget runs on that shop's own origin, since the cart lives in that domain's
 * session (7.4). Any other configured origin (a blog, a second domain) gets none.
 */
export function nativeCartPlatform(
  config: Pick<StoreConfig, 'source'>,
  pageOrigin: string | undefined,
): NativeCartPlatform | undefined {
  const { kind, platform, shopUrl } = config.source;
  if (kind !== 'connector' || pageOrigin === undefined || shopUrl === undefined) {
    return undefined;
  }
  if (originOf(shopUrl) !== pageOrigin) {
    return undefined;
  }
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

/** Shopify's cart lives at the shop origin, whatever path the shop URL has. */
function shopifyRequest(shopUrl: string, variantId: string): [string, RequestInit] {
  return [
    `${originOf(shopUrl) ?? shopUrl}/cart/add.js`,
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
function wooRequest(shopUrl: string, variantId: string): [string, RequestInit] {
  // A Woo shop may live under a path (`https://host/shop`): its front end answers there.
  return [`${shopUrl}/?add-to-cart=${variantId}`, { method: 'GET', credentials: 'same-origin' }];
}

function succeeded(platform: NativeCartPlatform, response: Response): boolean {
  if (platform === 'shopify') {
    return response.ok;
  }
  return response.status >= HTTP_STATUS_OK_MIN && response.status <= HTTP_STATUS_REDIRECT_MAX;
}

/**
 * Add one unit of a determined variant to the host store's cart, at the shop
 * URL the config names (no trailing slash). Resolves `false` on any refusal,
 * network error or timeout; the caller then shows the product page link.
 */
export async function nativeAddToCart(
  platform: NativeCartPlatform,
  shopUrl: string,
  variant: Pick<CatalogVariant, 'id' | 'values'>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const variantId = nativeCartVariantId(variant);
  if (variantId === undefined) {
    return false;
  }
  const [url, init] =
    platform === 'shopify' ? shopifyRequest(shopUrl, variantId) : wooRequest(shopUrl, variantId);
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
