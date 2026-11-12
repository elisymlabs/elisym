import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { CATALOG_PAGE_LIMIT, CATALOG_PAGES_PER_FILTER } from '../constants';
import { readHistory } from './history';
import type { ServerPool } from './pool';

export interface PageLimits {
  connectionTimeoutMs: number;
  pageTimeoutMs?: number;
  /** Unix ms after which the read gives up. */
  deadline?: number;
}

/**
 * Read every page of a filter set backwards in time on one connection (2.4).
 * Undefined unless every page ended in a real EOSE on the same connection.
 * A page boundary is inclusive and events are kept once by id, so events
 * sharing the boundary second are not lost. A relay that keeps answering
 * full pages cannot hold a caller: pages are capped per filter, and
 * `complete` says whether every filter ended before the cap. A full page
 * that adds nothing new (more than a page of events in one second) ends the
 * read too, not complete.
 */
export async function readAllPages(
  pool: Pick<ServerPool, 'ensureRelay'>,
  url: string,
  filters: readonly Filter[],
  limits: PageLimits,
): Promise<{ events: NostrEvent[]; complete: boolean } | undefined> {
  let relay;
  try {
    relay = await pool.ensureRelay(url, { connectionTimeout: limits.connectionTimeoutMs });
  } catch {
    return undefined;
  }
  const collected = new Map<string, NostrEvent>();
  let complete = true;
  for (const filter of filters) {
    let until: number | undefined;
    let ended = false;
    for (let pages = 0; pages < CATALOG_PAGES_PER_FILTER; pages += 1) {
      if (limits.deadline !== undefined && Date.now() >= limits.deadline) {
        return undefined;
      }
      const page: NostrEvent[] = [];
      const pageFilter: Filter = {
        ...filter,
        limit: CATALOG_PAGE_LIMIT,
        ...(until === undefined ? {} : { until }),
      };
      const read = readHistory(
        relay,
        [pageFilter],
        (event) => {
          // Only what was asked for: another author's events never reach the caller.
          if (matchFilter(pageFilter, event)) {
            page.push(event);
          }
        },
        limits.pageTimeoutMs === undefined ? {} : { timeoutMs: limits.pageTimeoutMs },
      );
      const real = await read.done;
      read.close();
      if (!real || !relay.connected) {
        return undefined;
      }
      let added = 0;
      for (const event of page) {
        if (!collected.has(event.id)) {
          collected.set(event.id, event);
          added += 1;
        }
      }
      if (page.length < CATALOG_PAGE_LIMIT) {
        ended = true;
        break;
      }
      if (added === 0) {
        // A full page of events already read: more than a page share one second, which an
        // inclusive `until` cannot step past. Whatever lies before it is unread.
        break;
      }
      until = Math.min(...page.map((event) => event.created_at));
    }
    complete &&= ended;
  }
  return { events: [...collected.values()], complete };
}
