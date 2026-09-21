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

/** The cached object is never handed out, and it says how old it is. */
function snapshotOf(entry: CacheEntry): EvmProtocolConfig {
  return { ...entry.config, source: 'cache', cachedAgeMs: Date.now() - entry.cachedAt };
}

export interface EvmProtocolConfig {
  /** CAIP-2 id of the chain the config was read on. */
  chain: string;
  contract: string;
  feeBps: number;
  /** Lowercase. Meaningful only when `feeBps` is above zero. */
  treasury: string;
  source: 'onchain' | 'cache';
  /**
   * How old the snapshot is, on the `cache` path only. Stale-while-error has no
   * age bound on purpose - a fee that cannot be re-read is better than no fee at
   * all - so a caller that wants one enforces it from here.
   */
  cachedAgeMs?: number;
}

export interface GetEvmProtocolConfigOptions {
  ttlMs?: number;
  forceRefresh?: boolean;
  /** Stop awaiting the reads. A cached snapshot is still served if one exists. */
  signal?: AbortSignal;
}

interface CacheEntry {
  config: EvmProtocolConfig;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Every read that is about to write takes a number; only the LATEST one may
 * write, and a refusal takes a number of its own so that nothing older can undo
 * it. Without this, a refusal and a slower good read racing each other decide
 * by arrival order: the refusal deletes the snapshot, the older read puts it
 * back, and the process keeps quoting a fee the chain no longer has while a
 * process without the overlap refuses outright.
 */
let writes = 0;

export function clearEvmProtocolConfigCache(): void {
  cache.clear();
  writes += 1;
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
  const cached = cache.get(chain.caip2);
  const ttlMs = options?.ttlMs ?? CACHE_TTL_MS;
  let raw: unknown;
  let generation = 0;
  try {
    // BEFORE the cache is served. A snapshot is a snapshot of THIS chain, and a
    // client pointed somewhere else must not be served from it - the cache is
    // keyed by the chain, not by the endpoint, so nothing else would notice.
    // Inside the try, so that a caller's deadline during THIS read falls back to
    // the snapshot exactly as a deadline during the call below does.
    const chainId = await withAbort(checkEvmChain(client, chain), options?.signal);
    if (options?.forceRefresh !== true && cached && Date.now() - cached.cachedAt < ttlMs) {
      return snapshotOf(cached);
    }
    if (chainId === null) {
      throw new Error('eth_chainId was unreadable');
    }
    generation = ++writes;
    raw = await withAbort(
      client.request({
        method: 'eth_call',
        // A tag, deliberately, and the conservative one: `finalized` cannot be
        // reorged away, and on Tempo it equals `latest`. (The scan rule that
        // forbids a tag is about a RANGE, where a lagging backend silently
        // narrows the window it searched.)
        params: [{ to: contract, data: CONFIG_SELECTOR }, 'finalized'],
      }),
      options?.signal,
    );
  } catch (error) {
    // The wrong chain is never stale data - it is the wrong money.
    if (error instanceof WrongEvmChainError) {
      throw error;
    }
    // Stale-while-error covers the TRANSPORT only.
    if (cached) {
      return snapshotOf(cached);
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
    // A read that another one overtook does not get to write: its answer is the
    // older of the two. `ttlMs` is a per-CALL leniency and never writes a global
    // one, so one caller's long TTL cannot pin the snapshot every other caller
    // in the process reads.
    if (generation === writes) {
      cache.set(chain.caip2, { config, cachedAt: Date.now() });
    }
    // A copy: the cached object is this module's, and a caller that edited the
    // returned one in place would change the fee every other caller reads.
    return { ...config };
  } catch (error) {
    writes += 1;
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
