import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilters } from 'nostr-tools/filter';
import type { RelayLike, ServerPool } from '../src/relay/pool';

type SubscribeParams = Parameters<RelayLike['subscribe']>[1];

interface FakeSubscription {
  filters: Filter[];
  params: SubscribeParams;
  live: boolean;
  closed: boolean;
}

/** One relay URL's store and its current connection, nostr-rs-relay style: history, EOSE, then live. */
export class FakeRelay implements RelayLike {
  connected = true;
  readonly events: NostrEvent[] = [];
  readonly subscriptions: FakeSubscription[] = [];
  /** Every REQ opened, for counting reloads and their filters. */
  readonly requests: Filter[][] = [];
  /** The most REQs that read history (not `limit: 0`) open at once. */
  maxOpenHistory = 0;
  /** Ids handed to `onevent`, in order (after `alreadyHaveEvent`). */
  readonly delivered: string[] = [];
  /** When set, a REQ matching it gets its events but no EOSE. */
  holdEose: ((filters: Filter[]) => boolean) | undefined;
  /** When set, a REQ matching it is closed by the relay right after its events. */
  closeOn: ((filters: Filter[]) => boolean) | undefined;
  /** When set, sent to every history REQ whether it matches or not (a misbehaving relay). */
  stray: ((filters: Filter[]) => NostrEvent[]) | undefined;
  /** Answers each REQ this late (a slow relay). */
  delayMs = 0;
  /** When set, the socket dies right after the EOSE of a REQ matching it (no close reaches the REQ yet). */
  disconnectAfterEose: ((filters: Filter[]) => boolean) | undefined;

  constructor(private readonly verify: (event: NostrEvent) => boolean) {}

  get open(): FakeSubscription[] {
    return this.subscriptions.filter((subscription) => !subscription.closed);
  }

  private deliver(subscription: FakeSubscription, event: NostrEvent): void {
    if (subscription.params.alreadyHaveEvent?.(event.id)) {
      return;
    }
    if (!this.verify(event)) {
      return;
    }
    this.delivered.push(event.id);
    subscription.params.onevent?.(event);
  }

  subscribe(filters: Filter[], params: SubscribeParams): { close: (reason?: string) => void } {
    const subscription: FakeSubscription = { filters, params, live: false, closed: false };
    this.subscriptions.push(subscription);
    this.requests.push(filters);
    const close = (reason = 'closed by caller') => {
      if (!subscription.closed) {
        subscription.closed = true;
        params.onclose?.(reason);
      }
    };
    const historyOpen = this.open.filter((open) =>
      open.filters.every((filter) => filter.limit !== 0),
    ).length;
    this.maxOpenHistory = Math.max(this.maxOpenHistory, historyOpen);
    const answer = (run: () => void) =>
      this.delayMs > 0 ? setTimeout(run, this.delayMs) : queueMicrotask(run);
    answer(() => {
      if (subscription.closed) {
        return;
      }
      for (const filter of filters) {
        if (filter.limit === 0) {
          continue;
        }
        const matching = this.events
          .filter((event) => matchFilters([filter], event))
          .sort((left, right) => right.created_at - left.created_at)
          .slice(0, filter.limit ?? Number.MAX_SAFE_INTEGER);
        for (const event of matching) {
          this.deliver(subscription, event);
        }
      }
      const history = filters.every((filter) => filter.limit !== 0 && filter['#p'] === undefined);
      for (const event of history ? (this.stray?.(filters) ?? []) : []) {
        this.deliver(subscription, event);
      }
      if (this.closeOn?.(filters)) {
        close('relay connection closed');
        return;
      }
      if (!this.holdEose?.(filters)) {
        params.oneose?.();
      }
      if (this.disconnectAfterEose?.(filters)) {
        this.disconnectAfterEose = undefined;
        this.connected = false;
      }
      subscription.live = true;
    });
    return { close };
  }

  /** Store an event and hand it to every live REQ it matches. */
  accept(event: NostrEvent): void {
    this.events.push(event);
    for (const subscription of this.open) {
      if (subscription.live && matchFilters(subscription.filters, event)) {
        this.deliver(subscription, event);
      }
    }
  }

  /** The connection drops: every REQ closes. */
  drop(): void {
    this.connected = false;
    for (const subscription of this.open) {
      subscription.closed = true;
      subscription.params.onclose?.('relay connection closed');
    }
  }
}

/**
 * A pool over fake relays, one per URL; a dropped relay is replaced by a new
 * connection over the same events on the next `ensureRelay`, as the real pool does.
 */
export class FakePool implements ServerPool {
  readonly relays = new Map<string, FakeRelay>();
  readonly published: NostrEvent[] = [];
  /** URLs whose connection attempts fail. */
  readonly unreachable = new Set<string>();

  constructor(private readonly verify: (event: NostrEvent) => boolean = () => true) {}

  relay(url: string): FakeRelay {
    const existing = this.relays.get(url);
    if (existing?.connected) {
      return existing;
    }
    const fresh = new FakeRelay(this.verify);
    if (existing) {
      fresh.events.push(...existing.events);
      fresh.holdEose = existing.holdEose;
      fresh.closeOn = existing.closeOn;
    }
    this.relays.set(url, fresh);
    return fresh;
  }

  async ensureRelay(url: string): Promise<RelayLike> {
    if (this.unreachable.has(url)) {
      throw new Error(`cannot connect to ${url}`);
    }
    return this.relay(url);
  }

  publish(relays: string[], event: NostrEvent): Promise<string>[] {
    this.published.push(event);
    return relays.map(async (url) => {
      this.relay(url).accept(event);
      return '';
    });
  }
}
