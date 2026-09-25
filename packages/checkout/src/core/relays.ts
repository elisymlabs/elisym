import { isPublicHostname } from '@elisym/commerce';
import { DEFAULT_RELAYS, MAX_RELAY_URL_LENGTH, STORE_RELAY_CAP } from './constants';

/**
 * A store-named relay URL the widget may connect to, in one spelling, or
 * `undefined`. Only `wss:` on a public DNS name: the URL comes from the store
 * (its inbox list) or the page (naddr hints), so a loopback, private or IP
 * literal host - or plain `ws:` - is never contacted.
 */
export function normalizeRelayUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RELAY_URL_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'wss:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !isPublicHostname(url.hostname)
  ) {
    return undefined;
  }
  // Repeated slashes are one relay to the pool, so they are one relay here.
  const path = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '');
  return `wss://${url.host}${path}`;
}

/** Each usable URL once, in the order given. */
export function uniqueRelays(values: readonly unknown[]): string[] {
  const relays: string[] = [];
  for (const value of values) {
    const relay = normalizeRelayUrl(value);
    if (relay !== undefined && !relays.includes(relay)) {
      relays.push(relay);
    }
  }
  return relays;
}

export interface StoreRelaySources {
  /** The relays of the store's current inbox list (kind 10050): where it reads and replies. */
  inbox?: readonly unknown[];
  /** Older inbox relays that acknowledged this order: kept for republishing only. */
  acknowledged?: readonly unknown[];
  /** Relay hints from the product naddr. */
  hints?: readonly unknown[];
}

/**
 * The store-named relays, capped at `STORE_RELAY_CAP` in a fixed priority: the
 * current inbox first (the widget listens there), then old relays that
 * acknowledged the order, then naddr hints - so a page's hints can never crowd
 * out the store's inbox.
 */
export function storeRelays(sources: StoreRelaySources): string[] {
  return uniqueRelays([
    ...(sources.inbox ?? []),
    ...(sources.acknowledged ?? []),
    ...(sources.hints ?? []),
  ]).slice(0, STORE_RELAY_CAP);
}

/**
 * Where the offer and the store's inbox list are read: the default relays,
 * always and outside the cap, plus the capped store-named ones.
 */
export function readRelays(sources: StoreRelaySources): string[] {
  const named = storeRelays(sources);
  return [...DEFAULT_RELAYS, ...named.filter((relay) => !DEFAULT_RELAYS.includes(relay))];
}
