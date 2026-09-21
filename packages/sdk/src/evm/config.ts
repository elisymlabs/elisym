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
function snapshotOf(config: EvmProtocolConfig, cachedAt: number): EvmProtocolConfig {
  return { ...config, source: 'cache', cachedAgeMs: monotonicNow() - cachedAt };
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

/**
 * One entry per chain, and it is the ONLY thing anyone reads: never a reference
 * taken before an `await`, because what the chain says can change while a read
 * is in flight.
 *
 * An entry with no `config` is a TOMBSTONE - a refusal happened, and there is
 * no snapshot to serve. Writing one instead of deleting is what makes the
 * ordering rule a single comparison in both directions: an entry is replaced
 * only by a read that STARTED LATER. Without that, a refusal and a slower good
 * read that overlapped it decide by arrival order - the refusal clears the
 * snapshot, the older read puts it straight back, and the process keeps quoting
 * a fee the chain no longer has while a process without the overlap refuses
 * outright.
 */
interface CacheEntry {
  /** Absent on a tombstone: the chain answered something this SDK will not price against. */
  config?: EvmProtocolConfig;
  cachedAt: number;
  /** The ticket the writing read took BEFORE it asked the chain. */
  generation: number;
}

const cache = new Map<string, CacheEntry>();

/** Ticket numbers, in the order reads ASK THE CHAIN. Monotonic for the life of the module. */
let writes = 0;
/** No ticket below this may write: what a `clear` leaves behind for chains it had no entry for. */
let floor = 0;

/**
 * A monotonic clock, so that a backward system clock cannot make a snapshot
 * look fresh for ever, nor report a negative age to a caller imposing its own
 * bound on staleness.
 */
function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** Replace the entry only from a read that asked the chain later than the one there. */
function writeEntry(key: string, entry: CacheEntry): void {
  if (entry.generation < floor) {
    return;
  }
  const existing = cache.get(key);
  if (existing === undefined || existing.generation < entry.generation) {
    cache.set(key, entry);
  }
}

/**
 * One entry per chain AND contract. The module reasons about the endpoint being
 * the right chain; the contract is the other half of what a snapshot is OF, and
 * "a new version is a new address" is exactly how this contract is replaced.
 */
function cacheKey(caip2: string, contract: string): string {
  return `${caip2}|${contract}`;
}

export function clearEvmProtocolConfigCache(): void {
  // A floor rather than a bare clear: a read already in flight holds an older
  // ticket and must not repopulate a cache the caller just emptied - including
  // for a chain this process had no entry for yet, which a per-entry tombstone
  // could not express.
  floor = ++writes;
  cache.clear();
}

/**
 * Thrown when the endpoint is not the chain it was asked about. It is never a
 * cached value's fault, so it is never swallowed into stale-while-error - with
 * the one exception a caller asks for: a DEADLINE that expires before the chain
 * read answers leaves the question unanswered, and a snapshot is then served
 * exactly as it would be for any other unanswered read.
 */
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
 * throws and the caller refuses. A wrong chain id is not a failure of that
 * kind: it is a misconfigured endpoint, and an ANSWERED chain read that names
 * another chain always throws. Two reads leave the question unanswered rather
 * than answered wrongly, and both then behave like any other unanswered read -
 * a caller's deadline expiring first, and an endpoint that will not name its
 * chain readably at all.
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
  const ttlMs = options?.ttlMs ?? CACHE_TTL_MS;
  const key = cacheKey(chain.caip2, contract);
  let raw: unknown;
  let generation = 0;
  // Never read before it is stamped below; every write is downstream of that.
  let askedAt = Number.NaN;
  try {
    // BEFORE the cache is served. A snapshot is a snapshot of THIS chain, and a
    // client pointed somewhere else must not be served from it - the cache is
    // keyed by the chain, not by the endpoint, so nothing else would notice.
    // Inside the try, so that a caller's deadline during THIS read falls back to
    // the snapshot exactly as a deadline during the call below does.
    const chainId = await withAbort(checkEvmChain(client, chain), options?.signal);
    // Read the map HERE, not before the await: a refusal may have landed while
    // this read was waiting, and a reference taken earlier would not see it.
    const cached = cache.get(key);
    if (
      options?.forceRefresh !== true &&
      cached?.config &&
      monotonicNow() - cached.cachedAt < ttlMs
    ) {
      return snapshotOf(cached.config, cached.cachedAt);
    }
    if (chainId === null) {
      throw new Error('eth_chainId was unreadable');
    }
    generation = ++writes;
    // Stamped when the chain is ASKED, not when the answer comes back: otherwise
    // the reported age is short by a whole round trip and the effective TTL is
    // the TTL plus it - and that age is the lever a caller has for bounding
    // staleness itself, since stale-while-error deliberately has none.
    askedAt = monotonicNow();
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
    // Stale-while-error covers the TRANSPORT only - and reads the map at the
    // moment it needs it, so a snapshot another read established since this one
    // started is served, and one a refusal removed is not.
    const fallback = cache.get(key);
    if (fallback?.config) {
      return snapshotOf(fallback.config, fallback.cachedAt);
    }
    throw new Error(
      `Failed to read the elisym config contract ${contract} on ${chain.caip2} and no cached value exists. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  // A REFUSAL is not a failed read. The contract answered, and what it said is
  // not something this SDK will price against: a fee above the cap, a treasury
  // that cannot receive, an answer that is not two words. Serving the old
  // snapshot instead would keep a whole fleet quoting a fee the chain no longer
  // has, split by how long each process had been running.
  try {
    const config = parseConfig(raw, chain.caip2, contract);
    // `ttlMs` is a per-CALL leniency and is never written into the entry, so
    // one caller's long TTL cannot pin the snapshot every other caller reads.
    writeEntry(key, { config, cachedAt: askedAt, generation });
    // A copy: the cached object is this module's, and a caller that edited the
    // returned one in place would change the fee every other caller reads.
    return { ...config };
  } catch (error) {
    writeEntry(key, { cachedAt: askedAt, generation });
    throw new Error(
      `Refusing the elisym config at ${contract} on ${chain.caip2}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
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
