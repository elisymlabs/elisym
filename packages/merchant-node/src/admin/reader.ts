/**
 * Reads the gift wraps addressed to the store from its inbox relays, newest
 * first, page by page, opening at most a budget of them per load: anyone can
 * flood the store's `#p` for free, and every wrap costs two decryptions.
 */
import { KIND_GIFT_WRAP, MAX_FUTURE_SKEW_SECS, type UnwrappedOrderMessage } from '@elisym/commerce';
import type { EventTemplate, Filter, NostrEvent, VerifiedEvent } from 'nostr-tools';
import { EARLIEST_ORDER_SECS, WRAP_BACKDATE_SECS } from '../constants';
import { nextPageUntil } from '../order-rules';

/** Wraps opened per load ("more history not loaded" past it). */
export const MAX_UNWRAPS_PER_LOAD = 1000;

/** Wraps asked of a relay per page. */
export const WRAP_PAGE_LIMIT = 250;

/** How long one page may take before the relay counts as not read through. */
export const PAGE_WAIT_MS = 20_000;

/**
 * Passed as `maxWait`: longer than `PAGE_WAIT_MS`, so the library's own EOSE
 * timeout - which it reports exactly like a real EOSE - never ends a page first.
 */
const LIBRARY_WAIT_MS = PAGE_WAIT_MS + 15_000;

/** The close reason nostr-tools gives a `subscribeEose` that reached EOSE (or its own timeout). */
const EOSE_CLOSE_REASON = 'closed automatically on eose';

/** No wrap of an order is dated before this: the earliest order, back-dated. */
const HISTORY_SINCE = EARLIEST_ORDER_SECS - WRAP_BACKDATE_SECS;

/** The part of nostr-tools' `SimplePool` the reader uses. */
export interface WrapPool {
  subscribeEose(
    relays: string[],
    filter: Filter,
    params: {
      maxWait?: number;
      onauth?: (template: EventTemplate) => Promise<VerifiedEvent>;
      onevent?: (event: NostrEvent) => void;
      onclose?: (reasons: string[]) => void;
    },
  ): { close(reason?: string): void };
}

export interface WrapReaderOptions {
  pool: WrapPool;
  relays: readonly string[];
  storePubkey: string;
  /** Answers a relay's NIP-42 challenge with the store key. */
  auth: (template: EventTemplate) => Promise<VerifiedEvent>;
  /** Opens one wrap with the store key, or `undefined` for anything that is not a genuine order message. */
  unwrap: (wrap: NostrEvent) => UnwrappedOrderMessage | undefined;
  now: () => number;
  budget?: number;
  /** Timers, so tests can run them; returns a cancel function. */
  setTimer?: (task: () => void, ms: number) => () => void;
}

/** A stretch of wrap dates still to read from one relay, `until` inclusive. */
interface Range {
  since: number;
  until: number;
}

interface Page {
  wraps: NostrEvent[];
  /** The relay reached its end of stored events in time. */
  complete: boolean;
  /** The relay sent wraps dated outside the range asked. */
  ignoredDates: boolean;
}

export interface LoadResult {
  /** Wraps are left unread because the budget ran out. */
  more: boolean;
  /** Relays that failed to answer a page before the deadline, or ignored the dates asked. */
  partial: string[];
}

export class WrapReader {
  /** Every order message read so far, each rumor once. */
  readonly messages: UnwrappedOrderMessage[] = [];
  private readonly seenWraps = new Set<string>();
  private readonly seenRumors = new Set<string>();
  private readonly ranges = new Map<string, Range[]>();
  private readonly failed = new Set<string>();
  /** Relays that ignored the dates asked: what they hold cannot be paged through. */
  private readonly ignoringDates = new Set<string>();
  /** When the newest stretch was queued: wraps sent since are dated from two days before it. */
  private lastReadAt: number;
  private readonly setTimer: (task: () => void, ms: number) => () => void;

  constructor(private readonly options: WrapReaderOptions) {
    this.setTimer =
      options.setTimer ??
      ((task, ms) => {
        const handle = setTimeout(task, ms);
        return () => clearTimeout(handle);
      });
    const now = options.now();
    this.lastReadAt = now;
    for (const relay of options.relays) {
      this.ranges.set(relay, [{ since: HISTORY_SINCE, until: now }]);
    }
  }

