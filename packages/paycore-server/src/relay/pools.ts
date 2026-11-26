/**
 * One relay pool per running store. nostr-tools keeps one NIP-42 AUTH per
 * connection, so a store needs its own sockets to authenticate as its own key;
 * and the subscription nostr-tools opens again after `auth-required` is not
 * closed by the listener's `close`, only by destroying the pool, which `close`
 * here does when the store stops.
 */
import { listeningPool } from '@merchant-node/relay-pool';
import type { SimplePool } from 'nostr-tools/pool';

export class StorePools {
  private readonly pools = new Map<string, SimplePool>();

  constructor(private readonly makePool: () => SimplePool = listeningPool) {}

  /** The pool of a store starting now (a store already running is a bug of the caller). */
  open(storePubkey: string): SimplePool {
    if (this.pools.has(storePubkey)) {
      throw new Error(`store ${storePubkey} already has a relay pool`);
    }
    const pool = this.makePool();
    this.pools.set(storePubkey, pool);
    return pool;
  }

  /** Close every socket of a stopped store (after its node's `stop`). */
  close(storePubkey: string): void {
    const pool = this.pools.get(storePubkey);
    if (pool === undefined) {
      return;
    }
    this.pools.delete(storePubkey);
    pool.destroy();
  }

  closeAll(): void {
    for (const storePubkey of [...this.pools.keys()]) {
      this.close(storePubkey);
    }
  }

  get size(): number {
    return this.pools.size;
  }
}
