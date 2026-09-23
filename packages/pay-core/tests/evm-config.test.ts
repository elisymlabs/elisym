/**
 * The fee and the treasury of an EVM chain, read from the config contract.
 * An unreadable config is a REFUSAL: a client that read it as "fee 0" would
 * build a payment the provider then refuses, or pay no fee at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Eip1193Client } from '@elisym/pay-core';
import {
  WrongEvmChainError,
  checkEvmChain,
  clearEvmProtocolConfigCache,
  getEvmProtocolConfig,
} from '@elisym/pay-core';
import { CHAINS } from '@elisym/pay-core';

const TREASURY = '716ebf6bef1c3f27ea5c315ecfc60527d97041a2';

/** A second EVM chain with a contract of its own, for the per-chain rules. */
const SECOND_CHAIN = {
  ...CHAINS.TEMPO_DEVNET,
  caip2: 'eip155:31337',
  evmChainId: 31337,
  protocolConfig: { address: `0x${'ab'.repeat(20)}` },
};
const VIRTUAL = '11223344fdfdfdfdfdfdfdfdfdfd556677889900';

function word(hex: string): string {
  return hex.padStart(64, '0');
}

function answer(feeBps: number | bigint, treasury = TREASURY): string {
  return `0x${word(BigInt(feeBps).toString(16))}${word(treasury)}`;
}

function clientAnswering(result: unknown, chainId: unknown = '0xa5bf') {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') {
      return chainId;
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  return { client: { request } as unknown as Eip1193Client, request };
}

beforeEach(() => {
  clearEvmProtocolConfigCache();
});

