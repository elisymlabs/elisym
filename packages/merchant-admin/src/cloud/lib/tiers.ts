/**
 * The tier catalog as cloud-api serves it (`GET /tiers`): names, prices and
 * limits are data the admin reads, never ids it knows (plan
 * `cloud-pricing-and-onboarding.md` 2.1). The catalog is public: it is read
 * with no auth, before any key exists (plan `admin-onboarding.md` 2.2).
 */
import { type ApiAnswer, type Fetcher, UNREACHABLE } from './api';
import { fieldOf } from './fields';

/** One tier as the plan picker shows it. */
export interface TierCard {
  id: string;
  name: string;
  /** A display string ("$29/mo"). */
  price: string;
  /** Started by the merchant here; otherwise "talk to us". */
  selfServe: boolean;
  limits: { products: number; ordersPerMonth?: number };
  /** Strings shown instead of a limit's number ("No cap"). */
  display: { products?: string; ordersPerMonth?: string };
  /** The merchant may set their own RPC per network. */
  ownRpc: boolean;
  /** How the first month can be paid now: by card, in stablecoins. */
  payable: { card: boolean; crypto: boolean };
}

/** A malformed field: the whole catalog is refused. */
class Malformed extends Error {}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Malformed();
  }
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Malformed();
  }
  return value;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Malformed();
  }
  return value;
}

function optionalCount(value: unknown): number | undefined {
  return value === undefined ? undefined : count(value);
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Malformed();
  }
  return { ...value };
}

function tierOf(value: unknown): TierCard {
  const limits = record(fieldOf(value, 'limits'));
  const display = record(fieldOf(value, 'display'));
  const payable = record(fieldOf(value, 'payable'));
  const ordersPerMonth = optionalCount(limits.ordersPerMonth);
  const shownProducts = optionalText(display.products);
  const shownOrders = optionalText(display.ordersPerMonth);
  return {
    id: text(fieldOf(value, 'id')),
    name: text(fieldOf(value, 'name')),
    price: text(fieldOf(value, 'price')),
    selfServe: flag(fieldOf(value, 'selfServe')),
    limits: {
      products: count(limits.products),
      ...(ordersPerMonth === undefined ? {} : { ordersPerMonth }),
    },
    display: {
      ...(shownProducts === undefined ? {} : { products: shownProducts }),
      ...(shownOrders === undefined ? {} : { ordersPerMonth: shownOrders }),
    },
    ownRpc: flag(fieldOf(value, 'ownRpc')),
    payable: { card: flag(payable.card), crypto: flag(payable.crypto) },
  };
}

/** The tiers of a `GET /tiers` body, or undefined when it is not a catalog or any tier is malformed. */
export function tierCardsFrom(body: unknown): TierCard[] | undefined {
  const tiers = fieldOf(body, 'tiers');
  if (!Array.isArray(tiers)) {
    return undefined;
  }
  try {
    return tiers.map(tierOf);
  } catch (error) {
    if (error instanceof Malformed) {
      return undefined;
    }
    throw error;
  }
}

/** A tier a merchant can start here: self-serve, and payable some way now. */
export function canStart(tier: TierCard): boolean {
  return tier.selfServe && (tier.payable.card || tier.payable.crypto);
}

/** How a tier's first month can be paid, in words; undefined when no way is open. */
export function paidBy(payable: TierCard['payable']): string | undefined {
  if (payable.card && payable.crypto) {
    return 'Pay by card or in stablecoins';
  }
  if (payable.card) {
    return 'Pay by card';
  }
  return payable.crypto ? 'Pay in stablecoins' : undefined;
}

/** The catalog, read with no auth (cloud-api serves it before a key exists); never a throw. */
export async function fetchTiers(apiOrigin: string, fetcher?: Fetcher): Promise<ApiAnswer> {
  const origin = new URL(apiOrigin).origin;
  const send: Fetcher = fetcher ?? ((request) => fetch(request));
  try {
    // Never from the browser cache, as every cloud-api request.
    const response = await send(new Request(`${origin}/tiers`, { cache: 'no-store' }));
    const received = await response.text();
    let body: unknown = received;
    try {
      body = JSON.parse(received);
    } catch {
      // Not JSON: kept as text.
    }
    return { status: response.status, body };
  } catch {
    return UNREACHABLE;
  }
}
