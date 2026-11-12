import {
  CONFIG_D_TAG,
  type CatalogItem,
  type CatalogItemInput,
  type CatalogKeyRole,
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  KIND_POLICY,
  type Policy,
  type StoreConfig,
  parseCatalogItem,
  parseConfig,
  parsePolicy,
  readCatalogAuthority,
} from '@elisym/askr';
import { KIND_DELETION, KIND_PRODUCT, KIND_STORE_AUTH } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { MAX_FUTURE_SKEW_SECS } from '../constants';
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

/** Whether a deletion by the author names the event's address at or after it. */
function deleted(event: NostrEvent, deletions: readonly NostrEvent[]): boolean {
  const address = `${event.kind}:${event.pubkey}:${dOf(event) ?? ''}`;
  return deletions.some(
    (deletion) =>
      deletion.kind === KIND_DELETION &&
      deletion.pubkey === event.pubkey &&
      deletion.created_at >= event.created_at &&
      deletion.tags.some((tag) => tag[0] === 'a' && tag[1] === address) &&
      verifyEvent(deletion),
  );
}

/**
 * The owner's config as the relay holds it: none, the newest one, or a newest
 * one that does not parse (then the newest that does, if the relay kept one).
 */
export type ConfigRead =
  | { state: 'none' }
  | { state: 'ok'; config: StoreConfig }
  | { state: 'unreadable'; newestAt: number; fallback: StoreConfig | undefined };

export async function readConfig(
  reader: RelayReader,
  owner: string,
  now: number = nowSecs(),
): Promise<ConfigRead> {
  const events = await reader.query({
    kinds: [KIND_CONFIG],
    authors: [owner],
    '#d': [CONFIG_D_TAG],
  });
  const [newest] = newestByD(events, KIND_CONFIG, owner, now);
  if (newest === undefined) {
    return { state: 'none' };
  }
  const config = parseConfig(newest);
  if (config !== undefined) {
    return { state: 'ok', config };
  }
  const older = events
    .filter((event) => event.id !== newest.id && event.created_at <= newest.created_at)
    .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id));
  let fallback: StoreConfig | undefined;
  for (const event of newestByDAll(older, owner, now)) {
    fallback = parseConfig(event);
    if (fallback !== undefined) {
      break;
    }
  }
  return { state: 'unreadable', newestAt: newest.created_at, fallback };
}

/** Signed configs of `owner`, newest first, each passing the same checks as `newestByD`. */
function newestByDAll(events: readonly NostrEvent[], owner: string, now: number): NostrEvent[] {
  return events.filter((event) => newestByD([event], KIND_CONFIG, owner, now).length === 1);
}

export interface AuthorityRead {
  /** The keys the owner authorizes now, with their roles (1.2). */
  keys: Map<string, Set<CatalogKeyRole>>;
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
      kinds: [KIND_CATALOG_AUTH, KIND_STORE_AUTH, KIND_DELETION],
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

/** Keys holding the catalog role now. */
export function catalogKeysOf(authority: AuthorityRead): Set<string> {
  return new Set(
    [...authority.keys].filter(([, roles]) => roles.has('catalog')).map(([key]) => key),
  );
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
  const events = await reader.query({ kinds: [KIND_PRODUCT, KIND_DELETION], authors: [key] });
  const deletions = events.filter((event) => event.kind === KIND_DELETION);
  // A deleted listing is gone, not hidden: it must not come back, count or be re-created.
  return newestByD(events, KIND_PRODUCT, key, now)
    .filter((event) => !deleted(event, deletions))
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
      const item = parseCatalogItem(readable, { role: 'catalog', now });
      return item === undefined ? [] : [inputOfListing(item, hidden)];
    });
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
    .filter((event) => !deleted(event, deletions))
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
