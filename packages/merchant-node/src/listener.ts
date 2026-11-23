import { KIND_GIFT_WRAP, MAX_FUTURE_SKEW_SECS } from '@elisym/commerce';
import type { Filter, NostrEvent } from 'nostr-tools';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/pure';
import { RESUBSCRIBE_BACKOFF_MS, WRAP_BACKDATE_SECS } from './constants';
import { nextPageUntil } from './order-rules';

/** The close reason nostr-tools gives a `subscribeEose` that reached EOSE (or its own timeout). */
const EOSE_CLOSE_REASON = 'closed automatically on eose';

/** How long one backfill page may take before it counts as not read. */
export const PAGE_WAIT_MS = 30_000;

/**
 * Passed as `maxWait`: longer than `PAGE_WAIT_MS`, so the library's own EOSE
 * timeout - which it reports exactly like a real EOSE - never ends a page first.
 */
const LIBRARY_WAIT_MS = PAGE_WAIT_MS + 15_000;

/** A failed backfill is tried again after this long, while its subscription is open. */
const BACKFILL_RETRY_MS = 30_000;

interface SubscribeParams {
  maxWait?: number;
  onauth?: (template: EventTemplate) => Promise<VerifiedEvent>;
  onevent: (event: NostrEvent) => void;
  oneose?: () => void;
  onclose?: (reasons: string[]) => void;
}

/** The part of nostr-tools' `SimplePool` the listener uses. */
export interface ListenerPool {
  subscribe(relays: string[], filter: Filter, params: SubscribeParams): { close(): void };
  subscribeEose(relays: string[], filter: Filter, params: SubscribeParams): { close(): void };
}

export interface ListenerOptions {
  pool: ListenerPool;
  storePubkey: string;
  auth: (template: EventTemplate) => Promise<VerifiedEvent>;
  onWrap: (wrap: NostrEvent) => void;
  log: (message: string) => void;
  now: () => number;
  /** Timers, so tests can run them; returns a cancel function. */
  setTimer?: (task: () => void, ms: number) => () => void;
}

/**
 * The resume point after a sweep: the moment it was queued, if every inbox
 * relay was read through and live then (every wrap received earlier is ahead of
 * the sweep on the queue); otherwise the old one stays.
 */
export function resumePointAfterSweep(
  allLive: boolean,
  queuedAt: number,
  current: number | undefined,
): number | undefined {
  return allLive ? queuedAt : current;
}

/**
 * Wrap ids already handed on, dropped once older than any read could reach:
 * a wrap read again (the live burst overlapping the backfill, a reconnect
 * re-reading its window) is not unwrapped a second time.
 */
export class SeenWraps {
  private readonly seen = new Map<string, number>();

  /** True the first time a wrap id is offered, false after. */
  admit(wrap: Pick<NostrEvent, 'id' | 'created_at'>): boolean {
    if (this.seen.has(wrap.id)) {
      return false;
    }
    this.seen.set(wrap.id, wrap.created_at);
    return true;
  }

  /** Let a wrap be offered again (one that could not be acted on yet). */
  forget(id: string): void {
    this.seen.delete(id);
  }

