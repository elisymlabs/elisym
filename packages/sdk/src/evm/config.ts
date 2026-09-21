/**
 * The protocol fee and treasury of elisym on an EVM chain, read from the
 * `ElisymConfig` contract the SDK registry names for that chain. The twin of
 * `config/onchain.ts` (Solana): no fallback value ships in the SDK, so the chain is
 * the only source of truth, and an unreadable config is a refusal, not a zero fee.
 */

import type { ChainConfig } from '../payment/chains';
import { isVirtualEvmAddress } from '../payment/chains';
import type { Eip1193Client } from './client';
import { withAbort } from './client';
import { readAddressWord, readQuantity, readUint256, readWords } from './rpc-read';

const CACHE_TTL_MS = 60_000;
/** `config()` - both values in one call, so they come from one block. */
const CONFIG_SELECTOR = '0x79502c55';
/** The contract's own cap (`MAX_FEE_BPS`). A larger answer is not this contract. */
export const MAX_EVM_FEE_BPS = 1000;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export interface EvmProtocolConfig {
  /** CAIP-2 id of the chain the config was read on. */
  chain: string;
  contract: string;
  feeBps: number;
  /** Lowercase. Meaningful only when `feeBps` is above zero. */
  treasury: string;
  source: 'onchain' | 'cache';
}

export interface GetEvmProtocolConfigOptions {
  ttlMs?: number;
  forceRefresh?: boolean;
  /** Stop awaiting the reads. A cached snapshot is still served if one exists. */
  signal?: AbortSignal;
}

interface CacheEntry {
  config: EvmProtocolConfig;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

export function clearEvmProtocolConfigCache(): void {
  cache.clear();
}

/** Thrown when the endpoint is not the chain it was asked about. Never served from cache. */
export class WrongEvmChainError extends Error {
  constructor(expected: number, actual: string) {
    super(`The rpc endpoint is not chain ${expected} (it answered ${actual}).`);
    this.name = 'WrongEvmChainError';
  }
}

/**
 * Read `eth_chainId` and refuse an endpoint that is not the chain asked about.
 *
 * Returns the chain id, or `null` when the endpoint did not answer readably -
 * which is "no fresh read" for a caller holding a cached value, and a failure
 * for one that has nothing. The MISMATCH always throws: a value read from the
 * wrong chain is not stale data, it is the wrong money.
 */
export async function checkEvmChain(
  client: Eip1193Client,
  chain: ChainConfig,
): Promise<bigint | null> {
  if (chain.family !== 'evm' || chain.evmChainId === undefined) {
    throw new Error(`${chain.caip2} is not an EVM chain this SDK can read.`);
  }
  const chainId = readQuantity(await client.request({ method: 'eth_chainId' }).catch(() => null));
  if (chainId !== null && chainId !== BigInt(chain.evmChainId)) {
    throw new WrongEvmChainError(chain.evmChainId, `0x${chainId.toString(16)}`);
  }
  return chainId;
}

/**
 * Read the config, cached for 60 s per chain. On an rpc FAILURE the last good
 * snapshot is served (stale-while-error, as on Solana); with nothing cached it
 * throws and the caller refuses. A wrong chain id is not a failure of that kind:
 * it is a misconfigured endpoint, and it always throws.
 */
export async function getEvmProtocolConfig(
  client: Eip1193Client,
  chain: ChainConfig,
  options?: GetEvmProtocolConfigOptions,
): Promise<EvmProtocolConfig> {
  const contract = chain.protocolConfig?.address;
  if (chain.family !== 'evm' || chain.evmChainId === undefined || contract === undefined) {
    throw new Error(`No elisym config contract is registered for ${chain.caip2}.`);
  }
  // BEFORE the cache is even looked at. A snapshot is a snapshot of THIS chain,
  // and a client pointed somewhere else must not be served from it - the cache
  // is keyed by the chain, not by the endpoint, so nothing else would notice.
  const chainId = await withAbort(checkEvmChain(client, chain), options?.signal);

  const cached = cache.get(chain.caip2);
  if (options?.forceRefresh !== true && cached && Date.now() < cached.expires) {
    return { ...cached.config, source: 'cache' };
  }

  let raw: unknown;
  try {
    if (chainId === null) {
      throw new Error('eth_chainId was unreadable');
    }
    raw = await withAbort(
      client.request({
        method: 'eth_call',
        // The NUMBER-versus-tag rule of a log scan, applied here: a lagging
        // backend resolves a tag to its own older head with no error. On Tempo
        // `finalized` equals `latest`, so this costs nothing and cannot read a
        // fee change that a reorg then takes back.
        params: [{ to: contract, data: CONFIG_SELECTOR }, 'finalized'],
      }),
      options?.signal,
    );
  } catch (error) {
    // Stale-while-error covers the TRANSPORT only.
    if (cached) {
      return { ...cached.config, source: 'cache' };
    }
    throw new Error(
      `Failed to read the elisym config contract ${contract} on ${chain.caip2} and no cached value exists. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // A REFUSAL is not a failed read. The contract answered, and what it said is
  // not something this SDK will price against: a fee above the cap, a treasury
  // that cannot receive, an answer that is not two words. Serving the old
  // snapshot instead would keep a whole fleet quoting a fee the chain no longer
  // has, split by how long each process had been running.
  try {
    const config = parseConfig(raw, chain.caip2, contract);
    cache.set(chain.caip2, { config, expires: Date.now() + (options?.ttlMs ?? CACHE_TTL_MS) });
    // A copy: the cached object is this module's, and a caller that edited the
    // returned one in place would change the fee every other caller reads.
    return { ...config };
  } catch (error) {
    cache.delete(chain.caip2);
    throw new Error(
      `Refusing the elisym config at ${contract} on ${chain.caip2}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseConfig(raw: unknown, caip2: string, contract: string): EvmProtocolConfig {
  // Exactly two words. `0x` is what an address with no code answers.
  const words = readWords(raw, 2);
  const feeBps = readUint256(words?.[0]);
  const treasury = readAddressWord(words?.[1]);
  if (feeBps === null || treasury === null) {
    throw new Error('the contract did not answer config() with a fee and a treasury');
  }
  if (feeBps > BigInt(MAX_EVM_FEE_BPS)) {
    throw new Error('the contract answered a fee above its own cap');
  }
  if (feeBps > 0n && (treasury === ZERO_ADDRESS || isVirtualEvmAddress(treasury))) {
    throw new Error('the contract names a treasury that cannot receive a fee');
  }
  return { chain: caip2, contract, feeBps: Number(feeBps), treasury, source: 'onchain' };
}
