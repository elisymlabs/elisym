/**
 * Reading Tempo transfers from the chain.
 *
 * Three rules hold everywhere in this file, and every verdict downstream rests
 * on them:
 *
 * - **Unreadable is not empty.** A log, a block or a chunk that does not decode
 *   exactly as the layout says makes the pass INCOMPLETE. An incomplete pass can
 *   still credit a payment it found; it can never conclude that nothing was sent.
 * - **A log that is free to forge is dropped, not counted.** A zero-amount
 *   `transferFromWithMemo` succeeds from any caller with any `from`, and an
 *   infinite allowance makes `from == to` free as well - so a log below the
 *   amount we are looking for, or one whose sides are equal, is discarded and
 *   does NOT make the pass incomplete. It proves nothing either way.
 * - **The scan reports the block it reached.** A caller that wants to say "not
 *   paid" needs to know how far the evidence goes, and `finalized` resolved by a
 *   lagging backend is not an answer - so a chunk always asks for the NUMBER the
 *   scan read, never the tag.
 */

import { normalizeEvmAddress } from '../payment/chains';
import type { Eip1193Client } from './client';
import { EvmRpcError, withAbort } from './client';
import {
  HISTORY_CONTROL_START_BLOCKS,
  MAX_HISTORY_CONTROL_ITERATIONS,
  MAX_LOG_BLOCK_RANGE,
  MAX_LOG_SCAN_REQUESTS,
  TEMPO_TRANSFER_GUARD,
  TRANSFER_BLOCKED_TOPIC,
  TRANSFER_TOPIC,
  TRANSFER_WITH_MEMO_TOPIC,
} from './constants';
import {
  readAddressWord,
  readBlockNumber,
  readField,
  readTopicAddress,
  readTopicWord,
  readTxHash,
  readUint256,
  readWords,
  toQuantity,
} from './rpc-read';

const ADDRESS_TOPIC_PADDING = '0'.repeat(24);

export type TempoTransferEvent = 'TransferWithMemo' | 'Transfer';

const EVENT_TOPICS: Record<TempoTransferEvent, string> = {
  TransferWithMemo: TRANSFER_WITH_MEMO_TOPIC,
  Transfer: TRANSFER_TOPIC,
};
const EVENT_TOPIC_COUNT: Record<TempoTransferEvent, number> = {
  TransferWithMemo: 4,
  Transfer: 3,
};

export interface TempoTransferLog {
  /** The token that emitted it, in wire form. */
  token: string;
  /**
   * The hash of the block this log claims to be in. Every node sends it, and
   * it is the only field on a log that names a CHAIN: a scan answered by a
   * backend on the other Tempo network is otherwise indistinguishable, because
   * the token, the guard and the registry are at the same addresses on both.
   */
  blockHash: string;
  from: string;
  to: string;
  amount: bigint;
  /** The 32-byte memo word. Absent on a plain `Transfer`. */
  memo?: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
}

export interface TempoBlockedLog {
  /** The token whose transfer was blocked (topic 1). */
  token: string;
  /** The account whose receive policy refused it (topic 2). */
  receiver: string;
  amount: bigint;
  originator: string;
  /** The recipient inside the claim receipt; equals `receiver` or the log is unreadable. */
  recipient: string;
  /** The 32-byte memo word of the blocked transfer. */
  memo: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
}

/**
 * A block by height and clock. The finalized HEAD is read as one of these:
 * nothing binds a read to the head's hash (every bind goes through
 * `readBlockByNumber`), so requiring a field no caller reads would make every
 * verify `chain_unreadable` on an endpoint that omits it.
 */
export interface TempoHeadRef {
  number: number;
  timestamp: number;
}

/** A block read BY NUMBER, which a receipt or a log can be bound to. */
export interface TempoBlockRef extends TempoHeadRef {
  hash: string;
}

/**
 * What one entry turned out to be. `other` is a log this lookup is not about
 * (another token, another event) - expected inside a RECEIPT, where the fee leg
 * and every other token appear, and impossible in a filtered scan, where it
 * means the node answered something it was not asked for.
 */
export type TempoLogDecode<T> =
  | { kind: 'log'; log: T }
  | { kind: 'other' }
  | { kind: 'unreadable' };

