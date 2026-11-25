import { ASKR_RELAYS, isLauncherText } from '@elisym/askr';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { STORE_CHECK_PREFIX, STORE_CHECK_TTL_MS } from './constants';
import type { Gateway } from './gateway';
import { type RelayConnect, type RelayConnection, queryHistory } from './relay';
import { type KeyValueStorage, readItem, writeItem } from './storage';
import { readStoreConfig, readStoreEvents } from './store-data';

/**
 * Whether the widget shows on the page: `hide` only for a store the Askr service does not serve
 * (pending, never set up): no launcher and no panel. Anything uncertain shows it.
 */
export type StoreVisibility = 'show' | 'hide';

/** The check's answer: whether to show, and the store's own launcher text when it set one. */
export interface StoreCheck {
  visibility: StoreVisibility;
  launcherText?: string | undefined;
}

export interface StoreCheckDeps {
  connect: RelayConnect;
  gateway: Gateway;
  /** sessionStorage: a decision is kept for a while, so each page view does not read again. */
  storage?: KeyValueStorage | undefined;
  /** Unix milliseconds. */
  now?: () => number;
}

/**
 * A kept launcher text, checked again as the parser checks it: `undefined` for a part that
 * does not decode or that the parser would not accept.
 */
function decodedLauncherText(encoded: string): string | undefined {
  let text: string;
  try {
    text = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  return isLauncherText(text) ? text : undefined;
}

/**
 * A kept decision: `<visibility>:<ms>`, and for `show` an optional third part, the store's
 * launcher text URI-encoded. Older builds read only the first two parts, so they share the key.
 */
function cached(
  storage: KeyValueStorage | undefined,
  owner: string,
  now: number,
): StoreCheck | undefined {
  const raw = readItem(storage, `${STORE_CHECK_PREFIX}${owner}`);
  const parts = raw?.split(':') ?? [];
  const [visibility, at, encodedText] = parts;
  if (
    parts.length > 3 ||
    (visibility !== 'show' && visibility !== 'hide') ||
    !/^\d{1,15}$/.test(at ?? '')
  ) {
    return undefined;
  }
  const age = now - Number(at);
  if (age < 0 || age >= STORE_CHECK_TTL_MS) {
    return undefined;
  }
  if (encodedText === undefined) {
    return { visibility };
  }
  const launcherText = visibility === 'show' ? decodedLauncherText(encodedText) : undefined;
  return launcherText === undefined ? undefined : { visibility, launcherText };
}

function cacheEntryOf(check: StoreCheck, now: number): string {
  const decision = `${check.visibility}:${now}`;
  return check.launcherText === undefined
    ? decision
    : `${decision}:${encodeURIComponent(check.launcherText)}`;
}

/** The decision, and whether it is certain enough to keep. */
async function decide(
  owner: string,
  deps: StoreCheckDeps,
  now: number,
): Promise<StoreCheck & { certain: boolean }> {
  let connection: RelayConnection;
  try {
    connection = await deps.connect(ASKR_RELAYS[0] ?? '');
  } catch {
    return { visibility: 'show', certain: false };
  }
  try {
    const nowSecs = Math.floor(now / 1000);
    const events = await readStoreEvents(
      owner,
      (filters) => queryHistory(connection, filters),
      nowSecs,
    );
    // A store's settings reach the relay only once it is active: this store has been served.
    const config = readStoreConfig(events, owner, nowSecs);
    if (config !== undefined) {
      return { visibility: 'show', launcherText: config.launcherText, certain: true };
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
const IN_FLIGHT = new Map<string, Promise<StoreCheck>>();

async function freshCheck(owner: string, deps: StoreCheckDeps): Promise<StoreCheck> {
  const now = deps.now?.() ?? Date.now();
  const kept = cached(deps.storage, owner, now);
  if (kept !== undefined) {
    return kept;
  }
  const { certain, ...check } = await decide(owner, deps, now);
  if (certain) {
    writeItem(deps.storage, `${STORE_CHECK_PREFIX}${owner}`, cacheEntryOf(check, now));
  }
  return check;
}

/**
 * Whether to show the widget for `owner` (B): read before the launcher appears, from the
 * store's config on the Askr relay and, when it has none, the gateway. A relay or gateway
 * failure shows it, so a transient error never hides a live store. A check already running
 * for the store is shared, not started again. A shown store's own launcher text comes with the
 * answer, so the launcher never shows the default text first.
 */
export function checkStore(owner: string, deps: StoreCheckDeps): Promise<StoreCheck> {
  const running = IN_FLIGHT.get(owner);
  if (running !== undefined) {
    return running;
  }
  const check = freshCheck(owner, deps).finally(() => IN_FLIGHT.delete(owner));
  IN_FLIGHT.set(owner, check);
  return check;
}
