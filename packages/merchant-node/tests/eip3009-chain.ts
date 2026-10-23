/**
 * A fake `eip3009` chain for the node's tests: one USDC proxy (FiatToken v2.2's
 * logs: `AuthorizationUsed` IMMEDIATELY before the `Transfer` it authorizes),
 * blocks with real timestamps, receipts, and an `eth_getLogs` that behaves
 * like a qualified provider: a range cap answered with Tenderly's "block range
 * too large", a range past the head refused, a reversed range refused. Any
 * request can be scripted to answer otherwise (`script`).
 */
import { type Asset, type ChainConfig, assetsFor, chainByCaip2 } from '@elisym/pay-core';
import {
  AUTHORIZATION_USED_TOPIC,
  type Eip1193Client,
  EvmRpcError,
  FIAT_TOKEN_IMPLEMENTATION_SLOT,
} from '@elisym/pay-core/evm';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const BLOCK_SECS = 2;

export function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

export function hexNumber(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

/** A block hash per number (and per fork: a reorged block hashes differently). */
export function blockHashOf(number: number, fork = 0): string {
  return `0x${fork.toString(16).padStart(8, '0')}${'b'.repeat(48)}${number.toString(16).padStart(8, '0')}`;
}

export function txHashOf(seed: number): string {
  return `0x${'7'.repeat(56)}${seed.toString(16).padStart(8, '0')}`;
}

function topicOf(address: string): string {
  return `0x${word(address.toLowerCase())}`;
}

export interface FakeLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed: boolean;
}

interface FakeReceipt {
  transactionHash: string;
  status: string;
  blockNumber: string;
  blockHash: string;
  logs: FakeLog[];
}

export interface NodeChain {
  client: Eip1193Client;
  chain: ChainConfig;
  asset: Asset;
  /** The proxy, lowercase. */
  mint: string;
  chainId: number;
  /** `latest`. */
  head: number;
  safe: number;
  finalized: number;
  /** The timestamp of block 0: one block every `BLOCK_SECS`. */
  genesis: number;
  logs: FakeLog[];
  receipts: Map<string, FakeReceipt>;
  /** What the implementation slot holds. */
  implementation: string;
  /** The provider's own `eth_getLogs` range cap. */
  providerCap: number;
  calls: { method: string; params: readonly unknown[] }[];
  /** How `eth_getLogs` shows each log (a lagging backend shows another fork's). */
  logView: (log: FakeLog) => FakeLog;
  /**
   * Answers a request instead of the chain: return `undefined` to let the chain
   * answer, throw to fail it, or return `{ value }` to answer `value`.
   */
  script:
    | ((method: string, params: readonly unknown[]) => { value: unknown } | undefined)
    | undefined;
}

export function timeOf(chain: NodeChain, number: number): number {
  return chain.genesis + number * BLOCK_SECS;
}

/** The registry chain of `caip2` and its USDC. */
export function registryUsdc(caip2: string): { chain: ChainConfig; asset: Asset } {
  const chain = chainByCaip2(caip2);
  const asset =
    chain === undefined
      ? undefined
      : assetsFor(chain.slug, chain.network).find((coin) => coin.eip712 !== undefined);
  if (chain === undefined || asset === undefined) {
    throw new Error(`no USDC on ${caip2}`);
  }
  return { chain, asset };
}

function rpcError(method: string, code: number, message: string): EvmRpcError {
  return new EvmRpcError(method, { code, message });
}

function topicMatches(filter: unknown, value: unknown): boolean {
  if (filter === null || filter === undefined) {
    return true;
  }
  return Array.isArray(filter) ? filter.includes(value) : filter === value;
}

function quantity(method: string, value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/.test(value)) {
    throw rpcError(method, -32602, 'invalid argument');
  }
  return Number.parseInt(value, 16);
}

export interface NodeChainOptions {
  caip2?: string;
  head?: number;
  /** Seconds: the head's time. */
  headTime: number;
  providerCap?: number;
}

