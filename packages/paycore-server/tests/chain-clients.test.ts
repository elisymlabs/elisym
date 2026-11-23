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

  it('a new caller never jumps the queue, even when tokens refilled before the timer fired', async () => {
    let clock = 0;
    const bucket = new TokenBucket({ requestsPerSecond: 1, burst: 1 }, () => clock);
    const done: string[] = [];
    await bucket.take();
    void bucket.take().then(() => {
      done.push('waiting');
    });
    clock += 1000;
    void bucket.take().then(() => {
      done.push('late');
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toEqual([]);
    expect(bucket.queued).toBe(2);
    await vi.advanceTimersToNextTimerAsync();
    expect(done).toEqual(['waiting']);
    clock += 1000;
    await vi.advanceTimersToNextTimerAsync();
    expect(done).toEqual(['waiting', 'late']);
  });

  it('one refill releases every waiter it has tokens for, in one timer', async () => {
    let clock = 0;
    const bucket = new TokenBucket({ requestsPerSecond: 1, burst: 3 }, () => clock);
    for (let index = 0; index < 3; index++) {
      await bucket.take();
    }
    const done: number[] = [];
    for (const index of [0, 1, 2, 3]) {
      void bucket.take().then(() => {
        done.push(index);
      });
    }
    expect(vi.getTimerCount()).toBe(1);
    clock += 3000;
    await vi.advanceTimersToNextTimerAsync();
    expect(done).toEqual([0, 1, 2]);
    expect(bucket.queued).toBe(1);
  });

  it('keeps one timer however many callers wait', () => {
    const bucket = new TokenBucket({ requestsPerSecond: 1, burst: 1 }, () => Date.now());
    for (let index = 0; index < 5; index++) {
      void bucket.take();
    }
    expect(bucket.queued).toBe(4);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('wakes once, when a whole token is free, at a rate that does not divide a second', async () => {
    const bucket = new TokenBucket({ requestsPerSecond: 3, burst: 1 }, () => Date.now());
    await bucket.take();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      let done = false;
      void bucket.take().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(333);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(setTimeoutSpy.mock.calls.map((call) => call[1])).toEqual([334]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('a burst is at least one request, below one per second too', async () => {
    for (const limit of [{ requestsPerSecond: 0.5 }, { requestsPerSecond: 5, burst: 0 }]) {
      const bucket = new TokenBucket(limit, () => Date.now());
      let done = false;
      void bucket.take().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
    }
  });

  it('a clock going backwards takes no token away', async () => {
    let clock = 10_000;
    const bucket = new TokenBucket({ requestsPerSecond: 1, burst: 2 }, () => clock);
    await bucket.take();
    clock -= 5000;
    let done = false;
    void bucket.take().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('does not keep the process alive while callers wait', () => {
    vi.useRealTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const bucket = new TokenBucket({ requestsPerSecond: 1, burst: 1 });
      void bucket.take();
      void bucket.take();
      const timer = setTimeoutSpy.mock.results.at(-1)?.value as
        | { hasRef: () => boolean }
        | undefined;
      expect(timer?.hasRef()).toBe(false);
    } finally {
      setTimeoutSpy.mockRestore();
    }
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

  it('reads the fee config through its own bucket: a saturated store bucket on the same URL never delays it', async () => {
    const sent: string[] = [];
    const transport = (async (request: Parameters<RpcTransport>[0]) => {
      sent.push((request.payload as { method: string }).method);
      return { jsonrpc: '2.0', id: 1, result: null };
    }) as RpcTransport;
    const clients = new ChainClients({
      defaultLimit: { requestsPerSecond: 1, burst: 1 },
      clock: () => Date.now(),
      solanaTransportFor: () => transport,
    });
    const stores = clients.solana(SOLANA_URL);
    const fee = clients.fee(SOLANA_URL);
    expect(fee).not.toBe(stores);
    expect(clients.fee(SOLANA_URL)).toBe(fee);
    expect(clients.feeBucketFor(SOLANA_URL)).not.toBe(clients.bucketFor(SOLANA_URL));
    // Twenty sweeps' calls queued on the stores' bucket: 19 s of backlog at 1/s.
    const sweeps = Array.from({ length: 20 }, () =>
      stores.getSignaturesForAddress('x' as never).send(),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(clients.bucketFor(SOLANA_URL).queued).toBe(19);
    const read = fee.getAccountInfo('y' as never).send();
    await vi.advanceTimersByTimeAsync(0);
    await read;
    expect(sent.filter((method) => method === 'getAccountInfo')).toHaveLength(1);
    expect(sent.filter((method) => method === 'getSignaturesForAddress')).toHaveLength(1);
    // The fee bucket has the URL's limit too: a second read right away waits its turn.
    const again = fee.getAccountInfo('y' as never).send();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((method) => method === 'getAccountInfo')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await again;
    expect(sent.filter((method) => method === 'getAccountInfo')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all(sweeps);
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