  /** Forget wraps dated before `oldestReadable`: no read reaches them any more. */
  prune(oldestReadable: number): void {
    for (const [id, createdAt] of this.seen) {
      if (createdAt < oldestReadable) {
        this.seen.delete(id);
      }
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * Where a read that must reach every wrap sent since `from` starts: NIP-59
 * dates each wrap at a random moment up to two days back, and the rumor inside
 * may be dated up to the skew allowance ahead.
 */
export function readSince(from: number): number {
  return from - WRAP_BACKDATE_SECS - MAX_FUTURE_SKEW_SECS;
}

export function wrapFilter(storePubkey: string, since: number, until?: number): Filter {
  return {
    kinds: [KIND_GIFT_WRAP],
    '#p': [storePubkey],
    since,
    ...(until === undefined ? {} : { until }),
  };
}

/**
 * One subscription per store inbox relay, kept alive, plus a paged backfill of
 * what the relay stored before it opened. A relay counts as read through only
 * once a backfill reached a genuine end on a subscription that is still open.
 */
export class InboxListener {
  private readonly live = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly startTimer: (task: () => void, ms: number) => () => void;
  /** Timers not yet fired and subscriptions still open: all ended by `close`. */
  private readonly timers = new Set<() => void>();
  private readonly subscriptions = new Set<{ close(): void }>();
  private closed = false;

  constructor(private readonly options: ListenerOptions) {
    this.startTimer =
      options.setTimer ??
      ((task, ms) => {
        const handle = setTimeout(task, ms);
        return () => clearTimeout(handle);
      });
  }

  /** Stop listening for good: no wrap is handed on, nothing is retried. */
  close(): void {
    this.closed = true;
    this.live.clear();
    for (const cancel of this.timers) {
      cancel();
    }
    this.timers.clear();
    for (const subscription of this.subscriptions) {
      subscription.close();
    }
    this.subscriptions.clear();
  }

  private setTimer(task: () => void, ms: number): () => void {
    if (this.closed) {
      return () => undefined;
    }
    let cancel: () => void = () => undefined;
    const run = () => {
      this.timers.delete(cancel);
      if (!this.closed) {
        task();
      }
    };
    const stopTimer = this.startTimer(run, ms);
    cancel = () => {
      this.timers.delete(cancel);
      stopTimer();
    };
    this.timers.add(cancel);
    return cancel;
  }

  private open(subscription: { close(): void }): void {
    if (this.closed) {
      subscription.close();
      return;
    }
    this.subscriptions.add(subscription);
  }

  /** Whether every one of `relays` is currently read through and listening. */
  allLive(relays: readonly string[]): boolean {
    return relays.every((relay) => this.live.has(relay));
  }

  isLive(relay: string): boolean {
    return this.live.has(relay);
  }

  /** Listen on `relay` for every wrap sent since `from`. */
  listen(relay: string, from: number): void {
    if (this.closed) {
      return;
    }
    const { pool, storePubkey, auth, onWrap, log, now } = this.options;
    const since = readSince(from);
    const openedAt = now();
    let closed = false;
    let readThrough = false;
    const runBackfill = () => {
      if (closed) {
        return;
      }
      void this.backfill(relay, since, openedAt).then((done) => {
        if (closed || this.closed) {
          return;
        }
        if (done) {
          readThrough = true;
          this.attempts.set(relay, 0);
          this.live.add(relay);
          return;
        }
        log(`could not read the stored wraps of ${relay}; trying again`);
        this.setTimer(runBackfill, BACKFILL_RETRY_MS);
      });
    };
    // Declared first: a pool may call `onclose` before `subscribe` returns.
    let subscription: { close(): void } | undefined;
    subscription = pool.subscribe([relay], wrapFilter(storePubkey, since), {
      onauth: auth,
      onevent: (wrap) => {
        if (!this.closed) {
          onWrap(wrap);
        }
      },
      // nostr-tools also calls this right before `onclose` when a subscription
      // fails: the backfill starts on the next turn, and only if still open.
      oneose: () => this.setTimer(runBackfill, 0),
      onclose: (reasons) => {
        closed = true;
        if (subscription !== undefined) {
          this.subscriptions.delete(subscription);
        }
        if (this.closed) {
          return;
        }
        this.live.delete(relay);
        const attempt = this.attempts.get(relay) ?? 0;
        this.attempts.set(relay, attempt + 1);
        const pause =
          RESUBSCRIBE_BACKOFF_MS[Math.min(attempt, RESUBSCRIBE_BACKOFF_MS.length - 1)] ?? 60_000;
        // Reach back from the close only if this subscription read the stored history.
        const resumeFrom = readThrough ? now() : from;
        log(`subscription on ${relay} closed (${reasons.join(', ')}); again in ${pause} ms`);
        this.setTimer(() => this.listen(relay, resumeFrom), pause);
      },
    });
    if (!closed) {
      this.open(subscription);
    }
  }

  /** Page backwards through `relay`'s stored wraps in `[since, until]`; true only when read to the end. */
  backfill(relay: string, since: number, until: number): Promise<boolean> {
    const { pool, storePubkey, auth, onWrap } = this.options;
    return new Promise((resolve) => {
      let received = 0;
      let oldest = until;
      let timedOut = false;
      let cancelTimer: (() => void) | undefined;
      let ended = false;
      // Declared first: a pool may call `onclose` before `subscribeEose` returns.
      let subscription: { close(): void } | undefined;
      subscription = pool.subscribeEose([relay], wrapFilter(storePubkey, since, until), {
        maxWait: LIBRARY_WAIT_MS,
        onauth: auth,
        onevent: (wrap) => {
          received += 1;
          oldest = Math.min(oldest, wrap.created_at);
          if (!this.closed) {
            onWrap(wrap);
          }
        },
        onclose: (reasons) => {
          ended = true;
          cancelTimer?.();
          if (subscription !== undefined) {
            this.subscriptions.delete(subscription);
          }
          if (this.closed) {
            resolve(false);
            return;
          }
          if (timedOut || !reasons.every((reason) => reason === EOSE_CLOSE_REASON)) {
            resolve(false);
            return;
          }
          const next = nextPageUntil(since, until, received, oldest);
          if (next === undefined) {
            resolve(true);
          } else {
            void this.backfill(relay, since, next).then(resolve);
          }
        },
      });
      if (ended) {
        return;
      }
      const opened = subscription;
      this.open(opened);
      cancelTimer = this.setTimer(() => {
        timedOut = true;
        opened.close();
      }, PAGE_WAIT_MS);
    });
  }
}
