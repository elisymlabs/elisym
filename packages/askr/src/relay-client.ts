import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { Relay } from 'nostr-tools/relay';
import type { SyncRelayClient } from './sync';

/**
 * One page of a history read. A shorter page ends the read, which holds only
 * on a relay that serves a whole page: the Askr relay (nostr-rs-relay 0.10
 * with the production config) answered limits of 500, 1 000 and 5 000 in full
 * (checked 2026-11-12). A relay that cut pages shorter would end a read early.
 */
const PAGE_LIMIT = 500;
/** Pages per filter before a read gives up as incomplete (20 000 events). */
const PAGES_PER_FILTER = 40;
const EOSE_TIMEOUT_MS = 20_000;
/** nostr-tools' own EOSE timer fires `oneose` too: set past ours, so only a real EOSE counts. */
const LIBRARY_EOSE_TIMEOUT_MS = EOSE_TIMEOUT_MS + 10_000;
const CONNECTION_TIMEOUT_MS = 10_000;

/** What the client needs of a relay connection: nostr-tools' `AbstractRelay` fits, and so does a test fake. */
export interface SyncRelayConnection {
  readonly connected: boolean;
  subscribe(
    filters: Filter[],
    params: {
      onevent: (event: NostrEvent) => void;
      oneose: () => void;
      onclose: (reason: string) => void;
      eoseTimeout: number;
    },
  ): { close: () => void };
  publish(event: NostrEvent): Promise<string>;
}

/** One page: resolves the events after a real EOSE, undefined on a close or a timeout. */
function readPage(
  relay: SyncRelayConnection,
  filter: Filter,
  timeoutMs: number,
): Promise<NostrEvent[] | undefined> {
  return new Promise((resolve) => {
    const page: NostrEvent[] = [];
    let settled = false;
    const settle = (events: NostrEvent[] | undefined) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        subscription.close();
        resolve(events);
      }
    };
    const subscription = relay.subscribe([filter], {
      onevent: (event) => {
        // Only what was asked for: another author's events never reach the caller.
        if (!settled && matchFilter(filter, event)) {
          page.push(event);
        }
      },
      oneose: () => settle(page),
      onclose: () => settle(undefined),
      eoseTimeout: LIBRARY_EOSE_TIMEOUT_MS,
    });
    const timer = setTimeout(() => settle(undefined), timeoutMs);
  });
}

/**
 * `syncCatalog`'s relay access over one connection (7.2). A read is whole or
 * it throws: every page must end in a real EOSE, pages step back in time with
 * an inclusive boundary (events kept once by id), and a read that hits the
 * page cap, or a full page adding nothing new, is refused, since a partial
 * read would re-create existing listings and miss stale ones. A publish counts
 * only on the relay's OK. Every call goes to this one relay, whatever list
 * the caller names.
 */
export function relaySyncClient(
  relay: SyncRelayConnection,
  options: { pageTimeoutMs?: number } = {},
): SyncRelayClient {
  const timeoutMs = options.pageTimeoutMs ?? EOSE_TIMEOUT_MS;
  return {
    async query(_relays, filter) {
      const collected = new Map<string, NostrEvent>();
      let until: number | undefined;
      for (let pages = 0; pages < PAGES_PER_FILTER; pages += 1) {
        const page = await readPage(
          relay,
          { ...filter, limit: PAGE_LIMIT, ...(until === undefined ? {} : { until }) },
          timeoutMs,
        );
        if (page === undefined || !relay.connected) {
          throw new Error('The relay did not answer the whole read');
        }
        let added = 0;
        for (const event of page) {
          if (!collected.has(event.id)) {
            collected.set(event.id, event);
            added += 1;
          }
        }
        if (page.length < PAGE_LIMIT) {
          return [...collected.values()];
        }
        if (added === 0) {
          break;
        }
        until = Math.min(...page.map((event) => event.created_at));
      }
      throw new Error('Too many events to read whole');
    },
    async publish(_relays, event) {
      // A refusal (OK false), a timeout and a dropped connection all reject here.
      await relay.publish(event);
    },
  };
}

/** A client on its own connection to `url`; `close` ends it. */
export async function connectSyncClient(
  url: string,
): Promise<SyncRelayClient & { close: () => void }> {
  const relay = new Relay(url);
  await relay.connect({ timeout: CONNECTION_TIMEOUT_MS });
  return { ...relaySyncClient(relay), close: () => relay.close() };
}