describe('getEvmProtocolConfig', () => {
  it('reads the fee and the treasury from the registry contract, chain id first', async () => {
    const { client, request } = clientAnswering(answer(250));
    const config = await getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET);
    expect(config).toEqual({
      chain: 'eip155:42431',
      contract: CHAINS.TEMPO_DEVNET.protocolConfig.address,
      feeBps: 250,
      treasury: `0x${TREASURY}`,
      source: 'onchain',
    });
    expect(request.mock.calls[0]?.[0]).toEqual({ method: 'eth_chainId' });
    expect(request.mock.calls[1]?.[0]).toEqual({
      method: 'eth_call',
      params: [{ to: CHAINS.TEMPO_DEVNET.protocolConfig.address, data: '0x79502c55' }, 'finalized'],
    });
  });

  it('refuses a chain that has no config contract in this SDK', async () => {
    const { client, request } = clientAnswering(answer(0));
    await expect(getEvmProtocolConfig(client, CHAINS.TEMPO_MAINNET)).rejects.toThrow(
      /No elisym config contract/,
    );
    await expect(getEvmProtocolConfig(client, CHAINS.SOLANA_DEVNET)).rejects.toThrow(
      /No elisym config contract/,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing at all - what an address with no code answers', '0x'],
    ['one word', `0x${word('0')}`],
    ['three words', `${answer(0)}${word('0')}`],
    ['a fee above the contract’s own cap', answer(1001)],
    ['a fee with dirty upper bytes', answer(2n ** 200n)],
    ['a treasury with dirty upper bytes', `0x${word('0')}${'ff'.repeat(12)}${TREASURY}`],
    ['the zero treasury at a fee above zero', answer(100, '0'.repeat(40))],
    ['a virtual treasury at a fee above zero', answer(100, VIRTUAL)],
    ['a result that is not hex', '0xzz'],
    ['a result that is not a string', 7],
    ['null', null],
  ])('refuses %s', async (_label, result) => {
    const { client } = clientAnswering(result);
    await expect(getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET)).rejects.toThrow(
      /Refusing the elisym config at/,
    );
  });

  it.each([
    ['a fee above the cap', answer(1001)],
    ['a treasury that cannot receive a fee', answer(100, '0'.repeat(40))],
    ['an answer that is not two words', '0x'],
  ])(
    'still refuses %s with a good snapshot cached, and drops that snapshot',
    async (_label, result) => {
      const good = clientAnswering(answer(250));
      await getEvmProtocolConfig(good.client, CHAINS.TEMPO_DEVNET);
      // The contract now answers something this SDK will not price against.
      // Serving the old fee would keep a fleet quoting a fee the chain does not
      // have, split by how long each process had been running.
      const bad = clientAnswering(result);
      await expect(
        getEvmProtocolConfig(bad.client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 }),
      ).rejects.toThrow(/Refusing the elisym config at/);
      // And the snapshot is gone: the next transport failure has nothing to serve.
      const failing = clientAnswering(new Error('rpc exploded'));
      await expect(getEvmProtocolConfig(failing.client, CHAINS.TEMPO_DEVNET)).rejects.toThrow(
        /no cached value exists/,
      );
    },
  );

  it('hands back a COPY, so a caller cannot rewrite the fee other callers read', async () => {
    const { client } = clientAnswering(answer(250));
    const first = await getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET);
    first.feeBps = 0;
    first.treasury = `0x${'11'.repeat(20)}`;
    const second = await getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET);
    expect(second.feeBps).toBe(250);
    expect(second.treasury).toBe(`0x${TREASURY}`);
  });

  it('accepts any treasury at fee 0: nothing is ever sent to it', async () => {
    const { client } = clientAnswering(answer(0, '0'.repeat(40)));
    const config = await getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET);
    expect(config.feeBps).toBe(0);
  });

  it('accepts the fee AT the cap and an uppercase hex answer', async () => {
    const { client } = clientAnswering(answer(1000).toUpperCase().replace('0X', '0x'));
    const config = await getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET);
    expect(config.feeBps).toBe(1000);
    expect(config.treasury).toBe(`0x${TREASURY}`);
  });

  it('throws on a WRONG chain id, and never serves the cache for it', async () => {
    const good = clientAnswering(answer(250));
    await getEvmProtocolConfig(good.client, CHAINS.TEMPO_DEVNET);
    // The same process is now pointed at mainnet's endpoint for the devnet chain.
    const wrong = clientAnswering(answer(250), '0x1079');
    await expect(
      getEvmProtocolConfig(wrong.client, CHAINS.TEMPO_DEVNET, { forceRefresh: true }),
    ).rejects.toBeInstanceOf(WrongEvmChainError);
    expect(wrong.request).toHaveBeenCalledTimes(1);
  });

  it('refuses an unreadable chain id when nothing is cached', async () => {
    const { client } = clientAnswering(answer(250), 'not-a-quantity');
    await expect(getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET)).rejects.toThrow(
      /eth_chainId was unreadable/,
    );
  });

  it('checks the chain even on a cache HIT: a snapshot belongs to one chain', async () => {
    const good = clientAnswering(answer(250));
    await getEvmProtocolConfig(good.client, CHAINS.TEMPO_DEVNET);
    // Same process, same chain asked about, an endpoint that is now mainnet.
    const wrong = clientAnswering(answer(250), '0x1079');
    await expect(getEvmProtocolConfig(wrong.client, CHAINS.TEMPO_DEVNET)).rejects.toBeInstanceOf(
      WrongEvmChainError,
    );
  });

  it('hands back a copy on the CACHE path too', async () => {
    const { client } = clientAnswering(answer(250));
    await getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET);
    const cached = await getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET);
    cached.feeBps = 0;
    const again = await getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET);
    expect(again.feeBps).toBe(250);
  });

  it('serves the cache when the chain-id read FAILS: a failure is not a wrong chain', async () => {
    const good = clientAnswering(answer(250));
    await getEvmProtocolConfig(good.client, CHAINS.TEMPO_DEVNET);
    const failing = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          throw new Error('rpc exploded');
        }
        return answer(999);
      },
    } as unknown as Eip1193Client;
    const cached = await getEvmProtocolConfig(failing, CHAINS.TEMPO_DEVNET, { ttlMs: 0 });
    expect(cached.feeBps).toBe(250);
    expect(cached.source).toBe('cache');
  });

  it('serves the cache inside the TTL, reading only the chain id', async () => {
    const first = clientAnswering(answer(250));
    await getEvmProtocolConfig(first.client, CHAINS.TEMPO_DEVNET);
    const second = clientAnswering(answer(999));
    const cached = await getEvmProtocolConfig(second.client, CHAINS.TEMPO_DEVNET);
    expect(cached.feeBps).toBe(250);
    expect(cached.source).toBe('cache');
    expect(second.request).toHaveBeenCalledTimes(1);
    expect(second.request.mock.calls[0]?.[0]).toEqual({ method: 'eth_chainId' });
  });

  it('serves the cache when the chain id is unreadable: that is not a wrong chain', async () => {
    const first = clientAnswering(answer(250));
    await getEvmProtocolConfig(first.client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 });
    const mute = clientAnswering(answer(999), 'not-a-quantity');
    const cached = await getEvmProtocolConfig(mute.client, CHAINS.TEMPO_DEVNET);
    expect(cached.feeBps).toBe(250);
    expect(cached.source).toBe('cache');
  });

  it('serves the last good snapshot when the rpc FAILS, and throws when there is none', async () => {
    const failing = clientAnswering(new Error('rpc exploded'));
    await expect(getEvmProtocolConfig(failing.client, CHAINS.TEMPO_DEVNET)).rejects.toThrow(
      /no cached value exists/,
    );
    const good = clientAnswering(answer(250));
    await getEvmProtocolConfig(good.client, CHAINS.TEMPO_DEVNET);
    const stale = await getEvmProtocolConfig(failing.client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 });
    expect(stale.feeBps).toBe(250);
    expect(stale.source).toBe('cache');
    expect(stale.cachedAgeMs).toBeGreaterThanOrEqual(0);
  });

  it('forceRefresh reads again inside the TTL', async () => {
    const first = clientAnswering(answer(250));
    await getEvmProtocolConfig(first.client, CHAINS.TEMPO_DEVNET);
    const second = clientAnswering(answer(300));
    const fresh = await getEvmProtocolConfig(second.client, CHAINS.TEMPO_DEVNET, {
      forceRefresh: true,
    });
    expect(fresh.feeBps).toBe(300);
    expect(fresh.source).toBe('onchain');
  });

  it('reads again once the TTL has passed', async () => {
    const first = clientAnswering(answer(250));
    await getEvmProtocolConfig(first.client, CHAINS.TEMPO_DEVNET);
    const second = clientAnswering(answer(300));
    const fresh = await getEvmProtocolConfig(second.client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 });
    expect(fresh.feeBps).toBe(300);
    expect(fresh.source).toBe('onchain');
  });

  it('keeps one caller’s long TTL out of what every other caller reads', async () => {
    // `ttlMs` is how much staleness THIS call will accept, never a deadline
    // written into a cache the whole process shares.
    const first = clientAnswering(answer(250));
    await getEvmProtocolConfig(first.client, CHAINS.TEMPO_DEVNET, { ttlMs: 3_600_000 });
    const second = clientAnswering(answer(300));
    const fresh = await getEvmProtocolConfig(second.client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 });
    expect(fresh.feeBps).toBe(300);
  });

  it('serves the cache rather than throwing when a DEADLINE lands on the chain read', async () => {
    // The option says a cached snapshot is still served, and that must not
    // depend on which of the two round trips happened to be the slow one.
    const good = clientAnswering(answer(250));
    await getEvmProtocolConfig(good.client, CHAINS.TEMPO_DEVNET);
    const hanging = {
      request: async () => new Promise(() => undefined),
    } as unknown as Eip1193Client;
    const cached = await getEvmProtocolConfig(hanging, CHAINS.TEMPO_DEVNET, {
      ttlMs: 0,
      signal: AbortSignal.timeout(10),
    });
    expect(cached.feeBps).toBe(250);
    expect(cached.source).toBe('cache');
  });

  it('throws on a deadline when there is no snapshot to fall back to', async () => {
    const hanging = {
      request: async () => new Promise(() => undefined),
    } as unknown as Eip1193Client;
    await expect(
      getEvmProtocolConfig(hanging, CHAINS.TEMPO_DEVNET, { signal: AbortSignal.timeout(10) }),
    ).rejects.toThrow(/no cached value exists/);
  });

  it('lets a read that started AFTER a refusal establish a snapshot again', async () => {
    // The order is what decides, not the verdict: this read asked the chain
    // later than the refusal did, so its answer is the current one. Blocking it
    // would leave the process refusing a config the chain no longer has.
    await getEvmProtocolConfig(clientAnswering(answer(250)).client, CHAINS.TEMPO_DEVNET);
    await expect(
      getEvmProtocolConfig(clientAnswering(answer(1001)).client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 }),
    ).rejects.toThrow(/Refusing the elisym config at/);
    const recovered = await getEvmProtocolConfig(
      clientAnswering(answer(300)).client,
      CHAINS.TEMPO_DEVNET,
    );
    expect(recovered.feeBps).toBe(300);
  });

  it('an OVERLAPPING read is never served a snapshot a refusal has removed', async () => {
    // The trigger needs nothing exotic: two ordinary reads overlap, the later
    // one refuses, and the earlier one - which entered while the old snapshot
    // was good - must not hand its caller the fee that refusal just retired.
    await getEvmProtocolConfig(clientAnswering(answer(250)).client, CHAINS.TEMPO_DEVNET);
    const slowChainId = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return '0xa5bf';
        }
        return answer(250);
      },
    } as unknown as Eip1193Client;
    const overlapping = getEvmProtocolConfig(slowChainId, CHAINS.TEMPO_DEVNET);
    await expect(
      getEvmProtocolConfig(clientAnswering(answer(1001)).client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 }),
    ).rejects.toThrow(/Refusing the elisym config at/);
    const served = await overlapping;
    expect(served.source).toBe('onchain');
    expect(served.feeBps).toBe(250);
  });

  it('serves a snapshot another read established while this one was failing', async () => {
    // Entered on an empty cache, so a reference taken at entry would have been
    // `undefined` and this would refuse - although a good snapshot now exists.
    const slowFailing = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return '0xa5bf';
        }
        throw new Error('rpc exploded');
      },
    } as unknown as Eip1193Client;
    const failing = getEvmProtocolConfig(slowFailing, CHAINS.TEMPO_DEVNET);
    await getEvmProtocolConfig(clientAnswering(answer(250)).client, CHAINS.TEMPO_DEVNET);
    const served = await failing;
    expect(served.feeBps).toBe(250);
    expect(served.source).toBe('cache');
  });

  it('keeps the value of the read that asked the chain LAST', async () => {
    const slowOld = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          return '0xa5bf';
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        return answer(250);
      },
    } as unknown as Eip1193Client;
    const older = getEvmProtocolConfig(slowOld, CHAINS.TEMPO_DEVNET);
    const newer = await getEvmProtocolConfig(
      clientAnswering(answer(300)).client,
      CHAINS.TEMPO_DEVNET,
      {
        ttlMs: 0,
      },
    );
    expect(newer.feeBps).toBe(300);
    await older;
    const cached = await getEvmProtocolConfig(
      clientAnswering(answer(999)).client,
      CHAINS.TEMPO_DEVNET,
    );
    expect(cached.feeBps).toBe(300);
    expect(cached.source).toBe('cache');
  });

  it('does not let one chain read block another chain from caching', async () => {
    // A second EVM chain that really has a contract - `TEMPO_MAINNET` has none,
    // so a test built on it never reaches the client at all.
    const slowOther = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return '0x7a69';
        }
        return answer(250);
      },
    } as unknown as Eip1193Client;
    const other = getEvmProtocolConfig(slowOther, SECOND_CHAIN);
    await getEvmProtocolConfig(clientAnswering(answer(250)).client, CHAINS.TEMPO_DEVNET);
    expect((await other).feeBps).toBe(250);
    const cached = await getEvmProtocolConfig(
      clientAnswering(answer(999)).client,
      CHAINS.TEMPO_DEVNET,
    );
    expect(cached.source).toBe('cache');
    expect(cached.feeBps).toBe(250);
  });

  it('keeps one chain snapshot out of another chain answer', async () => {
    await getEvmProtocolConfig(clientAnswering(answer(250)).client, CHAINS.TEMPO_DEVNET);
    const second = await getEvmProtocolConfig(
      clientAnswering(answer(300), '0x7a69').client,
      SECOND_CHAIN,
    );
    expect(second.feeBps).toBe(300);
    expect(second.chain).toBe('eip155:31337');
  });

  it('does not serve one CONTRACT snapshot for another on the same chain', async () => {
    // "A new version is a new address" is how this contract is replaced, and a
    // snapshot is of a chain AND a contract.
    await getEvmProtocolConfig(clientAnswering(answer(250)).client, CHAINS.TEMPO_DEVNET);
    const movedContract = {
      ...CHAINS.TEMPO_DEVNET,
      protocolConfig: { address: `0x${'cd'.repeat(20)}` },
    };
    const fresh = await getEvmProtocolConfig(clientAnswering(answer(300)).client, movedContract);
    expect(fresh.feeBps).toBe(300);
    expect(fresh.source).toBe('onchain');
  });

  it('a clear bars an in-flight read even for a chain it had no entry for', async () => {
    const slow = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          return '0xa5bf';
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        return answer(250);
      },
    } as unknown as Eip1193Client;
    const inFlight = getEvmProtocolConfig(slow, CHAINS.TEMPO_DEVNET);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearEvmProtocolConfigCache();
    await inFlight;
    const failing = clientAnswering(new Error('rpc exploded'));
    await expect(getEvmProtocolConfig(failing.client, CHAINS.TEMPO_DEVNET)).rejects.toThrow(
      /no cached value exists/,
    );
  });

  it('a cleared cache is not repopulated by a read that was already in flight', async () => {
    await getEvmProtocolConfig(clientAnswering(answer(250)).client, CHAINS.TEMPO_DEVNET);
    // Already past its own `eth_call` when the clear lands, so its answer is
    // older than the clear and must not become the cache again. (A read that
    // asks the chain AFTER the clear is a fresh read and does cache.)
    const slow = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          return '0xa5bf';
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        return answer(250);
      },
    } as unknown as Eip1193Client;
    const inFlight = getEvmProtocolConfig(slow, CHAINS.TEMPO_DEVNET, { ttlMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearEvmProtocolConfigCache();
    await inFlight;
    const failing = clientAnswering(new Error('rpc exploded'));
    await expect(getEvmProtocolConfig(failing.client, CHAINS.TEMPO_DEVNET)).rejects.toThrow(
      /no cached value exists/,
    );
  });

  it('gives up awaiting a deadline on the CALL, not only on the chain read', async () => {
    const good = clientAnswering(answer(250));
    await getEvmProtocolConfig(good.client, CHAINS.TEMPO_DEVNET);
    const hangingCall = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          return '0xa5bf';
        }
        return new Promise(() => undefined);
      },
    } as unknown as Eip1193Client;
    const cached = await getEvmProtocolConfig(hangingCall, CHAINS.TEMPO_DEVNET, {
      ttlMs: 0,
      signal: AbortSignal.timeout(10),
    });
    expect(cached.source).toBe('cache');
    expect(cached.feeBps).toBe(250);
  });

  it('measures the age from when the chain was ASKED, not from when it answered', async () => {
    // The round trip that separates the two stamps is the eth_call's, not the
    // chain id's: a test that delays the chain id would pass either way.
    const slowCall = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          return '0xa5bf';
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
        return answer(250);
      },
    } as unknown as Eip1193Client;
    await getEvmProtocolConfig(slowCall, CHAINS.TEMPO_DEVNET);
    const cached = await getEvmProtocolConfig(
      clientAnswering(answer(999)).client,
      CHAINS.TEMPO_DEVNET,
    );
    expect(cached.source).toBe('cache');
    expect(cached.cachedAgeMs ?? -1).toBeGreaterThanOrEqual(55);
  });

  it('does not count the chain-id read as age: the ticket is taken after it', async () => {
    const slowChainId = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return '0xa5bf';
        }
        return answer(250);
      },
    } as unknown as Eip1193Client;
    await getEvmProtocolConfig(slowChainId, CHAINS.TEMPO_DEVNET);
    const cached = await getEvmProtocolConfig(
      clientAnswering(answer(999)).client,
      CHAINS.TEMPO_DEVNET,
    );
    expect(cached.cachedAgeMs ?? Number.MAX_SAFE_INTEGER).toBeLessThan(30);
  });

  it('reports a real age, and never a negative one', async () => {
    const { client } = clientAnswering(answer(250));
    await getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const cached = await getEvmProtocolConfig(client, CHAINS.TEMPO_DEVNET);
    expect(cached.cachedAgeMs ?? -1).toBeGreaterThan(15);
    // And from above: a wall-clock value here would be about 1.79e12.
    expect(cached.cachedAgeMs ?? Number.MAX_SAFE_INTEGER).toBeLessThan(5_000);
  });

  it('a REFUSAL is not undone by a slower good read that was already in flight', async () => {
    // Both writers are last-one-wins by arrival, so without a generation the
    // refusal deletes the snapshot and the older read puts it straight back.
    await getEvmProtocolConfig(clientAnswering(answer(250)).client, CHAINS.TEMPO_DEVNET);
    const slowGood = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') {
          return '0xa5bf';
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        return answer(250);
      },
    } as unknown as Eip1193Client;
    const settled = await Promise.allSettled([
      getEvmProtocolConfig(slowGood, CHAINS.TEMPO_DEVNET, { ttlMs: 0 }),
      getEvmProtocolConfig(clientAnswering(answer(1001)).client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 }),
    ]);
    expect(settled.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    const failing = clientAnswering(new Error('rpc exploded'));
    await expect(getEvmProtocolConfig(failing.client, CHAINS.TEMPO_DEVNET)).rejects.toThrow(
      /no cached value exists/,
    );
  });
});

