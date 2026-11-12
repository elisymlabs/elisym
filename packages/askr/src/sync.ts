import {
  KIND_DELETION,
  NO_FUTURE_LIMIT,
  isEventShaped,
  isGenuineEvent,
  newestSigned,
  nowSecs,
  tagValue,
  tagValues,
} from '@elisym/commerce';
import type { EventTemplate, Filter, NostrEvent } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { ASKR_RELAYS, KIND_CATALOG_AUTH, KIND_POLICY } from './constants';
import { hasRole } from './events/catalog-auth';
import {
  type CatalogItemInput,
  CatalogItemInputSchema,
  buildCatalogItemEvent,
  catalogAddress,
} from './events/catalog-item';
import { type PolicyInput, PolicyInputSchema, buildPolicyEvent } from './events/policy';

const KIND_PRODUCT = 30402;
/** Default publishing pace, well under the shared relay's server-wide cap. */
export const DEFAULT_SYNC_EVENTS_PER_SEC = 10;

/** The relay access `syncCatalog` needs; the SDK's pool or a test double. */
export interface SyncRelayClient {
  /**
   * Every matching event, paged as needed: a result truncated by a relay's
   * limit would make the sync re-create existing listings and miss stale ones.
   */
  query(relays: readonly string[], filter: Filter): Promise<NostrEvent[]>;
  publish(relays: readonly string[], event: NostrEvent): Promise<void>;
}

