/**
 * What happened to a transfer this process sent.
 *
 * The SENDER's question, not the receiver's, and a different one: the receiver
 * asks "was I paid", which a memo can answer from anywhere in the chain's
 * history; the sender asks "did MY transaction land", which only its own
 * receipt can answer. So `delivered` is read from that receipt and nowhere
 * else - a leg found by memo in some other transaction is somebody else's
 * payment, and crediting it here would let one job's money answer for another.
 *
 * The verdict that costs the most to get right is `unsent`, because it is the
 * only one that says a transaction may be safely replaced. It takes a reverted
 * receipt, or proof that the deadline has passed AND a complete log pass over
 * every block the transaction could have been in finds nothing of it. A null
 * receipt proves none of that: the node answering may be a lagging backend
 * behind the same load balancer as the one that accepted the broadcast.
 */

import type { Eip1193Client } from './client';
import { withAbort } from './client';
import { TEMPO_FEE_SINK } from './constants';
import type { TempoBlockedLog, TempoTransferLog } from './logs';
import {
  decodeTempoBlockedLog,
  decodeTempoTransferLog,
  listTempoBlockedLogs,
  listTempoLogs,
  readFinalizedBlock,
} from './logs';
import { readBlockNumber, readField, readQuantity, readTxHash } from './rpc-read';

/**
 * One leg of what was sent. A payment is one or two of these; a withdrawal is
 * one with no memo, which is why the memo is optional rather than a second
 * shape.
 */
export interface TempoLegExpectation {
  token: string;
  from: string;
  to: string;
  amount: bigint;
  /** Absent for a memo-less leg - a withdrawal, where the sender is the binding. */
  memo?: string;
}

export type TempoTransferOutcome =
  | { state: 'delivered'; legs: TempoTransferLog[] }
  | {
      state: 'blocked';
      leg: TempoLegExpectation;
      /** Who can claim the parked funds: the receiver's recovery authority, or the sender. */
      claimableBy: string;
    }
  /** Safe to replace: it is not on chain and its deadline has passed. */
  | { state: 'unsent'; reason: 'reverted' | 'deadline_passed' }
  | { state: 'pending' };

