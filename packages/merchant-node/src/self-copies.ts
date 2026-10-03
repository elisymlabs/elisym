import type { NostrEvent } from 'nostr-tools';
import { SELF_COPY_CONCURRENCY, SELF_COPY_QUEUE_MAX, SELF_COPY_RETRY_DELAYS_MS } from './constants';

export interface SelfCopyDeps {
  /** Publish one copy to the store's inbox relays; resolves to the relays that took it. */
  publish: (wrap: NostrEvent) => Promise<string[]>;
  log: (message: string) => void;
  /** Run `task` after `ms`; replaceable in tests. */
  later?: (ms: number, task: () => void) => void;
}

interface PendingCopy {
  wrap: NostrEvent;
  /** What the log calls it: the order key. */
  label: string;
  /** Tries made so far. */
  tries: number;
}

/**
 * The store's copies of its own replies, wrapped to its own key so the admin can
 * read what the node answered. They feed nothing on the node, so they never sit
 * on the ledger queue and never hold up a buyer's delivery: they wait here, a
 * bounded FIFO drained a few at a time, paused while deliveries are published
 * (a relay's rate limit must not refuse a buyer copy because of them).
 */
export class SelfCopies {
  private readonly queue: PendingCopy[] = [];
  private inFlight = 0;
  /** Copies waiting out a retry pause: lost too if the process exits. */
  private waiting = 0;
  private pauses = 0;
  private readonly later: NonNullable<SelfCopyDeps['later']>;

  constructor(private readonly deps: SelfCopyDeps) {
    this.later =
      deps.later ??
      ((ms, task) => {
        setTimeout(task, ms);
      });
  }

  /** Queue a copy; dropped, and logged, only when the queue is full. */
  add(wrap: NostrEvent, label: string): void {
    this.push({ wrap, label, tries: 0 });
  }

  /** Hold the drain while a delivery is published; every `pause` takes one `resume`. */
  pause(): void {
    this.pauses += 1;
  }

  resume(): void {
    this.pauses = Math.max(0, this.pauses - 1);
    this.drain();
  }

  /** Copies still queued, in flight or waiting to retry: lost if the process exits now. */
  get pending(): number {
    return this.queue.length + this.inFlight + this.waiting;
  }

  private push(copy: PendingCopy): void {
    if (this.queue.length >= SELF_COPY_QUEUE_MAX) {
      this.deps.log(`copy for ${copy.label} lost: the copy queue is full`);
      return;
    }
    this.queue.push(copy);
    this.drain();
  }

  private drain(): void {
    while (this.pauses === 0 && this.inFlight < SELF_COPY_CONCURRENCY) {
      const copy = this.queue.shift();
      if (copy === undefined) {
        return;
      }
      this.inFlight += 1;
      void this.send(copy).finally(() => {
        this.inFlight -= 1;
        this.drain();
      });
    }
  }

  private async send(copy: PendingCopy): Promise<void> {
    let taken: string[];
    try {
      taken = await this.deps.publish(copy.wrap);
    } catch {
      taken = [];
    }
    if (taken.length > 0) {
      return;
    }
    const delay = SELF_COPY_RETRY_DELAYS_MS[copy.tries];
    if (delay === undefined) {
      this.deps.log(`copy for ${copy.label} lost: taken by 0 relays`);
      return;
    }
    this.waiting += 1;
    this.later(delay, () => {
      this.waiting -= 1;
      this.push({ ...copy, tries: copy.tries + 1 });
    });
  }
}
