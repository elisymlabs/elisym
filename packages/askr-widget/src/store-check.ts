import { ASKR_RELAYS } from '@elisym/askr';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { STORE_CHECK_PREFIX, STORE_CHECK_TTL_MS } from './constants';
import type { Gateway } from './gateway';
import { type RelayConnect, type RelayConnection, queryHistory } from './relay';
import { type KeyValueStorage, readItem, writeItem } from './storage';
import { readStoreConfig, storeFilters } from './store-data';

/**
 * Whether the widget shows on the page: `hide` only for a store the Askr service does not serve
 * (pending, never set up): no launcher and no panel. Anything uncertain shows it.
 */
export type StoreVisibility = 'show' | 'hide';

export interface StoreCheckDeps {
  connect: RelayConnect;
  gateway: Gateway;
  /** sessionStorage: a decision is kept for a while, so each page view does not read again. */
  storage?: KeyValueStorage | undefined;
  /** Unix milliseconds. */
  now?: () => number;
}

function cached(
  storage: KeyValueStorage | undefined,
  owner: string,
  now: number,
): StoreVisibility | undefined {
  const raw = readItem(storage, `${STORE_CHECK_PREFIX}${owner}`);
  const [visibility, at] = raw?.split(':') ?? [];
  if ((visibility !== 'show' && visibility !== 'hide') || !/^\d{1,15}$/.test(at ?? '')) {
    return undefined;
  }
  const age = now - Number(at);
  return age >= 0 && age < STORE_CHECK_TTL_MS ? visibility : undefined;
}

/** The decision, and whether it is certain enough to keep. */
async function decide(
  owner: string,
  deps: StoreCheckDeps,
  now: number,
): Promise<{ visibility: StoreVisibility; certain: boolean }> {
  let connection: RelayConnection;
  try {
    connection = await deps.connect(ASKR_RELAYS[0] ?? '');
  } catch {
    return { visibility: 'show', certain: false };
  }
  try {
    const events = await queryHistory(connection, storeFilters(owner));
    // A store's settings reach the relay only once it is active: this store has been served.
    if (readStoreConfig(events, owner, Math.floor(now / 1000)) !== undefined) {
      return { visibility: 'show', certain: true };
    }
  } catch {
    return { visibility: 'show', certain: false };
  } finally {
    connection.close();
  }
  // No settings: a pending store, or one that moved to a new owner key (K21). Only the gateway
  // can tell, asked with a throwaway visitor key so nothing of the visitor's own session starts.
  const result = await deps.gateway.openSession(owner, getPublicKey(generateSecretKey()));
  if (result.kind === 'unavailable') {
    return { visibility: 'hide', certain: true };
  }
  return { visibility: 'show', certain: result.kind !== 'error' };
}

/** Checks still running, by store: several elements of one store on a page share one. */
const IN_FLIGHT = new Map<string, Promise<StoreVisibility>>();

async function freshCheck(owner: string, deps: StoreCheckDeps): Promise<StoreVisibility> {
  const now = deps.now?.() ?? Date.now();
  const kept = cached(deps.storage, owner, now);
  if (kept !== undefined) {
    return kept;
  }
  const { visibility, certain } = await decide(owner, deps, now);
  if (certain) {
    writeItem(deps.storage, `${STORE_CHECK_PREFIX}${owner}`, `${visibility}:${now}`);
  }
  return visibility;
}

/**
 * Whether to show the widget for `owner` (B): read before the launcher appears, from the
 * store's config on the Askr relay and, when it has none, the gateway. A relay or gateway
 * failure shows it, so a transient error never hides a live store. A check already running
 * for the store is shared, not started again.
 */
export function checkStore(owner: string, deps: StoreCheckDeps): Promise<StoreVisibility> {
  const running = IN_FLIGHT.get(owner);
  if (running !== undefined) {
    return running;
  }
  const check = freshCheck(owner, deps).finally(() => IN_FLIGHT.delete(owner));
  IN_FLIGHT.set(owner, check);
  return check;
}
