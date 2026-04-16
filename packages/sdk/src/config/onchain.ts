import { deriveConfigAddress, fetchConfig } from '@elisym/config-client';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';

const CACHE_TTL_MS = 60_000;

/**
 * Snapshot of the on-chain elisym-config program state.
 *
 * `source` reflects how this snapshot was obtained:
 *   - `onchain`: fresh fetch via RPC.
 *   - `cache`: served from in-memory cache (still within TTL or stale-while-error).
 *
 * If RPC fails and no cached value exists, `getProtocolConfig` throws instead of
 * returning stale hardcoded defaults - callers must handle the error explicitly.
 */
export interface ProtocolConfig {
  programId: Address;
  feeBps: number;
  treasury: Address;
  admin: Address;
  pendingAdmin: Address | null;
  paused: boolean;
  version: number;
  source: 'onchain' | 'cache';
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
 * last known good snapshot from cache. If nothing is cached, throws - callers
 * must handle the error (e.g. refuse the payment, show a warning).
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
  } catch (error) {
    if (cached) {
      return { ...cached.config, source: 'cache' };
    }
    throw new Error(
      `Failed to fetch protocol config from on-chain program ${programId} and no cached value exists. ` +
        `Ensure RPC is reachable and the program is initialized. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