export function nodeChain(options: NodeChainOptions): NodeChain {
  const { chain, asset } = registryUsdc(options.caip2 ?? 'eip155:84532');
  const head = options.head ?? 10_000_000;
  const state: NodeChain = {
    client: { request: async () => undefined },
    chain,
    asset,
    mint: (asset.mint ?? '').toLowerCase(),
    chainId: chain.evmChainId ?? 0,
    head,
    // Base: `safe` about 3 minutes back, `finalized` about 18.
    safe: head - 90,
    finalized: head - 540,
    genesis: options.headTime - head * BLOCK_SECS,
    logs: [],
    receipts: new Map(),
    implementation: (asset.implementation ?? '').toLowerCase(),
    providerCap: options.providerCap ?? 10_000,
    calls: [],
    logView: (log) => log,
    script: undefined,
  };
  const block = (number: number): Record<string, unknown> | null =>
    number < 0 || number > state.head
      ? null
      : {
          number: hexNumber(number),
          hash: blockHashOf(number),
          timestamp: hexNumber(timeOf(state, number)),
        };
  const blockByTag = (tag: unknown): Record<string, unknown> | null => {
    switch (tag) {
      case 'latest':
        return block(state.head);
      case 'safe':
        return block(state.safe);
      case 'finalized':
        return block(state.finalized);
      default:
        return block(quantity('eth_getBlockByNumber', tag));
    }
  };
  const getLogs = (params: readonly unknown[]): FakeLog[] => {
    const filter = params[0] as {
      address?: unknown;
      topics?: unknown;
      fromBlock?: unknown;
      toBlock?: unknown;
    };
    const from = quantity('eth_getLogs', filter.fromBlock);
    const to = quantity('eth_getLogs', filter.toBlock);
    if (from > to) {
      throw rpcError('eth_getLogs', -32602, 'invalid block range params');
    }
    if (to > state.head) {
      throw rpcError('eth_getLogs', -32602, 'block range extends beyond current head block');
    }
    if (to - from + 1 > state.providerCap) {
      throw rpcError('eth_getLogs', -32602, 'block range too large');
    }
    const topics = Array.isArray(filter.topics) ? filter.topics : [];
    return state.logs
      .filter((log) => {
        const number = Number.parseInt(log.blockNumber, 16);
        return (
          log.address === String(filter.address).toLowerCase() &&
          number >= from &&
          number <= to &&
          topics.every((topic, index) => topicMatches(topic, log.topics[index]))
        );
      })
      .map((log) => state.logView(log));
  };
  const storageAt = (params: readonly unknown[]): string => {
    const pinned = params[2] as { blockHash?: unknown; requireCanonical?: unknown } | undefined;
    const known =
      typeof pinned?.blockHash === 'string' &&
      pinned.requireCanonical === true &&
      Number.parseInt(pinned.blockHash.slice(-8), 16) <= state.head &&
      pinned.blockHash === blockHashOf(Number.parseInt(pinned.blockHash.slice(-8), 16));
    if (!known) {
      throw rpcError('eth_getStorageAt', -32000, 'header not found');
    }
    if (
      String(params[0]).toLowerCase() !== state.mint ||
      String(params[1]).toLowerCase() !== FIAT_TOKEN_IMPLEMENTATION_SLOT
    ) {
      return `0x${word(0n)}`;
    }
    return `0x${word(state.implementation)}`;
  };
  state.client = {
    request: async ({ method, params = [] }) => {
      state.calls.push({ method, params });
      const scripted = state.script?.(method, params);
      if (scripted !== undefined) {
        return scripted.value;
      }
      switch (method) {
        case 'eth_chainId':
          return hexNumber(state.chainId);
        case 'eth_getBlockByNumber':
          return blockByTag(params[0]);
        case 'eth_getLogs':
          return getLogs(params);
        case 'eth_getTransactionReceipt':
          return state.receipts.get(String(params[0])) ?? null;
        case 'eth_getStorageAt':
          return storageAt(params);
        default:
          throw rpcError(method, -32601, 'the method does not exist');
      }
    },
  };
  return state;
}

function logAt(
  state: NodeChain,
  hash: string,
  block: number,
  index: number,
  topics: string[],
  data: string,
): FakeLog {
  return {
    address: state.mint,
    topics,
    data,
    blockNumber: hexNumber(block),
    blockHash: blockHashOf(block),
    transactionHash: hash,
    logIndex: hexNumber(index),
    removed: false,
  };
}

/** Record a successful transaction with `logs` in its block. */
function mine(state: NodeChain, hash: string, block: number, logs: FakeLog[]): void {
  state.logs.push(...logs);
  state.receipts.set(hash, {
    transactionHash: hash,
    status: '0x1',
    blockNumber: hexNumber(block),
    blockHash: blockHashOf(block),
    logs,
  });
}

/**
 * A `transferWithAuthorization` landed in `block`: `AuthorizationUsed(authorizer,
 * nonce)` at `index` and the USDC `Transfer` it authorizes at `index + 1`.
 */
export function payWithAuthorization(
  state: NodeChain,
  options: {
    hash: string;
    authorizer: string;
    nonce: string;
    payee: string;
    value: bigint;
    block: number;
    index?: number;
  },
): void {
  const index = options.index ?? 3;
  mine(state, options.hash, options.block, [
    logAt(
      state,
      options.hash,
      options.block,
      index,
      [AUTHORIZATION_USED_TOPIC, topicOf(options.authorizer), options.nonce],
      '0x',
    ),
    logAt(
      state,
      options.hash,
      options.block,
      index + 1,
      [TRANSFER_TOPIC, topicOf(options.authorizer), topicOf(options.payee)],
      `0x${word(options.value)}`,
    ),
  ]);
}

/** A plain USDC `transfer` (no authorization before it) in `block`. */
export function plainTransfer(
  state: NodeChain,
  options: { hash: string; from: string; to: string; value: bigint; block: number; index?: number },
): void {
  mine(state, options.hash, options.block, [
    logAt(
      state,
      options.hash,
      options.block,
      options.index ?? 0,
      [TRANSFER_TOPIC, topicOf(options.from), topicOf(options.to)],
      `0x${word(options.value)}`,
    ),
  ]);
}

/** The `eth_getLogs` ranges asked for transfers to `payout`, in order. */
export function payoutRanges(state: NodeChain, payout: string): [number, number][] {
  return state.calls.flatMap(({ method, params }) => {
    const filter = params[0] as
      | { topics?: unknown[]; fromBlock?: string; toBlock?: string }
      | undefined;
    if (method !== 'eth_getLogs' || filter?.topics?.[2] !== topicOf(payout)) {
      return [];
    }
    return [
      [Number.parseInt(filter.fromBlock ?? '', 16), Number.parseInt(filter.toBlock ?? '', 16)],
    ];
  });
}

/** The receipts read, by hash, in order. */
export function receiptReads(state: NodeChain): string[] {
  return state.calls.flatMap(({ method, params }) =>
    method === 'eth_getTransactionReceipt' ? [String(params[0])] : [],
  );
}
