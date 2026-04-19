import net from 'node:net';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeRelays } from '../src/diagnostics';

function silentLogger(): ReturnType<typeof pino> {
  return pino({ level: 'silent' });
}

function listenEphemeral(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('listen: unexpected address shape'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

describe('probeRelays', () => {
  let ephemeral: { port: number; close: () => Promise<void> };

  beforeEach(async () => {
    ephemeral = await listenEphemeral();
  });

  afterEach(async () => {
    await ephemeral.close();
  });

  it('returns DNS + TCP open result for a reachable localhost relay', async () => {
    const url = `ws://127.0.0.1:${ephemeral.port}`;
    const results = await probeRelays([url], silentLogger());
    expect(results).toHaveLength(1);
    const [probe] = results;
    expect(probe?.host).toBe('127.0.0.1');
    expect(probe?.port).toBe(ephemeral.port);
    expect(probe?.tcpOpenMs).toBeTypeOf('number');
    expect(probe?.error).toBeUndefined();
  });

  it('returns tcp error for a closed port without crashing', async () => {
    // Hold a listening socket, grab a port, close to guarantee it is free.
    const { port, close } = await listenEphemeral();
    await close();
    const url = `ws://127.0.0.1:${port}`;
    const results = await probeRelays([url], silentLogger(), 500);
    expect(results[0]?.ips).toContain('127.0.0.1');
    expect(results[0]?.tcpOpenMs).toBeUndefined();
    expect(results[0]?.error).toMatch(/tcp:/);
  });

  it('marks unparseable URL as invalid without throwing', async () => {
    const results = await probeRelays(['not a url'], silentLogger());
    expect(results[0]?.error).toBe('invalid URL');
  });

  it('returns dns failure for a non-resolving hostname', async () => {
    // Use a guaranteed-unresolvable TLD per RFC 6761 / 2606 conventions.
    const results = await probeRelays(['wss://definitely-not-a-host.invalid'], silentLogger(), 500);
    expect(results[0]?.error).toMatch(/dns:/);
  });
});
