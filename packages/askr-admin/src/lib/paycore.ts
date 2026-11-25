import {
  HEX_PUBKEY_RE,
  KIND_DELETION,
  KIND_STORE_AUTH,
  isGenuineEvent,
  newestSigned,
  parseStoreProfile,
  resolveStoreAuth,
  tagValue,
} from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import type { RelayReader } from './relay';

/** Where a merchant sets up a PayCore store (hosted mode of the PayCore admin). */
export const PAYCORE_ONBOARDING_URL = 'https://admin.elisym.network/hosted/';

/** The pinned checkout v4 loader a PayCore store's pages add for Buy (`checkout/src/embed/v4.sri`). */
export const CHECKOUT_V4_SRC = 'https://pay.elisym.network/v4/embed.js';
export const CHECKOUT_V4_INTEGRITY =
  'sha384-x6dXYbL43ZTUT6tSX44pwUJazMDSiOULx6bsJD2JVk+eooivU9FcyYcvLD43LwWV';
/** The checkout's own origin: its loader and its frame. */
export const CHECKOUT_ORIGIN = 'https://pay.elisym.network';

/** The snippet a PayCore store adds beside the chat, so payable cards get a Buy button. */
export const CHECKOUT_V4_SNIPPET = [
  '<script',
  `  src="${CHECKOUT_V4_SRC}"`,
  `  integrity="${CHECKOUT_V4_INTEGRITY}"`,
  '  crossorigin="anonymous"',
  '></script>',
].join('\n');

const KIND_PROFILE = 0;

export type StoreAuthModeName = 'hosted' | 'self-host';

/**
 * A PayCore store key S the owner signed a 30490 for. `active`: the owner's
 * current word authorizes it (not revoked, expired or deleted); otherwise its
 * authorization is inactive. `mode`/`operator` come from the newest of its
 * 30490s that grants (so an inactive one still says how it was run); none when
 * every one on the relay revokes.
 */
export interface PayCoreStoreAuth {
  key: string;
  active: boolean;
  mode?: StoreAuthModeName;
  operator?: string;
  /** The newest 30490 for the key, unix seconds. */
  newestAt: number;
}

function grantOf(event: NostrEvent): { mode: StoreAuthModeName; operator?: string } | undefined {
  const modes = event.tags.filter((tag) => tag[0] === 'mode');
  const [tag] = modes;
  if (modes.length !== 1 || tag === undefined) {
    return undefined;
  }
  const [, mode, operator] = tag;
  if (mode !== 'hosted' && mode !== 'self-host') {
    return undefined;
  }
  return mode === 'hosted' && operator !== undefined ? { mode, operator } : { mode };
}

/**
 * Every store key the owner signed a 30490 for, among `events` (any mix of
 * kinds and authors: only the owner's genuine 30490s and kind 5s count),
 * newest first. A key with no 30490 left on the relay (a deletion the relay
 * honored) is not listed.
 */
export function payCoreStoresOf(
  events: readonly NostrEvent[],
  owner: string,
  now: number,
): PayCoreStoreAuth[] {
  const byKey = new Map<string, NostrEvent[]>();
  for (const event of events) {
    const key = tagValue(event.tags, 'd');
    if (
      event.kind !== KIND_STORE_AUTH ||
      event.pubkey !== owner ||
      key === undefined ||
      !HEX_PUBKEY_RE.test(key) ||
      !isGenuineEvent(event)
    ) {
      continue;
    }
    byKey.set(key, [...(byKey.get(key) ?? []), event]);
  }
  const stores: PayCoreStoreAuth[] = [];
  for (const [key, own] of byKey) {
    const resolved = resolveStoreAuth(events, owner, key, now);
    const newestAt = Math.max(...own.map((event) => event.created_at));
    const granting = [...own]
      .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id))
      .map((event) => grantOf(event))
      .find((grant) => grant !== undefined);
    const store: PayCoreStoreAuth = { key, active: resolved.status === 'active', newestAt };
    const grant = resolved.status === 'active' ? resolved : granting;
    if (grant !== undefined) {
      store.mode = grant.mode;
      if (grant.mode === 'hosted' && grant.operator !== undefined) {
        store.operator = grant.operator;
      }
    }
    stores.push(store);
  }
  return stores.sort(
    (left, right) => right.newestAt - left.newestAt || left.key.localeCompare(right.key),
  );
}

/** The store discovery offers: the newest with an active authorization. */
export function discoveredStore<Store extends PayCoreStoreAuth>(
  stores: readonly Store[],
): Store | undefined {
  return stores.find((store) => store.active);
}

interface SourceKeys {
  source: { kind: string };
  catalogKey: string;
  policyKey: string;
}

/**
 * Whether a config has a PayCore store's layout: a catalog source whose
 * products come from a key other than the server's, its policies from the
 * server's key.
 */
export function hasPayCoreLayout(config: SourceKeys, serverKey: string): boolean {
  return (
    config.source.kind === 'catalog' &&
    config.catalogKey !== serverKey &&
    config.policyKey === serverKey
  );
}

/**
 * What a read config is, given the owner's 30490s: a PayCore store when it
 * has a PayCore store's layout and the owner signed a 30490 for its product
 * key (active or not). Without any 30490 for it, it is a merchant catalog: a
 * self-host store key's 30497 reads the same as a merchant key's.
 */
export function detectPayCore(
  config: SourceKeys,
  serverKey: string,
  stores: readonly PayCoreStoreAuth[],
): PayCoreStoreAuth | undefined {
  return hasPayCoreLayout(config, serverKey)
    ? stores.find((store) => store.key === config.catalogKey)
    : undefined;
}

/** A discovered store with its name, from the store key's own kind 0. */
export interface PayCoreStoreView extends PayCoreStoreAuth {
  name?: string;
}

/** The store names, from each key's newest signed kind 0 on the relay. */
export async function readStoreNames(
  reader: RelayReader,
  keys: readonly string[],
  now: number,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (keys.length === 0) {
    return names;
  }
  const events = await reader.query({ kinds: [KIND_PROFILE], authors: [...keys] });
  for (const key of keys) {
    const newest = newestSigned(events, KIND_PROFILE, key, now);
    const name = newest === undefined ? undefined : parseStoreProfile(newest)?.name?.trim();
    if (name !== undefined && name !== '') {
      names.set(key, name);
    }
  }
  return names;
}

/** The owner's PayCore stores with their names, newest first. Names are best effort. */
export async function readPayCoreStores(
  reader: RelayReader,
  owner: string,
  now: number,
): Promise<PayCoreStoreView[]> {
  const events = await reader.query({ kinds: [KIND_STORE_AUTH, KIND_DELETION], authors: [owner] });
  const stores = payCoreStoresOf(events, owner, now);
  let names = new Map<string, string>();
  try {
    names = await readStoreNames(
      reader,
      stores.map((store) => store.key),
      now,
    );
  } catch {
    // A name is a label: the store is still offered by its npub.
  }
  return stores.map((store) => {
    const name = names.get(store.key);
    return name === undefined ? store : { ...store, name };
  });
}
