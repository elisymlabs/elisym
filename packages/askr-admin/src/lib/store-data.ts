import {
  D_TAG_RE,
  type CatalogItem,
  type CatalogItemInput,
  KIND_CATALOG_AUTH,
  KIND_POLICY,
  type Policy,
  type StoreConfig,
  configCandidates,
  delegateConfigFilters,
  parseCatalogItem,
  parsePolicy,
  readCatalogAuthority,
  readConfigDelegates,
  storeConfigFilters,
} from '@elisym/askr';
import {
  KIND_DELETION,
  KIND_PRODUCT,
  MAX_FUTURE_SKEW_SECS,
  newestDeletion,
} from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import type { RelayReader } from './relay';

function dOf(event: NostrEvent): string | undefined {
  return event.tags.find((tag) => tag[0] === 'd')?.[1];
}

/** Newer first; at the same second the lower id wins (NIP-01). */
function isNewer(candidate: NostrEvent, current: NostrEvent): boolean {
  return (
    candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id)
  );
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Signed events of `author` of `kind`, newest per `d`. An event dated further
 * ahead than clock skew explains is left out, so a future-dated one cannot
 * shadow the real newest.
 */
export function newestByD(
  events: readonly NostrEvent[],
  kind: number,
  author: string,
  now: number = nowSecs(),
): NostrEvent[] {
  const newest = new Map<string, NostrEvent>();
  for (const event of events) {
    const d = dOf(event);
    if (
      event.kind !== kind ||
      event.pubkey !== author ||
      d === undefined ||
      event.created_at > now + MAX_FUTURE_SKEW_SECS ||
      !verifyEvent(event)
    ) {
      continue;
    }
    const current = newest.get(d);
    if (current === undefined || isNewer(event, current)) {
      newest.set(d, event);
    }
  }
  return [...newest.values()];
}

/**
 * Whether a deletion by the author names the event's address at or after it,
 * read as the assistant's server reads it: the newest signed one, not dated
 * past the clock skew.
 */
function deleted(event: NostrEvent, deletions: readonly NostrEvent[], now: number): boolean {
  const address = `${event.kind}:${event.pubkey}:${dOf(event) ?? ''}`;
  const deletion = newestDeletion(deletions, address, event.pubkey, now);
  return deletion !== undefined && deletion.created_at >= event.created_at;
}

/**
 * The store's config as the relay holds it: none, the newest one, or a newest
 * one that does not parse (then the newest that does, if the relay kept one).
 * Candidates are the owner's configs and its active delegates' (1.3).
 */
export type ConfigRead =
  | { state: 'none' }
  | { state: 'ok'; config: StoreConfig; id: string }
  | {
      state: 'unreadable';
      newestAt: number;
      fallback: StoreConfig | undefined;
      /** The event `fallback` was read from. */
      fallbackId: string | undefined;
    };

export async function readConfig(
  reader: RelayReader,
  owner: string,
  now: number = nowSecs(),
): Promise<ConfigRead> {
  const events = await readConfigEvents(reader, owner, now);
  const [newest, ...older] = configCandidates(events, owner, { now, isGenuine: verifyEvent });
  if (newest === undefined) {
    return { state: 'none' };
  }
  if (newest.config !== undefined) {
    return { state: 'ok', config: newest.config, id: newest.event.id };
  }
  const fallback = older.find((candidate) => candidate.config !== undefined);
  return {
    state: 'unreadable',
    newestAt: newest.event.created_at,
    fallback: fallback?.config,
    fallbackId: fallback?.event.id,
  };
}

/**
 * The owner's configs, delegations and deletions, then its active delegates'
 * configs and deletions when it has any (1.3). The owner's deletions of its
 * own config are not applied here: the admin shows a deleted config, as it
 * always has.
 */
async function readConfigEvents(
  reader: RelayReader,
  owner: string,
  now: number,
): Promise<NostrEvent[]> {
  const ownerEvents = (
    await Promise.all(storeConfigFilters(owner).map((filter) => reader.query(filter)))
  ).flat();
  const delegates = readConfigDelegates(ownerEvents, owner, now);
  if (delegates.length === 0) {
    return ownerEvents;
  }
  const delegateEvents = (
    await Promise.all(delegateConfigFilters(delegates).map((filter) => reader.query(filter)))
  ).flat();
  return [...ownerEvents, ...delegateEvents];
}

export interface AuthorityRead {
  /** The catalog keys the owner authorizes now (1.2). */
  keys: Set<string>;
  /** The date of the newest 30497 per key: a new one for that key must be dated after it. */
  newestAt: Map<string, number>;
}

/** The owner's authorizations, signature checked (the shared reader does not check signatures). */
export async function readAuthority(
  reader: RelayReader,
  owner: string,
  now: number = nowSecs(),
): Promise<AuthorityRead> {
  const events = (
    await reader.query({
      kinds: [KIND_CATALOG_AUTH, KIND_DELETION],
      authors: [owner],
    })
  ).filter((event) => verifyEvent(event));
  const newestAt = new Map<string, number>();
  for (const event of newestByD(events, KIND_CATALOG_AUTH, owner, now)) {
    const key = dOf(event);
    if (key !== undefined) {
      newestAt.set(key, event.created_at);
    }
  }
  return { keys: readCatalogAuthority(events, owner, now), newestAt };
}