  /** Whether some relay still has wraps to read. */
  get more(): boolean {
    return [...this.ranges.values()].some((ranges) => ranges.length > 0);
  }

  /**
   * Queue the wraps sent since the last read ahead of the history: a new wrap
   * is dated up to two days back (NIP-59), and its rumor up to the skew
   * allowance ahead.
   */
  refresh(): Promise<LoadResult> {
    const now = this.options.now();
    const since = Math.max(
      HISTORY_SINCE,
      this.lastReadAt - WRAP_BACKDATE_SECS - MAX_FUTURE_SKEW_SECS,
    );
    this.lastReadAt = now;
    for (const relay of this.options.relays) {
      const ranges = this.ranges.get(relay) ?? [];
      ranges.unshift({ since, until: now });
      this.ranges.set(relay, ranges);
    }
    return this.load();
  }

  /** Read on, every relay at once, until the history is read or the budget is spent. */
  async load(): Promise<LoadResult> {
    const budget = { left: this.options.budget ?? MAX_UNWRAPS_PER_LOAD };
    await Promise.all(this.options.relays.map((relay) => this.readRelay(relay, budget)));
    return { more: this.more, partial: [...new Set([...this.failed, ...this.ignoringDates])] };
  }

  private async readRelay(relay: string, budget: { left: number }): Promise<void> {
    const ranges = this.ranges.get(relay) ?? [];
    let range = ranges[0];
    while (range !== undefined && budget.left > 0) {
      const page = await this.readPage(relay, range);
      if (!page.complete) {
        // Read again on the next load, from where this page started.
        this.failed.add(relay);
        return;
      }
      this.failed.delete(relay);
      if (page.ignoredDates) {
        this.ignoringDates.add(relay);
      }
      let oldest = range.until;
      let exhausted = false;
      for (const wrap of page.wraps) {
        oldest = Math.min(oldest, wrap.created_at);
        if (this.seenWraps.has(wrap.id)) {
          continue;
        }
        if (budget.left <= 0) {
          exhausted = true;
          continue;
        }
        budget.left -= 1;
        this.seenWraps.add(wrap.id);
        const unwrapped = this.options.unwrap(wrap);
        if (unwrapped !== undefined && !this.seenRumors.has(unwrapped.rumorId)) {
          this.seenRumors.add(unwrapped.rumorId);
          this.messages.push(unwrapped);
        }
      }
      if (exhausted) {
        // This page again next time: the wraps opened now are skipped by id.
        return;
      }
      const next = nextPageUntil(range.since, range.until, page.wraps.length, oldest);
      if (next === undefined) {
        ranges.shift();
        range = ranges[0];
      } else {
        range.until = next;
      }
      // Let the page paint between pages: opening wraps is synchronous work.
      await new Promise<void>((resolve) => this.setTimer(resolve, 0));
    }
  }

  private readPage(relay: string, range: Range): Promise<Page> {
    const { pool, storePubkey, auth } = this.options;
    return new Promise((resolve) => {
      const wraps: NostrEvent[] = [];
      let ignoredDates = false;
      let timedOut = false;
      let cancelTimer: (() => void) | undefined;
      const filter: Filter = {
        kinds: [KIND_GIFT_WRAP],
        '#p': [storePubkey],
        since: range.since,
        until: range.until,
        limit: WRAP_PAGE_LIMIT,
      };
      const subscription = pool.subscribeEose([relay], filter, {
        maxWait: LIBRARY_WAIT_MS,
        onauth: auth,
        onevent: (wrap) => {
          if (wrap.kind !== KIND_GIFT_WRAP) {
            return;
          }
          // A relay that ignores the dates would otherwise page one second at a time.
          if (wrap.created_at < range.since || wrap.created_at > range.until) {
            ignoredDates = true;
            return;
          }
          wraps.push(wrap);
        },
        onclose: (reasons) => {
          cancelTimer?.();
          resolve({
            wraps,
            ignoredDates,
            complete: !timedOut && reasons.every((reason) => reason === EOSE_CLOSE_REASON),
          });
        },
      });
      cancelTimer = this.setTimer(() => {
        timedOut = true;
        subscription.close('timed out');
      }, PAGE_WAIT_MS);
    });
  }
}
