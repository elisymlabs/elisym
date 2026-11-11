import { KIND_DELETION, nowSecs, newestSigned, tagValue } from '@elisym/commerce';
import type { EventTemplate, Filter, NostrEvent } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { COMCORE_RELAYS, KIND_CATALOG_AUTH } from './constants';
import { catalogKeyRole } from './events/catalog-auth';
import {
  type CatalogItemInput,
  CatalogItemInputSchema,
  buildCatalogItemEvent,
  catalogAddress,
} from './events/catalog-item';

const KIND_PRODUCT = 30402;
/** Default publishing pace, well under the shared relay's server-wide cap. */
export const DEFAULT_SYNC_EVENTS_PER_SEC = 10;

/** The relay access `syncCatalog` needs; the SDK's pool or a test double. */
export interface SyncRelayClient {
  query(relays: readonly string[], filter: Filter): Promise<NostrEvent[]>;
  publish(relays: readonly string[], event: NostrEvent): Promise<void>;
}

export interface SyncCatalogOptions {
  /** The catalog key K: must be 30497-authorized by `store` (never a Pay Core S). */
  signer: Uint8Array;
  /** The store owner O. */
  store: string;
  items: readonly CatalogItemInput[];
  client: SyncRelayClient;
  dryRun?: boolean;
  /** Events per second while publishing. */
  pace?: number;
  now?: number;
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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const relays = COMCORE_RELAYS;
  const authorityEvents = await options.client.query(relays, {
    kinds: [KIND_CATALOG_AUTH, KIND_DELETION],
    authors: [options.store],
  });
  if (catalogKeyRole(authorityEvents, options.store, key, now) !== 'catalog') {
    throw new Error('This key is not authorized as a catalog key by the store owner');
  }

  const desired = new Map<string, EventTemplate>();
  for (const input of options.items) {
    const item = CatalogItemInputSchema.parse(input);
    if (desired.has(item.d)) {
      throw new Error(`Duplicate item d: ${item.d}`);
    }
    desired.set(item.d, buildCatalogItemEvent({ ...input, createdAt: now }));
  }

  const existingEvents = await options.client.query(relays, {
    kinds: [KIND_PRODUCT],
    authors: [key],
  });
  const existing = new Map<string, NostrEvent>();
  for (const d of new Set(existingEvents.map((event) => tagValue(event.tags, 'd')))) {
    if (d === undefined) {
      continue;
    }
    const newest = newestSigned(existingEvents, KIND_PRODUCT, key, now, d);
    if (newest) {
      existing.set(d, newest);
    }
  }

  const diff: SyncDiff = { created: [], updated: [], hidden: [], unchanged: [] };
  const toPublish: EventTemplate[] = [];
  for (const [d, template] of desired) {
    const current = existing.get(d);
    if (!current) {
      diff.created.push(d);
      toPublish.push(template);
    } else if (sameListing(template, current)) {
      diff.unchanged.push(d);
    } else {
      diff.updated.push(d);
      toPublish.push(template);
    }
  }
  for (const [d, current] of existing) {
    if (desired.has(d) || tagValue(current.tags, 'visibility') === 'hidden') {
      continue;
    }
    diff.hidden.push(d);
    const hiddenTags = current.tags
      .filter((tag) => tag[0] !== 'visibility')
      .concat([['visibility', 'hidden']]);
    toPublish.push({
      kind: KIND_PRODUCT,
      created_at: now,
      tags: hiddenTags,
      content: current.content,
    });
    toPublish.push({
      kind: KIND_DELETION,
      created_at: now,
      tags: [
        ['a', catalogAddress(key, d)],
        ['k', String(KIND_PRODUCT)],
      ],
      content: '',
    });
  }

  if (options.dryRun) {
    return diff;
  }
  const pace = options.pace ?? DEFAULT_SYNC_EVENTS_PER_SEC;
  if (!(pace > 0)) {
    throw new Error('pace must be positive');
  }
  const sleep = options.sleep ?? defaultSleep;
  const gapMs = Math.ceil(1000 / pace);
  for (const [index, template] of toPublish.entries()) {
    if (index > 0) {
      await sleep(gapMs);
    }
    await options.client.publish(relays, finalizeEvent(template, options.signer));
  }
  return diff;
}
