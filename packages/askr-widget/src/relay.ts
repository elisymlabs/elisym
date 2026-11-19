import type { NostrEvent } from 'nostr-tools';
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import type { Filter } from 'nostr-tools/filter';
import { verifyEvent } from 'nostr-tools/pure';
import { CONNECT_TIMEOUT_MS, EOSE_TIMEOUT_SLACK_MS, NO_EOSE_TIMEOUT_MS } from './constants';

export interface RelaySubscriptionHandlers {
  onevent: (event: NostrEvent) => void;
  oneose: () => void;
  onclose: (reason: string) => void;
}

export interface RelaySubscription {
  close: () => void;
}

/**
 * One relay connection, as the chat client needs it. Injectable, so tests can
 * drive EOSE, closes and publishes without a socket.
 */
export interface RelayConnection {
  readonly url: string;
  subscribe: (
    filters: Filter[],
    handlers: RelaySubscriptionHandlers,
    eoseTimeoutMs: number,
  ) => RelaySubscription;
  /** Resolves on the relay's OK true; rejects on OK false, a timeout or a closed socket. */
  publish: (event: NostrEvent) => Promise<void>;
  close: () => void;
  /** Set by the client; called once when the socket closes. */
  onclose: (() => void) | undefined;
}

export type RelayConnect = (url: string) => Promise<RelayConnection>;

/**
 * A real connection over nostr-tools' `AbstractRelay`: no `enableReconnect`
 * (it resubscribes with a `since` that loses backdated wraps) and no
 * `enablePing` (a browser socket cannot ping and `nostr-rs-relay` never
 * answers the REQ-based ping), 2.4. The client reconnects itself.
 */
export async function connectNostrRelay(url: string): Promise<RelayConnection> {
  const relay = new AbstractRelay(url, {
    verifyEvent,
    enablePing: false,
    enableReconnect: false,
  });
  await relay.connect({ timeout: CONNECT_TIMEOUT_MS });
  const connection: RelayConnection = {
    url,
    onclose: undefined,
    subscribe(filters, handlers, eoseTimeoutMs) {
      const subscription = relay.subscribe(filters, {
        onevent: handlers.onevent,
        oneose: handlers.oneose,
        onclose: handlers.onclose,
        eoseTimeout: eoseTimeoutMs,
      });
      return { close: () => subscription.close() };
    },
    async publish(event) {
      await relay.publish(event);
    },
    close() {
      relay.close();
    },
  };
  let closed = false;
  relay.onclose = () => {
    if (closed) {
      return;
    }
    closed = true;
    connection.onclose?.();
  };
  return connection;
}

export interface HistoryReadHandlers {
  onevent: (event: NostrEvent) => void;
  /** A real EOSE: it came before the subscription closed and before our own timer. */
  onEose: () => void;
  /** No real EOSE: the subscription closed first, or our timer ran out (then it is CLOSEd). */
  onFail: () => void;
  /** The subscription closed after its real EOSE (the relay or the socket ended it). */
  onClosedAfterEose?: () => void;
}

export interface HistoryRead {
  close: () => void;
}

/**
 * A REQ that reads history (2.4): judged by a real EOSE only. nostr-tools
 * fires `oneose` on its own `eoseTimeout` and does not clear that timer on
 * close, so an `oneose` counts only before `onclose` and before our timer,
 * which runs shorter than the `eoseTimeout` we hand it.
 */
export function openHistoryRead(
  connection: RelayConnection,
  filters: Filter[],
  handlers: HistoryReadHandlers,
): HistoryRead {
  let gotEose = false;
  // Set by the relay's close, our timer and our own close alike: nothing counts after it.
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subscription = connection.subscribe(
    filters,
    {
      onevent: (event) => {
        if (!closed) {
          handlers.onevent(event);
        }
      },
      oneose: () => {
        if (closed || gotEose) {
          return;
        }
        gotEose = true;
        clearTimeout(timer);
        handlers.onEose();
      },
      onclose: () => {
        if (closed) {
          return;
        }
        closed = true;
        clearTimeout(timer);
        if (gotEose) {
          handlers.onClosedAfterEose?.();
        } else {
          handlers.onFail();
        }
      },
    },
    NO_EOSE_TIMEOUT_MS + EOSE_TIMEOUT_SLACK_MS,
  );
  // Cleared by a real EOSE and by every close, so it fires only while still waiting.
  timer = setTimeout(() => {
    closed = true;
    subscription.close();
    handlers.onFail();
  }, NO_EOSE_TIMEOUT_MS);
  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(timer);
      subscription.close();
    },
  };
}

export class HistoryReadFailed extends Error {
  constructor() {
    super('The relay gave no EOSE in time');
  }
}

/** A one-shot history read: every stored event up to the real EOSE, then CLOSE. */
export function queryHistory(
  connection: RelayConnection,
  filters: Filter[],
): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    const read = openHistoryRead(connection, filters, {
      onevent: (event) => events.push(event),
      onEose: () => {
        queueMicrotask(() => read.close());
        resolve(events);
      },
      onFail: () => reject(new HistoryReadFailed()),
    });
  });
}
