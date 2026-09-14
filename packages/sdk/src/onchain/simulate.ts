/**
 * Step three: recompile the call under the client's control, then simulate it
 * and read the state it would leave behind.
 *
 * Two things move from the provider to the client here, and both are the point:
 *
 * - **The lifetime.** A fresh blockhash is set by us, so a call cannot arrive
 *   with a stale one (simulation would pass under `replaceRecentBlockhash` and
 *   the real send would fail after the user had already signed).
 * - **The budget.** Every `ComputeBudget` instruction that PRICES the call is
 *   stripped and replaced with our own limit and price. A priority fee is
 *   lamports leaving the signer that a simulation reports no figure for, so
 *   leaving it in provider hands would be an unbounded, invisible charge. The two that only
 *   ask for room rather than set a price (`RequestHeapFrame`,
 *   `SetLoadedAccountsDataSizeLimit`) are kept - see
 *   `CLIENT_PRESERVED_BUDGET_DISCRIMINATORS`.
 *
 * Two passes, because the budget is not inert. A program can read its own
 * remaining compute (`sol_remaining_compute_units`) and branch on it, so a
 * transaction simulated WITHOUT the budget instructions is not the same call as
 * the one the customer signs WITH them. Pass one therefore only sizes the call;
 * pass two simulates the exact bytes that will be signed, and every fact the
 * ceilings are asserted against comes from that second run.
 *
 * The fee itself is still arithmetic, never inferred from the simulation. The
 * simulation does charge it - it debits the fee payer before execution - but it
 * reports no figure, so `feeFor` computes it and `analyzeStateChange` takes it
 * back out of the fee payer's delta rather than letting it be counted twice.
 */

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { estimatePriorityFeeMicroLamports } from '../payment/priorityFee';
import type { Network } from '../types';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS_STR, isProviderBudgetInstruction } from './checks';
import {
  MAX_TRANSACTION_ACCOUNTS,
  MAX_WIRE_TRANSACTION_BYTES,
  SYSTEM_PROGRAM_ADDRESS_STR,
} from './constants';
import { instructionsOf, type CallInstruction, type DecodedCall } from './decode';
import { describeError, OnchainRefusalError, refuse } from './errors';

/** Owner of every account that does not exist, and of every account just closed. */

/** Lamports every signature costs. Solana's base fee, fixed. */
const SIGNATURE_FEE_LAMPORTS = 5_000n;

/** Ceiling the runtime itself enforces on a transaction's compute-unit limit. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000n;

/** Headroom over the simulated consumption, so a slightly heavier real run still fits. */
const COMPUTE_UNIT_HEADROOM = 10_000n;

/** Percentile of recent prioritization fees to bid, matching the web app's payment path. */
const PRIORITY_FEE_PERCENTILE = 75;

/**
 * How far the authoritative simulation's slot may run ahead of the pre-state
 * read. Bounded, because the subtraction of the two reads is the whole ceiling.
 *
 * Measured against mainnet: five consecutive verifications of one call on a
 * live wallet drifted 0-1 slots, and the wallet's own balance moved ~16k
 * lamports per slot. So 32 is ~30x the observed drift and buys nothing at the
 * top of its range - but it is not free to tighten either: the bound is in
 * SLOTS while the risk is in LAMPORTS, and a busier account moves more per
 * slot than the one measured. Left generous deliberately; the ceilings, not
 * this, are what bound what can leave.
 */
const MAX_STATE_SLOT_DRIFT = 32n;

export interface AccountSnapshot {
  address: string;
  /** False when the account does not exist at this point in time. */
  exists: boolean;
  lamports: bigint;
  /** Owning program. Empty string when the account does not exist. */
  owner: string;
  /** True for a program account - written to only in the sense of being invoked. */
  executable: boolean;
  data: Uint8Array;
  /**
   * The account's true on-chain length, which the RPC reports even under a
   * `dataSlice`. Used to bound how much the post-state read can be made to
   * pull, and to apply the token-account layout rules to the length the account
   * really has rather than the length that was returned.
   *
   * `readPreState` REFUSES a missing one, because reading it as zero would void
   * that bound. The post side defaults to `0` instead: its data arrives whole,
   * so `data.length` is already the true length there, and a real node reports
   * `space` on both. The asymmetry is deliberate, and the post side is the
   * lenient one only because it does not need the field.
   */
  space: number;
}

