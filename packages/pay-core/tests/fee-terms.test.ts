import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FeeConfigError,
  MAX_FEE_BPS,
  PROTOCOL_PROGRAM_ID_MAINNET,
  clearProtocolConfigCache,
  feeAmountFor,
  getProtocolConfig,
  protocolFeeFor,
  readFeeTerms,
  solanaConfigNetworkFor,
} from '../src/index';
import { TEMPO_FEE_SINK } from '../src/payment/chains';

const SOLANA_TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
const EVM_TREASURY = '0x7edb1404ebae28332867756c0d01440b9e63f3f7';
const RECIPIENT_EVM = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const { fetchConfigMock, derivedFor } = vi.hoisted(() => ({
  fetchConfigMock: vi.fn(),
  derivedFor: [] as string[],
}));

vi.mock('@elisym/config-client', () => ({
  deriveConfigAddress: vi.fn(async (programId: string) => {
    derivedFor.push(programId);
    return 'ConfigPda1111111111111111111111111111111111' as Address;
  }),
  fetchConfig: (...args: unknown[]) => fetchConfigMock(...args),
  CONFIG_SEED: 'config',
  MAX_FEE_BPS: 1000,
}));

function account(feeBps: number, evmTreasury: Uint8Array = new Uint8Array(20)) {
  return {
    address: 'ConfigPda1111111111111111111111111111111111' as Address,
    data: {
      feeBps,
      treasury: SOLANA_TREASURY,
      admin: SOLANA_TREASURY,
      pendingAdmin: { __option: 'None' as const },
      paused: false,
      version: 1,
      evmTreasury,
    },
  };
}

function evmBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.slice(2).match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** An rpc that answers `getGenesisHash` from the list, in order (the last one repeats). */
function rpcAnswering(...answers: (string | Error)[]) {
  const counter = { genesisCalls: 0 };
  const rpc = {
    getGenesisHash: () => ({
      send: async () => {
        const answer = answers[Math.min(counter.genesisCalls, answers.length - 1)];
        counter.genesisCalls += 1;
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { rpc, counter };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(FeeConfigError);
    return (error as FeeConfigError).code;
  }
}

function syncCodeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(FeeConfigError);
    return (error as FeeConfigError).code;
  }
}

describe('protocolFeeFor', () => {
  const config = { feeBps: 250, treasury: SOLANA_TREASURY as Address, evmTreasury: EVM_TREASURY };

  it('names the Solana treasury on Solana and the EVM treasury on Tempo', () => {
    expect(protocolFeeFor(config, 'solana')).toEqual({ feeBps: 250, treasury: SOLANA_TREASURY });
    expect(protocolFeeFor(config, 'tempo')).toEqual({ feeBps: 250, treasury: EVM_TREASURY });
  });

  it('writes an EVM treasury in wire form', () => {
    const checksummed = '0x7EDB1404ebae28332867756C0d01440b9E63F3f7';
    expect(protocolFeeFor({ ...config, evmTreasury: checksummed }, 'tempo').treasury).toBe(
      EVM_TREASURY,
    );
  });

  it('answers no treasury at all at a rate of 0, on either rail, set or not', () => {
    for (const rail of ['solana', 'tempo'] as const) {
      expect(protocolFeeFor({ ...config, feeBps: 0 }, rail)).toEqual({ feeBps: 0, treasury: '' });
      expect(protocolFeeFor({ ...config, feeBps: 0, evmTreasury: undefined }, rail)).toEqual({
        feeBps: 0,
        treasury: '',
      });
    }
  });

  it('refuses a Tempo fee with no EVM treasury', () => {
    expect(syncCodeOf(() => protocolFeeFor({ ...config, evmTreasury: undefined }, 'tempo'))).toBe(
      'no_evm_treasury',
    );
    // The Solana rail does not need one.
    expect(protocolFeeFor({ ...config, evmTreasury: undefined }, 'solana').feeBps).toBe(250);
  });

  it.each([
    ['the fee sink', TEMPO_FEE_SINK],
    ['the burn address', `0x${'0'.repeat(40)}`],
    ['a coin contract', '0x20c0000000000000000000000000000000000000'],
    ['a virtual address', `0x11223344${'fd'.repeat(10)}556677889900`],
    ['not an address', '0x1234'],
  ])('refuses an EVM treasury that is %s', (_label, evmTreasury) => {
    expect(syncCodeOf(() => protocolFeeFor({ ...config, evmTreasury }, 'tempo'))).toBe(
      'bad_config',
    );
  });

  it.each([MAX_FEE_BPS + 1, -1, 2.5])('refuses a rate of %s on either rail', (feeBps) => {
    for (const rail of ['solana', 'tempo'] as const) {
      expect(syncCodeOf(() => protocolFeeFor({ ...config, feeBps }, rail))).toBe('bad_config');
    }
  });

  it('takes the cap itself', () => {
    expect(protocolFeeFor({ ...config, feeBps: MAX_FEE_BPS }, 'solana').feeBps).toBe(1000);
  });
});

describe('feeAmountFor', () => {
  const solana = { feeBps: 33, treasury: SOLANA_TREASURY };
  const payout = 'HXtBm8XZbxaTt41uqaKhwUAa6Z1aPyvJdsZVENiWsetg';

  it('rounds up, in whole subunits', () => {
    expect(feeAmountFor(10_000n, solana, { payout })).toBe(33n);
    expect(feeAmountFor(10_001n, solana, { payout })).toBe(34n);
    expect(feeAmountFor(1_001n, { ...solana, feeBps: 1 }, { payout })).toBe(1n);
  });

  it('is 0 at a rate of 0', () => {
    expect(feeAmountFor(10_000n, { feeBps: 0, treasury: '' }, { payout })).toBe(0n);
  });

  it('is 0 when the treasury is the payout or the payer', () => {
    expect(feeAmountFor(10_000n, solana, { payout: SOLANA_TREASURY })).toBe(0n);
    expect(feeAmountFor(10_000n, solana, { payout, payer: SOLANA_TREASURY })).toBe(0n);
    expect(feeAmountFor(10_000n, solana, { payout, payer: payout })).toBe(33n);
  });

  it('compares EVM addresses case-insensitively, base58 exactly', () => {
    const tempo = { feeBps: 33, treasury: EVM_TREASURY };
    const checksummed = '0x7EDB1404ebae28332867756C0d01440b9E63F3f7';
    expect(feeAmountFor(10_000n, tempo, { payout: checksummed })).toBe(0n);
    expect(feeAmountFor(10_000n, tempo, { payout: RECIPIENT_EVM, payer: checksummed })).toBe(0n);
    // Base58 is case-sensitive: a different case is a different address.
    const otherCase = `g${SOLANA_TREASURY.slice(1)}`;
    expect(feeAmountFor(10_000n, solana, { payout: otherCase })).toBe(33n);
  });

  it('is 0 when the fee would take the whole price', () => {
    const cap = { ...solana, feeBps: MAX_FEE_BPS };
    expect(feeAmountFor(1n, cap, { payout })).toBe(0n);
    expect(feeAmountFor(2n, cap, { payout })).toBe(1n);
  });
});

describe('solanaConfigNetworkFor', () => {
  it.each([
    ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'mainnet'],
    ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'devnet'],
    ['eip155:4217', 'mainnet'],
    ['eip155:42431', 'devnet'],
  ])('pairs %s with the %s config', (caip2, network) => {
    expect(solanaConfigNetworkFor(caip2)).toBe(network);
  });

  it.each(['eip155:1', 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z', '__proto__', ''])(
    'refuses %s',
    (caip2) => {
      expect(() => solanaConfigNetworkFor(caip2)).toThrow(/No elisym fee config/);
    },
  );
});

