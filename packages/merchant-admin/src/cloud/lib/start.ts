/** A tier id as the catalog writes them; whether it may be started is the catalog's answer. */
const TIER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The tier id a `/start` link chose, or undefined (another path, or not a tier id). */
export function startTierOf(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.pathname !== '/start') {
    return undefined;
  }
  const tier = parsed.searchParams.get('tier');
  return tier !== null && TIER_ID.test(tier) ? tier : undefined;
}

/** How a Stripe Checkout came back, for which store (its URLs are `/tenants/<id>?checkout=`). */
export interface CheckoutReturn {
  tenantId: string;
  outcome: 'done' | 'cancelled';
}

const STORE_PATH = /^\/tenants\/([a-z0-9]{12})$/;

/** The Checkout return the console was opened at, or undefined. */
export function checkoutReturnOf(url: string): CheckoutReturn | undefined {
  const parsed = new URL(url);
  const tenantId = STORE_PATH.exec(parsed.pathname)?.[1];
  const outcome = parsed.searchParams.get('checkout');
  if (tenantId === undefined || (outcome !== 'done' && outcome !== 'cancelled')) {
    return undefined;
  }
  return { tenantId, outcome };
}
