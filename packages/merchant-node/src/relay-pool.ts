import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

/** True when nostr-tools can send a WebSocket ping on this socket (it needs `ping` and `once`). */
export function canPing(prototype: object): boolean {
  return 'ping' in prototype && 'once' in prototype;
}

/**
 * The pool `run` listens with. Pings find a half-open socket, which would
 * otherwise never close. nostr-tools sends a WebSocket ping only when the
 * socket can (the built-in one in Node and Bun cannot); otherwise it pings with
 * a `limit: 0` REQ, which some relays (nostr-rs-relay, relay.elisym.network)
 * never answer, and it drops every connection about every 50 s. `ws` can. The
 * switch is nostr-tools' own, for every pool the process makes after it.
 */
export function listeningPool(): SimplePool {
  const builtIn: typeof globalThis.WebSocket | undefined = globalThis.WebSocket;
  if (builtIn === undefined || !canPing(builtIn.prototype)) {
    useWebSocketImplementation(WebSocket);
  }
  return new SimplePool({ enablePing: true });
}
