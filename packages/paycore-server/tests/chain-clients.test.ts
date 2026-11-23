import type { Eip1193Client } from '@elisym/pay-core/evm';
import type { RpcTransport } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainClients, TokenBucket } from '../src/chain/clients';

const SOLANA_URL = 'https://solana.operator.example';
const EVM_URL = 'https://base.operator.example';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TokenBucket', () => {
  it('lets a burst through, then queues in call order at the rate, failing none', async () => {
    const bucket = new TokenBucket({ requestsPerSecond: 2, burst: 2 }, () => Date.now());
    const done: number[] = [];
    const takes = Array.from({ length: 6 }, (_, index) =>
      bucket.take().then(() => {
        done.push(index);
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toEqual([0, 1]);
    expect(bucket.queued).toBe(4);
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toEqual([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toEqual([0, 1, 2, 3, 4, 5]);
    await Promise.all(takes);
    expect(bucket.queued).toBe(0);
  });

  it('refills after a quiet spell, up to the burst only', async () => {
    const bucket = new TokenBucket({ requestsPerSecond: 1, burst: 2 }, () => Date.now());
    await bucket.take();
    await bucket.take();
    await vi.advanceTimersByTimeAsync(60_000);
    const done: number[] = [];
    for (const index of [0, 1, 2]) {
      void bucket.take().then(() => {
        done.push(index);
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toEqual([0, 1, 2]);
  });

  it('refuses a rate that is not above 0', () => {
    expect(() => new TokenBucket({ requestsPerSecond: 0 })).toThrow(/above 0/);
  });
});

describe('ChainClients', () => {
  it('makes one EVM and one Tempo client per URL, sharing that URL limiter', async () => {
    const made: string[] = [];
    const sent: string[] = [];
    const clients = new ChainClients({
      defaultLimit: { requestsPerSecond: 1, burst: 1 },
      clock: () => Date.now(),
      evmClientFor: (url): Eip1193Client => {
        made.push(url);
        return {
          request: async ({ method }) => {
            sent.push(method);
            return '0x1';
          },
        };
      },
    });
    expect(clients.evm(EVM_URL)).toBe(clients.evm(EVM_URL));
    expect(clients.tempo(EVM_URL)).toBe(clients.tempo(EVM_URL));
    expect(made).toEqual([EVM_URL, EVM_URL]);
    const answers = Promise.all([
      clients.evm(EVM_URL).request({ method: 'eth_chainId' }),
      clients.tempo(EVM_URL).request({ method: 'eth_blockNumber' }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['eth_chainId']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(['eth_chainId', 'eth_blockNumber']);
    expect(await answers).toEqual(['0x1', '0x1']);
  });

  it('a URL with its own limit is not slowed by another URL', async () => {
    const sent: string[] = [];
    const clients = new ChainClients({
      defaultLimit: { requestsPerSecond: 1, burst: 1 },
      limits: new Map([['https://fast.example', { requestsPerSecond: 100 }]]),
      clock: () => Date.now(),
      evmClientFor: (url): Eip1193Client => ({
        request: async () => {
          sent.push(url);
          return null;
        },
      }),
    });
    const slow = clients.evm('https://slow.example');
    const fast = clients.evm('https://fast.example');
    void slow.request({ method: 'a' });
    void slow.request({ method: 'b' });
    for (let index = 0; index < 5; index++) {
      void fast.request({ method: 'c' });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((url) => url === 'https://fast.example')).toHaveLength(5);
    expect(sent.filter((url) => url === 'https://slow.example')).toHaveLength(1);
  });

  it('sends Solana requests through the limited transport, one client per URL', async () => {
    const payloads: unknown[] = [];
    const transport = (async (request: Parameters<RpcTransport>[0]) => {
      payloads.push(request.payload);
      return { jsonrpc: '2.0', id: 1, result: 'genesis' };
    }) as RpcTransport;
    const madeFor: string[] = [];
    const clients = new ChainClients({
      defaultLimit: { requestsPerSecond: 1, burst: 1 },
      clock: () => Date.now(),
      solanaTransportFor: (url) => {
        madeFor.push(url);
        return transport;
      },
    });
    const rpc = clients.solana(SOLANA_URL);
    expect(clients.solana(SOLANA_URL)).toBe(rpc);
    expect(madeFor).toEqual([SOLANA_URL]);
    const first = rpc.getGenesisHash().send();
    const second = rpc.getSlot().send();
    await vi.advanceTimersByTimeAsync(0);
    expect(payloads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(payloads).toHaveLength(2);
    expect(payloads.map((payload) => (payload as { method: string }).method)).toEqual([
      'getGenesisHash',
      'getSlot',
    ]);
    await Promise.all([first, second]);
  });
});
