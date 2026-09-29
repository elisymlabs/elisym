/**
 * The memo legs one transaction's receipt holds, read with the trust rules of a
 * verify by hash: the receipt is the one asked for, its block is finalized and
 * bound to this chain, and `eth_chainId` names the chain before anything but
 * "unreadable" is answered.
 *
 * `absent` (the endpoint knows no such transaction) is answered before the
 * chain is named: it only ever means "ask again".
 *
 * A merchant reads it BEFORE a full verify of a hash a buyer reported: a hash
 * with no receipt, or with no leg for this order, costs one read instead of a
 * memo scan, so free reports of other people's hashes stay cheap. `none` is
 * evidence about this one receipt only - a receipt read and a log scan may be
 * answered by different backends, so a caller never treats it as final about
 * the payment.
 */
import type { ChainConfig } from '../payment/chains';
import type { Eip1193Client } from './client';
import { withAbort } from './client';
import { checkEvmChain } from './config';
import type { TempoBlockedLog, TempoTransferLog } from './logs';
import {
  decodeTempoBlockedLog,
  decodeTempoTransferLog,
  isOnThisChain,
  readFinalizedBlock,
} from './logs';
import { readBlockNumber, readField, readQuantity, readTxHash } from './rpc-read';

export interface ReadTempoReceiptLegsOptions {
  /** The chain the payment is on: `eth_chainId` must name it. */
  chain: ChainConfig;
  /** The registry tokens a leg may be in (lowercase contract addresses). */
  tokens: readonly string[];
  /** The payout addresses a leg may pay (lowercase). */
  recipients: readonly string[];
  /** The order's memo (0x + 64 lowercase hex). */
  memo: string;
  /** The lowest amount a leg must carry; the caller filters per term. */
  minAmount: bigint;
  signal?: AbortSignal;
}

export type TempoReceiptLegs =
  /** Nothing could be trusted: ask again. */
  | { kind: 'unreadable' }
  /** The endpoint knows no such transaction (yet). */
  | { kind: 'absent' }
  /** A trusted receipt with no leg for this memo to these recipients. */
  | { kind: 'none' }
  | {
      kind: 'legs';
      blockNumber: number;
      /** `TransferWithMemo` legs with this memo to a recipient, at least `minAmount`. */
      transfers: TempoTransferLog[];
      /** Transfers with this memo to a recipient that its receive policy blocked. */
      blocked: TempoBlockedLog[];
    };

const UNREADABLE: TempoReceiptLegs = { kind: 'unreadable' };

async function readReceipt(
  client: Eip1193Client,
  hash: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  // The call sits inside the try: a provider that validates synchronously
  // throws where a `.catch` on the promise cannot see it.
  try {
    return await withAbort(
      client.request({ method: 'eth_getTransactionReceipt', params: [hash] }),
      signal,
    );
  } catch {
    return undefined;
  }
}

export async function readTempoReceiptLegs(
  client: Eip1193Client,
  hash: string,
  options: ReadTempoReceiptLegsOptions,
): Promise<TempoReceiptLegs> {
  const wanted = readTxHash(hash);
  if (wanted === null) {
    return UNREADABLE;
  }
  const receipt = await readReceipt(client, wanted, options.signal);
  if (receipt === null) {
    return { kind: 'absent' };
  }
  if (receipt === undefined || readTxHash(readField(receipt, 'transactionHash')) !== wanted) {
    return UNREADABLE;
  }
  const status = readQuantity(readField(receipt, 'status'));
  const blockNumber = readBlockNumber(readField(receipt, 'blockNumber'));
  const logs = readField(receipt, 'logs');
  if ((status !== 0n && status !== 1n) || blockNumber === null) {
    return UNREADABLE;
  }
  if (status === 1n && !Array.isArray(logs)) {
    return UNREADABLE;
  }
  const finalized = await readFinalizedBlock(client);
  if (finalized === null || blockNumber > finalized.number) {
    return UNREADABLE;
  }
  if (!(await isOnThisChain(client, blockNumber, readTxHash(readField(receipt, 'blockHash'))))) {
    return UNREADABLE;
  }

  const tokens = new Set(options.tokens.map((token) => token.toLowerCase()));
  const recipients = new Set(options.recipients.map((recipient) => recipient.toLowerCase()));
  const memo = options.memo.toLowerCase();
  const transfers: TempoTransferLog[] = [];
  const blocked: TempoBlockedLog[] = [];
  // A reverted transaction emitted nothing: it holds no leg.
  const entries: readonly unknown[] = status === 1n && Array.isArray(logs) ? logs : [];
  for (const entry of entries) {
    for (const token of tokens) {
      const decoded = decodeTempoTransferLog(entry, 'TransferWithMemo', token);
      if (
        decoded.kind === 'log' &&
        decoded.log.transactionHash === wanted &&
        decoded.log.blockNumber === blockNumber &&
        recipients.has(decoded.log.to) &&
        decoded.log.memo === memo &&
        decoded.log.amount >= options.minAmount &&
        decoded.log.from !== decoded.log.to
      ) {
        transfers.push(decoded.log);
      }
    }
    const guard = decodeTempoBlockedLog(entry);
    if (
      guard.kind === 'log' &&
      guard.log.transactionHash === wanted &&
      guard.log.blockNumber === blockNumber &&
      tokens.has(guard.log.token) &&
      recipients.has(guard.log.receiver) &&
      guard.log.memo === memo &&
      guard.log.amount >= options.minAmount
    ) {
      blocked.push(guard.log);
    }
  }

  // Every answer past "unreadable" needs the chain NAMED: the two Tempo
  // networks share the token and guard addresses.
  const named = await withAbort(checkEvmChain(client, options.chain), options.signal).catch(
    () => null,
  );
  if (named === null) {
    return UNREADABLE;
  }
  if (transfers.length === 0 && blocked.length === 0) {
    return { kind: 'none' };
  }
  return { kind: 'legs', blockNumber, transfers, blocked };
}
