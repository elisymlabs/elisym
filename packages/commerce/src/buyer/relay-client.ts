import type { EventTemplate, Filter, NostrEvent, VerifiedEvent } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { normalizeURL } from 'nostr-tools/utils';
import {
  SUBSCRIBE_RETRY_MAX_MS,
  SUBSCRIBE_RETRY_MS,
  SUBSCRIBE_STABLE_MS,
  RELAY_CONNECT_MAX_WAIT_MS,
  RELAY_PUBLISH_DEADLINE_MS,
  RELAY_QUERY_DEADLINE_MS,
  RELAY_QUERY_MAX_WAIT_MS,
  SLOW_CONNECT_FAILURE_MAX_MS,
  SLOW_CONNECT_FAILURE_MS,
  UNREACHABLE_RELAY_SKIP_MS,
} from './constants';
import { isGenuineEvent } from './events';

/** Signs a NIP-42 AUTH event with the buyer key when a relay asks for one. */
export type AuthSigner = (template: EventTemplate) => Promise<VerifiedEvent>;

export interface PublishResult {
  /** Relays that answered OK. */
  accepted: string[];
  /** Relays that refused, failed or timed out, with their reason. */
  failed: { relay: string; reason: string }[];
}

export interface QueryOptions {
  /**
   * Pass by the relays this client recently waited on and could not connect to.
   * For the reads that open a page only: never for a read that decides where an
   * order goes or what a payment pays, which must try every relay.
   */
  skipUnreachable?: boolean;
}

export interface RelayClient {
  /**
   * Every event the relays hold for the filters, each once. Nothing is trusted:
   * the caller checks signatures and authors itself. A relay that fails adds
   * nothing; it does not fail the query.
   */
  query(
    relays: readonly string[],
    filters: readonly Filter[],
    options?: QueryOptions,
  ): Promise<NostrEvent[]>;
  publish(relays: readonly string[], event: NostrEvent): Promise<PublishResult>;
  /**
   * Keep listening on each relay for `filter`, each event handed on once. A
   * relay that closes the subscription is opened again after a pause; one that
   * asks for AUTH gets it once, signed by the client's key.
   */
  subscribe(
    relays: readonly string[],
    filter: Filter,
    onEvent: (event: NostrEvent) => void,
  ): { close(): void };
  close(): void;
}