function addressTopic(address: string): string {
  return `0x${ADDRESS_TOPIC_PADDING}${address.slice(2).toLowerCase()}`;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

interface LogHeader {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
}

/**
 * The fields every log carries, or `null`. The topics are read as WORDS here and
 * as addresses by the decoder that knows which of them hold one: a memo is a
 * bytes32 that may legitimately have any upper bytes, while an address topic
 * with dirty upper bytes is a forgery attempt.
 */
function readLogHeader(entry: unknown): LogHeader | null {
  if (readField(entry, 'removed') === true) {
    return null;
  }
  const address = normalizeEvmAddress(readField(entry, 'address')) ?? null;
  const rawTopics = readField(entry, 'topics');
  const data = readField(entry, 'data');
  const transactionHash = readTxHash(readField(entry, 'transactionHash'));
  const logIndex = readBlockNumber(readField(entry, 'logIndex'));
  const blockNumber = readBlockNumber(readField(entry, 'blockNumber'));
  const blockHash = readTxHash(readField(entry, 'blockHash'));
  if (
    address === null ||
    !Array.isArray(rawTopics) ||
    typeof data !== 'string' ||
    transactionHash === null ||
    logIndex === null ||
    blockNumber === null ||
    blockHash === null
  ) {
    return null;
  }
  const topics: string[] = [];
  for (const topic of rawTopics) {
    const word = readTopicWord(topic);
    if (word === null) {
      return null;
    }
    topics.push(word);
  }
  return { address, topics, data, transactionHash, logIndex, blockNumber, blockHash };
}

/** The single 32-byte word of a transfer log's data, or `null`. */
function readAmountWord(data: string): bigint | null {
  return readUint256(readWords(data, 1)?.[0]);
}

/**
 * Decode one entry as a transfer of `token`. Everything the layout promises is
 * checked: the emitter, the topic count, twelve zero bytes before each address,
 * exactly 32 bytes of data. A log of the right event on the right token that
 * fails any of them is UNREADABLE, never merely skipped - that is the shape a
 * forgery would take.
 */
export function decodeTempoTransferLog(
  entry: unknown,
  event: TempoTransferEvent,
  token: string,
): TempoLogDecode<TempoTransferLog> {
  const header = readLogHeader(entry);
  if (header === null) {
    return { kind: 'unreadable' };
  }
  if (!sameAddress(header.address, token)) {
    return { kind: 'other' };
  }
  if (header.topics[0] !== EVENT_TOPICS[event]) {
    return { kind: 'other' };
  }
  if (header.topics.length !== EVENT_TOPIC_COUNT[event]) {
    return { kind: 'unreadable' };
  }
  const from = readTopicAddress(header.topics[1]);
  const to = readTopicAddress(header.topics[2]);
  const amount = readAmountWord(header.data);
  if (from === null || to === null || amount === null) {
    return { kind: 'unreadable' };
  }
  const memo = event === 'TransferWithMemo' ? header.topics[3] : undefined;
  if (event === 'TransferWithMemo' && memo === undefined) {
    return { kind: 'unreadable' };
  }
  return {
    kind: 'log',
    log: {
      token: header.address,
      blockHash: header.blockHash,
      from,
      to,
      amount,
      ...(memo === undefined ? {} : { memo }),
      transactionHash: header.transactionHash,
      logIndex: header.logIndex,
      blockNumber: header.blockNumber,
    },
  };
}

/** Words of the `TransferBlocked` data, by their offset in the 448-byte body. */
const BLOCKED_WORDS = {
  amount: 0,
  receiptVersion: 1,
  receiptOffset: 2,
  receiptLength: 3,
  claimVersion: 4,
  token: 5,
  originator: 7,
  recipient: 8,
  kind: 12,
  memo: 13,
} as const;
const BLOCKED_DATA_WORDS = 14;
const CLAIM_RECEIPT_OFFSET = 0x60n;
const CLAIM_RECEIPT_LENGTH = 320n;
const CLAIM_RECEIPT_V1 = 1n;
const CLAIM_KIND_TRANSFER = 0n;

/**
 * Decode one entry as the guard's `TransferBlocked`. The claim receipt inside it
 * must agree with the indexed topics: a log whose body names another token or
 * another recipient than its own topics is not a receipt this code understands,
 * and reading it as one would let a blocked transfer of somebody else's money
 * answer for ours.
 */
export function decodeTempoBlockedLog(entry: unknown): TempoLogDecode<TempoBlockedLog> {
  const header = readLogHeader(entry);
  if (header === null) {
    return { kind: 'unreadable' };
  }
  if (!sameAddress(header.address, TEMPO_TRANSFER_GUARD)) {
    return { kind: 'other' };
  }
  if (header.topics[0] !== TRANSFER_BLOCKED_TOPIC) {
    return { kind: 'other' };
  }
  if (header.topics.length !== 4) {
    return { kind: 'unreadable' };
  }
  const token = readTopicAddress(header.topics[1]);
  const receiver = readTopicAddress(header.topics[2]);
  const words = readWords(header.data, BLOCKED_DATA_WORDS);
  if (token === null || receiver === null || words === null) {
    return { kind: 'unreadable' };
  }
  const amount = readUint256(words[BLOCKED_WORDS.amount]);
  const receiptVersion = readUint256(words[BLOCKED_WORDS.receiptVersion]);
  const receiptOffset = readUint256(words[BLOCKED_WORDS.receiptOffset]);
  const receiptLength = readUint256(words[BLOCKED_WORDS.receiptLength]);
  const claimVersion = readUint256(words[BLOCKED_WORDS.claimVersion]);
  const kind = readUint256(words[BLOCKED_WORDS.kind]);
  const receiptToken = readAddressWord(words[BLOCKED_WORDS.token]);
  const originator = readAddressWord(words[BLOCKED_WORDS.originator]);
  const recipient = readAddressWord(words[BLOCKED_WORDS.recipient]);
  const memo = words[BLOCKED_WORDS.memo];
  // A claim of another KIND is somebody else's event, not a malformed one:
  // the guard emits `TransferBlocked` for a bounced MINT too, and 28 of those
  // are on Moderato today - one naming the registry coin and a receiver this
  // suite uses. Unreadable would make the pass incomplete, and an incomplete
  // guard pass is what stops `none` and `fee_leg_missing` from ever being
  // reached. The "unreadable is not empty" rule is about FORGERIES; a real
  // mint bounce is not one.
  if (kind !== null && kind !== CLAIM_KIND_TRANSFER) {
    return { kind: 'other' };
  }
  if (
    amount === null ||
    receiptVersion !== CLAIM_RECEIPT_V1 ||
    receiptOffset !== CLAIM_RECEIPT_OFFSET ||
    receiptLength !== CLAIM_RECEIPT_LENGTH ||
    claimVersion !== CLAIM_RECEIPT_V1 ||
    receiptToken === null ||
    originator === null ||
    recipient === null ||
    memo === undefined
  ) {
    return { kind: 'unreadable' };
  }
  if (!sameAddress(receiptToken, token) || !sameAddress(recipient, receiver)) {
    return { kind: 'unreadable' };
  }
  return {
    kind: 'log',
    log: {
      token,
      receiver,
      amount,
      originator,
      recipient,
      memo: `0x${memo}`,
      transactionHash: header.transactionHash,
      logIndex: header.logIndex,
      blockNumber: header.blockNumber,
    },
  };
}

/**
 * The finalized block, as a number and a timestamp. `finalized` equals `latest`
 * on both Tempo networks today, but the tag is asked for once here and the
 * NUMBER is what every scan then uses: a lagging backend resolves the tag to its
 * own older head without an error, while a number above its head is an explicit
 * one.
 */
export async function readFinalizedBlock(client: Eip1193Client): Promise<TempoHeadRef | null> {
  const block = await client
    .request({ method: 'eth_getBlockByNumber', params: ['finalized', false] })
    .catch(() => null);
  const number = readBlockNumber(readField(block, 'number'));
  const timestamp = readBlockNumber(readField(block, 'timestamp'));
  if (number === null || timestamp === null) {
    return null;
  }
  return { number, timestamp };
}

/** A block by NUMBER, for reading the timestamp a scan actually reached. */
export async function readBlockByNumber(
  client: Eip1193Client,
  blockNumber: number,
): Promise<TempoBlockRef | null> {
  const block = await client
    .request({ method: 'eth_getBlockByNumber', params: [toQuantity(blockNumber), false] })
    .catch(() => null);
  const number = readBlockNumber(readField(block, 'number'));
  const timestamp = readBlockNumber(readField(block, 'timestamp'));
  const hash = readTxHash(readField(block, 'hash'));
  if (number === null || timestamp === null || hash === null || number !== blockNumber) {
    return null;
  }
  return { number, timestamp, hash };
}

/**
 * Tempo answers FOUR different `eth_getLogs` failures with `-32602` and no
 * `data`, so they are told apart by the node's own message and nothing else.
 * Only the two that mean "you asked for too much" are worth retrying smaller;
 * "invalid block range params" and a range beyond the head are not, and a retry
 * loop on them would be an infinite one.
 */
function isTooMuchError(error: unknown): boolean {
  // Read the words off whatever was thrown, not off one class: this module is
  // exported for a browser wallet's own provider, which throws its own error
  // shape, and a client whose cap errors go unrecognized never halves -
  // it skips whole chunks and calls the pass incomplete for good.
  // Each place the words could be is tested ON ITS OWN: joined together, half
  // a phrase in one field and half in another would match a sentence neither
  // of them says.
  const places = [
    error instanceof EvmRpcError ? error.rpcMessage : undefined,
    readField(error, 'message'),
    readField(readField(error, 'data'), 'message'),
  ];
  return places.some(
    (place) =>
      typeof place === 'string' &&
      (/exceeds max results/i.test(place) || /exceeds max block range/i.test(place)),
  );
}

interface ScanRequest {
  address: string;
  topics: (string | null)[];
  fromBlock: number;
  toBlock: number;
  signal?: AbortSignal;
}

interface ScanOutcome {
  complete: boolean;
}

/**
 * Walk `[fromBlock, toBlock]` in chunks, handing every entry to `onEntry`.
 *
 * A chunk that fails does NOT stop the walk: the money may be in a later one,
 * and a pass that found it credits whether or not it was complete. What a
 * failure does is make the pass incomplete for good, which is what forbids the
 * "nothing was ever sent" verdict.
 */
async function scanLogs(
  client: Eip1193Client,
  request: ScanRequest,
  onEntry: (entry: unknown) => 'ok' | 'drop' | 'unreadable',
): Promise<ScanOutcome> {
  let cursor = request.fromBlock;
  let size = MAX_LOG_BLOCK_RANGE;
  let complete = true;
  let requests = 0;
  while (cursor <= request.toBlock) {
    if (request.signal?.aborted || requests >= MAX_LOG_SCAN_REQUESTS) {
      return { complete: false };
    }
    requests += 1;
    const chunkTo = Math.min(cursor + size - 1, request.toBlock);
    let result: unknown;
    try {
      // An injected client may have no deadline of its own, so the caller's
      // signal has to be able to stop us AWAITING one - not only between chunks.
      result = await withAbort(
        client.request({
          method: 'eth_getLogs',
          params: [
            {
              address: request.address,
              topics: request.topics,
              fromBlock: toQuantity(cursor),
              toBlock: toQuantity(chunkTo),
            },
          ],
        }),
        request.signal,
      );
    } catch (error) {
      // A single-block chunk that is still too much cannot be split further.
      if (isTooMuchError(error) && size > 1) {
        size = Math.max(1, Math.floor(size / 2));
        continue;
      }
      complete = false;
      cursor = chunkTo + 1;
      continue;
    }
    if (!Array.isArray(result)) {
      complete = false;
      cursor = chunkTo + 1;
      continue;
    }
    for (const entry of result) {
      if (onEntry(entry) === 'unreadable') {
        complete = false;
      }
    }
    cursor = chunkTo + 1;
  }
  return { complete };
}

export interface ListTempoLogsOptions {
  /** The registry token. Logs from any other emitter are not this token's. */
  token: string;
  event: TempoTransferEvent;
  /** The receiving side, always filtered: a leg counts whoever paid it. */
  to: string;
  /** Filtered only for a memo-less leg, where the sender is what binds it. */
  from?: string;
  /** The 32-byte memo word, filtered for a payment leg. */
  memo?: string;
  /** Inclusive floor of the scan, persisted by the issuer beside the request. */
  fromBlock: number;
  /** Logs below this are dropped: they are free to forge and prove nothing. */
  minAmount: bigint;
  /** Inclusive ceiling. Default: the finalized number read now. */
  toBlock?: number;
  signal?: AbortSignal;
}

export interface TempoLogScan {
  candidates: TempoTransferLog[];
  complete: boolean;
  /** The block the scan reached, or `null` when it never started. */
  toBlock: number | null;
}

/**
 * Every candidate transfer of `token` to `to` at or above `minAmount`, between
 * `fromBlock` and the finalized head.
 *
 * `fromBlock` is never defaulted. A missing or nonsensical floor means the
 * caller does not know where its own evidence starts, and substituting one would
 * turn "I did not look" into "I looked and there was nothing".
 */
export async function listTempoLogs(
  client: Eip1193Client,
  options: ListTempoLogsOptions,
): Promise<TempoLogScan> {
  const head = options.toBlock ?? (await readFinalizedBlock(client))?.number ?? null;
  if (head === null) {
    return { candidates: [], complete: false, toBlock: null };
  }
  if (!Number.isSafeInteger(options.fromBlock) || options.fromBlock < 0) {
    return { candidates: [], complete: false, toBlock: head };
  }
  if (options.fromBlock > head) {
    return { candidates: [], complete: false, toBlock: head };
  }
  const topics: (string | null)[] = [
    EVENT_TOPICS[options.event],
    options.from === undefined ? null : addressTopic(options.from),
    addressTopic(options.to),
  ];
  if (options.event === 'TransferWithMemo') {
    topics.push(options.memo ?? null);
  }
  const candidates: TempoTransferLog[] = [];
  const outcome = await scanLogs(
    client,
    {
      address: options.token,
      topics,
      fromBlock: options.fromBlock,
      toBlock: head,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    (entry) => {
      const decoded = decodeTempoTransferLog(entry, options.event, options.token);
      if (decoded.kind !== 'log') {
        // A filtered scan is answered only with logs it asked for, so anything
        // that is not ours is the node answering something else - unreadable.
        return 'unreadable';
      }
      const log = decoded.log;
      if (!sameAddress(log.to, options.to)) {
        return 'unreadable';
      }
      // The block range is a filter dimension like any other: an entry outside
      // the chunk that was asked for is the node answering something else.
      if (log.blockNumber < options.fromBlock || log.blockNumber > (options.toBlock ?? head)) {
        return 'unreadable';
      }
      // A memo can only be re-checked when one was ASKED for: a plain
      // `Transfer` carries none to compare, and a memo scan run WITHOUT a memo
      // never named one in the filter either. Re-checking in either case calls
      // every entry unreadable and leaves the pass permanently incomplete.
      if (
        options.event === 'TransferWithMemo' &&
        options.memo !== undefined &&
        log.memo !== options.memo
      ) {
        return 'unreadable';
      }
      if (options.from !== undefined && !sameAddress(log.from, options.from)) {
        return 'unreadable';
      }
      if (log.amount < options.minAmount || sameAddress(log.from, log.to)) {
        return 'drop';
      }
      candidates.push(log);
      return 'ok';
    },
  );
  return { candidates, complete: outcome.complete, toBlock: head };
}

export interface ListBlockedLogsOptions {
  token: string;
  /** The account whose policy refused - the leg's `to`. */
  receiver: string;
  fromBlock: number;
  toBlock?: number;
  signal?: AbortSignal;
}

export interface TempoBlockedScan {
  candidates: TempoBlockedLog[];
  complete: boolean;
  toBlock: number | null;
}

/**
 * The guard's `TransferBlocked` logs for one token and one receiver. A blocked
 * transfer SUCCEEDS and emits no `TransferWithMemo`, so without this lookup a
 * payment the recipient's own policy refused is indistinguishable from one that
 * was never sent - and the provider would be told "not paid" about money that
 * left the customer's account.
 */
export async function listTempoBlockedLogs(
  client: Eip1193Client,
  options: ListBlockedLogsOptions,
): Promise<TempoBlockedScan> {
  const head = options.toBlock ?? (await readFinalizedBlock(client))?.number ?? null;
  if (head === null) {
    return { candidates: [], complete: false, toBlock: null };
  }
  if (!Number.isSafeInteger(options.fromBlock) || options.fromBlock < 0) {
    return { candidates: [], complete: false, toBlock: head };
  }
  if (options.fromBlock > head) {
    return { candidates: [], complete: false, toBlock: head };
  }
  const candidates: TempoBlockedLog[] = [];
  const outcome = await scanLogs(
    client,
    {
      address: TEMPO_TRANSFER_GUARD,
      topics: [TRANSFER_BLOCKED_TOPIC, addressTopic(options.token), addressTopic(options.receiver)],
      fromBlock: options.fromBlock,
      toBlock: head,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    (entry) => {
      const decoded = decodeTempoBlockedLog(entry);
      if (decoded.kind !== 'log') {
        return 'unreadable';
      }
      const log = decoded.log;
      if (
        !sameAddress(decoded.log.token, options.token) ||
        !sameAddress(decoded.log.receiver, options.receiver)
      ) {
        return 'unreadable';
      }
      // The block range is a filter dimension like any other here too: an
      // entry outside the chunk asked for is the node answering something
      // else, and this scan's empty-and-complete answer is what lets a caller
      // say money was NOT parked with the guard.
      if (log.blockNumber < options.fromBlock || log.blockNumber > (options.toBlock ?? head)) {
        return 'unreadable';
      }
      candidates.push(decoded.log);
      return 'ok';
    },
  );
  return { candidates, complete: outcome.complete, toBlock: head };
}

export interface HistoryControlOptions {
  token: string;
  /** The edge the window ENDS at - one end of the scan being vouched for. */
  edgeBlock: number;
  signal?: AbortSignal;
}

/**
 * Does this endpoint actually serve this token's logs around `edgeBlock`?
 *
 * A node with pruned logs answers `[]` with no error, and an empty answer is
 * exactly what "nobody paid" looks like. So before a scan may conclude that
 * nothing was ever sent, both its edges are vouched for by an UNFILTERED window
 * of the same token that comes back non-empty. A window after the floor could be
 * served from kept recent logs while the payment sits behind the pruning
 * horizon, which is why both edges are checked and not just one.
 *
 * Anything that is not a non-empty answer fails: an error, a non-array, a walk
 * back to genesis that found nothing. Failing means "inconclusive", never "not
 * paid".
 */
export async function passesHistoryControl(
  client: Eip1193Client,
  options: HistoryControlOptions,
): Promise<boolean> {
  if (!Number.isSafeInteger(options.edgeBlock) || options.edgeBlock < 0) {
    return false;
  }
  let width = HISTORY_CONTROL_START_BLOCKS;
  // A width the node has already called too big is a ceiling, not something to
  // walk back into: without it, widening past the range cap oscillates - refuse,
  // halve, empty, widen, refuse - and spends every iteration without reaching
  // further back. A token quieter than one log per cap-width at an edge would
  // then never be vouched for, and `none` would be unreachable for ever.
  let ceiling = Number.MAX_SAFE_INTEGER;
  // The caller's options are the caller's; the window walks on a copy.
  let edge = options.edgeBlock;
  for (let iteration = 0; iteration < MAX_HISTORY_CONTROL_ITERATIONS; iteration += 1) {
    if (options.signal?.aborted) {
      return false;
    }
    const from = Math.max(0, edge - width + 1);
    let result: unknown;
    try {
      result = await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: options.token,
            fromBlock: toQuantity(from),
            toBlock: toQuantity(edge),
          },
        ],
      });
    } catch (error) {
      if (!isTooMuchError(error)) {
        return false;
      }
      // More logs than the node will return is itself proof that it holds this
      // token's history here - but only once the window cannot shrink further.
      if (width <= 1) {
        return true;
      }
      ceiling = width;
      width = Math.max(1, Math.floor(width / 2));
      continue;
    }
    if (!Array.isArray(result)) {
      return false;
    }
    if (result.length > 0) {
      return true;
    }
    if (from === 0) {
      return false;
    }
    if (width * 4 >= ceiling) {
      // Widening further only re-asks a question the node has already refused,
      // so the window SLIDES back instead, at the widest size this endpoint
      // will serve.
      edge = Math.max(0, edge - width);
      continue;
    }
    width *= 4;
  }
  return false;
}