/** Bytes of account data the verifier reads: the SPL token account base layout. */
const TOKEN_ACCOUNT_SLICE = 165;

/**
 * Total account bytes one call may make the client read. The pre-state is
 * sliced to the token layout, but `simulateTransaction` has no `dataSlice`, so
 * the post-state is pulled whole - a provider naming a handful of multi-megabyte
 * accounts would otherwise make a browser download tens of megabytes per
 * preview. Far above anything a real routed call touches; this is a denial-of-
 * service bound, not a policy.
 *
 * Measured over accounts that already exist, since that is where `space` is
 * reported. An account the call CREATES is bounded instead by its rent, which
 * the signer must actually hold: ~70 SOL for 10 MB, and a simulation that
 * cannot pay it fails before any post-state is read.
 */
const MAX_TOTAL_ACCOUNT_BYTES = 10_000_000;

/**
 * What the price instruction adds to the sizing probe, which already carries
 * the limit instruction and so already pays for the program's account slot:
 * program index, account count, data length, and a u64 behind its discriminator.
 * Fixed, because a compute-budget value encodes to a constant width whatever
 * number it holds - which is what lets the final size be known before the probe
 * has told us what that number is.
 */
export const PRICE_INSTRUCTION_BYTES = 12;

export interface SimulatedCall {
  /** Base64 wire transaction to sign: the simulated call plus our budget instructions. */
  transaction: string;
  /**
   * The lifetime the client set on it. Carried out so a caller can confirm the
   * send against the same bound (`sendConfirmToTerminal`) instead of guessing
   * when a transaction can no longer land.
   */
  lifetime: { blockhash: string; lastValidBlockHeight: bigint };
  /** Account state before the call, keyed by address. */
  pre: Map<string, AccountSnapshot>;
  /** Account state the simulation left behind, keyed by address. */
  post: Map<string, AccountSnapshot>;
  unitsConsumed: bigint;
  /** What the client will pay in fees: base signature fee plus the priority bid. */
  feeLamports: bigint;
  /** Programs that appeared only inside the executed CPIs. */
  innerPrograms: string[];
  /** Accounts the transaction writes to - the only ones that can lose value. */
  writable: Set<string>;
}

interface SimulateArgs {
  decoded: DecodedCall;
  signer: Address;
  network: Network;
  rpc: Rpc<SolanaRpcApi>;
}

