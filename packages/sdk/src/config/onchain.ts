import { deriveConfigAddress, fetchConfig } from '@elisym/config-client';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { PROTOCOL_FEE_BPS, PROTOCOL_TREASURY } from '../constants';

const CACHE_TTL_MS = 60_000;

/**
 * Snapshot of the on-chain elisym-config program state.
 *
 * `source` reflects how this snapshot was obtained:
 *   - `onchain`: fresh fetch via RPC.
 *   - `cache`: served from in-memory cache (still within TTL or stale-while-error).
 *   - `fallback`: RPC failed AND nothing was cached - bundled defaults are used.
 *
 * When `source === 'fallback'`, `admin` and `pendingAdmin` are `null` because
 * the on-chain admin is unknown without a successful RPC fetch. Callers MUST
 * NOT make admin-based decisions in that case.
 */
export interface ProtocolConfig {
  programId: Address;
  feeBps: number;
  treasury: Address;
  admin: Address | null;
  pendingAdmin: Address | null;
  paused: boolean;
  version: number;
  source: 'onchain' | 'cache' | 'fallback';
}

interface CacheEntry {
  config: ProtocolConfig;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

export function clearProtocolConfigCache(): void {
  cache.clear();
}

export interface GetProtocolConfigOptions {
  ttlMs?: number;
  forceRefresh?: boolean;
}

/**
 * Fetch the protocol config from the on-chain `elisym-config` program.
 *
 * Caches per-program-id with a TTL (default 60s). On RPC error, returns the
 * last known good snapshot from cache; if nothing is cached, returns bundled
 * fallback constants and marks `source: 'fallback'` so callers can branch on
 * it (e.g. refuse admin operations, surface a warning).
 */
export async function getProtocolConfig(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  options?: GetProtocolConfigOptions,
): Promise<ProtocolConfig> {
  const key = programId.toString();
  const ttl = options?.ttlMs ?? CACHE_TTL_MS;
  const cached = cache.get(key);
  if (!options?.forceRefresh && cached && Date.now() < cached.expires) {
    return { ...cached.config, source: 'cache' };
  }

  try {
    const configPda = await deriveConfigAddress(programId);
    const account = await fetchConfig(rpc, configPda);
    const data = account.data;
    const config: ProtocolConfig = {
      programId,
      feeBps: data.feeBps,
      treasury: data.treasury,
      admin: data.admin,
      pendingAdmin: data.pendingAdmin.__option === 'Some' ? data.pendingAdmin.value : null,
      paused: data.paused,
      version: data.version,
      source: 'onchain',
    };
    cache.set(key, { config, expires: Date.now() + ttl });
    return config;
  } catch {
    if (cached) {
      return { ...cached.config, source: 'cache' };
    }
    return {
      programId,
      feeBps: PROTOCOL_FEE_BPS,
      treasury: PROTOCOL_TREASURY,
      admin: null,
      pendingAdmin: null,
      paused: false,
      version: 1,
      source: 'fallback',
    };
  }
}
