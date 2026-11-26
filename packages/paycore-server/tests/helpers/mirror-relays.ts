import type { Filter, NostrEvent } from 'nostr-tools';
import type { EventTemplate } from 'nostr-tools/pure';
import type { MirrorPool, MirrorRelay, MirrorSubscribeParams } from '../../src/relay/mirror';

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? '');
}

function matches(filter: Filter, event: NostrEvent, ignoreAuthors: boolean): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (!ignoreAuthors && filter.authors !== undefined && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  for (const name of ['d', 'a'] as const) {
    const wanted = filter[`#${name}`];
    if (wanted !== undefined && !tagValues(event, name).some((value) => wanted.includes(value))) {
      return false;
    }
  }
  return true;
}

export interface RelayBehaviour {
  /**
   * Never sends EOSE or CLOSED. As nostr-tools does, the subscription's own
   * `eoseTimeout` still fires `oneose` (without an EOSE from the relay).
   */
  silent?: boolean;
  /** Answers inside `subscribe`, before it returns. */
  synchronous?: boolean;
  /** Serves events of any author (a lying relay): the sweep must check the author itself. */
  ignoreAuthors?: boolean;
  /** Takes a write only from a connection that authenticated (NIP-42). */
  authForWrites?: boolean;
  /** Closes every subscription with `auth-required` until the connection authenticated. */
  authForReads?: boolean;
  /** Closes every subscription with this reason (after `closeAfterMs`, default at once). */
  closeReads?: string;
  closeAfterMs?: number;
}

/** Relays each holding their own events; every pool of the sweep reads and writes them. */
export class MirrorRelays {
  readonly held = new Map<string, NostrEvent[]>();
  readonly behaviour = new Map<string, RelayBehaviour>();
  /** Every publish tried, by relay. */
  readonly sends: { url: string; event: NostrEvent }[] = [];
  /** The pubkeys connections authenticated as, by relay. */
  readonly auths: { url: string; pubkey: string }[] = [];
  /** Every filter served, by relay (`querySync` and `subscribe` alike). */
  readonly reads: { url: string; filter: Filter }[] = [];
  refuse: (event: NostrEvent, url: string) => boolean = () => false;
  /** A `querySync` of a filter it holds rejects. */
  failQuery: (filter: Filter) => boolean = () => false;
  /** Every `querySync` waits for this first, when set. */
  queryGate: Promise<void> | undefined;
  subscribes = 0;
  closes = 0;
  queries = 0;
  pools = 0;
  destroyed = 0;
  onDestroy: (() => void) | undefined;

  on(url: string): NostrEvent[] {
    return this.held.get(url) ?? [];
  }

  put(url: string, ...events: NostrEvent[]): void {
    this.held.set(url, [...this.on(url), ...events]);
  }

  served(url: string, filter: Filter): NostrEvent[] {
    this.reads.push({ url, filter });
    const ignoreAuthors = this.behaviour.get(url)?.ignoreAuthors === true;
    return this.on(url).filter((event) => matches(filter, event, ignoreAuthors));
  }

  pool(): MirrorPool {
    this.pools += 1;
    const authed = new Set<string>();
    return {
      querySync: async (urls, filter) => {
        this.queries += 1;
        await this.queryGate;
        if (this.failQuery(filter)) {
          throw new Error('relay connection failed');
        }
        const found = new Map<string, NostrEvent>();
        for (const url of urls) {
          for (const event of this.served(url, filter)) {
            found.set(event.id, event);
          }
        }
        return [...found.values()];
      },
      ensureRelay: async (url) => this.relay(url, authed),
      destroy: () => {
        this.destroyed += 1;
        this.onDestroy?.();
      },
    };
  }

  private answer(url: string, filters: Filter[], params: MirrorSubscribeParams): void {
    for (const filter of filters) {
      for (const event of this.served(url, filter)) {
        params.onevent(event);
      }
    }
    params.oneose();
  }

  private relay(url: string, authed: Set<string>): MirrorRelay {
    return {
      subscribe: (filters: Filter[], params: MirrorSubscribeParams) => {
        this.subscribes += 1;
        const behaviour = this.behaviour.get(url) ?? {};
        const timers: ReturnType<typeof setTimeout>[] = [];
        if (behaviour.authForReads === true && !authed.has(url)) {
          queueMicrotask(() => params.onclose('auth-required: reads need a known key'));
        } else if (behaviour.closeReads !== undefined) {
          const reason = behaviour.closeReads;
          timers.push(setTimeout(() => params.onclose(reason), behaviour.closeAfterMs ?? 0));
        } else if (behaviour.silent === true) {
          timers.push(setTimeout(() => params.oneose(), params.eoseTimeout));
        } else if (behaviour.synchronous === true) {
          this.answer(url, filters, params);
        } else {
          queueMicrotask(() => this.answer(url, filters, params));
        }
        return {
          close: () => {
            this.closes += 1;
            for (const timer of timers) {
              clearTimeout(timer);
            }
          },
        };
      },
      publish: async (event: NostrEvent) => {
        this.sends.push({ url, event });
        if (this.behaviour.get(url)?.authForWrites === true && !authed.has(url)) {
          throw new Error('auth-required: this relay takes writes from known keys');
        }
        if (this.refuse(event, url)) {
          throw new Error('blocked: refused');
        }
        this.put(url, event);
        return '';
      },
      auth: async (signer: (template: EventTemplate) => Promise<NostrEvent>) => {
        const signed = await signer({ kind: 22_242, created_at: 0, tags: [], content: '' });
        authed.add(url);
        this.auths.push({ url, pubkey: signed.pubkey });
        return '';
      },
    };
  }
}
