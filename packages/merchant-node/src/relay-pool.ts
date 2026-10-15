import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

/** True when nostr-tools can send a WebSocket ping on this socket (it needs `ping` and `once`). */
function canPing(prototype: object): boolean {
  return 'ping' in prototype && 'once' in prototype;
}

/**
 * The pool `run` listens with. Pings find a half-open socket, which would
 * otherwise never close. nostr-tools sends a WebSocket ping only when the
 * socket can (the built-in one in Node and Bun cannot); otherwise it pings with
 * a `limit: 0` REQ, which some relays (nostr-rs-relay, relay.elisym.network)
 * never answer, and it drops every connection about every 50 s. `ws` can.
 */
export function listeningPool(): SimplePool {
  if (!canPing(globalThis.WebSocket.prototype)) {
    useWebSocketImplementation(WebSocket);
  }
  return new SimplePool({ enablePing: true });
}
