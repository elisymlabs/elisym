import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { listeningPool } from '../src/relay-pool';

/** Short enough for a test, long enough for a pong over loopback. */
const PING_TIMEOUT_MS = 500;

/** The private nostr-tools method `run` relies on, called directly instead of waiting 29 s. */
interface Pinging {
  pingpong(): Promise<void>;
}

/** A relay like nostr-rs-relay: answers WebSocket pings (ws does by itself), never a REQ. */
async function silentRelay(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => resolve());
      }),
  };
}

async function connectionAfterPing(pool: SimplePool, url: string): Promise<boolean> {
  const relay = await pool.ensureRelay(url);
  relay.pingTimeout = PING_TIMEOUT_MS;
  await (relay as unknown as Pinging).pingpong();
  // A failed ping closes the socket: let the close event land.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const connected = relay.connected;
  pool.destroy();
  return connected;
}

describe('listeningPool', () => {
  const builtIn = globalThis.WebSocket;
  afterEach(() => useWebSocketImplementation(builtIn));

  it('keeps the connection to a relay that answers pings but never a limit-0 REQ', async () => {
    const relay = await silentRelay();
    try {
      expect(await connectionAfterPing(listeningPool(), relay.url)).toBe(true);
    } finally {
      await relay.close();
    }
  });

  it("a pool on Node's built-in WebSocket drops it: the failure the pool exists for", async () => {
    const relay = await silentRelay();
    try {
      useWebSocketImplementation(builtIn);
      expect(await connectionAfterPing(new SimplePool({ enablePing: true }), relay.url)).toBe(
        false,
      );
    } finally {
      await relay.close();
    }
  });
});
