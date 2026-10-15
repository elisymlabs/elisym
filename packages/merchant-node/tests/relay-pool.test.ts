import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { canPing, listeningPool } from '../src/relay-pool';

/** Short enough for a test, long enough for a pong over loopback. */
const PING_TIMEOUT_MS = 500;
/** How long a failed ping may take to close the socket. */
const CLOSE_DEADLINE_MS = 2000;

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

interface AfterPing {
  pinging: boolean;
  connected: boolean;
}

async function connectionAfterPing(pool: SimplePool, url: string): Promise<AfterPing> {
  try {
    const relay = await pool.ensureRelay(url);
    relay.pingTimeout = PING_TIMEOUT_MS;
    await (relay as unknown as Pinging).pingpong();
    // A failed ping closes the socket: wait for the close to land.
    const deadline = Date.now() + CLOSE_DEADLINE_MS;
    while (relay.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { pinging: relay.enablePing === true, connected: relay.connected };
  } finally {
    pool.destroy();
  }
}

describe('canPing', () => {
  it('needs both ping and once, as nostr-tools does', () => {
    expect(canPing({ ping() {}, once() {} })).toBe(true);
    // Bun's built-in WebSocket: ping without once.
    expect(canPing({ ping() {} })).toBe(false);
    expect(canPing({ once() {} })).toBe(false);
    expect(canPing({})).toBe(false);
  });
});

describe('listeningPool', () => {
  const builtIn = globalThis.WebSocket;
  afterEach(() => {
    vi.unstubAllGlobals();
    useWebSocketImplementation(builtIn);
  });

  it('keeps the connection to a relay that answers pings but never a limit-0 REQ', async () => {
    const relay = await silentRelay();
    try {
      expect(await connectionAfterPing(listeningPool(), relay.url)).toEqual({
        pinging: true,
        connected: true,
      });
    } finally {
      await relay.close();
    }
  });

  it('uses ws on a runtime with no global WebSocket', async () => {
    const relay = await silentRelay();
    try {
      vi.stubGlobal('WebSocket', undefined);
      expect(await connectionAfterPing(listeningPool(), relay.url)).toEqual({
        pinging: true,
        connected: true,
      });
    } finally {
      await relay.close();
    }
  });

  it("a pool on Node's built-in WebSocket drops it: the failure the pool exists for", async () => {
    const relay = await silentRelay();
    try {
      useWebSocketImplementation(builtIn);
      const after = await connectionAfterPing(new SimplePool({ enablePing: true }), relay.url);
      expect(after.connected).toBe(false);
    } finally {
      await relay.close();
    }
  });
});