export async function simulateCall(args: SimulateArgs): Promise<SimulatedCall> {
  const { decoded, signer, network, rpc } = args;

  // Only the budget instructions that set what the CUSTOMER pays are taken
  // away; a heap-frame or loaded-data-size request is the program saying how
  // much room it needs, and dropping it breaks the call for no benefit.
  const instructions = demoteInvokedPrograms(
    instructionsOf(decoded).filter(
      (instruction) => !isProviderBudgetInstruction(instruction.programAddress, instruction.data),
    ),
  );
  // Derived from the instructions that survive, which is the list both wires
  // are built from - so a watched address can never be one the probe does not
  // reference, which `simulateTransaction` would reject.
  const watched = watchedAddresses(instructions, signer);

  // The rebuild's own account list: `watched` already carries every program the
  // surviving instructions name, plus the signer, so the only key it can still
  // gain is the ComputeBudget program our own two instructions reference.
  const carriesBudgetProgram = new Set<string>(watched).has(COMPUTE_BUDGET_PROGRAM_ADDRESS_STR);
  const rebuiltAccounts = watched.length + (carriesBudgetProgram ? 0 : 1);
  if (rebuiltAccounts > MAX_TRANSACTION_ACCOUNTS) {
    refuse(
      'too-many-accounts',
      `the call needs ${rebuiltAccounts} accounts once elisym adds its own compute budget, above Solana's limit of ${MAX_TRANSACTION_ACCOUNTS}, so it could never land`,
    );
  }

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const baseMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayer(signer, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
    (message) =>
      appendTransactionMessageInstructions(
        instructions as unknown as Parameters<typeof appendTransactionMessageInstructions>[0],
        message,
      ),
  );

  // PASS ONE - sizing only. Nothing but `unitsConsumed` is read from this run.
  //
  // It runs under the MAXIMUM compute limit rather than under none. Stripping
  // the provider's budget and substituting nothing leaves the runtime default,
  // which is an allocation of 200k units per instruction - and a routed swap
  // routinely needs more than that in a single instruction. Such a call would
  // come back `ProgramFailedToComplete` and be reported as "the call fails
  // against the current chain state", which is a false refusal of exactly the
  // case this feature exists for. Sizing under the ceiling and then fitting the
  // signed transaction to what was actually consumed is what kit's own
  // estimator does.
  const probeMessage = setTransactionMessageComputeUnitLimit(
    Number(MAX_COMPUTE_UNIT_LIMIT),
    baseMessage,
  );
  const probeWire = compileToWire(probeMessage, decoded);
  // Checked BEFORE the probe is sent. A node refuses an oversized simulate
  // payload outright, and that arrives here as a bare RPC error the verifier
  // can only report as "the chain could not be reached" - transient and
  // retryable-sounding, for a permanent size problem only the provider can fix.
  assertWireFits(wireByteLength(probeWire) + PRICE_INSTRUCTION_BYTES);
  const probe = await simulate(rpc, probeWire, {});
  if (probe.err !== null) {
    refuse(
      'simulation-failed',
      `the call fails when run against the current chain state (${describeSimulationError(probe.err)})`,
    );
  }
  if (probe.unitsConsumed === undefined) {
    // Without it the compute-unit limit below would be a floor of 10k units, so
    // the customer would sign a transaction that cannot execute.
    refuse(
      'post-state-unavailable',
      'the RPC did not report how much compute this call needs, so the transaction cannot be sized',
    );
  }

  const computeUnitLimit = pickComputeUnitLimit(probe.unitsConsumed);
  const priorityFeeMicroLamports = await estimatePriorityFeeMicroLamports(rpc, {
    network,
    percentile: PRIORITY_FEE_PERCENTILE,
  });
  const finalMessage = pipe(
    baseMessage,
    (message) => setTransactionMessageComputeUnitLimit(Number(computeUnitLimit), message),
    (message) => setTransactionMessageComputeUnitPrice(priorityFeeMicroLamports, message),
  );
  const finalWire = compileToWire(finalMessage, decoded);
  // The measurement behind the prediction above. Both are kept: the prediction
  // is what buys the honest reason, this is what stays true if kit's encoding
  // ever stops matching `PRICE_INSTRUCTION_BYTES`.
  assertWireFits(wireByteLength(finalWire));

  // PASS TWO - the authoritative run, on the EXACT bytes that will be signed.
  // Pre-state first, then simulate at a slot no older than the one it was read
  // at: run concurrently, the two could land on different banks of a
  // load-balanced endpoint and the difference of the two reads would not be a
  // fact about any single moment - and this subtraction is the whole bound.
  const preState = await readPreState(rpc, watched);
  const simulation = await simulate(rpc, finalWire, {
    addresses: watched,
    minContextSlot: preState.slot,
  });

  // `minContextSlot` bounds the drift in one direction only. Without an upper
  // bound too, a balance that ARRIVES between the two reads is absent from the
  // pre-state and spent in the post-state, and the outflow nets to zero.
  if (simulation.slot > preState.slot + MAX_STATE_SLOT_DRIFT) {
    refuse(
      'post-state-unavailable',
      `the chain moved ${simulation.slot - preState.slot} slots between reading your accounts and simulating the call, so the difference of the two is not a fact about one moment`,
    );
  }
  // And the other direction. `minContextSlot` is supposed to make this
  // impossible, but every other answer this file takes from the node is checked
  // rather than trusted, and this one matters most: a post-state read at an
  // OLDER bank turns a withdrawal that happened between the two reads into an
  // apparent inflow, which is the one direction the diff must never fail in.
  if (simulation.slot < preState.slot) {
    refuse(
      'post-state-unavailable',
      `the chain answered the simulation at slot ${simulation.slot}, older than the ${preState.slot} your accounts were read at, so the difference of the two could hide an outflow`,
    );
  }

  if (simulation.err !== null) {
    refuse(
      'simulation-failed',
      `the call fails when run against the current chain state (${describeSimulationError(simulation.err)})`,
    );
  }
  if (!simulation.accounts) {
    refuse(
      'post-state-unavailable',
      'the RPC did not return the account state this call would leave behind, so its effect cannot be bounded',
    );
  }

  // Fail CLOSED, like the checks around it. An empty list for a missing field
  // would read as "this call made no CPI", and `assertInnerProgramsDeclared`
  // would then wave through a call reaching any program at all - voiding the
  // card's allowlist, which is the promise the whole verifier exists to
  // enforce. A node that supports the field answers `[]` for a CPI-free call,
  // so absence really does mean "not reported".
  if (!Array.isArray(simulation.innerInstructions)) {
    refuse(
      'post-state-unavailable',
      "the RPC did not report which programs this call reaches inside, so the capability's program list cannot be enforced",
    );
  }

  return {
    transaction: finalWire,
    lifetime: {
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    },
    pre: preState.accounts,
    post: snapshotsFrom(watched, simulation.accounts, 'after'),
    // From the authoritative pass, which is the run this call actually is. The
    // probe's number sized the budget and is a fallback only: no bound reads
    // this, so a display value is worth more than a refusal here.
    unitsConsumed: simulation.unitsConsumed ?? probe.unitsConsumed,
    feeLamports: feeFor(
      computeUnitLimit,
      priorityFeeMicroLamports,
      precompileSignatures(instructions),
    ),
    innerPrograms: innerProgramsOf(simulation.innerInstructions),
    writable: writableAddresses(instructions, decoded.message.feePayer.address),
  };
}

