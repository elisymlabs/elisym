import { SimplePool, type Filter, type Event } from 'nostr-tools';
import { RELAYS, DEFAULTS } from '../constants';
import { BoundedSet } from '../primitives/bounded-set';
import type { SubCloser } from '../types';

export class NostrPool {
  private pool: SimplePool;
  private relays: string[];
  private activeSubscriptions = new Set<SubCloser>();

  constructor(relays: string[] = RELAYS) {
    this.pool = new SimplePool();
    this.relays = relays;
  }

  /** Query relays synchronously. Returns `[]` on timeout (no error thrown). */
  async querySync(filter: Filter): Promise<Event[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const query = this.pool.querySync(this.relays, filter);
    query.catch(() => {}); // prevent unhandled rejection if timeout wins
    try {
      const result = await Promise.race([
        query,
        new Promise<Event[]>((resolve) => {
          timer = setTimeout(() => resolve([]), DEFAULTS.QUERY_TIMEOUT_MS);
        }),
      ]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async queryBatched(
    filter: Omit<Filter, 'authors'>,
    keys: string[],
    batchSize: number = DEFAULTS.BATCH_SIZE,
    maxConcurrency: number = DEFAULTS.QUERY_MAX_CONCURRENCY,
  ): Promise<Event[]> {
    const batchKeys: string[][] = [];
    for (let i = 0; i < keys.length; i += batchSize) {
      batchKeys.push(keys.slice(i, i + batchSize));
    }

    const results: Event[] = [];
    for (let c = 0; c < batchKeys.length; c += maxConcurrency) {
      const chunk = batchKeys.slice(c, c + maxConcurrency);
      const chunkResults = await Promise.all(
        chunk.map((batch) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const query = this.pool.querySync(this.relays, {
            ...filter,
            authors: batch,
          } as Filter);
          query.catch(() => {}); // prevent unhandled rejection if timeout wins
          return (async () => {
            try {
              return await Promise.race([
                query,
                new Promise<Event[]>((resolve) => {
                  timer = setTimeout(() => resolve([]), DEFAULTS.QUERY_TIMEOUT_MS);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          })();
        }),
      );
      results.push(...chunkResults.flat());
    }
    return results;
  }

  async queryBatchedByTag(
    filter: Filter,
    tagName: string,
    values: string[],
    batchSize: number = DEFAULTS.BATCH_SIZE,
    maxConcurrency: number = DEFAULTS.QUERY_MAX_CONCURRENCY,
  ): Promise<Event[]> {
    const batchValues: string[][] = [];
    for (let i = 0; i < values.length; i += batchSize) {
      batchValues.push(values.slice(i, i + batchSize));
    }

    const results: Event[] = [];
    for (let c = 0; c < batchValues.length; c += maxConcurrency) {
      const chunk = batchValues.slice(c, c + maxConcurrency);
      const chunkResults = await Promise.all(
        chunk.map((batch) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const query = this.pool.querySync(this.relays, {
            ...filter,
            [`#${tagName}`]: batch,
          } as Filter);
          query.catch(() => {}); // prevent unhandled rejection if timeout wins
          return (async () => {
            try {
              return await Promise.race([
                query,
                new Promise<Event[]>((resolve) => {
                  timer = setTimeout(() => resolve([]), DEFAULTS.QUERY_TIMEOUT_MS);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          })();
        }),
      );
      results.push(...chunkResults.flat());
    }
    return results;
  }

  async publish(event: Event): Promise<void> {
    try {
      await Promise.any(this.pool.publish(this.relays, event));
    } catch (err) {
      if (err instanceof AggregateError) {
        throw new Error(
          `Failed to publish to all ${this.relays.length} relays: ${err.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e))).join(', ')}`,
        );
      }
      throw err;
    }
  }

  /** Publish to all relays and wait for all to settle. Throws if none accepted. */
  async publishAll(event: Event): Promise<void> {
    const results = await Promise.allSettled(this.pool.publish(this.relays, event));
    const anyOk = results.some((r) => r.status === 'fulfilled');
    if (!anyOk) {
      throw new Error(`Failed to publish to all ${this.relays.length} relays`);
    }
  }

  subscribe(filter: Filter, onEvent: (event: Event) => void): SubCloser {
    const rawSub = this.pool.subscribeMany(this.relays, filter, { onevent: onEvent });
    const tracked: SubCloser = {
      close: (reason?: string) => {
        this.activeSubscriptions.delete(tracked);
        rawSub.close(reason);
      },
    };
    this.activeSubscriptions.add(tracked);
    return tracked;
  }

  /**
   * Subscribe and wait until at least one relay confirms the subscription
   * is active (EOSE). Resolves on the first relay that responds.
   * Essential for ephemeral events where the subscription must be live
   * before publishing.
   *
   * Note: resolves on timeout even if no relay sent EOSE. The caller
   * cannot distinguish timeout from success - this is intentional for
   * best-effort ephemeral event delivery.
   */
  subscribeAndWait(
    filter: Filter,
    onEvent: (event: Event) => void,
    timeoutMs: number = DEFAULTS.EOSE_TIMEOUT_MS,
  ): Promise<SubCloser> {
    return new Promise((resolve) => {
      let resolved = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const subs: SubCloser[] = [];
      const combinedSub: SubCloser = {
        close: (reason?: string) => {
          this.activeSubscriptions.delete(combinedSub);
          for (const s of subs) {
            s.close(reason);
          }
        },
      };
      this.activeSubscriptions.add(combinedSub);

      const done = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve(combinedSub);
      };

      // Subscribe to each relay individually so we can resolve
      // as soon as the first relay sends EOSE (not waiting for all).
      // Dedup events by id since per-relay subscriptions bypass SimplePool dedup.
      const seen = new BoundedSet<string>(10_000);
      const dedupedOnEvent = (ev: Event) => {
        if (seen.has(ev.id)) {
          return;
        }
        seen.add(ev.id);
        onEvent(ev);
      };

      for (const relay of this.relays) {
        try {
          const sub = this.pool.subscribeMany([relay], filter, {
            onevent: dedupedOnEvent,
            oneose: done,
          });
          subs.push(sub);
        } catch {
          /* skip failed relay - handled by subs.length === 0 check below */
        }
      }

      // If all relays failed, resolve immediately
      if (subs.length === 0) {
        done();
        return;
      }

      if (!resolved) {
        timer = setTimeout(done, timeoutMs);
      }
    });
  }

  /**
   * Tear down pool and create a fresh one.
   * Works around nostr-tools `onerror - skipReconnection = true` bug
   * that permanently kills subscriptions. Callers must re-subscribe.
   */
  reset(): void {
    for (const sub of this.activeSubscriptions) {
      sub.close('pool reset');
    }
    this.activeSubscriptions.clear();
    try {
      this.pool.close(this.relays);
    } catch {
      /* ignore */
    }
    this.pool = new SimplePool();
  }

  /**
   * Lightweight connectivity probe. Returns true if at least one relay responds.
   */
  async probe(timeoutMs: number = DEFAULTS.EOSE_TIMEOUT_MS): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const query = this.pool.querySync(this.relays, { kinds: [0], limit: 1 } as Filter);
    query.catch(() => {}); // prevent unhandled rejection if timeout wins
    try {
      await Promise.race([
        query,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('probe timeout')), timeoutMs);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  getRelays(): string[] {
    return this.relays;
  }

  close(): void {
    for (const sub of this.activeSubscriptions) {
      sub.close('pool closed');
    }
    this.activeSubscriptions.clear();
    try {
      this.pool.close(this.relays);
    } catch {
      /* ignore - already disconnected */
    }
  }
}
