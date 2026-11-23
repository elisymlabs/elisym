import type { Network, ProtocolConfig } from '@elisym/pay-core';
import { TREASURY_RETENTION_SECS, knownTreasuries } from '@merchant-node/fee';
import { type LedgerState, emptyLedger } from '@merchant-node/ledger';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { NetworkTreasuries, TREASURY_SHARE_SECS } from '../src/chain/treasuries';

const NOW = 1_791_000_000;
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1zcqDFVGPZXAh';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SOL_TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
const NEW_SOL_TREASURY = 'HXtBm8XZbxaTt41uqaKhwUAa6Z1aPyvJdsZVENiWsetg';
const EVM_TREASURY = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';

function genesisRpc(genesis: string) {
  const asked = { genesis: 0 };
  const rpc = {
    getGenesisHash: () => ({
      send: async () => {
        asked.genesis += 1;
        return genesis;
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { rpc, asked };
}

function configRead(treasury: string, source: 'onchain' | 'cache' = 'onchain'): ProtocolConfig {
  return {
    programId: treasury,
    feeBps: 300,
    treasury,
    admin: treasury,
    pendingAdmin: null,
    paused: false,
    version: 1,
    evmTreasury: EVM_TREASURY,
    source,
  } as unknown as ProtocolConfig;
}

function countingConfig(treasury: () => string = () => SOL_TREASURY) {
  const reads = { count: 0 };
  const readConfig = async () => {
    reads.count += 1;
    return configRead(treasury());
  };
  return { readConfig, reads };
}

function stores(count: number): LedgerState[] {
  return Array.from({ length: count }, () => emptyLedger());
}

describe('NetworkTreasuries', () => {
  it('N stores in one window share one genesis read and one config read', async () => {
    const { rpc, asked } = genesisRpc(DEVNET_GENESIS);
    const { readConfig, reads } = countingConfig();
    const treasuries = new NetworkTreasuries({ rpcs: { devnet: rpc }, readConfig });
    const ledgers = stores(5);
    const outcomes = await Promise.all(
      ledgers.map((state, index) => treasuries.refreshFor('devnet', state, NOW + index)),
    );
    expect(outcomes).toEqual(ledgers.map(() => ({ kind: 'read', feeBps: 300 })));
    expect(asked.genesis).toBe(1);
    expect(reads.count).toBe(1);
    for (const state of ledgers) {
      expect(state.treasuries.devnet?.solana).toEqual({ [SOL_TREASURY]: NOW });
    }
    await treasuries.refreshFor('devnet', emptyLedger(), NOW + TREASURY_SHARE_SECS - 1);
    expect(reads.count).toBe(1);
  });

  it('reads again once the window is over, without a second genesis check', async () => {
    const { rpc, asked } = genesisRpc(DEVNET_GENESIS);
    const { readConfig, reads } = countingConfig();
    const treasuries = new NetworkTreasuries({ rpcs: { devnet: rpc }, readConfig });
    for (const state of stores(3)) {
      await treasuries.refreshFor('devnet', state, NOW);
    }
    const later = emptyLedger();
    for (const state of [later, ...stores(3)]) {
      await treasuries.refreshFor('devnet', state, NOW + TREASURY_SHARE_SECS);
    }
    expect(reads.count).toBe(2);
    expect(asked.genesis).toBe(1);
    expect(later.treasuries.devnet?.solana).toEqual({ [SOL_TREASURY]: NOW + TREASURY_SHARE_SECS });
  });

  it('applies the shared read with the time it was read, not the time a store asked', async () => {
    const { rpc } = genesisRpc(DEVNET_GENESIS);
    let treasury = SOL_TREASURY;
    const { readConfig } = countingConfig(() => treasury);
    const treasuries = new NetworkTreasuries({ rpcs: { devnet: rpc }, readConfig });
    await treasuries.boot(NOW);
    treasury = NEW_SOL_TREASURY;
    const state = emptyLedger();
    await treasuries.refreshFor('devnet', state, NOW + 45);
    expect(state.treasuries.devnet).toEqual({
      solana: { [SOL_TREASURY]: NOW },
      evm: { [EVM_TREASURY]: NOW },
      latest: { solana: SOL_TREASURY, evm: EVM_TREASURY },
    });
    // The next read rotates; the old one stays known for its retention from its own read time.
    await treasuries.refreshFor('devnet', state, NOW + TREASURY_SHARE_SECS);
    expect(state.treasuries.devnet?.solana).toEqual({
      [SOL_TREASURY]: NOW,
      [NEW_SOL_TREASURY]: NOW + TREASURY_SHARE_SECS,
    });
    expect(knownTreasuries(state, 'devnet', 'solana', NOW + TREASURY_RETENTION_SECS + 1)).toEqual([
      NEW_SOL_TREASURY,
    ]);
  });

  it('an unreachable read records nothing, is shared too, and is asked again after the window', async () => {
    const { rpc } = genesisRpc(DEVNET_GENESIS);
    let calls = 0;
    const treasuries = new NetworkTreasuries({
      rpcs: { devnet: rpc },
      readConfig: async () => {
        calls += 1;
        return configRead(SOL_TREASURY, calls === 1 ? 'cache' : 'onchain');
      },
    });
    expect(await treasuries.boot(NOW)).toEqual(
      new Map([['devnet', { kind: 'unreachable', problem: 'the config could not be read fresh' }]]),
    );
    const state = emptyLedger();
    expect(await treasuries.refreshFor('devnet', state, NOW + 10)).toMatchObject({
      kind: 'unreachable',
    });
    expect(state.treasuries).toEqual({});
    expect(calls).toBe(1);
    expect(await treasuries.refreshFor('devnet', state, NOW + TREASURY_SHARE_SECS)).toEqual({
      kind: 'read',
      feeBps: 300,
    });
    expect(state.treasuries.devnet?.latest).toEqual({ solana: SOL_TREASURY, evm: EVM_TREASURY });
  });

  it('a config RPC of another cluster throws at boot and reads no config', async () => {
    const { rpc } = genesisRpc(MAINNET_GENESIS);
    const { readConfig, reads } = countingConfig();
    const treasuries = new NetworkTreasuries({ rpcs: { devnet: rpc }, readConfig });
    await expect(treasuries.boot(NOW)).rejects.toThrow(
      /fee config of devnet: .*does not serve Solana devnet/,
    );
    expect(reads.count).toBe(0);
  });

  it('boots every network in use, each with its own reader', async () => {
    const devnet = genesisRpc(DEVNET_GENESIS);
    const mainnet = genesisRpc(MAINNET_GENESIS);
    const { readConfig, reads } = countingConfig();
    const treasuries = new NetworkTreasuries({
      rpcs: { devnet: devnet.rpc, mainnet: mainnet.rpc },
      readConfig,
    });
    const outcomes = await treasuries.boot(NOW);
    expect([...outcomes.keys()].sort()).toEqual<Network[]>(['devnet', 'mainnet']);
    expect(reads.count).toBe(2);
    const state = emptyLedger();
    await treasuries.refreshFor('mainnet', state, NOW + 1);
    expect(Object.keys(state.treasuries)).toEqual(['mainnet']);
    expect(devnet.asked.genesis + mainnet.asked.genesis).toBe(2);
  });

  it('a clock gone back before the last read does not reuse it', async () => {
    const { rpc } = genesisRpc(DEVNET_GENESIS);
    const { readConfig, reads } = countingConfig();
    const treasuries = new NetworkTreasuries({ rpcs: { devnet: rpc }, readConfig });
    await treasuries.boot(NOW);
    await treasuries.refreshFor('devnet', emptyLedger(), NOW);
    expect(reads.count).toBe(1);
    const state = emptyLedger();
    await treasuries.refreshFor('devnet', state, NOW - 1);
    expect(reads.count).toBe(2);
    expect(state.treasuries.devnet?.solana).toEqual({ [SOL_TREASURY]: NOW - 1 });
  });

  it('refuses a network it has no config RPC for', async () => {
    const treasuries = new NetworkTreasuries({ rpcs: {} });
    await expect(treasuries.refreshFor('mainnet', emptyLedger(), NOW)).rejects.toThrow(
      'no fee config RPC for mainnet',
    );
  });
});
