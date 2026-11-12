import type { StoreCatalog } from '@elisym/askr-agent';
import type { Filter, NostrEvent } from 'nostr-tools';
import {
  CONNECTION_TIMEOUT_MS,
  EXTRA_RELAY_BUDGET_MS,
  EXTRA_RELAY_TIMEOUT_MS,
  STABLE_CONNECTION_MS,
} from '../constants';
import { Backoff } from '../relay/backoff';
import { chunkByBytes } from '../relay/chunks';
import type { RelayLike, ServerPool } from '../relay/pool';
import { type PageLimits, readAllPages } from '../relay/read-all';
import type { StoreRecord } from '../state/types';
import {
  buildStoreCatalog,
  extraFilters,
  extraRelaysFor,
  deletionFilters,
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
  /** A page with no real EOSE in this long fails (2.4); tests shorten it. */
  historyTimeoutMs?: number;
  /** A Pay Core default relay's connect and page timeout, and its budget per reload (5.1); tests shorten them. */
  extraRelayTimeoutMs?: number;
  extraRelayBudgetMs?: number;
  /** How long a connection must stay up to reset the live backoff (2.4); tests shorten it. */
  stableConnectionMs?: number;
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
  private readonly unservable = new Set<string>();
  private readonly dirty = new Set<string>();
  /** Paces reload retries; reset by a reload that succeeded. */
  private readonly backoff = new Backoff();
  /** Paces live REQ reopens; reset only by a live REQ that stayed up through one ping cycle (2.4). */
  private readonly liveBackoff = new Backoff();
  /** The connection the live REQ runs on and when it came up: re-issues on it keep that time. */
  private liveRelay: RelayLike | undefined;
  private liveRelayUpAt = 0;
  private pumping = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private liveGeneration = 0;
  private liveSubscriptions: { close: () => void }[] = [];
  /** Author to the owners whose stores it feeds: two stores may share a key or name each other's owner. */
  private liveAuthors = new Map<string, Set<string>>();

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
    this.retryTimer = undefined;
    for (const subscription of this.liveSubscriptions) {
      subscription.close();
    }
    this.liveSubscriptions = [];
  }

  /** Resolves once the queue is empty and nothing is reloading (tests and start-up). */
  async settled(): Promise<void> {
    while (
      !this.stopped &&
      (this.pumping || (this.dirty.size > 0 && this.retryTimer === undefined))
    ) {
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
    this.unservable.delete(owner);
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

  private async readAll(
    url: string,
    filters: Filter[],
    limits: PageLimits = {
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      ...(this.deps.historyTimeoutMs === undefined
        ? {}
        : { pageTimeoutMs: this.deps.historyTimeoutMs }),
    },
  ): Promise<NostrEvent[] | undefined> {
    // The page cap returns what it read (5.1).
    return (await readAllPages(this.deps.pool, url, filters, limits))?.events;
  }

  /**
   * Best effort: what a third-party relay returns within its time budget is
   * merged; a dead or slow one changes nothing and holds the queue at most
   * that budget.
   */
  private async readExtra(owner: string, productKey: string | undefined, relays: string[]) {
    const deadline = Date.now() + (this.deps.extraRelayBudgetMs ?? EXTRA_RELAY_BUDGET_MS);
    const timeoutMs = this.deps.extraRelayTimeoutMs ?? EXTRA_RELAY_TIMEOUT_MS;
    const reads = await Promise.all(
      relays.map((url) =>
        this.readAll(url, extraFilters(owner, productKey), {
          connectionTimeoutMs: timeoutMs,
          pageTimeoutMs: timeoutMs,
          deadline,
        }),
      ),
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
      this.settle(store.owner, undefined);
      return true;
    }
    const keyEvents = await this.readAll(
      this.deps.relayUrl,
      keyFilters(config.catalogKey, config.policyKey),
    );
    if (!keyEvents) {
      return false;
    }
    const deletions = deletionFilters(keyEvents, config.catalogKey, config.policyKey);
    const deletionEvents =
      deletions.length === 0 ? [] : await this.readAll(this.deps.relayUrl, deletions);
    if (!deletionEvents) {
      return false;
    }
    const extra = await this.readExtra(store.owner, config.catalogKey, extraRelaysFor(config));
    const byId = new Map<string, NostrEvent>();
    for (const event of [...ownerEvents, ...keyEvents, ...deletionEvents, ...extra]) {
      byId.set(event.id, event);
    }
    const catalog = buildStoreCatalog(
      [...byId.values()],
      store.owner,
      store.assistantSecretKey,
      this.deps.now(),
    );
    this.settle(store.owner, catalog);
    return true;
  }

  /**
   * Write a reload's outcome, unless the store stopped being leased while it
   * read. A store read in full with nothing servable (no config, or one naming
   * another assistant) is marked so: the gateway answers it as unavailable,
   * not as still loading.
   */
  private settle(owner: string, catalog: StoreCatalog | undefined): void {
    if (!this.deps.leased().some((record) => record.owner === owner)) {
      return;
    }
    if (catalog) {
      this.catalogs.set(owner, catalog);
      this.unservable.delete(owner);
    } else {
      this.catalogs.delete(owner);
      this.unservable.add(owner);
    }
  }

  /** Read in full, and nothing to serve (3). */
  isUnservable(owner: string): boolean {
    return this.unservable.has(owner);
  }

  /** Author to owners for every leased store: the owner, and the keys its cached config names. */
  private authors(): Map<string, Set<string>> {
    const authors = new Map<string, Set<string>>();
    const add = (author: string, owner: string) => {
      const owners = authors.get(author) ?? new Set<string>();
      owners.add(owner);
      authors.set(author, owners);
    };
    for (const store of this.deps.leased()) {
      add(store.owner, store.owner);
      const config = this.catalogs.get(store.owner)?.config;
      if (config) {
        add(config.catalogKey, store.owner);
        add(config.policyKey, store.owner);
      }
    }
    return authors;
  }

  /** Re-issue the live REQ when the leased stores or their keys changed (2.4). */
  reissueLiveIfChanged(): void {
    const next = this.authors();
    const same =
      next.size === this.liveAuthors.size &&
      [...next].every(([author, owners]) => {
        const current = this.liveAuthors.get(author);
        return (
          current !== undefined &&
          current.size === owners.size &&
          [...owners].every((owner) => current.has(owner))
        );
      });
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
          if (relay !== this.liveRelay) {
            this.liveRelay = relay;
            this.liveRelayUpAt = Date.now();
          }
          this.liveSubscriptions = chunkByBytes([...authors.keys()]).map((chunk) =>
            relay.subscribe([{ authors: chunk, limit: 0 }], {
              onevent: (event) => {
                for (const owner of authors.get(event.pubkey) ?? []) {
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
    if (
      this.liveRelay !== undefined &&
      Date.now() - this.liveRelayUpAt >= (this.deps.stableConnectionMs ?? STABLE_CONNECTION_MS)
    ) {
      this.liveBackoff.reset();
    }
    this.liveRelay = undefined;
    setTimeout(() => {
      if (this.stopped) {
        return;
      }
      this.openLive();
      for (const store of this.deps.leased()) {
        this.enqueue(store.owner);
      }
    }, this.liveBackoff.next());
  }
}
