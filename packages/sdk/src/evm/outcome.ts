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
import {
  EARLIEST_TEMPO_SECONDS,
  LATEST_TEMPO_SECONDS,
  TEMPO_FEE_SINK,
  ZERO_ADDRESS,
} from './constants';
import type { TempoBlockedLog, TempoTransferLog } from './logs';
import {
  decodeTempoBlockedLog,
  decodeTempoTransferLog,
  isOnThisChain,
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
 * One receipt read, or `undefined`.
 *
 * Named, like `requestBlockOrNull` and `callRegistryOrNull`, so the
 * synchronous-throw rule has ONE shape in the three places that need it: the
 * call goes inside the `try`, because a provider that validates its params
 * before returning a promise throws where a `.catch` cannot see it, and this
 * function's header promises that every rpc failure is `pending`.
 */
async function requestReceiptOrUndefined(
  client: Eip1193Client,
  hash: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    return await withAbort(
      client.request({ method: 'eth_getTransactionReceipt', params: [hash] }),
      signal,
    );
  } catch {
    return undefined;
  }
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

/** Thirty-two bytes of hex, in either case - the shape a topic word has. */
function isMemoWord(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Two 32-byte words are the same word whatever case they are spelled in.
 *
 * Both sides are always present here: a leg reaches this only when it names a
 * memo, and the decoder is asked for `TransferWithMemo` in that case, so a log
 * without one is `other` and never arrives. A guard for the absent side would
 * be a claim this code does not make.
 */
function sameWord(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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
  // `log.memo` is optional on the type and never absent here: this line is
  // reached only for a leg that names a memo, and such a leg asks the decoder
  // for `TransferWithMemo`, so a log without one is `other` and never arrives.
  // The narrowing is for the compiler; no test can kill it, and none should be
  // written to pretend otherwise.
  //
  // `from == to` proves nothing and is refused here as it is everywhere else
  // this log class is read: an infinite allowance is never decremented, so
  // `transferFromWithMemo(from = X, to = X)` is a free full-amount memo log for
  // anyone holding X's allowance. The scan drops such an entry (`logs.ts`) and
  // the provider refuses it (`verify.ts`); the receipt path held the rule
  // nowhere, which is the one-site-of-two shape this rail keeps finding.
  return (
    log.memo !== undefined &&
    !sameAddress(log.from, log.to) &&
    sameWord(log.memo, leg.memo) &&
    log.amount >= leg.amount
  );
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
  // A MEMO is the only thing binding a transfer to a request, and it was the
  // one leg field with no shape guard while seven others had one. A value that
  // is not a 32-byte word matches no log and no receipt: `unsent` on the
  // absence path - pay it again, for money that is on chain - and `pending`
  // for ever on the receipt path, which has no absence proof to fall through
  // to. (Measured: `''`, `'0x'`, `'0xdeadbeef'`, a 31-byte word and a
  // prefix-less 64-hex word all reached `unsent` on this project's own fake.
  // Live they land on `pending` instead, because Tempo's rpc refuses four of
  // the five as `-32602` - that is one vendor's parser, not a guard.)
  if (expected.some((leg) => leg.memo !== undefined && !isMemoWord(leg.memo))) {
    throw new Error('resolveTempoTransferOutcome needs a leg memo to be a 32-byte word.');
  }
  // `from` binds a memo-LESS leg to its sender, in the transfer pass and in
  // the guard pass both; a memo leg is by design paid by anyone.
  if (expected.some((leg) => leg.memo === undefined && !isAddressLike(leg.from))) {
    throw new Error('resolveTempoTransferOutcome needs a leg with no memo to name its sender.');
  }
  // A leg pointed back at its own sender moves nothing, and the two halves of
  // this rail read it differently: the scan DROPS a `from == to` log
  // (`logs.ts`), while a receipt would carry it - so the same self-transfer
  // reads `delivered` from its receipt and `unsent` from the absence proof,
  // and `unsent` is the verdict that invites a replacement. Refused here
  // rather than in `matchesLeg`, because a rule in the branch would leave the
  // receipt path `pending` for ever instead of telling the caller its leg is
  // the problem. The customer's gate refuses the same shape as
  // `self_payment`.
  if (expected.some((leg) => typeof leg.from === 'string' && sameAddress(leg.from, leg.to))) {
    throw new Error('resolveTempoTransferOutcome needs every leg to move between two addresses.');
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
  // The call is INSIDE the try, not only the promise it returns: a provider
  // that validates its params synchronously throws before `withAbort` is
  // handed anything to attach a handler to, and this function's header
  // promises that every rpc failure is `pending`.
  const receipt = await requestReceiptOrUndefined(client, hash, options.signal);
  // No test can kill this line and none should be written for it: a failed
  // read falls through `fromReceipt` to the same `pending` anyway. It says in
  // one place what that path only implies - a read that did not happen is not
  // evidence of anything.
  if (receipt === undefined) {
    return { state: 'pending' };
  }
  if (receipt !== null) {
    return await fromReceipt(client, receipt, expected, hash);
  }
  // No receipt here proves nothing about the chain - only that THIS backend has
  // not seen it. The deadline and a complete log pass are what prove absence.
  return await provenUnsent(client, expected, options);
}

async function fromReceipt(
  client: Eip1193Client,
  receipt: unknown,
  expected: readonly TempoLegExpectation[],
  hash: string,
): Promise<TempoTransferOutcome> {
  // The receipt has to be THIS transaction's before anything is read out of
  // it - the revert branch included. A backend that answers with somebody
  // else's failed receipt would otherwise say `unsent`, which is the one
  // verdict that tells the caller it may send a replacement, while ours is
  // still pending: both could land, and that is twice the money.
  if (readTxHash(readField(receipt, 'transactionHash')) !== hash) {
    return { state: 'pending' };
  }
  const blockNumber = readBlockNumber(readField(receipt, 'blockNumber'));
  // ...and it has to be a receipt from THIS chain, before any verdict rests on
  // it - the revert included, for the same reason. A hash binds a receipt to a
  // transaction but not to a network: the two Tempo chains share the token,
  // the guard and the registry addresses, and their heights overlap, so a
  // split endpoint can answer with a receipt that is perfectly real somewhere
  // else. The provider's verifier has bound its reads this way since 2b-i;
  // this is the sender's side of the same rule, and it is the more expensive
  // side to get wrong, because the sender's terminal verdict is what invites
  // a replacement. A block this endpoint cannot show is not evidence either.
  if (
    blockNumber === null ||
    !(await isOnThisChain(client, blockNumber, readTxHash(readField(receipt, 'blockHash'))))
  ) {
    return { state: 'pending' };
  }
  const status = readQuantity(readField(receipt, 'status'));
  if (status === 0n) {
    // A reverted transaction moved nothing, and its hash can never be reused.
    return { state: 'unsent', reason: 'reverted' };
  }
  const logs = readField(receipt, 'logs');
  if (status !== 1n || !Array.isArray(logs)) {
    return { state: 'pending' };
  }

  const blockHash = readTxHash(readField(receipt, 'blockHash'));
  const blocked = blockedLeg(logs, expected, hash, blockNumber, blockHash);
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
          // ...and to the same BLOCK, by hash, not only by height. The receipt
          // above is bound to the chain; its logs arrive in the same object
          // and are bound to it by number alone, which two chains can share.
          // `verify.ts` binds a scanned leg's `blockHash` through the same
          // helper, so this is the third reader of one rule.
          decoded.log.blockHash === blockHash &&
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
  blockHash: string | null,
): TempoTransferOutcome | null {
  for (const entry of logs) {
    const decoded = decodeTempoBlockedLog(entry);
    if (
      decoded.kind !== 'log' ||
      decoded.log.transactionHash !== hash ||
      decoded.log.blockNumber !== blockNumber ||
      // ...and the same BLOCK by hash, as the transfer pass does. A guard log
      // decides the more expensive of the two verdicts - `blocked` tells the
      // sender its money is parked, and a caller that re-sends on that reading
      // pays twice - and it is read FIRST, so an unbound one wins over a
      // delivered match. Height alone is a value the two networks share.
      decoded.log.blockHash !== blockHash
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
    : sameWord(blocked.memo, leg.memo);
}

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
  // The deadline was bounded when it arrived; the head it is compared against
  // needs the CEILING of that same window, because one bounded operand is no
  // comparison at all. Tempo's own consensus counts in milliseconds, so an rpc
  // answering a millisecond `timestamp` is one translation away - and such a
  // value clears every deadline by three orders of magnitude, which would call
  // every transfer still sitting in the mempool `unsent`. That is the
  // replacement that pays twice, decided by a number that was never a time.
  //
  // Only the ceiling is written, because only the ceiling is reachable: a head
  // BELOW `EARLIEST_TEMPO_SECONDS` is below `validBefore` too - the deadline
  // may not be smaller - so the comparison on the next line already answers
  // `pending` for it, and a floor here could never be killed by a test.
  if (
    finalized === null ||
    finalized.timestamp > LATEST_TEMPO_SECONDS ||
    finalized.timestamp < options.validBefore
  ) {
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
      ...(leg.memo === undefined ? { from: leg.from } : { memo: leg.memo.toLowerCase() }),
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