describe('checkEvmChain', () => {
  it('returns the chain id when the endpoint is the chain asked about', async () => {
    const { client } = clientAnswering('0x', '0xa5bf');
    expect(await checkEvmChain(client, CHAINS.TEMPO_DEVNET)).toBe(42431n);
  });

  it('throws on a chain that is not the one asked about', async () => {
    const { client } = clientAnswering('0x', '0x1079');
    await expect(checkEvmChain(client, CHAINS.TEMPO_DEVNET)).rejects.toBeInstanceOf(
      WrongEvmChainError,
    );
  });

  it.each([
    ['an answer that is not a quantity', 'not-a-quantity'],
    ['a JSON number, which a compliant node never sends', 42431],
    ['nothing at all', null],
  ])('answers null - not a wrong chain - on %s', async (_label, chainId) => {
    const { client } = clientAnswering('0x', chainId);
    expect(await checkEvmChain(client, CHAINS.TEMPO_DEVNET)).toBeNull();
  });

  it('answers null when the read FAILS: a caller with a snapshot may still use it', async () => {
    const client = {
      request: async () => {
        throw new Error('rpc exploded');
      },
    } as unknown as Eip1193Client;
    expect(await checkEvmChain(client, CHAINS.TEMPO_DEVNET)).toBeNull();
  });

  it('refuses a chain that is not an EVM one at all', async () => {
    const { client } = clientAnswering('0x');
    await expect(checkEvmChain(client, CHAINS.SOLANA_DEVNET)).rejects.toThrow(
      /is not an EVM chain/,
    );
  });
});
