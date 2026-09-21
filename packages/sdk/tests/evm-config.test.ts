/**
 * The fee and the treasury of an EVM chain, read from the config contract.
 * An unreadable config is a REFUSAL: a client that read it as "fee 0" would
 * build a payment the provider then refuses, or pay no fee at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Eip1193Client } from '../src/evm/client';
import {
  WrongEvmChainError,
  clearEvmProtocolConfigCache,
  getEvmProtocolConfig,
} from '../src/evm/config';
import { CHAINS } from '../src/payment/chains';

const TREASURY = '716ebf6bef1c3f27ea5c315ecfc60527d97041a2';
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
      await getEvmProtocolConfig(good.client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 });
      // The contract now answers something this SDK will not price against.
      // Serving the old fee would keep a fleet quoting a fee the chain does not
      // have, split by how long each process had been running.
      const bad = clientAnswering(result);
      await expect(getEvmProtocolConfig(bad.client, CHAINS.TEMPO_DEVNET)).rejects.toThrow(
        /Refusing the elisym config at/,
      );
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
    await getEvmProtocolConfig(good.client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 });
    const stale = await getEvmProtocolConfig(failing.client, CHAINS.TEMPO_DEVNET);
    expect(stale.feeBps).toBe(250);
    expect(stale.source).toBe('cache');
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
    await getEvmProtocolConfig(first.client, CHAINS.TEMPO_DEVNET, { ttlMs: 0 });
    const second = clientAnswering(answer(300));
    const fresh = await getEvmProtocolConfig(second.client, CHAINS.TEMPO_DEVNET);
    expect(fresh.feeBps).toBe(300);
    expect(fresh.source).toBe('onchain');
  });
});
