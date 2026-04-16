import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearProtocolConfigCache,
  getProtocolConfig,
  PROTOCOL_FEE_BPS,
  PROTOCOL_TREASURY,
} from '../src/index';

const PROGRAM_ID = 'BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE' as Address;
const SAMPLE_ADMIN = '11111111111111111111111111111111' as Address;
const SAMPLE_TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy' as Address;

const { fetchConfigMock } = vi.hoisted(() => ({
  fetchConfigMock: vi.fn(),
}));

vi.mock('@elisym/program-client', () => ({
  deriveConfigAddress: vi.fn(async () => 'ConfigPda1111111111111111111111111111111111' as Address),
  fetchConfig: (...args: unknown[]) => fetchConfigMock(...args),
  CONFIG_SEED: 'config',
  MAX_FEE_BPS: 1000,
}));

function makeRpc(): Rpc<SolanaRpcApi> {
  return {} as Rpc<SolanaRpcApi>;
}

function makeAccount(overrides?: {
  feeBps?: number;
  treasury?: Address;
  admin?: Address;
  pendingAdmin?: Address | null;
  paused?: boolean;
  version?: number;
}) {
  return {
    address: 'ConfigPda1111111111111111111111111111111111' as Address,
    data: {
      feeBps: overrides?.feeBps ?? 300,
      treasury: overrides?.treasury ?? SAMPLE_TREASURY,
      admin: overrides?.admin ?? SAMPLE_ADMIN,
      pendingAdmin:
        overrides?.pendingAdmin === undefined || overrides.pendingAdmin === null
          ? { __option: 'None' as const }
          : { __option: 'Some' as const, value: overrides.pendingAdmin },
      paused: overrides?.paused ?? false,
      version: overrides?.version ?? 1,
    },
  };
}

describe('getProtocolConfig', () => {
  beforeEach(() => {
    clearProtocolConfigCache();
    fetchConfigMock?.mockReset();
  });

  it('returns on-chain config on RPC success', async () => {
    fetchConfigMock.mockResolvedValueOnce(makeAccount({ feeBps: 250 }));
    const config = await getProtocolConfig(makeRpc(), PROGRAM_ID);
    expect(config.feeBps).toBe(250);
    expect(config.treasury).toBe(SAMPLE_TREASURY);
    expect(config.admin).toBe(SAMPLE_ADMIN);
    expect(config.source).toBe('onchain');
  });

  it('serves from cache on second call within TTL', async () => {
    fetchConfigMock.mockResolvedValueOnce(makeAccount());
    const first = await getProtocolConfig(makeRpc(), PROGRAM_ID);
    const second = await getProtocolConfig(makeRpc(), PROGRAM_ID);
    expect(first.source).toBe('onchain');
    expect(second.source).toBe('cache');
    expect(fetchConfigMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to bundled constants when RPC throws and no cache', async () => {
    fetchConfigMock.mockRejectedValueOnce(new Error('rpc down'));
    const config = await getProtocolConfig(makeRpc(), PROGRAM_ID);
    expect(config.source).toBe('fallback');
    expect(config.feeBps).toBe(PROTOCOL_FEE_BPS);
    expect(config.treasury).toBe(PROTOCOL_TREASURY);
    expect(config.admin).toBeNull();
    expect(config.pendingAdmin).toBeNull();
  });

  it('returns stale cache when RPC fails on refresh', async () => {
    fetchConfigMock.mockResolvedValueOnce(makeAccount({ feeBps: 400 }));
    await getProtocolConfig(makeRpc(), PROGRAM_ID);
    fetchConfigMock.mockRejectedValueOnce(new Error('rpc down'));
    const stale = await getProtocolConfig(makeRpc(), PROGRAM_ID, { forceRefresh: true });
    expect(stale.source).toBe('cache');
    expect(stale.feeBps).toBe(400);
  });

  it('forceRefresh bypasses cache and fetches again', async () => {
    fetchConfigMock.mockResolvedValueOnce(makeAccount({ feeBps: 300 }));
    fetchConfigMock.mockResolvedValueOnce(makeAccount({ feeBps: 500 }));
    const first = await getProtocolConfig(makeRpc(), PROGRAM_ID);
    expect(first.feeBps).toBe(300);
    const second = await getProtocolConfig(makeRpc(), PROGRAM_ID, { forceRefresh: true });
    expect(second.feeBps).toBe(500);
    expect(second.source).toBe('onchain');
    expect(fetchConfigMock).toHaveBeenCalledTimes(2);
  });

  it('honors custom ttlMs option', async () => {
    fetchConfigMock.mockResolvedValueOnce(makeAccount());
    await getProtocolConfig(makeRpc(), PROGRAM_ID, { ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fetchConfigMock.mockResolvedValueOnce(makeAccount({ feeBps: 999 }));
    const config = await getProtocolConfig(makeRpc(), PROGRAM_ID);
    expect(config.source).toBe('onchain');
    expect(config.feeBps).toBe(999);
  });

  it('translates pendingAdmin Some to plain address', async () => {
    fetchConfigMock.mockResolvedValueOnce(makeAccount({ pendingAdmin: SAMPLE_ADMIN }));
    const config = await getProtocolConfig(makeRpc(), PROGRAM_ID);
    expect(config.pendingAdmin).toBe(SAMPLE_ADMIN);
  });
});