/**
 * Every account the call touches, the signer included. The RPC caps
 * `accounts.addresses` at the transaction's own account count, so watching all
 * of them is always allowed - and it is the only way to see an account the call
 * CREATES (a fresh token account) in the post-state.
 *
 * Measured on devnet: the cap counts the RESOLVED account list, not the static
 * one - a call with 2 static and 12 looked-up accounts answers
 * "Too many accounts provided; max 14". A routed swap, whose whole point is
 * that lookup tables keep the static list short, is therefore watchable in
 * full; this set is a subset of that list by construction.
 */
function watchedAddresses(instructions: readonly CallInstruction[], signer: Address): Address[] {
  const addresses = new Set<string>([signer]);
  for (const instruction of instructions) {
    addresses.add(instruction.programAddress);
    for (const account of instruction.accounts ?? []) {
      addresses.add(account.address);
    }
  }
  return [...addresses] as Address[];
}

/**
 * A chain error, rendered so it can actually be shown.
 *
 * Kit decodes every RPC integer as a `bigint`, so a real `err` looks like
 * `{ InstructionError: [0n, { Custom: 1n }] }` - and plain `JSON.stringify`
 * THROWS on that. The throw happened while building the refusal string, before
 * `refuse` was reached, so it escaped as an untyped error and the customer was
 * told "the chain could not be reached" for a call that had simply failed. On a
 * real node `simulation-failed` could therefore never fire, and the chain's own
 * reason was lost with it.
 */
