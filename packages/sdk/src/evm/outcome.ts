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

import type { ChainConfig } from '../payment/chains';
import { isVirtualEvmAddress } from '../payment/chains';
import type { Eip1193Client } from './client';
import { withAbort } from './client';
import { checkEvmChain, WrongEvmChainError } from './config';
import { EARLIEST_TEMPO_SECONDS, LATEST_TEMPO_SECONDS, TEMPO_FEE_SINK } from './constants';
import type { TempoBlockedLog, TempoTransferLog } from './logs';
import {
  decodeTempoBlockedLog,
  decodeTempoTransferLog,
  listTempoBlockedLogs,
  listTempoLogs,
  passesHistoryControl,
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
  /**
   * The chain this transfer was sent on. Read, not assumed: a caller holding a
   * browser wallet's provider does not control which network it is on, and
   * pathUSD lives at the SAME address on both Tempo networks, so a Moderato
   * transfer looked for on mainnet finds an endpoint that answers every
   * question plausibly and nothing of ours - which is `unsent`.
   */
  chain: ChainConfig;
  hash: string;
  /** The finalized number the SENDER read before broadcasting: the floor of its own search. */
  floor: number;
  /** The `valid_before` the transaction was signed with, in seconds. */
  validBefore: number;
  signal?: AbortSignal;
}

/**
 * Is this endpoint NOT the chain the caller named?
 *
 * A mismatch throws out of `checkEvmChain` - a misconfiguration the caller has
 * to fix, the same class of error as a hash that is not a hash. An endpoint
 * that will not say answers `true` here, and the caller gets `pending`.
 *
 * This is the gate BEFORE the reads, where another chain is a
 * misconfiguration the caller has to fix. `stillOnThisChain` is the one after
 * them, where the same answer means a user switched networks mid-call - not a
 * fault, and not something to throw at a polling loop.
 */
async function notOnThisChain(
  client: Eip1193Client,
  options: ResolveTempoTransferOptions,
): Promise<boolean> {
  const chainId = await withAbort(checkEvmChain(client, options.chain), options.signal).catch(
    (error: unknown) => {
      // A MISMATCH is the caller's to fix and is never swallowed. Anything
      // else - an abandoned call, a dead endpoint - is "could not confirm".
      if (error instanceof WrongEvmChainError) {
        throw error;
      }
      return null;
    },
  );
  return chainId === null;
}

/**
 * The closing ask, where ANY answer but "still this chain" means the reads
 * above cannot be trusted - and none of them is worth throwing over, because
 * a network switch mid-call is the ordinary case this exists to catch.
 */
async function stillOnThisChain(
  client: Eip1193Client,
  options: ResolveTempoTransferOptions,
): Promise<boolean> {
  const chainId = await withAbort(checkEvmChain(client, options.chain), options.signal).catch(
    () => null,
  );
  return chainId !== null;
}

/**
 * Twenty bytes and nothing else. Anything shorter is not an address a log can
 * carry, so a leg built on one is `pending` for ever rather than refused -
 * which is the whole reason this guard exists. Case-insensitive on purpose: a
 * wallet's `getAddresses()` answers EIP-55 and that is a legitimate caller.
 */