function isHidden(event: NostrEvent): boolean {
  return event.tags.some((tag) => tag[0] === 'visibility' && tag[1] === 'hidden');
}

/**
 * Every listing of a catalog key as the editor holds it, hidden ones included
 * (marked `hidden`), so a hidden product can be shown again. The reader drops
 * hidden listings, so a hidden one is read as on sale and marked back.
 */
export async function readListings(
  reader: RelayReader,
  key: string,
  now: number = nowSecs(),
): Promise<CatalogItemInput[]> {
  return (await readCatalog(reader, key, now)).listings;
}

/** The editor's listings and every product ID the key has, from one read of the relay. */
export async function readCatalog(
  reader: RelayReader,
  key: string,
  now: number = nowSecs(),
): Promise<{ listings: CatalogItemInput[]; ids: string[] }> {
  const events = await reader.query({ kinds: [KIND_PRODUCT, KIND_DELETION], authors: [key] });
  return { listings: listingsOf(events, key, now), ids: listedIdsOf(events, key, now) };
}

function listingsOf(events: readonly NostrEvent[], key: string, now: number): CatalogItemInput[] {
  const deletions = events.filter((event) => event.kind === KIND_DELETION);
  // A deleted listing is gone, not hidden: it must not come back, count or be re-created.
  return newestByD(events, KIND_PRODUCT, key, now)
    .filter((event) => !deleted(event, deletions, now))
    .flatMap((event) => {
      const hidden = isHidden(event);
      const readable = hidden
        ? {
            ...event,
            tags: event.tags.map((tag) =>
              tag[0] === 'visibility' ? ['visibility', 'on-sale'] : tag,
            ),
          }
        : event;
      const item = parseCatalogItem(readable, { now });
      return item === undefined ? [] : [inputOfListing(item, hidden)];
    });
}

/**
 * Every product ID the key lists on the relay: a valid `d` whose newest signed
 * version, however dated, is not deleted after it; also ones `listingsOf`
 * leaves out (unreadable, dated ahead). The server counts these same IDs
 * against the plan, so a publish removes the ones the draft does not hold, as
 * replacing the whole catalog did.
 */
function listedIdsOf(events: readonly NostrEvent[], key: string, now: number): string[] {
  const newest = new Map<string, NostrEvent>();
  for (const event of events) {
    const d = dOf(event);
    if (
      event.kind !== KIND_PRODUCT ||
      event.pubkey !== key ||
      d === undefined ||
      !D_TAG_RE.test(d) ||
      !verifyEvent(event)
    ) {
      continue;
    }
    const kept = newest.get(d);
    if (kept === undefined || event.created_at > kept.created_at) {
      newest.set(d, event);
    }
  }
  const deletions = events.filter((event) => event.kind === KIND_DELETION);
  return [...newest].filter(([, event]) => !deleted(event, deletions, now)).map(([d]) => d);
}

/**
 * How many products in `currency` a catalog key shows shoppers now (hidden and
 * deleted ones left out), read as the assistant reads them, from the Askr relay.
 */
export async function countListed(
  reader: RelayReader,
  key: string,
  currency: string,
  now: number = nowSecs(),
): Promise<number> {
  const events = await reader.query({ kinds: [KIND_PRODUCT, KIND_DELETION], authors: [key] });
  const deletions = events.filter((event) => event.kind === KIND_DELETION);
  return newestByD(events, KIND_PRODUCT, key, now).filter((event) => {
    if (deleted(event, deletions, now)) {
      return false;
    }
    // Only the store's currency counts against the plan: the assistant leaves the rest out.
    return parseCatalogItem(event, { now })?.price.currency === currency;
  }).length;
}

/** The policies a policy key shows now, by slug. */
export async function readPolicies(
  reader: RelayReader,
  key: string,
  now: number = nowSecs(),
): Promise<Policy[]> {
  const events = await reader.query({ kinds: [KIND_POLICY, KIND_DELETION], authors: [key] });
  const deletions = events.filter((event) => event.kind === KIND_DELETION);
  return newestByD(events, KIND_POLICY, key, now)
    .filter((event) => !deleted(event, deletions, now))
    .flatMap((event) => {
      const policy = parsePolicy(event);
      return policy === undefined ? [] : [policy];
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

/** A listing as the catalog API takes it back, so a re-sent catalog keeps it as it is. */
export function inputOfListing(item: CatalogItem, hidden = false): CatalogItemInput {
  const input: CatalogItemInput = {
    d: item.d,
    title: item.title,
    description: item.description,
    price: {
      amount: item.price.amount,
      currency: item.price.currency,
      ...(item.price.frequency === undefined ? {} : { frequency: item.price.frequency }),
    },
    images: item.images,
    topics: item.topics,
    attrs: item.attrs,
    options: item.options,
    variants: item.variants,
    visibility: hidden ? 'hidden' : item.visibility,
  };
  if (item.summary !== undefined) {
    input.summary = item.summary;
  }
  const [url] = item.links;
  if (url !== undefined) {
    input.url = url;
  }
  if (item.sku !== undefined) {
    input.sku = item.sku;
  }
  if (item.sourceId !== undefined) {
    input.sourceId = item.sourceId;
  }
  if (item.priceFrom) {
    input.priceFrom = true;
  }
  return input;
}