function describeSimulationError(err: unknown): string {
  return JSON.stringify(err, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/**
 * Read-only any account that is also a program this call invokes.
 *
 * The runtime does this itself - `LoadedMessage::is_writable` calls
 * `demote_program_id`, so a program carried as a writable meta is silently
 * downgraded and the transaction lands. Kit's `compileTransaction` instead
 * REFUSES to build such a message, so without this the rebuild threw and the
 * customer was told, after paying, that Solana would not accept a shape it
 * accepts every block: 24 of 3,273 successful mainnet transactions in one
 * sample carry it, and for a capability wrapping FLASHX it is not a
 * fraction but every call (142 of 142 sampled), and Meteora DLMM carries it on
 * roughly a quarter of its traffic.
 *
 * Only ever NARROWS what the customer signs, so it cannot widen a bound: the
 * accounts stay in the message and in `watched`, they simply stop being
 * writable. The runtime's one exception - no demotion when the upgradeable
 * loader is present - would surface as `simulation-failed` rather than as a
 * silent widening, because the simulated bytes are the signed bytes.
 */
function demoteInvokedPrograms(
  instructions: readonly CallInstruction[],
): readonly CallInstruction[] {
  const invoked = new Set(instructions.map((instruction) => instruction.programAddress));
  return instructions.map((instruction) => {
    const accounts = instruction.accounts;
    if (!accounts?.some((account) => invoked.has(account.address))) {
      return instruction;
    }
    return {
      ...instruction,
      accounts: accounts.map((account) =>
        invoked.has(account.address) ? { ...account, role: demotedRole(account.role) } : account,
      ),
    };
  });
}

/**
 * The `WRITABLE_SIGNER` arm is deliberately defensive and deliberately
 * untested: `runStaticChecks` refuses any signer meta that is not the customer,
 * and the customer's wallet is not executable, so no call that reaches
 * simulation can carry an invoked program as a writable SIGNER. It mirrors the
 * runtime's own demotion, which does not special-case the signer bit either.
 */
function demotedRole(role: number): number {
  if (role === AccountRole.WRITABLE) {
    return AccountRole.READONLY;
  }
  return role === AccountRole.WRITABLE_SIGNER ? AccountRole.READONLY_SIGNER : role;
}

function wireByteLength(wire: string): number {
  return getBase64Encoder().encode(wire).length;
}

/**
 * Our own budget instructions add an account and two instructions, so a call
 * that arrived just under the transport limit can compile to one that can never
 * land. Refused before the customer signs, and before the probe is sent.
 */
function assertWireFits(bytes: number) {
  if (bytes > MAX_WIRE_TRANSACTION_BYTES) {
    refuse(
      'oversized-transaction',
      `once elisym sets its own fee this call is ${bytes} bytes, above Solana's ${MAX_WIRE_TRANSACTION_BYTES}-byte limit, so it could never land`,
    );
  }
}

function compileToWire(
  message: Parameters<typeof compileTransaction>[0],
  decoded: DecodedCall,
): string {
  const compressed =
    Object.keys(decoded.lookupTables).length > 0
      ? compressTransactionMessageUsingAddressLookupTables(
          message as Parameters<typeof compressTransactionMessageUsingAddressLookupTables>[0],
          decoded.lookupTables,
        )
      : message;
  try {
    return getBase64EncodedWireTransaction(
      compileTransaction(compressed as Parameters<typeof compileTransaction>[0]),
    );
  } catch (error) {
    // Kit enforces the protocol's own message rules here, and its errors are
    // not ours: left to escape they reach the verifier's generic catch and are
    // reported as "the chain could not be reached", which is transient and
    // retryable-sounding for a permanent, provider-fixable shape.
    //
    // NOT `too-many-accounts`: the account count is refused above, so what
    // reaches here is every OTHER rule kit enforces - an invoked program also
    // carried as a writable meta, a program address as fee payer - which
    // non-kit builders emit happily. Naming the account limit for those would
    // be the same mislabel this round found next door in `decode.ts`.
    refuse(
      'malformed-instruction',
      `the call cannot be rebuilt into a transaction Solana would accept (${describeError(error)})`,
    );
  }
}

async function readPreState(
  rpc: Rpc<SolanaRpcApi>,
  addresses: Address[],
): Promise<{ accounts: Map<string, AccountSnapshot>; slot: bigint }> {
  // Only the token-account base layout is ever read, so the slice keeps a
  // provider that references a few multi-megabyte accounts from making the
  // client pull them whole.
  const { context, value } = await rpc
    .getMultipleAccounts(addresses, {
      encoding: 'base64',
      dataSlice: { offset: 0, length: TOKEN_ACCOUNT_SLICE },
    })
    .send();
  // `space` is what bounds the UNSLICED post-state read below; reading a missing
  // one as zero would void that bound, so it is required rather than defaulted.
  value.forEach((raw, index) => {
    if (raw && raw.space === undefined) {
      refuse(
        'post-state-unavailable',
        `the RPC did not report the size of ${addresses[index]}, so how much this call would make elisym read cannot be bounded`,
      );
    }
  });
  const accounts = snapshotsFrom(addresses, value, 'before');
  let totalBytes = 0;
  for (const snapshot of accounts.values()) {
    totalBytes += snapshot.space;
  }
  if (totalBytes > MAX_TOTAL_ACCOUNT_BYTES) {
    // Not `too-many-accounts`: that one names Solana's own limit on how many
    // accounts a transaction may hold, and this call may be well under it. What
    // failed is that elisym will not read this much state, so the effect cannot
    // be established - which is exactly what `post-state-unavailable` says.
    refuse(
      'post-state-unavailable',
      `the call's accounts hold ${totalBytes} bytes; elisym reads at most ${MAX_TOTAL_ACCOUNT_BYTES} to bound it`,
    );
  }
  return { accounts, slot: context.slot };
}

async function simulate(
  rpc: Rpc<SolanaRpcApi>,
  wireTransaction: string,
  options: { addresses?: Address[]; minContextSlot?: bigint },
) {
  try {
    const { context, value } = await rpc
      .simulateTransaction(wireTransaction as Parameters<typeof rpc.simulateTransaction>[0], {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
        innerInstructions: true,
        ...(options.minContextSlot === undefined ? {} : { minContextSlot: options.minContextSlot }),
        ...(options.addresses === undefined
          ? {}
          : { accounts: { encoding: 'base64' as const, addresses: options.addresses } }),
      })
      .send();
    return { ...value, slot: context.slot };
  } catch (error) {
    // A table the DECODER could read but the bank will not load - a deactivated
    // or closed lookup table, which a provider caching a stale one produces.
    // Left to the generic catch it reads as "the chain could not be reached",
    // transient wording for something only the provider can fix. `decode.ts`
    // already owns this reason for the half it can see.
    if (error instanceof OnchainRefusalError) {
      throw error;
    }
    // `describeError`, not `error.message`: kit hands the node's own words over
    // in `context.__serverMessage`, and in a production build that context is
    // the ONLY place they survive - the message becomes "Solana error #...;
    // Decode this error by running ...". Matching the node's wording on
    // `message` worked in the tests and in no shipped client.
    const detail = describeError(error);
    if (detail.includes('address table account')) {
      refuse(
        'lookup-table-unavailable',
        `an address lookup table this call depends on could not be loaded by the chain (${detail})`,
      );
    }
    throw error;
  }
}

interface RawAccount {
  lamports: bigint;
  owner: string;
  executable?: boolean;
  data: readonly [string, string] | string;
  /** True data length, reported even when the read was sliced. */
  space?: bigint | number;
}

function snapshotsFrom(
  addresses: readonly Address[],
  accounts: readonly (RawAccount | null)[],
  stage: 'before' | 'after',
): Map<string, AccountSnapshot> {
  // A short array would silently read as "these accounts do not exist", which
  // turns an outflow into an inflow. An RPC that answers fewer accounts than it
  // was asked about has not answered.
  if (accounts.length !== addresses.length) {
    refuse(
      'post-state-unavailable',
      `the RPC returned ${accounts.length} accounts for ${addresses.length} addresses, so the state ${stage} this call cannot be read`,
    );
  }
  const snapshots = new Map<string, AccountSnapshot>();
  addresses.forEach((address, index) => {
    const raw = accounts[index];
    if (!raw) {
      snapshots.set(address, {
        address,
        exists: false,
        lamports: 0n,
        owner: '',
        executable: false,
        data: new Uint8Array(),
        space: 0,
      });
      return;
    }
    const data = decodeAccountData(raw.data);
    const lamports = BigInt(raw.lamports);
    snapshots.set(address, {
      address,
      // A CLOSED account comes back zeroed, not null: `simulateTransaction`
      // reads the post-simulation accounts directly and so bypasses the
      // zero-lamport filter that `getMultipleAccounts` applies. Zero lamports
      // with no data and the System program as owner IS a non-existent account
      // on chain - a rent-paying account cannot hold zero - so this keeps
      // `exists` meaning the same thing on both sides of the diff, whichever
      // RPC method produced the snapshot.
      //
      // No consumer depends on it today. It was written for the temporary wSOL
      // account an ordinary swap creates and closes, and `isSelfEvident` now
      // reaches the same verdict on that shape through `isBareWallet` - a
      // zeroed account is system-owned with no data, which is what that
      // predicate asks. Kept because the field should be true, not because a
      // branch downstream is waiting on it; the wSOL behaviour is pinned
      // against `isBareWallet` instead.
      exists: !(lamports === 0n && data.length === 0 && raw.owner === SYSTEM_PROGRAM_ADDRESS_STR),
      lamports,
      owner: raw.owner,
      executable: raw.executable === true,
      data,
      space: raw.space === undefined ? 0 : Number(raw.space),
    });
  });
  return snapshots;
}

/**
 * Accounts the SIGNED transaction can write to.
 *
 * Load-bearing, not bookkeeping: `analyzeStateChange` reports an account it
 * cannot attribute ONLY when this set contains it, because a read-only account
 * cannot lose value and naming it would be noise on a warning that has to stay
 * rare to mean anything.
 *
 * Built from the instructions that survive the budget strip, not the raw list:
 * a stripped pricing instruction's metas are in neither the rebuild nor the
 * wallet, so treating one as writable would let a provider widen this set with
 * an instruction the client throws away.
 */
function writableAddresses(
  instructions: readonly CallInstruction[],
  feePayer: string,
): Set<string> {
  // The fee payer seed is defensive, not load-bearing: `analyzeStateChange`
  // handles the signer's own account before it consults this set at all, and
  // `runStaticChecks` has already refused any fee payer that is not the signer.
  // It stays because this set describes what the signed transaction may write
  // to, and the fee payer always may.
  const writable = new Set<string>([feePayer]);
  for (const instruction of instructions) {
    for (const account of instruction.accounts ?? []) {
      if (account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER) {
        writable.add(account.address);
      }
    }
  }
  return writable;
}

function decodeAccountData(data: RawAccount['data']): Uint8Array {
  const encoded = typeof data === 'string' ? data : data[0];
  if (!encoded) {
    return new Uint8Array();
  }
  return new Uint8Array(getBase64Encoder().encode(encoded));
}

function pickComputeUnitLimit(unitsConsumed: bigint): bigint {
  const withHeadroom = (unitsConsumed * 12n) / 10n + COMPUTE_UNIT_HEADROOM;
  return withHeadroom > MAX_COMPUTE_UNIT_LIMIT ? MAX_COMPUTE_UNIT_LIMIT : withHeadroom;
}

/**
 * Programs whose instruction data DECLARES signatures the runtime also charges
 * for. The count is the first byte of the instruction data in all three.
 */
const PRECOMPILE_PROGRAMS: readonly string[] = [
  'Ed25519SigVerify111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111',
];

/**
 * Signatures the transaction carries beyond the customer's own.
 *
 * The runtime charges `5000 x num_total_signatures`, and that total INCLUDES
 * the ones declared inside a precompile instruction - measured on live mainnet,
 * where each Ed25519 signature added exactly 5,000 lamports. Missing them made
 * `feeFor` under-report, which is safe in itself (the shortfall stays in the
 * native delta rather than being credited away) but lands the difference on the
 * spend ceiling of a SOL-priced card: a `max_per_call: "0"` capability gated on
 * an attestation would refuse every call it ever returned, after payment.
 */
function precompileSignatures(instructions: readonly CallInstruction[]): bigint {
  let total = 0n;
  for (const instruction of instructions) {
    if (PRECOMPILE_PROGRAMS.includes(instruction.programAddress)) {
      total += BigInt(instruction.data?.[0] ?? 0);
    }
  }
  return total;
}

/** Base signature fee plus the priority bid, rounded up the way the runtime charges it. */
function feeFor(
  computeUnitLimit: bigint,
  priorityFeeMicroLamports: bigint,
  extraSignatures: bigint,
): bigint {
  const priorityLamports = (priorityFeeMicroLamports * computeUnitLimit + 999_999n) / 1_000_000n;
  return SIGNATURE_FEE_LAMPORTS * (1n + extraSignatures) + priorityLamports;
}

/**
 * Programs that ran inside the call's CPIs.
 *
 * Fail CLOSED on any shape this cannot read. The RPC answers `jsonParsed` where
 * it can and plain `json` otherwise, and the `json` encoding names a program by
 * its INDEX into the transaction's account list rather than by address. Reading
 * such an entry as "no program" would silently empty the list the card's
 * allowlist is checked against - the same fail-open the missing-field guard
 * above exists to prevent.
 */
function innerProgramsOf(groups: readonly unknown[]): string[] {
  const programs = new Set<string>();
  for (const group of groups) {
    const instructions = (group as { instructions?: unknown }).instructions;
    if (!Array.isArray(instructions)) {
      refuse(
        'post-state-unavailable',
        "the RPC reported this call's inner instructions in a shape elisym cannot read, so the capability's program list cannot be enforced",
      );
    }
    for (const instruction of instructions) {
      const programId = (instruction as { programId?: unknown }).programId;
      if (typeof programId !== 'string') {
        refuse(
          'post-state-unavailable',
          "the RPC named this call's inner programs by index rather than by address, so the capability's program list cannot be enforced",
        );
      }
      programs.add(programId);
    }
  }
  return [...programs];
}