export interface ResolveTempoTransferOptions {
  hash: string;
  /** The finalized number the SENDER read before broadcasting: the floor of its own search. */
  floor: number;
  /** The `valid_before` the transaction was signed with, in seconds. */
  validBefore: number;
  signal?: AbortSignal;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function matchesLeg(log: TempoTransferLog, leg: TempoLegExpectation): boolean {
  if (!sameAddress(log.token, leg.token) || !sameAddress(log.to, leg.to)) {
    return false;
  }
  if (leg.memo === undefined) {
    // A memo-less leg is bound by its SENDER and its exact amount - the only
    // things it has. The token's own gas `Transfer` to the fee sink is the
    // shape this must never match, and it never does: a different destination.
    return sameAddress(log.from, leg.from) && log.amount === leg.amount;
  }
  return log.memo === leg.memo && log.amount >= leg.amount;
}

/**
 * Read the outcome of one transaction from the sender's own rpc.
 *
 * Every rpc failure is `pending`. A sender that cannot read the chain knows
 * nothing, and the one thing it must not do is conclude that its transaction
 * is gone - the replacement would be a second payment.
 */
export async function resolveTempoTransferOutcome(
  client: Eip1193Client,
  expected: readonly TempoLegExpectation[],
  options: ResolveTempoTransferOptions,
): Promise<TempoTransferOutcome> {
  if (expected.length === 0) {
    throw new Error('resolveTempoTransferOutcome needs at least one expected leg.');
  }
  const receipt = await withAbort(
    client.request({ method: 'eth_getTransactionReceipt', params: [options.hash] }),
    options.signal,
  ).catch(() => undefined);
  if (receipt === undefined) {
    return { state: 'pending' };
  }
  if (receipt !== null) {
    return fromReceipt(receipt, expected, options.hash);
  }
  // No receipt here proves nothing about the chain - only that THIS backend has
  // not seen it. The deadline and a complete log pass are what prove absence.
  return await provenUnsent(client, expected, options);
}

function fromReceipt(
  receipt: unknown,
  expected: readonly TempoLegExpectation[],
  hash: string,
): TempoTransferOutcome {
  const status = readQuantity(readField(receipt, 'status'));
  if (status === 0n) {
    // A reverted transaction moved nothing, and its hash can never be reused.
    return { state: 'unsent', reason: 'reverted' };
  }
  const blockNumber = readBlockNumber(readField(receipt, 'blockNumber'));
  const logs = readField(receipt, 'logs');
  if (
    status !== 1n ||
    readTxHash(readField(receipt, 'transactionHash')) !== hash ||
    blockNumber === null ||
    !Array.isArray(logs)
  ) {
    return { state: 'pending' };
  }

  const blocked = blockedLeg(logs, expected, hash, blockNumber);
  if (blocked !== null) {
    return blocked;
  }

  const found: TempoTransferLog[] = [];
  for (const leg of expected) {
    const event = leg.memo === undefined ? 'Transfer' : 'TransferWithMemo';
    const match = logs
      .map((entry) => decodeTempoTransferLog(entry, event, leg.token))
      .find(
        (decoded) =>
          decoded.kind === 'log' &&
          decoded.log.transactionHash === hash &&
          decoded.log.blockNumber === blockNumber &&
          !sameAddress(decoded.log.to, TEMPO_FEE_SINK) &&
          matchesLeg(decoded.log, leg),
      );
    if (match === undefined || match.kind !== 'log') {
      // The transaction succeeded and this leg is not in it: nothing here is
      // safe to call delivered, and nothing is safe to call unsent either.
      return { state: 'pending' };
    }
    found.push(match.log);
  }
  return { state: 'delivered', legs: found };
}

/** A guard log in this receipt naming one of our legs, and who may claim it. */
function blockedLeg(
  logs: readonly unknown[],
  expected: readonly TempoLegExpectation[],
  hash: string,
  blockNumber: number,
): TempoTransferOutcome | null {
  for (const entry of logs) {
    const decoded = decodeTempoBlockedLog(entry);
    if (
      decoded.kind !== 'log' ||
      decoded.log.transactionHash !== hash ||
      decoded.log.blockNumber !== blockNumber
    ) {
      continue;
    }
    const leg = expected.find((candidate) => matchesBlocked(decoded.log, candidate));
    if (leg !== undefined) {
      return { state: 'blocked', leg, claimableBy: claimantOf(decoded.log, leg) };
    }
  }
  return null;
}

function matchesBlocked(blocked: TempoBlockedLog, leg: TempoLegExpectation): boolean {
  if (!sameAddress(blocked.token, leg.token) || !sameAddress(blocked.receiver, leg.to)) {
    return false;
  }
  if (blocked.amount < leg.amount) {
    return false;
  }
  return leg.memo === undefined
    ? sameAddress(blocked.originator, leg.from)
    : blocked.memo === leg.memo;
}

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

/**
 * Blocked funds are claimable by the receiver's recovery authority, or - when
 * that is the zero address - by whoever sent them.
 */
function claimantOf(blocked: TempoBlockedLog, leg: TempoLegExpectation): string {
  return blocked.recoveryAuthority === ZERO_ADDRESS ? leg.from : blocked.recoveryAuthority;
}

/**
 * The only proof that a transaction will never land: a finalized block whose
 * timestamp is at or past the deadline it was signed with, and then a COMPLETE
 * pass over every block it could have been in that finds nothing of any leg.
 *
 * Anything short of that is `pending`. Concluding otherwise lets the caller
 * send a replacement while the original can still be included - and both could
 * land, which is twice the money.
 */
async function provenUnsent(
  client: Eip1193Client,
  expected: readonly TempoLegExpectation[],
  options: ResolveTempoTransferOptions,
): Promise<TempoTransferOutcome> {
  const finalized = await readFinalizedBlock(client);
  if (finalized === null || finalized.timestamp < options.validBefore) {
    return { state: 'pending' };
  }
  for (const leg of expected) {
    const scan = await listTempoLogs(client, {
      token: leg.token,
      event: leg.memo === undefined ? 'Transfer' : 'TransferWithMemo',
      to: leg.to,
      // A memo-less leg is bound by its sender, and ANY transfer of the right
      // size between them counts as something - which can only turn "unsent"
      // into "pending", never the other way.
      ...(leg.memo === undefined ? { from: leg.from } : { memo: leg.memo }),
      minAmount: leg.amount,
      fromBlock: options.floor,
      toBlock: finalized.number,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!scan.complete || scan.candidates.length > 0) {
      return { state: 'pending' };
    }
    const guard = await listTempoBlockedLogs(client, {
      token: leg.token,
      receiver: leg.to,
      fromBlock: options.floor,
      toBlock: finalized.number,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!guard.complete || guard.candidates.some((log) => matchesBlocked(log, leg))) {
      return { state: 'pending' };
    }
  }
  return { state: 'unsent', reason: 'deadline_passed' };
}
