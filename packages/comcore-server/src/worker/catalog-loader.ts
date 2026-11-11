import type { StoreCatalog } from '@elisym/comcore-agent';
import type { Filter, NostrEvent } from 'nostr-tools';
import { CATALOG_PAGE_LIMIT, CONNECTION_TIMEOUT_MS } from '../constants';
import { Backoff } from '../relay/backoff';
import { chunkByBytes } from '../relay/chunks';
import { readHistory } from '../relay/history';
import type { ServerPool } from '../relay/pool';
import type { StoreRecord } from '../state/types';
import {
  buildStoreCatalog,
  extraFilters,
  extraRelaysFor,
  keyFilters,
  ownerFilters,
  storeConfig,
} from './catalog';

export interface CatalogLoaderDeps {
  relayUrl: string;
  pool: ServerPool;
  /** The stores this worker leases, at call time. */
  leased: () => StoreRecord[];
  now: () => number;
  log: (message: string) => void;
}

/**
 * The catalog cache of every leased store (5.1, 2.4). One live `limit: 0` REQ
 * (split by the byte cap) over every store's authors opens first; any event
 * from them marks that store dirty. Full reloads run through one queue, one
 * store at a time, so reloads never stack, never race each other's cache
 * writes, and use one REQ slot. A store marked dirty again while it reloads
 * reloads once more after. A reload that fails (no real EOSE, a dropped
 * connection) keeps the old cache and retries after the backoff. When a
 * reload changes a store's keys (30496 `catalog-key`/`policy-key`), the live
 * REQ is re-issued: the new one opens before the old one closes.
 */
export class CatalogLoader {
  readonly catalogs = new Map<string, StoreCatalog>();
  private readonly dirty = new Set<string>();
  private readonly backoff = new Backoff();
  private pumping = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private liveGeneration = 0;
  private liveSubscriptions: { close: () => void }[] = [];
  private liveAuthors = new Map<string, string>();

  constructor(private readonly deps: CatalogLoaderDeps) {}

  /** REQs the live catalog subscription holds open. */
  get liveRequests(): number {
    return this.liveSubscriptions.length;
  }

  start(): void {
    this.stopped = false;
    this.openLive();
    for (const store of this.deps.leased()) {
      this.enqueue(store.owner);
    }
  }

  stop(): void {
    this.stopped = true;
    this.liveGeneration += 1;
    clearTimeout(this.retryTimer);
    for (const subscription of this.liveSubscriptions) {
      subscription.close();
    }
    this.liveSubscriptions = [];
  }