function isAddressLike(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function matchesLeg(log: TempoTransferLog, leg: TempoLegExpectation): boolean {
  // The token comparison is dead on both call paths - the decoder is handed
  // `leg.token` and answers `other` for any other emitter, and the scan filters
  // by address - and is kept so the predicate is true on its own terms.
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
  // Nothing to satisfy is satisfied by anything: an empty list makes `every`
  // true and would call a receipt `delivered` for money nobody expected. A
  // value that is not a list at all throws out of `.some` a few lines down,
  // which is this function's own error told in somebody else's words.
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error('resolveTempoTransferOutcome needs at least one expected leg.');
  }
  // Lowercased ONCE, here. Every hash read off the chain is lowercase, so an
  // uppercase one from a wallet would match no receipt and no log, and a
  // non-null receipt can never reach the absence proof: the answer would be
  // `pending` for ever, for a payment that landed.
  const hash = readTxHash(options.hash);
  if (hash === null) {
    throw new Error(`resolveTempoTransferOutcome needs a transaction hash, not ${options.hash}.`);
  }
  // The deadline decides the money verdict, so it is refused the same way the
  // hash is. `NaN`, `null` and `undefined` all compare FALSE against a block
  // timestamp, which would pass the gate below and reach `unsent` - the one
  // answer that tells the caller to send the money again - on a transaction
  // that can still land.
  // A deadline is a TIME, not merely a number: `0`, a negative, or any past
  // epoch second makes the gate below true on the first read, so a complete
  // empty scan answers `unsent` at once about a transaction still in the
  // mempool. (A caller passing a smaller deadline than the one it signed with
  // is beyond reach from here - that is the caller's own record to keep.)
  if (
    !Number.isFinite(options.validBefore) ||
    options.validBefore < EARLIEST_TEMPO_SECONDS ||
    options.validBefore > LATEST_TEMPO_SECONDS
  ) {
    throw new Error(`resolveTempoTransferOutcome needs a deadline, not ${options.validBefore}.`);
  }
  // Every address on the leg is matched against a log by `sameAddress`, which
  // lowercases what it is given: one that is not a string matches nothing at
  // all, so the leg is `pending` for ever rather than refused.
  if (expected.some((leg) => !isAddressLike(leg.token) || !isAddressLike(leg.to))) {
    throw new Error('resolveTempoTransferOutcome needs every leg to name a token and a receiver.');
  }
  // `from` binds a memo-LESS leg to its sender, in the transfer pass and in
  // the guard pass both; a memo leg is by design paid by anyone.
  if (expected.some((leg) => leg.memo === undefined && !isAddressLike(leg.from))) {
    throw new Error('resolveTempoTransferOutcome needs a leg with no memo to name its sender.');
  }
  // A leg of nothing is satisfied by a log that moved nothing, and those are
  // free to forge: `transferFromWithMemo` of zero succeeds from any caller.
  if (expected.some((leg) => typeof leg.amount !== 'bigint' || leg.amount <= 0n)) {
    // A leg of nothing is satisfied by a log that moved nothing, and a leg
    // whose amount is a `number` matches nothing at all: `log.amount === 5`
    // is false for every bigint, so such a leg is `pending` for ever.
    throw new Error(
      'resolveTempoTransferOutcome needs every leg to expect a positive amount of subunits.',
    );
  }
  // Not an rpc failure and not transient: a chain this rail cannot read is the
  // caller naming the wrong one, one identifier away in a dual-rail SDK, and
  // it would otherwise poll `pending` for ever with no traffic to notice.
  if (options.chain.family !== 'evm' || options.chain.evmChainId === undefined) {
    throw new Error(`resolveTempoTransferOutcome cannot read ${options.chain.caip2}.`);
  }
  // An endpoint that names another chain is a misconfiguration the caller has
  // to fix, and the same class of caller error as a hash that is not a hash.
  // One it cannot answer is an rpc failure like any other: `pending`.
  if (await notOnThisChain(client, options)) {
    return { state: 'pending' };
  }
  const receipt = await withAbort(
    client.request({ method: 'eth_getTransactionReceipt', params: [hash] }),
    options.signal,
  ).catch(() => undefined);
  // No test can kill this line and none should be written for it: a failed
  // read falls through `fromReceipt` to the same `pending` anyway. It says in
  // one place what that path only implies - a read that did not happen is not
  // evidence of anything.
  if (receipt === undefined) {
    return { state: 'pending' };
  }
  if (receipt !== null) {
    return fromReceipt(receipt, expected, hash);
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
  // The receipt has to be THIS transaction's before anything is read out of
  // it - the revert branch included. A backend that answers with somebody
  // else's failed receipt would otherwise say `unsent`, which is the one
  // verdict that tells the caller it may send a replacement, while ours is
  // still pending: both could land, and that is twice the money.
  if (readTxHash(readField(receipt, 'transactionHash')) !== hash) {
    return { state: 'pending' };
  }
  const status = readQuantity(readField(receipt, 'status'));
  if (status === 0n) {
    // A reverted transaction moved nothing, and its hash can never be reused.
    return { state: 'unsent', reason: 'reverted' };
  }
  const blockNumber = readBlockNumber(readField(receipt, 'blockNumber'));
  const logs = readField(receipt, 'logs');
  if (status !== 1n || blockNumber === null || !Array.isArray(logs)) {
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
      return { state: 'blocked', leg, claimableBy: claimantOf(decoded.log) };
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
 * that is the zero address - by whoever sent them. Both values come off the
 * guard's own log: a memo leg may have been paid by a relayer, so the leg's
 * `from` is what we EXPECTED to send it, not necessarily who did.
 */
function claimantOf(blocked: TempoBlockedLog): string {
  return blocked.recoveryAuthority === ZERO_ADDRESS
    ? blocked.originator
    : blocked.recoveryAuthority;
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
    // TIP-1022: a blocked transfer to an ALIAS emits a `TransferBlocked`
    // naming the master, so the guard pass below - which asks about the alias
    // - cannot see it, while the transfer pass finds nothing because a blocked
    // transfer emits no memo log at all. The two together would read as "never
    // sent" on money already parked with the guard. The transfer pass is sound
    // here (the memo log's `to` is the alias as passed); it is the ABSENCE of
    // guard evidence that is unreadable, and `unsent` rests on it.
    // ...and the same for a virtual SENDER on a memo-less leg, where the scan
    // filters on a `from` topic no log can ever carry: the alias is resolved
    // before the transfer is recorded, so the absence it proves is vacuous.
    if (isVirtualEvmAddress(leg.to) || (leg.memo === undefined && isVirtualEvmAddress(leg.from))) {
      return { state: 'pending' };
    }
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
      // Ending AT the finalized number is enough only because `valid_before`
      // is STRICT: a block whose timestamp is at or past it cannot include the
      // transaction, and the gate above has established that this one is.
      // Block timestamps do repeat from one block to the next on both
      // networks, so a relaxed rule would leave blocks above this ceiling
      // that could still carry the transaction.
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
    // An empty window is what a node with pruned logs answers, with no error -
    // and it is also what "nothing was sent" looks like. The receiver's side
    // refuses to say `none` without this control, and `unsent` is the more
    // expensive verdict of the two: it tells the caller to send the money
    // again.
    const vouched =
      (await passesHistoryControl(client, {
        token: leg.token,
        edgeBlock: options.floor,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })) &&
      (await passesHistoryControl(client, {
        token: leg.token,
        edgeBlock: finalized.number,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }));
    if (!vouched) {
      return { state: 'pending' };
    }
  }
  // Everything above was read from an endpoint that named this chain when we
  // started. `unsent` is the answer that spends money a second time, so the
  // endpoint is asked once more that it is still the same chain.
  if (!(await stillOnThisChain(client, options))) {
    return { state: 'pending' };
  }
  return { state: 'unsent', reason: 'deadline_passed' };
}