export interface SyncCatalogOptions {
  /** The catalog key K: must be 30497-authorized by `store` (never a Pay Core S). */
  signer: Uint8Array;
  /** The store owner O. */
  store: string;
  items: readonly CatalogItemInput[];
  /**
   * `replace` (default): `items` is the whole catalog, and K's listings missing
   * from it are hidden. `upsert`: only `items` and the listings named in `hide`
   * are touched, every other listing of K stays as it is.
   */
  mode?: 'replace' | 'upsert';
  /** `upsert` only: `d`s of K's listings to hide (one not listed is skipped). */
  hide?: readonly string[];
  client: SyncRelayClient;
  dryRun?: boolean;
  /** Events per second while publishing. */
  pace?: number;
  now?: number;
  /** The clock events are dated by as they are published (default: `now` if given, else the time). */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncDiff {
  created: string[];
  updated: string[];
  hidden: string[];
  unchanged: string[];
}

/** Tags and content are the listing; `created_at` is not, so an unchanged item is not republished. */
function sameListing(left: Pick<EventTemplate, 'tags' | 'content'>, right: NostrEvent): boolean {
  return left.content === right.content && JSON.stringify(left.tags) === JSON.stringify(right.tags);
}

/**
 * Events dated in one second at most: a reader pages back in time with an
 * inclusive `until`, so a second holding a whole page (500) could never be
 * stepped past and the catalog would never read whole again.
 */
export const MAX_EVENTS_PER_SECOND = 100;

/** Addresses per deletion query: keeps each REQ well under a relay's message size limit. */
const DELETION_ADDRESSES_PER_QUERY = 100;

const PUBLISH_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;

async function publishWithRetry(
  client: SyncRelayClient,
  relays: readonly string[],
  event: NostrEvent,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.publish(relays, event);
      return;
    } catch (error) {
      if (attempt >= PUBLISH_ATTEMPTS) {
        throw error;
      }
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Refuse unless the owner currently authorizes `key` as a catalog key (30497). */
async function requireCatalogKey(
  client: SyncRelayClient,
  store: string,
  key: string,
  now: number,
): Promise<void> {
  const authorityEvents = (
    await client.query(ASKR_RELAYS, {
      kinds: [KIND_CATALOG_AUTH, KIND_DELETION],
      authors: [store],
    })
  ).filter((event) => isEventShaped(event));
  if (!hasRole(authorityEvents, store, key, 'catalog', now)) {
    throw new Error('This key is not authorized as a catalog key by the store owner');
  }
}

interface OwnAddresses {
  /** Well-shaped, genuinely signed events by `key` only. */
  ownEvents: NostrEvent[];
  /** Latest version of each `d` actually on the relay, however far ahead its clock was. */
  latestAt: Map<string, number>;
  /** Latest NIP-09 deletion of each `d`, from the kind 5s themselves. */
  deletedAt: Map<string, number>;
}

/**
 * `key`'s addressable events of `kind` and its deletions, cleaned: a forged,
 * foreign or malformed relay entry must neither crash a sync nor steer its
 * dating or its deletions. A NIP-09 relay may keep nothing of a deleted address
 * but the deletion, so deletions are read straight from the kind 5s, and only
 * those of the addresses in play (the listed ones and `touched`): the kind 5s
 * of a long-running store only grow, and a read that must be whole could
 * otherwise outgrow the reader's cap.
 */
async function readOwnAddresses(
  client: SyncRelayClient,
  key: string,
  kind: number,
  touched: Iterable<string>,
): Promise<OwnAddresses> {
  const isOwn = (event: NostrEvent) =>
    isEventShaped(event) && event.pubkey === key && isGenuineEvent(event);
  const listings = (await client.query(ASKR_RELAYS, { kinds: [kind], authors: [key] })).filter(
    isOwn,
  );
  const ds = new Set(touched);
  for (const event of listings) {
    const d = tagValue(event.tags, 'd');
    if (d !== undefined) {
      ds.add(d);
    }
  }
  const addressList = [...ds].map((d) => `${kind}:${key}:${d}`);
  const deletions: NostrEvent[] = [];
  for (let start = 0; start < addressList.length; start += DELETION_ADDRESSES_PER_QUERY) {
    const chunk = addressList.slice(start, start + DELETION_ADDRESSES_PER_QUERY);
    deletions.push(
      ...(
        await client.query(ASKR_RELAYS, { kinds: [KIND_DELETION], authors: [key], '#a': chunk })
      ).filter(isOwn),
    );
  }
  const ownEvents = [...listings, ...deletions];
  const addressPrefix = `${kind}:${key}:`;
  const deletedAt = new Map<string, number>();
  const latestAt = new Map<string, number>();
  for (const event of ownEvents) {
    if (event.kind === KIND_DELETION) {
      for (const address of tagValues(event.tags, 'a')) {
        if (address.startsWith(addressPrefix)) {
          const d = address.slice(addressPrefix.length);
          deletedAt.set(d, Math.max(deletedAt.get(d) ?? -1, event.created_at));
        }
      }
      continue;
    }
    const d = tagValue(event.tags, 'd');
    if (event.kind === kind && d !== undefined) {
      latestAt.set(d, Math.max(latestAt.get(d) ?? -1, event.created_at));
    }
  }
  return { ownEvents, latestAt, deletedAt };
}

/** A date after every version and every deletion of `d`: a tie loses to the lower id (NIP-01). */
function floorFor(addresses: OwnAddresses, d: string, now: number): number {
  return Math.max(
    now,
    (addresses.latestAt.get(d) ?? -1) + 1,
    (addresses.deletedAt.get(d) ?? -1) + 1,
  );
}

/**
 * Bring K's listings on the relay in line with `items` (7.1): publish new and
 * changed ones, hide (and NIP-09 delete) K's own listings no longer in
 * `items`. Never touches another author. Refuses to run unless O currently
 * authorizes K as a catalog key.
 */
export async function syncCatalog(options: SyncCatalogOptions): Promise<SyncDiff> {
  const now = options.now ?? nowSecs();
  const key = getPublicKey(options.signer);
  const relays = ASKR_RELAYS;
  const upsert = options.mode === 'upsert';
  if (!upsert && options.hide !== undefined) {
    throw new Error('hide is for the upsert mode: a replace hides every listing not in items');
  }

  const inputs = new Map<string, CatalogItemInput>();
  for (const input of options.items) {
    const { d } = CatalogItemInputSchema.parse(input);
    if (inputs.has(d)) {
      throw new Error(`Duplicate item d: ${d}`);
    }
    inputs.set(d, input);
  }
  const toHide = new Set(options.hide ?? []);
  for (const d of toHide) {
    if (inputs.has(d)) {
      throw new Error(`An item to publish cannot also be hidden: ${d}`);
    }
  }
  await requireCatalogKey(options.client, options.store, key, now);

  const { ownEvents, latestAt, deletedAt } = await readOwnAddresses(
    options.client,
    key,
    KIND_PRODUCT,
    [...inputs.keys(), ...toHide],
  );
  const current = new Map<string, NostrEvent>();
  for (const d of latestAt.keys()) {
    // Our own listings, however far ahead a clock dated them: a reader will see
    // such a version once real time catches up, so it is replaced or hidden now.
    const newest = newestSigned(ownEvents, KIND_PRODUCT, key, NO_FUTURE_LIMIT, d);
    const lastDeletion = deletedAt.get(d);
    if (newest && (lastDeletion === undefined || lastDeletion < newest.created_at)) {
      current.set(d, newest);
    }
  }
  const addresses = { ownEvents, latestAt, deletedAt };

  const diff: SyncDiff = { created: [], updated: [], hidden: [], unchanged: [] };
  /** Each event with the `d` it is about: dating keeps one product's events in order. */
  const toPublish: { d: string; template: EventTemplate }[] = [];
  for (const [d, input] of inputs) {
    const listed = current.get(d);
    // Dated after every version on the relay and after any deletion of the address:
    // a tie loses to the lower id (NIP-01), and a deletion removes all up to its date.
    const createdAt = floorFor(addresses, d, now);
    const template = buildCatalogItemEvent({ ...input, createdAt });
    if (!listed) {
      diff.created.push(d);
      toPublish.push({ d, template });
    } else if (sameListing(template, listed)) {
      diff.unchanged.push(d);
    } else {
      diff.updated.push(d);
      toPublish.push({ d, template });
    }
  }
  const deletionOf = (d: string, at: number): EventTemplate => ({
    kind: KIND_DELETION,
    created_at: at,
    tags: [
      ['a', catalogAddress(key, d)],
      ['k', String(KIND_PRODUCT)],
    ],
    content: '',
  });
  for (const [d, listed] of current) {
    if (inputs.has(d) || (upsert && !toHide.has(d))) {
      continue;
    }
    diff.hidden.push(d);
    // Both dated at or after the listing they replace, so neither loses to it.
    const hiddenAt = floorFor(addresses, d, now);
    if (tagValue(listed.tags, 'visibility') !== 'hidden') {
      toPublish.push({
        d,
        template: {
          kind: KIND_PRODUCT,
          created_at: hiddenAt,
          tags: listed.tags
            .filter((tag) => tag[0] !== 'visibility')
            .concat([['visibility', 'hidden']]),
          content: listed.content,
        },
      });
    }
    // Also when only the hidden version made it last time: the deletion is retried.
    toPublish.push({ d, template: deletionOf(d, hiddenAt) });
  }

  const pace = options.pace ?? DEFAULT_SYNC_EVENTS_PER_SEC;
  if (!(pace > 0)) {
    throw new Error('pace must be positive');
  }
  if (options.dryRun) {
    return diff;
  }
  const sleep = options.sleep ?? defaultSleep;
  const clock = options.clock ?? (options.now === undefined ? nowSecs : () => now);
  const gapMs = Math.ceil(1000 / pace);
  // Each event is dated as it goes out: never before its floor, never before
  // an earlier event about the same product (a deletion stays at or after the
  // hidden version it follows), and never in a second that already holds
  // MAX_EVENTS_PER_SECOND events. One product's date never moves another's.
  const lastAtOf = new Map<string, number>();
  const countAt = new Map<number, number>();
  for (const [index, { d, template }] of toPublish.entries()) {
    if (index > 0) {
      await sleep(gapMs);
    }
    let createdAt = Math.max(template.created_at, clock(), lastAtOf.get(d) ?? -1);
    while ((countAt.get(createdAt) ?? 0) >= MAX_EVENTS_PER_SECOND) {
      createdAt += 1;
    }
    countAt.set(createdAt, (countAt.get(createdAt) ?? 0) + 1);
    lastAtOf.set(d, createdAt);
    const event = finalizeEvent({ ...template, created_at: createdAt }, options.signer);
    await publishWithRetry(options.client, relays, event, sleep);
  }
  return diff;
}

export interface PolicyWriteOptions {
  /** The store's policy key: must be 30497-authorized by `store`. */
  signer: Uint8Array;
  store: string;
  client: SyncRelayClient;
  now?: number;
}

/** Publish (or replace) a policy, dated after every version and deletion of its slug. */
export async function setPolicy(
  options: PolicyWriteOptions & { policy: PolicyInput },
): Promise<NostrEvent> {
  const now = options.now ?? nowSecs();
  const key = getPublicKey(options.signer);
  await requireCatalogKey(options.client, options.store, key, now);
  const { slug } = PolicyInputSchema.parse(options.policy);
  const addresses = await readOwnAddresses(options.client, key, KIND_POLICY, [slug]);
  const event = finalizeEvent(
    buildPolicyEvent({ ...options.policy, createdAt: floorFor(addresses, slug, now) }),
    options.signer,
  );
  await publishWithRetry(options.client, ASKR_RELAYS, event, defaultSleep);
  return event;
}

/** Delete a policy (NIP-09 on its address), dated at or after its latest version. */
export async function removePolicy(
  options: PolicyWriteOptions & { slug: string },
): Promise<NostrEvent> {
  const now = options.now ?? nowSecs();
  const key = getPublicKey(options.signer);
  await requireCatalogKey(options.client, options.store, key, now);
  const addresses = await readOwnAddresses(options.client, key, KIND_POLICY, [options.slug]);
  const event = finalizeEvent(
    {
      kind: KIND_DELETION,
      created_at: floorFor(addresses, options.slug, now),
      tags: [
        ['a', `${KIND_POLICY}:${key}:${options.slug}`],
        ['k', String(KIND_POLICY)],
      ],
      content: '',
    },
    options.signer,
  );
  await publishWithRetry(options.client, ASKR_RELAYS, event, defaultSleep);
  return event;
}