describe('readFeeTerms', () => {
  beforeEach(() => {
    clearProtocolConfigCache();
    fetchConfigMock.mockReset();
    derivedFor.length = 0;
  });

  it('reads the config of the network asked for, fresh', async () => {
    fetchConfigMock.mockResolvedValue(account(250, evmBytes(EVM_TREASURY)));
    const { rpc } = rpcAnswering(MAINNET_GENESIS);
    expect(await readFeeTerms(rpc, 'mainnet', 'solana')).toEqual({
      feeBps: 250,
      treasury: SOLANA_TREASURY,
    });
    expect(await readFeeTerms(rpc, 'mainnet', 'tempo')).toEqual({
      feeBps: 250,
      treasury: EVM_TREASURY,
    });
    expect(derivedFor).toEqual([PROTOCOL_PROGRAM_ID_MAINNET, PROTOCOL_PROGRAM_ID_MAINNET]);
  });

  it('checks the genesis hash FIRST and reads nothing from another cluster', async () => {
    fetchConfigMock.mockResolvedValue(account(250));
    const { rpc } = rpcAnswering(DEVNET_GENESIS);
    expect(await codeOf(readFeeTerms(rpc, 'mainnet', 'solana'))).toBe('wrong_cluster');
    expect(fetchConfigMock).not.toHaveBeenCalled();
    // Nothing went into the shared cache: a mainnet read now has nothing to serve.
    fetchConfigMock.mockRejectedValueOnce(new Error('rpc down'));
    await expect(getProtocolConfig(rpc, PROTOCOL_PROGRAM_ID_MAINNET, 'mainnet')).rejects.toThrow(
      /no cached value/,
    );
  });

  it('remembers a match per rpc and network, and never a mismatch', async () => {
    fetchConfigMock.mockResolvedValue(account(250));
    const { rpc, counter } = rpcAnswering(MAINNET_GENESIS, DEVNET_GENESIS);
    expect(await codeOf(readFeeTerms(rpc, 'devnet', 'solana'))).toBe('wrong_cluster');
    expect(await readFeeTerms(rpc, 'devnet', 'solana')).toMatchObject({ feeBps: 250 });
    expect(counter.genesisCalls).toBe(2);
    await readFeeTerms(rpc, 'devnet', 'solana');
    expect(counter.genesisCalls).toBe(2);
    // The config itself is read every time.
    expect(fetchConfigMock).toHaveBeenCalledTimes(2);
    // Another network on the same rpc is its own question.
    expect(await codeOf(readFeeTerms(rpc, 'mainnet', 'solana'))).toBe('wrong_cluster');
    expect(counter.genesisCalls).toBe(3);
    // And another rpc client is asked afresh.
    const other = rpcAnswering(DEVNET_GENESIS);
    await readFeeTerms(other.rpc, 'devnet', 'solana');
    expect(other.counter.genesisCalls).toBe(1);
  });

  it('answers unavailable when the genesis hash cannot be read, and asks again next time', async () => {
    fetchConfigMock.mockResolvedValue(account(250));
    const { rpc, counter } = rpcAnswering(new Error('timeout'), DEVNET_GENESIS);
    expect(await codeOf(readFeeTerms(rpc, 'devnet', 'solana'))).toBe('unavailable');
    expect(fetchConfigMock).not.toHaveBeenCalled();
    expect(await readFeeTerms(rpc, 'devnet', 'solana')).toMatchObject({ feeBps: 250 });
    expect(counter.genesisCalls).toBe(2);
  });

  it('answers unavailable when the config cannot be read and nothing is cached', async () => {
    fetchConfigMock.mockRejectedValue(new Error('rpc down'));
    const { rpc } = rpcAnswering(DEVNET_GENESIS);
    expect(await codeOf(readFeeTerms(rpc, 'devnet', 'solana'))).toBe('unavailable');
  });

  it('refuses a cached snapshot served on an rpc error', async () => {
    fetchConfigMock.mockResolvedValueOnce(account(250));
    const { rpc } = rpcAnswering(DEVNET_GENESIS);
    await readFeeTerms(rpc, 'devnet', 'solana');
    fetchConfigMock.mockRejectedValueOnce(new Error('rpc down'));
    expect(await codeOf(readFeeTerms(rpc, 'devnet', 'solana'))).toBe('unavailable');
  });

  it('bypasses a warm cache: the fee is the one on chain now', async () => {
    fetchConfigMock.mockResolvedValueOnce(account(100));
    const { rpc } = rpcAnswering(DEVNET_GENESIS);
    await getProtocolConfig(rpc, PROTOCOL_PROGRAM_ID_MAINNET, 'devnet');
    fetchConfigMock.mockResolvedValueOnce(account(300));
    expect(await readFeeTerms(rpc, 'devnet', 'solana')).toEqual({
      feeBps: 300,
      treasury: SOLANA_TREASURY,
    });
  });

  it("passes protocolFeeFor's refusals through", async () => {
    fetchConfigMock.mockResolvedValue(account(250));
    const { rpc } = rpcAnswering(DEVNET_GENESIS);
    expect(await codeOf(readFeeTerms(rpc, 'devnet', 'tempo'))).toBe('no_evm_treasury');
    fetchConfigMock.mockResolvedValue(account(250, evmBytes(TEMPO_FEE_SINK)));
    expect(await codeOf(readFeeTerms(rpc, 'devnet', 'tempo'))).toBe('bad_config');
  });
});
