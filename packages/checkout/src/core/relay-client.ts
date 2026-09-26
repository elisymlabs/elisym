import type { EventTemplate, Filter, NostrEvent, VerifiedEvent } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { normalizeURL } from 'nostr-tools/utils';
import {
  RELAY_CONNECT_MAX_WAIT_MS,
  RELAY_PUBLISH_DEADLINE_MS,
  RELAY_QUERY_DEADLINE_MS,
  RELAY_QUERY_MAX_WAIT_MS,
} from './constants';
import { isEventShaped } from './events';

/** Signs a NIP-42 AUTH event with the buyer key when a relay asks for one. */
export type AuthSigner = (template: EventTemplate) => Promise<VerifiedEvent>;

export interface PublishResult {
  /** Relays that answered OK. */
  accepted: string[];
  /** Relays that refused, failed or timed out, with their reason. */
  failed: { relay: string; reason: string }[];
}

export interface RelayClient {
  /**
   * Every event the relays hold for the filters, each once. Nothing is trusted:
   * the caller checks signatures and authors itself. A relay that fails adds
   * nothing; it does not fail the query.
   */
  query(relays: readonly string[], filters: readonly Filter[]): Promise<NostrEvent[]>;
  publish(relays: readonly string[], event: NostrEvent): Promise<PublishResult>;
  close(): void;
}

/** The part of a connected relay the client uses. */
export interface RelayLike {
  /** Resolves only on the relay's OK true; rejects on a refusal or a timeout. */
  publish(event: NostrEvent): Promise<string>;
  auth(signer: AuthSigner): Promise<string>;
}

/** The part of `SimplePool` the client uses, so tests can stand in for relays. */
export interface PoolLike {
  subscribeEose(
    relays: string[],
    filter: Filter,
    params: {
      maxWait?: number;
      onauth?: AuthSigner;
      onevent?: (event: NostrEvent) => void;
      onclose?: (reasons: string[]) => void;
    },
  ): { close(reason?: string): void };
  ensureRelay(url: string, params?: { connectionTimeout?: number }): Promise<RelayLike>;
  destroy(): void;
}

export interface RelayClientOptions {
  /** Answers NIP-42 AUTH challenges (the buyer key). Without it a relay that asks is refused. */
  auth?: AuthSigner;
  pool?: PoolLike;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A pool that never answers an AUTH challenge on its own: the buyer key signs
 * only for a relay that refuses a request with auth-required (the query's
 * `onauth`, the publish retry), not for every relay that merely asks on connect.
 * Exported for tests.
 */
export function createPool(): SimplePool {
  return new SimplePool();
}

export function createRelayClient(options: RelayClientOptions = {}): RelayClient {
  const pool: PoolLike = options.pool ?? createPool();

  /**
   * One filter at ONE relay to the end of its stored events; a relay that closes
   * with auth-required is retried after AUTH. One subscription per relay: relays
   * sharing a subscription share its seen-id set, so one relay's forged copy of
   * an event id would hide the genuine event from every other relay.
   */
  function queryRelay(relay: string, filter: Filter): Promise<NostrEvent[]> {
    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      let subscription: { close(reason?: string): void } | undefined;
      // An AUTH signer that fails leaves the library's retry pending forever:
      // answer with what arrived by the deadline instead.
      const deadline = setTimeout(() => {
        subscription?.close('deadline');
        resolve(events);
      }, RELAY_QUERY_DEADLINE_MS);
      try {
        subscription = pool.subscribeEose([relay], filter, {
          maxWait: RELAY_QUERY_MAX_WAIT_MS,
          ...(options.auth === undefined ? {} : { onauth: options.auth }),
          onevent: (event) => events.push(event),
          onclose: () => {
            clearTimeout(deadline);
            resolve(events);
          },
        });
      } catch (error) {
        clearTimeout(deadline);
        throw error;
      }
    });
  }

  /**
   * Publish to one relay: accepted only on its OK. A relay that cannot be reached
   * is a failure (the pool's own publish resolves a connection failure as if it
   * were an answer), and an auth-required refusal is retried once after AUTH.
   */
  async function publishOne(url: string, event: NostrEvent): Promise<string> {
    const relay = await pool.ensureRelay(url, { connectionTimeout: RELAY_CONNECT_MAX_WAIT_MS });
    try {
      return await relay.publish(event);
    } catch (error) {
      if (options.auth !== undefined && errorText(error).startsWith('auth-required')) {
        await relay.auth(options.auth);
        return relay.publish(event);
      }
      throw error;
    }
  }

  /** `publishOne` with an overall deadline: a relay that never settles counts as failed. */
  function publishWithDeadline(url: string, event: NostrEvent): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), RELAY_PUBLISH_DEADLINE_MS);
    });
    return Promise.race([publishOne(url, event), deadline]).finally(() => clearTimeout(timer));
  }

  return {
    async query(relays, filters) {
      if (relays.length === 0) {
        return [];
      }
      const seen = new Map<string, NostrEvent>();
      // One subscription per relay and filter: the pool takes a single filter, not a list.
      const batches = await Promise.allSettled(
        filters.flatMap((filter) => relays.map((relay) => queryRelay(relay, filter))),
      );
      for (const batch of batches) {
        if (batch.status !== 'fulfilled') {
          continue;
        }
        for (const event of batch.value) {
          if (isEventShaped(event) && !seen.has(event.id)) {
            seen.set(event.id, event);
          }
        }
      }
      return [...seen.values()];
    },
    async publish(relays, event) {
      // Deduplicated as the pool keys its connections: two spellings of one relay
      // share one connection, and would count as two acknowledgements.
      const byConnection = new Map<string, string>();
      const unusable: string[] = [];
      for (const relay of relays) {
        let connection: string;
        try {
          connection = normalizeURL(relay);
        } catch {
          unusable.push(relay);
          continue;
        }
        if (!byConnection.has(connection)) {
          byConnection.set(connection, relay);
        }
      }
      const targets = [...byConnection.values()];
      const results = await Promise.allSettled(
        targets.map((relay) => publishWithDeadline(relay, event)),
      );
      const outcome: PublishResult = {
        accepted: [],
        failed: unusable.map((relay) => ({ relay, reason: 'not a relay URL' })),
      };
      results.forEach((result, index) => {
        const relay = targets[index];
        if (relay === undefined) {
          return;
        }
        if (result.status === 'fulfilled') {
          outcome.accepted.push(relay);
        } else {
          outcome.failed.push({ relay, reason: errorText(result.reason) });
        }
      });
      return outcome;
    },
    close() {
      pool.destroy();
    },
  };
}
