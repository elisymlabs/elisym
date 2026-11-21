/**
 * What the owner signed and what the store's keys list, read the way the
 * admin and the server read them: the relay, plus the events the server
 * holds for it (a store that is not active, or not fully published yet, has
 * its settings only there). Every event is signature checked.
 */
import type { StoreConfig, StorePrivateConfig } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import { verifyEvent } from 'nostr-tools/pure';
import { MAX_AHEAD_SECS } from './constants';
import type { Session } from './session';
import { refusalExit } from './store';
import type { StoredEventsView } from './types';

const KIND_DELETION = 5;
const KIND_PRODUCT = 30402;

function isEventShaped(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const event: Partial<Record<keyof NostrEvent, unknown>> = value;
  return (
    typeof event.id === 'string' &&
    typeof event.pubkey === 'string' &&
    typeof event.created_at === 'number' &&
    typeof event.kind === 'number' &&
    typeof event.content === 'string' &&
    typeof event.sig === 'string' &&
    Array.isArray(event.tags) &&
    event.tags.every(
      (tag: unknown) => Array.isArray(tag) && tag.every((part) => typeof part === 'string'),
    )
  );
}

function verifies(event: NostrEvent): boolean {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

/** Signed by `author`, signature checked, not dated past the clock skew. */
function genuine(events: readonly unknown[], author: string, now: number): NostrEvent[] {
  return events.flatMap((value) => {
    if (!isEventShaped(value)) {
      return [];
    }
    const event: NostrEvent = {
      id: value.id,
      pubkey: value.pubkey,
      created_at: value.created_at,
      kind: value.kind,
      tags: value.tags.map((tag) => [...tag]),
      content: value.content,
      sig: value.sig,
    };
    return event.pubkey === author && event.created_at <= now + MAX_AHEAD_SECS && verifies(event)
      ? [event]
      : [];
  });
}

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

function newestPerD(events: readonly NostrEvent[], kind: number): Map<string, NostrEvent> {
  const newest = new Map<string, NostrEvent>();
  for (const event of events) {
    const d = dOf(event);
    if (event.kind !== kind || d === undefined) {
      continue;
    }
    const current = newest.get(d);
    if (current === undefined || isNewer(event, current)) {
      newest.set(d, event);
    }
  }
  return newest;
}

/** Whether a deletion by the same author names the event's address at or after it. */
function deletedAfter(event: NostrEvent, deletions: readonly NostrEvent[]): boolean {
  const address = `${event.kind}:${event.pubkey}:${dOf(event) ?? ''}`;
  return deletions.some(
    (deletion) =>
      deletion.created_at >= event.created_at &&
      deletion.tags.some((tag) => tag[0] === 'a' && tag[1] === address),
  );
}

export interface SignedSettings {
  /** The newest config O signed that parses, from the relay or the server's stored events. */
  config: StoreConfig | undefined;
  /** Its private part, read back with O's key. */
  privatePart: StorePrivateConfig | undefined;
  /** Catalog keys O authorizes now, by the relay and the stored events together. */
  authorized: Set<string>;
  /** The newest 30497 date per key: a new one for that key is dated after it. */
  authNewestAt: Map<string, number>;
}

/** O's config and authorizations, from the relay and the stored events (init step 4). */
export async function readSigned(
  session: Session,
  owner: string,
  secretKey: Uint8Array,
): Promise<SignedSettings> {
  const { askr } = session;
  const now = session.nowSecs();
  const relayEvents = await session.relayQuery({
    kinds: [askr.KIND_CONFIG, askr.KIND_CATALOG_AUTH, KIND_DELETION],
    authors: [owner],
  });
  const stored = await session.call<StoredEventsView>('GET', '/v1/admin/store/events');
  if (!stored.ok) {
    throw refusalExit(session, stored);
  }
  const storedEvents = Array.isArray(stored.body.events) ? stored.body.events : [];
  const seen = new Set<string>();
  const events = genuine([...relayEvents, ...storedEvents], owner, now).filter((event) => {
    if (seen.has(event.id)) {
      return false;
    }
    seen.add(event.id);
    return true;
  });
  const configs = events
    .filter((event) => event.kind === askr.KIND_CONFIG && dOf(event) === askr.CONFIG_D_TAG)
    .sort((left, right) => (isNewer(left, right) ? -1 : 1));
  let config: StoreConfig | undefined;
  for (const event of configs) {
    config = askr.parseConfig(event);
    if (config !== undefined) {
      break;
    }
  }
  const privatePart =
    config === undefined
      ? undefined
      : await askr.decryptPrivateConfigWith(config, async (ciphertext, peer) =>
          nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(secretKey, peer)),
        );
  const authNewestAt = new Map<string, number>();
  for (const [key, event] of newestPerD(events, askr.KIND_CATALOG_AUTH)) {
    authNewestAt.set(key, event.created_at);
  }
  return {
    config,
    privatePart,
    authorized: askr.readCatalogAuthority(events, owner, now),
    authNewestAt,
  };
}

export interface ListingCounts {
  /** Every `d` the key lists, hidden included, not deleted. */
  listed: string[];
  /** Listed and not `visibility: hidden`. */
  visible: number;
}

/** What a catalog key lists on the relay: what the plan limit counts (5.5). */
export async function readListings(session: Session, key: string): Promise<ListingCounts> {
  // No future bound, on purpose: this is the count the plan limit is checked against, and the
  // server's `listedOnRelay` (askr-server admin/api.ts) and the admin's `listedIdsOf` take every
  // listing and deletion of the key however dated. A bound here would make `products.listed`
  // disagree with the `too_many_products` the server answers. Only signature and author are checked.
  const events = genuine(
    await session.relayQuery({ kinds: [KIND_PRODUCT, KIND_DELETION], authors: [key] }),
    key,
    Number.POSITIVE_INFINITY,
  );
  const deletions = events.filter((event) => event.kind === KIND_DELETION);
  const live = [...newestPerD(events, KIND_PRODUCT)].filter(
    ([, event]) => !deletedAfter(event, deletions),
  );
  return {
    listed: live.map(([d]) => d),
    visible: live.filter(
      ([, event]) => !event.tags.some((tag) => tag[0] === 'visibility' && tag[1] === 'hidden'),
    ).length,
  };
}

/** The policy slugs a policy key shows now. */
export async function readPolicySlugs(session: Session, key: string): Promise<string[]> {
  const { askr } = session;
  const events = genuine(
    await session.relayQuery({ kinds: [askr.KIND_POLICY, KIND_DELETION], authors: [key] }),
    key,
    session.nowSecs(),
  );
  const deletions = events.filter((event) => event.kind === KIND_DELETION);
  return [...newestPerD(events, askr.KIND_POLICY)]
    .filter(([, event]) => !deletedAfter(event, deletions))
    .map(([slug]) => slug)
    .sort();
}