  /** Resolves once the queue is empty and nothing is reloading (tests and start-up). */
  async settled(): Promise<void> {
    while (this.pumping || (this.dirty.size > 0 && this.retryTimer === undefined)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Mark a store dirty; its full reload runs once the queue reaches it. */
  enqueue(owner: string): void {
    this.dirty.add(owner);
    if (this.retryTimer === undefined) {
      void this.pump();
    }
  }

  /** Forget a store no longer leased. */
  drop(owner: string): void {
    this.dirty.delete(owner);
    this.catalogs.delete(owner);
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) {
      return;
    }
    this.pumping = true;
    try {
      for (const owner of this.dirty) {
        if (this.stopped) {
          return;
        }
        this.dirty.delete(owner);
        const store = this.deps.leased().find((record) => record.owner === owner);
        if (!store) {
          this.catalogs.delete(owner);
          continue;
        }
        if (!(await this.reload(store))) {
          // The old cache stays; this store and the rest of the queue wait out the backoff.
          this.dirty.add(owner);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.pump();
          }, this.backoff.next());
          return;
        }
        this.backoff.reset();
        this.reissueLiveIfChanged();
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Read every page of a filter set backwards in time on one connection.
   * Undefined unless every page ended in a real EOSE on the same connection.
   * A page boundary is inclusive and events are kept once by id, so events
   * sharing the boundary second are not lost.
   */
  private async readAll(url: string, filters: Filter[]): Promise<NostrEvent[] | undefined> {
    let relay;
    try {
      relay = await this.deps.pool.ensureRelay(url, { connectionTimeout: CONNECTION_TIMEOUT_MS });
    } catch {
      return undefined;
    }
    const collected = new Map<string, NostrEvent>();
    for (const filter of filters) {
      let until: number | undefined;
      for (;;) {
        const page: NostrEvent[] = [];
        const read = readHistory(
          relay,
          [{ ...filter, limit: CATALOG_PAGE_LIMIT, ...(until === undefined ? {} : { until }) }],
          (event) => page.push(event),
        );
        const real = await read.done;
        read.close();
        if (!real || !relay.connected) {
          return undefined;
        }
        let added = 0;
        for (const event of page) {
          if (!collected.has(event.id)) {
            collected.set(event.id, event);
            added += 1;
          }
        }
        if (page.length < CATALOG_PAGE_LIMIT || added === 0) {
          break;
        }
        until = Math.min(...page.map((event) => event.created_at));
      }
    }
    return [...collected.values()];
  }

  /** Best effort: what a third-party relay returns is merged; a dead one changes nothing. */
  private async readExtra(owner: string, productKey: string | undefined, relays: string[]) {
    const reads = await Promise.all(
      relays.map((url) => this.readAll(url, extraFilters(owner, productKey))),
    );
    return reads.flatMap((events) => events ?? []);
  }

  /** True when the cache now reflects the relay (5.1); false keeps the old cache. */
  private async reload(store: StoreRecord): Promise<boolean> {
    const now = this.deps.now();
    const ownerEvents = await this.readAll(this.deps.relayUrl, ownerFilters(store.owner));
    if (!ownerEvents) {
      return false;
    }
    const config = storeConfig(ownerEvents, store.owner, now);
    if (!config) {
      this.catalogs.delete(store.owner);
      return true;
    }
    const keyEvents = await this.readAll(
      this.deps.relayUrl,
      keyFilters(config.catalogKey, config.policyKey),
    );
    if (!keyEvents) {
      return false;
    }
    const extra = await this.readExtra(store.owner, config.catalogKey, extraRelaysFor(config));
    const byId = new Map<string, NostrEvent>();
    for (const event of [...ownerEvents, ...keyEvents, ...extra]) {
      byId.set(event.id, event);
    }
    const catalog = buildStoreCatalog(
      [...byId.values()],
      store.owner,
      store.assistantSecretKey,
      this.deps.now(),
    );
    if (catalog) {
      this.catalogs.set(store.owner, catalog);
    } else {
      this.catalogs.delete(store.owner);
    }
    return true;
  }

  /** Author to owner for every leased store: the owner, and the keys its cached config names. */
  private authors(): Map<string, string> {
    const authors = new Map<string, string>();
    for (const store of this.deps.leased()) {
      authors.set(store.owner, store.owner);
      const config = this.catalogs.get(store.owner)?.config;
      if (config) {
        authors.set(config.catalogKey, store.owner);
        authors.set(config.policyKey, store.owner);
      }
    }
    return authors;
  }

  /** Re-issue the live REQ when the leased stores or their keys changed (2.4). */
  reissueLiveIfChanged(): void {
    const next = this.authors();
    const same =
      next.size === this.liveAuthors.size &&
      [...next].every(([author, owner]) => this.liveAuthors.get(author) === owner);
    if (!same) {
      this.openLive();
    }
  }

  private openLive(): void {
    if (this.stopped) {
      return;
    }
    const authors = this.authors();
    const generation = ++this.liveGeneration;
    const previous = this.liveSubscriptions;
    this.liveAuthors = authors;
    if (authors.size === 0) {
      this.liveSubscriptions = [];
      for (const subscription of previous) {
        subscription.close();
      }
      return;
    }
    void this.deps.pool
      .ensureRelay(this.deps.relayUrl, { connectionTimeout: CONNECTION_TIMEOUT_MS })
      .then(
        (relay) => {
          if (generation !== this.liveGeneration) {
            return;
          }
          this.liveSubscriptions = chunkByBytes([...authors.keys()]).map((chunk) =>
            relay.subscribe([{ authors: chunk, limit: 0 }], {
              onevent: (event) => {
                const owner = authors.get(event.pubkey);
                if (owner !== undefined) {
                  this.enqueue(owner);
                }
              },
              onclose: () => this.liveClosed(generation),
            }),
          );
          // Open the new one, then close the old (2.4).
          for (const subscription of previous) {
            subscription.close();
          }
        },
        () => this.liveClosed(generation),
      );
  }

  /** A live REQ of the current generation closed: reopen it, then reload every store in full (5.1). */
  private liveClosed(generation: number): void {
    if (this.stopped || generation !== this.liveGeneration) {
      return;
    }
    this.liveGeneration += 1;
    for (const subscription of this.liveSubscriptions) {
      subscription.close();
    }
    this.liveSubscriptions = [];
    setTimeout(() => {
      if (this.stopped) {
        return;
      }
      this.openLive();
      for (const store of this.deps.leased()) {
        this.enqueue(store.owner);
      }
    }, this.backoff.next());
  }
}
