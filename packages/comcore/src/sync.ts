import {
  KIND_DELETION,
  NO_FUTURE_LIMIT,
  newestDeletion,
  newestSigned,
  nowSecs,
  tagValue,
} from '@elisym/commerce';
import type { EventTemplate, Filter, NostrEvent } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { COMCORE_RELAYS, KIND_CATALOG_AUTH } from './constants';
import { hasRole } from './events/catalog-auth';
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
  if (!hasRole(authorityEvents, options.store, key, 'catalog', now)) {
    throw new Error('This key is not authorized as a catalog key by the store owner');
  }

  const inputs = new Map<string, CatalogItemInput>();
  for (const input of options.items) {
    const { d } = CatalogItemInputSchema.parse(input);
    if (inputs.has(d)) {
      throw new Error(`Duplicate item d: ${d}`);
    }
    inputs.set(d, input);
  }

  const ownEvents = await options.client.query(relays, {
    kinds: [KIND_PRODUCT, KIND_DELETION],
    authors: [key],
  });
  const current = new Map<string, NostrEvent>();
  const deletedAt = new Map<string, number>();
  for (const d of new Set(ownEvents.map((event) => tagValue(event.tags, 'd')))) {
    if (d === undefined) {
      continue;
    }
    const newest = newestSigned(ownEvents, KIND_PRODUCT, key, now, d);
    if (!newest) {
      continue;
    }
    // A NIP-09 deletion removes every version up to its own date.
    const deletion = newestDeletion(ownEvents, catalogAddress(key, d), key, NO_FUTURE_LIMIT);
    if (deletion) {
      deletedAt.set(d, deletion.created_at);
    }
    if (!deletion || deletion.created_at < newest.created_at) {
      current.set(d, newest);
    }
  }

  const diff: SyncDiff = { created: [], updated: [], hidden: [], unchanged: [] };
  const toPublish: EventTemplate[] = [];
  for (const [d, input] of inputs) {
    const listed = current.get(d);
    // Dated after the version it replaces and after any deletion of the address:
    // a tie loses to the lower id (NIP-01), and a deletion removes all up to its date.
    const createdAt = Math.max(now, (listed?.created_at ?? 0) + 1, (deletedAt.get(d) ?? -1) + 1);
    const template = buildCatalogItemEvent({ ...input, createdAt });
    if (!listed) {
      diff.created.push(d);
      toPublish.push(template);
    } else if (sameListing(template, listed)) {
      diff.unchanged.push(d);
    } else {
      diff.updated.push(d);
      toPublish.push(template);
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
    if (inputs.has(d)) {
      continue;
    }
    diff.hidden.push(d);
    // Both dated at or after the listing they replace, so neither loses to it.
    const hiddenAt = Math.max(now, listed.created_at + 1);
    if (tagValue(listed.tags, 'visibility') !== 'hidden') {
      toPublish.push({
        kind: KIND_PRODUCT,
        created_at: hiddenAt,
        tags: listed.tags
          .filter((tag) => tag[0] !== 'visibility')
          .concat([['visibility', 'hidden']]),
        content: listed.content,
      });
    }
    // Also when only the hidden version made it last time: the deletion is retried.
    toPublish.push(deletionOf(d, hiddenAt));
  }

  const pace = options.pace ?? DEFAULT_SYNC_EVENTS_PER_SEC;
  if (!(pace > 0)) {
    throw new Error('pace must be positive');
  }
  if (options.dryRun) {
    return diff;
  }
  const sleep = options.sleep ?? defaultSleep;
  const gapMs = Math.ceil(1000 / pace);
  for (const [index, template] of toPublish.entries()) {
    if (index > 0) {
      await sleep(gapMs);
    }
    await publishWithRetry(options.client, relays, finalizeEvent(template, options.signer), sleep);
  }
  return diff;
}
