import type { QueryPool } from '@merchant-node/checks';
import type { ListenerPool } from '@merchant-node/listener';
import type { PublishPool, PublishRelay } from '@merchant-node/publish';
import type { Filter, NostrEvent } from 'nostr-tools';
import type { SimplePool } from 'nostr-tools/pool';

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? '');
}

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) {
    return false;
  }
  for (const name of ['d', 'p'] as const) {
    const wanted = filter[`#${name}`];
    if (wanted !== undefined && !tagValues(event, name).some((value) => wanted.includes(value))) {
      return false;
    }
  }
  return true;
}

interface Subscription {
  filter: Filter;
  params: Parameters<ListenerPool['subscribe']>[2];
  closed: boolean;
}

/**
 * Every relay at once, as one store of events: what any pool publishes is
 * served to every pool's reads. `refuse` decides which publishes no relay takes.
 */
export class RelayWorld {
  readonly events: NostrEvent[] = [];
  readonly pools: WorldPool[] = [];
  refuse: (event: NostrEvent) => boolean = () => false;
  /** Runs before each read is answered (tests record what the database held then). */
  beforeQuery: (() => Promise<void>) | undefined;
  queries = 0;

  /** A new pool on this world (a `StorePools` factory). */
  pool(): WorldPool {
    const pool = new WorldPool(this);
    this.pools.push(pool);
    return pool;
  }

  /** The factory `StorePools` takes. */
  factory(): () => SimplePool {
    // The fake speaks the parts of SimplePool a store node, its checks and its setup use.
    return () => this.pool() as unknown as SimplePool;
  }

  add(event: NostrEvent): void {
    this.events.push(event);
  }

  /** Hand `wrap` to every live subscription of an open pool that waits for its recipient. */
  deliver(wrap: NostrEvent): void {
    for (const pool of this.pools) {
      pool.deliver(wrap);
    }
  }
}

export class WorldPool implements ListenerPool, PublishPool, QueryPool {
  readonly live: Subscription[] = [];
  readonly published: NostrEvent[] = [];
  destroyed = false;

  constructor(private readonly world: RelayWorld) {}

  async querySync(_relays: string[], filter: Filter): Promise<NostrEvent[]> {
    this.world.queries += 1;
    await this.world.beforeQuery?.();
    return this.world.events.filter((event) => matches(filter, event));
  }

  subscribe(_relays: string[], filter: Filter, params: Subscription['params']) {
    const entry: Subscription = { filter, params, closed: false };
    this.live.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
    };
  }

  subscribeEose() {
    return { close: () => undefined };
  }

  ensureRelay(): Promise<PublishRelay> {
    return Promise.resolve({
      publish: (event: NostrEvent) => {
        if (this.destroyed || this.world.refuse(event)) {
          return Promise.reject(new Error('blocked: refused'));
        }
        this.published.push(event);
        this.world.add(event);
        return Promise.resolve('');
      },
      auth: () => Promise.resolve(''),
    });
  }

  deliver(wrap: NostrEvent): void {
    if (this.destroyed) {
      return;
    }
    for (const subscription of this.live) {
      if (!subscription.closed && matches(subscription.filter, wrap)) {
        subscription.params.onevent(wrap);
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const subscription of this.live) {
      subscription.closed = true;
    }
  }
}