/** The part of a connected relay the client uses. */
export interface RelayLike {
  /** Resolves only on the relay's OK true; rejects on a refusal or a timeout. */
  publish(event: NostrEvent): Promise<string>;
  auth(signer: AuthSigner): Promise<string>;
  /** A relay-level subscription: nostr-tools takes a LIST of filters here. */
  subscribe(
    filters: Filter[],
    params: {
      onevent?: (event: NostrEvent) => void;
      oneose?: () => void;
      onclose?: (reason: string) => void;
    },
  ): { close(reason?: string): void };
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

/** What a pool reports about connections, and asks before it opens one for a query. */
export interface ConnectionHooks {
  onRelayConnectionFailure(url: string): void;
  onRelayConnectionSuccess(url: string): void;
}

/** The relays a query waited on and could not connect to, by the pool's spelling of their URL. */
export interface UnreachableRelays extends ConnectionHooks {
  /** A query starts dialling `url`. */
  dialling(url: string): void;
  /** Whether a query that skips unreachable relays passes `url` by now. */
  skipped(url: string): boolean;
}

export interface RelayClientOptions {
  /** Answers NIP-42 AUTH challenges (the buyer key). Without it a relay that asks is refused. */
  auth?: AuthSigner;
  pool?: PoolLike;
}

/** `promise`, or a rejection once `ms` passed. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
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
export function createPool(hooks?: ConnectionHooks): SimplePool {
  const pool = new SimplePool();
  if (hooks !== undefined) {
    // Fired by the pool's own subscriptions (the queries) only: publishes and the
    // long-lived subscriptions connect by hand.
    pool.onRelayConnectionFailure = (url) => hooks.onRelayConnectionFailure(url);
    pool.onRelayConnectionSuccess = (url) => hooks.onRelayConnectionSuccess(url);
  }
  return pool;
}

/**
 * Remembers the relays a query waited on and could not connect to, and passes
 * them by until the skip runs out, for the queries that ask. A failure that came
 * fast is not remembered (retrying it costs nothing), nor one that took longer
 * than a connection wait can (the page was frozen meanwhile).
 */
export function unreachableRelays(skipMs: number = UNREACHABLE_RELAY_SKIP_MS): UnreachableRelays {
  const skippedUntil = new Map<string, number>();
  // When the pending connection attempt began: the earliest, as concurrent
  // queries share one connection.
  const dialledAt = new Map<string, number>();
  return {
    dialling(url) {
      if (!dialledAt.has(url)) {
        dialledAt.set(url, Date.now());
      }
    },
    onRelayConnectionFailure(url) {
      const began = dialledAt.get(url);
      dialledAt.delete(url);
      const waited = began === undefined ? undefined : Date.now() - began;
      if (
        waited !== undefined &&
        waited >= SLOW_CONNECT_FAILURE_MS &&
        waited <= SLOW_CONNECT_FAILURE_MAX_MS
      ) {
        skippedUntil.set(url, Date.now() + skipMs);
      }
    },
    onRelayConnectionSuccess(url) {
      dialledAt.delete(url);
    },
    skipped(url) {
      const until = skippedUntil.get(url);
      if (until !== undefined && Date.now() < until) {
        return true;
      }
      skippedUntil.delete(url);
      return false;
    },
  };
}

/** The pool's spelling of a relay URL, or `undefined` for one it cannot connect to. */
function poolKey(relay: string): string | undefined {
  try {
    return normalizeURL(relay);
  } catch {
    return undefined;
  }
}

export function createRelayClient(options: RelayClientOptions = {}): RelayClient {
  const unreachable = unreachableRelays();
  const pool: PoolLike = options.pool ?? createPool(unreachable);

  /**
   * One filter at ONE relay to the end of its stored events; a relay that closes
   * with auth-required is retried after AUTH. One subscription per relay: relays
   * sharing a subscription share its seen-id set, so one relay's forged copy of
   * an event id would hide the genuine event from every other relay.
   */
  function queryRelay(
    relay: string,
    filter: Filter,
    skipUnreachable: boolean,
  ): Promise<NostrEvent[]> {
    const key = poolKey(relay);
    if (key !== undefined) {
      if (skipUnreachable && unreachable.skipped(key)) {
        return Promise.resolve([]);
      }
      unreachable.dialling(key);
    }
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

  /**
   * One relay's long-lived subscription. It is opened by hand (not through the
   * pool) so an AUTH re-subscription is ours to close, and re-opened after any
   * close with a growing pause until the caller closes it.
   */
  // Every live subscription's closer: closing the client closes them first, or a
  // subscription the pool drops would reconnect on a pool that no longer exists.
  const liveClosers = new Set<() => void>();

  function listenOn(url: string, filter: Filter, onEvent: (event: NostrEvent) => void) {
    let closed = false;
    let attempt = 0;
    // AUTH is answered once per CONNECTION: after a drop the pool builds a new,
    // unauthenticated one, which may ask again.
    let authenticatedOn: RelayLike | undefined;
    let current: { close(reason?: string): void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (closed) {
        return;
      }
      const pause =
        SUBSCRIBE_RETRY_MS[Math.min(attempt, SUBSCRIBE_RETRY_MS.length - 1)] ??
        SUBSCRIBE_RETRY_MAX_MS;
      attempt += 1;
      timer = setTimeout(() => void open(), pause);
    };
    const open = async () => {
      if (closed) {
        return;
      }
      let relay: RelayLike;
      try {
        relay = await pool.ensureRelay(url, { connectionTimeout: RELAY_CONNECT_MAX_WAIT_MS });
      } catch {
        again();
        return;
      }
      if (closed) {
        return;
      }
      let liveSince: number | undefined;
      const subscription = relay.subscribe([filter], {
        onevent: onEvent,
        // nostr-tools also fires this on its own EOSE timeout, even after a CLOSED:
        // only a subscription still open counts.
        oneose: () => {
          if (current === subscription) {
            liveSince = Date.now();
          }
        },
        onclose: (reason) => {
          if (current === subscription) {
            current = undefined;
            // Only a subscription that stayed up a while starts the pauses over.
            if (liveSince !== undefined && Date.now() - liveSince >= SUBSCRIBE_STABLE_MS) {
              attempt = 0;
            }
          }
          if (closed) {
            return;
          }
          if (
            options.auth !== undefined &&
            authenticatedOn !== relay &&
            reason.startsWith('auth-required')
          ) {
            authenticatedOn = relay;
            // A signer that throws leaves nostr-tools' AUTH pending forever: bound it.
            withDeadline(relay.auth(options.auth), RELAY_PUBLISH_DEADLINE_MS).then(
              () => void open(),
              () => again(),
            );
            return;
          }
          again();
        },
      });
      current = subscription;
    };
    void open();
    return () => {
      closed = true;
      clearTimeout(timer);
      current?.close('closed by caller');
    };
  }

  return {
    subscribe(relays, filter, onEvent) {
      const seen = new Set<string>();
      // The id does not cover the signature: a relay could send a same-id copy with
      // a bad one first and hide the genuine copy from another relay. Only a
      // verified event takes its id (nostr-tools verifies too; this does not rely on it).
      const handOn = (event: NostrEvent) => {
        if (!seen.has(event.id) && isGenuineEvent(event)) {
          seen.add(event.id);
          onEvent(event);
        }
      };
      const closers = relays.map((relay) => listenOn(relay, filter, handOn));
      const closeAll = () => {
        for (const close of closers) {
          close();
        }
        liveClosers.delete(closeAll);
      };
      liveClosers.add(closeAll);
      return { close: closeAll };
    },
    async query(relays, filters, queryOptions = {}) {
      if (relays.length === 0) {
        return [];
      }
      const seen = new Map<string, NostrEvent>();
      // One subscription per relay and filter: the pool takes a single filter, not a list.
      const batches = await Promise.allSettled(
        filters.flatMap((filter) =>
          relays.map((relay) => queryRelay(relay, filter, queryOptions.skipUnreachable === true)),
        ),
      );
      for (const batch of batches) {
        if (batch.status !== 'fulfilled') {
          continue;
        }
        for (const event of batch.value) {
          // As in `subscribe`: only a verified copy takes its id.
          if (!seen.has(event.id) && isGenuineEvent(event)) {
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
      for (const close of [...liveClosers]) {
        close();
      }
      // nostr-tools closes only OPEN sockets: one still connecting now opens
      // later and stays idle until the page goes (nothing subscribes on it).
      pool.destroy();
    },
  };
}
