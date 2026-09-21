/**
 * A replaying Tempo endpoint for the verifier's tests.
 *
 * It EVALUATES the `eth_getLogs` filter over the logs it holds rather than
 * answering a blanket list: a fake that returns everything it has would let a
 * verifier pass while asking for the wrong topics, which is most of what these
 * tests are about. It also lets a chunk fail on command, because "the node said
 * no" and "the node said nothing is there" must never come out the same.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Eip1193Client } from '../src/evm/client';
import { EvmRpcError } from '../src/evm/client';

export interface FakeLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  removed?: boolean;
}

export interface GetLogsCall {
  address: string;
  topics: (string | null)[];
  fromBlock: number;
  toBlock: number;
}

export interface FakeChainOptions {
  chainId?: unknown;
  /** `null` makes the finalized block unreadable. */
  finalized?: number | null;
  /** Block timestamps, by number. Anything missing reads as unreadable. */
  timestamps?: Record<number, number>;
  logs?: FakeLog[];
  /** Receipts by transaction hash. A hash that is absent answers `null`. */
  receipts?: Record<string, unknown>;
  /**
   * Block hashes by number, for the rows that need one to DISAGREE with a
   * receipt. Left alone, a block answers the `blockHash` of a receipt it
   * holds at that height - which is what a real node does, and what binds a
   * receipt to the chain it came from.
   */
  blockHashes?: Record<number, string>;
  /** Beyond this many matches, a chunk answers the result-cap error. */
  maxResults?: number;
  /** Fail a chunk: return an error to throw, or `undefined` to answer normally. */
  onGetLogs?: (call: GetLogsCall, index: number) => unknown;
  /** Answer `eth_call` (the receive-policy reads). */
  onCall?: (to: string, data: string) => unknown;
}

export interface FakeChain {
  client: Eip1193Client;
  calls: { method: string; params?: readonly unknown[] }[];
  getLogsCalls: GetLogsCall[];
}

const RESULT_CAP_MESSAGE = 'query exceeds max results 20000, retry with the range 1-2';

function quantity(value: number): string {
  return `0x${value.toString(16)}`;
}

function blockNumberOf(value: unknown, fallback: number): number {
  return typeof value === 'string' && value.startsWith('0x') ? Number(BigInt(value)) : fallback;
}

function matchesTopics(log: FakeLog, topics: (string | null)[] | undefined): boolean {
  if (topics === undefined) {
    return true;
  }
  return topics.every(
    (topic, index) => topic === null || topic === undefined || log.topics[index] === topic,
  );
}

export function wireLog(log: FakeLog): Record<string, unknown> {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: quantity(log.blockNumber),
    transactionHash: log.transactionHash,
    logIndex: quantity(log.logIndex),
    blockHash: `0x${'ab'.repeat(32)}`,
    transactionIndex: '0x0',
    removed: log.removed ?? false,
  };
}

export function fakeTempoChain(options: FakeChainOptions = {}): FakeChain {
  const calls: { method: string; params?: readonly unknown[] }[] = [];
  const getLogsCalls: GetLogsCall[] = [];
  const finalized = options.finalized === undefined ? 1_000 : options.finalized;

  const client: Eip1193Client = {
    async request({ method, params }) {
      calls.push({ method, ...(params === undefined ? {} : { params }) });
      if (method === 'eth_chainId') {
        return 'chainId' in options ? options.chainId : '0x1079';
      }
      if (method === 'eth_getBlockByNumber') {
        const tag = params?.[0];
        if (tag === 'finalized') {
          return finalized === null ? null : block(finalized, options);
        }
        const wanted = blockNumberOf(tag, -1);
        return block(wanted, options);
      }
      if (method === 'eth_getTransactionReceipt') {
        const hash = String(params?.[0]);
        return options.receipts?.[hash] ?? null;
      }
      if (method === 'eth_call') {
        const target = params?.[0] as { to?: string; data?: string } | undefined;
        return options.onCall?.(String(target?.to), String(target?.data)) ?? '0x';
      }
      if (method === 'eth_getLogs') {
        const filter = params?.[0] as {
          address?: string;
          topics?: (string | null)[];
          fromBlock?: string;
          toBlock?: string;
        };
        const call: GetLogsCall = {
          address: String(filter.address),
          topics: filter.topics ?? [],
          fromBlock: blockNumberOf(filter.fromBlock, 0),
          toBlock: blockNumberOf(filter.toBlock, 0),
        };
        getLogsCalls.push(call);
        const failure = options.onGetLogs?.(call, getLogsCalls.length - 1);
        if (failure !== undefined) {
          throw failure;
        }
        const matched = (options.logs ?? []).filter(
          (log) =>
            log.address.toLowerCase() === call.address.toLowerCase() &&
            log.blockNumber >= call.fromBlock &&
            log.blockNumber <= call.toBlock &&
            matchesTopics(log, filter.topics),
        );
        if (options.maxResults !== undefined && matched.length > options.maxResults) {
          throw resultCapError();
        }
        return matched.map(wireLog);
      }
      throw new Error(`the test chain was asked for ${method}`);
    },
  };
  return { client, calls, getLogsCalls };
}

function block(number: number, options: FakeChainOptions): unknown {
  const timestamp = options.timestamps?.[number];
  if (timestamp === undefined) {
    return null;
  }
  return {
    number: quantity(number),
    timestamp: quantity(timestamp),
    hash:
      options.blockHashes?.[number] ?? receiptBlockHash(number, options) ?? `0x${'cd'.repeat(32)}`,
  };
}

/**
 * The `blockHash` of a receipt this chain holds at that height. A real node's
 * block hash and its receipts' `blockHash` are the same value; a fake that
 * invented one would make every receipt look like it came from another chain.
 */
function receiptBlockHash(number: number, options: FakeChainOptions): string | undefined {
  for (const receipt of Object.values(options.receipts ?? {})) {
    const at = readNumber(receipt, 'blockNumber');
    const hash = readString(receipt, 'blockHash');
    if (at === number && hash !== undefined) {
      return hash;
    }
  }
  return undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const raw = readString(value, key);
  // A row may hold a receipt whose `blockNumber` is deliberately unreadable;
  // the fake has to answer that the way a node would, not throw.
  return raw !== undefined && /^0x[0-9a-f]+$/i.test(raw) ? Number(BigInt(raw)) : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

/** The node's own words: four different failures share `-32602`, and only this one halves. */
export function resultCapError(): EvmRpcError {
  return new EvmRpcError('eth_getLogs', { code: -32602, message: RESULT_CAP_MESSAGE });
}

export function rangeCapError(): EvmRpcError {
  return new EvmRpcError('eth_getLogs', {
    code: -32602,
    message: 'query exceeds max block range 100000',
  });
}

export function invalidRangeError(): EvmRpcError {
  return new EvmRpcError('eth_getLogs', { code: -32602, message: 'invalid block range params' });
}

/** One of the recorded Tempo receipts, as the node returned it. */
export function recordedReceipt(name: string): Record<string, unknown> {
  const path = join(__dirname, 'fixtures', 'tempo', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Every log of a recorded receipt, in the shape a scan would find them. */
export function receiptLogs(receipt: Record<string, unknown>): FakeLog[] {
  const logs = receipt.logs as Record<string, unknown>[];
  return logs.map((log) => ({
    address: String(log.address),
    topics: log.topics as string[],
    data: String(log.data),
    blockNumber: Number(BigInt(String(log.blockNumber))),
    transactionHash: String(log.transactionHash),
    logIndex: Number(BigInt(String(log.logIndex))),
  }));
}
