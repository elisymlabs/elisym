import { KIND_GIFT_WRAP, MAX_FUTURE_SKEW_SECS } from '@elisym/commerce';
import type { Filter, NostrEvent } from 'nostr-tools';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/pure';
import { RESUBSCRIBE_BACKOFF_MS, WRAP_BACKDATE_SECS } from './constants';

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
 * The next backfill page after one that returned `received` wraps, the oldest
 * dated `oldest`, or `undefined` when the history down to `since` is read.
 * `until` is inclusive: a page that did not move below `until` (a flood of
 * wraps sharing one second) steps one second down rather than stopping.
 */
export function nextPageUntil(
  since: number,
  until: number,
  received: number,
  oldest: number,
): number | undefined {
  if (received === 0 || oldest <= since) {
    return undefined;
  }
  const next = oldest < until ? oldest : until - 1;
  return next > since ? next : undefined;
}

/**
 * One subscription per store inbox relay, kept alive, plus a paged backfill of
 * what the relay stored before it opened. A relay counts as read through only
 * once a backfill reached a genuine end on a subscription that is still open.
 */
export class InboxListener {
  private readonly live = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly setTimer: (task: () => void, ms: number) => () => void;

  constructor(private readonly options: ListenerOptions) {
    this.setTimer =
      options.setTimer ??
      ((task, ms) => {
        const handle = setTimeout(task, ms);
        return () => clearTimeout(handle);
      });
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
        if (closed) {
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
    pool.subscribe([relay], wrapFilter(storePubkey, since), {
      onauth: auth,
      onevent: onWrap,
      // nostr-tools also calls this right before `onclose` when a subscription
      // fails: the backfill starts on the next turn, and only if still open.
      oneose: () => this.setTimer(runBackfill, 0),
      onclose: (reasons) => {
        closed = true;
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
  }

  /** Page backwards through `relay`'s stored wraps in `[since, until]`; true only when read to the end. */
  backfill(relay: string, since: number, until: number): Promise<boolean> {
    const { pool, storePubkey, auth, onWrap } = this.options;
    return new Promise((resolve) => {
      let received = 0;
      let oldest = until;
      let timedOut = false;
      let cancelTimer: (() => void) | undefined;
      const subscription = pool.subscribeEose([relay], wrapFilter(storePubkey, since, until), {
        maxWait: LIBRARY_WAIT_MS,
        onauth: auth,
        onevent: (wrap) => {
          received += 1;
          oldest = Math.min(oldest, wrap.created_at);
          onWrap(wrap);
        },
        onclose: (reasons) => {
          cancelTimer?.();
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
      cancelTimer = this.setTimer(() => {
        timedOut = true;
        subscription.close();
      }, PAGE_WAIT_MS);
    });
  }
}
