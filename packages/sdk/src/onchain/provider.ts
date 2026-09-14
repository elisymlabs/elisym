/**
 * The provider's own check on the call it is about to send.
 *
 * The client verifies everything again and trusts none of this - that is the
 * design. What this buys is failing the provider's own job instead of shipping
 * a call the customer will refuse: an agent whose script drifts outside its
 * published `programs`, returns malformed JSON, or names the wrong network is
 * broken, and its operator should see that as a job failure rather than as a
 * customer complaint.
 *
 * Deliberately offline. No RPC, no lookup-table resolution: a program address
 * that only exists inside a lookup table cannot be checked here and is left to
 * the client, which resolves the tables anyway.
 */

import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import {
  authorityShapeIssue,
  COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
  isProviderBudgetInstruction,
} from './checks';
import {
  CALL_CLOCK_SKEW_SECS,
  MAX_CALL_TTL_SECS,
  MAX_INSTRUCTIONS_PER_CALL,
  MAX_TRANSACTION_ACCOUNTS,
  MAX_WIRE_TRANSACTION_BYTES,
  SYSTEM_PROGRAM_ADDRESS_STR,
} from './constants';
import { describeError } from './errors';
import { parseOnchainCallEnvelope, type OnchainCallEnvelope } from './schema';
import type { SkillOnchainResolved } from './types';

/**
 * The two fields this check reads. Kit's compiled-message type is a union
 * across message versions, so it is narrowed once here and the shape is
 * verified at runtime before anything is read from it.
 */
export interface CompiledMessageView {
  staticAccounts: readonly string[];
  /**
   * How many leading accounts must sign. The customer is the only signer this
   * verifier will ever produce, so anything above 1 is a call no client signs.
   */
  header?: { numSignerAccounts?: number };
  instructions: readonly {
    programAddressIndex: number;
    data?: ArrayLike<number>;
    /** One byte each on the wire, and reclaimed when the instruction is stripped. */
    accountIndices?: readonly number[];
  }[];
  /** Absent on a legacy message in some decoders; only `'legacy'` matters here. */
  version?: 'legacy' | number;
  /**
   * Present on a v0 message. The ADDRESSES are not knowable offline, but their
   * count is, and they count against the transaction's account limit exactly as
   * the static ones do.
   */
  addressTableLookups?: readonly {
    lookupTableAddress: string;
    readonlyIndexes: readonly number[];
    writableIndexes: readonly number[];
  }[];
}

/** System program, and `AdvanceNonceAccount` - the marker of a durable nonce. */
const SYSTEM_ADVANCE_NONCE = 4;
const RECENT_BLOCKHASHES_SYSVAR_ADDRESS = 'SysvarRecentB1ockHashes11111111111111111111';

/**
 * Kit's `isAdvanceNonceAccountInstruction`, read off the COMPILED message.
 *
 * Everything kit checks that survives compilation is checked: the exact four
 * data bytes, exactly three accounts, and the sysvar in the middle. The account
 * ROLES kit also tests are implied by the sysvar's position and by the fee
 * payer being the only signer this verifier permits, and an index that resolves
 * through a lookup table is left to the client, which has the addresses.
 */
function advancesNonce(
  instruction: CompiledMessageView['instructions'][number],
  compiled: CompiledMessageView,
): boolean {
  const data = instruction.data;
  const accounts = instruction.accountIndices;
  if (data === undefined || data.length !== 4 || accounts?.length !== 3) {
    return false;
  }
  if (data[0] !== SYSTEM_ADVANCE_NONCE || data[1] !== 0 || data[2] !== 0 || data[3] !== 0) {
    return false;
  }
  const sysvarIndex = accounts[1];
  const sysvar = sysvarIndex === undefined ? undefined : compiled.staticAccounts[sysvarIndex];
  return sysvar === undefined || sysvar === RECENT_BLOCKHASHES_SYSVAR_ADDRESS;
}

export interface ValidateProviderCallArgs {
  /** Whatever the skill's script wrote to stdout. */
  output: unknown;
  /** The capability's own published promise, minus the network. */
  descriptor: SkillOnchainResolved;
  /** The agent's network, stamped on the card at publish time. */
  network: 'devnet' | 'mainnet';
}

/**
 * Accounts the call reaches through its lookup tables. Their addresses need the
 * chain to resolve, but each index is one account against the transaction's
 * limit whether or not this side can name it.
 */
export function lookedUpAccountCount(compiled: CompiledMessageView): number {
  if (!Array.isArray(compiled.addressTableLookups)) {
    return 0;
  }
  // Deduplicated by (table, index), because the same slot named twice is one
  // account lock, and counting it twice would fail the operator's own job for
  // a call that fits. Two DIFFERENT tables holding the same address still
  // count twice: telling them apart needs the chain, which this check
  // deliberately never touches. That leaves the provider side strictly
  // stricter than the client, which is the safe direction - the client
  // resolves the tables and counts exactly.
  const slots = new Set<string>();
  for (const lookup of compiled.addressTableLookups) {
    for (const index of lookup.readonlyIndexes ?? []) {
      slots.add(`r:${lookup.lookupTableAddress}:${index}`);
    }
    for (const index of lookup.writableIndexes ?? []) {
      slots.add(`w:${lookup.lookupTableAddress}:${index}`);
    }
  }
  return slots.size;
}

/**
 * What the client's rebuild will cost this transaction in bytes.
 *
 * The client removes the provider's limit and price instructions and appends
 * its own pair. Whatever the provider already spends on those comes back, and
 * the ComputeBudget program only costs its 32-byte account slot when the call
 * does not reference it already.
 */
export function clientBudgetOverhead(compiled: CompiledMessageView): number {
  const CLIENT_INSTRUCTION_BYTES = 20;
  const PROGRAM_ACCOUNT_BYTES = 32;
  let reclaimed = 0;
  let referencesBudgetProgram = false;
  for (const instruction of compiled.instructions) {
    if (
      compiled.staticAccounts[instruction.programAddressIndex] !==
      COMPUTE_BUDGET_PROGRAM_ADDRESS_STR
    ) {
      continue;
    }
    referencesBudgetProgram = true;
    if (isProviderBudgetInstruction(COMPUTE_BUDGET_PROGRAM_ADDRESS_STR, instruction.data)) {
      // programIdIndex + accounts length + data length + the data itself, plus
      // one index byte per account meta. Real builders do attach metas to a
      // pricing instruction - the client accepts and strips them - and missing
      // those bytes made this over-strict, failing the operator's own job for a
      // size problem that does not exist.
      reclaimed += 3 + (instruction.data?.length ?? 0) + (instruction.accountIndices?.length ?? 0);
    }
  }
  // A legacy input is rebuilt as v0: one byte for the version prefix and one
  // for the empty address-table-lookups array. Anything OTHER than a v0 message
  // is charged the same two bytes rather than zero - an unknown version cannot be
  // known to be free, and guessing zero errs toward "the provider ships it and the
  // client refuses it", which is the direction this whole gate exists to avoid.
  const versionCost = compiled.version === 0 ? 0 : 2;
  const added =
    CLIENT_INSTRUCTION_BYTES + versionCost + (referencesBudgetProgram ? 0 : PROGRAM_ACCOUNT_BYTES);
  return Math.max(0, added - reclaimed);
}

/**
 * Validate a call the agent is about to return. Returns the parsed envelope;
 * throws a plain `Error` (the runtime turns it into a failed job) when the
 * capability produced something it never promised.
 */
export function validateProviderCall(args: ValidateProviderCallArgs): OnchainCallEnvelope {
  const { output, descriptor, network } = args;

  const envelope = parseOnchainCallEnvelope(output);
  if (envelope === null) {
    throw new Error(
      'onchain skill did not return a call envelope (expected JSON with elisym_call, network, transaction, signer, expires_at)',
    );
  }
  if (envelope.network !== network) {
    throw new Error(
      `onchain skill returned a ${envelope.network} call from a ${network} agent - the card promises ${network}`,
    );
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  if (envelope.expires_at <= nowSecs) {
    throw new Error('onchain skill returned a call that is already expired');
  }
  // A FLOOR as well as a ceiling. Between this check and the customer's wallet
  // sit a Nostr round trip, a payment, and the client's own two-pass
  // simulation; a call minted with two seconds left is refused as `expired`
  // after the customer has paid, and the operator never hears about it. The
  // client's own clock-skew allowance is the natural floor - below it, the call
  // is not reliably checkable even by a client whose clock is right.
  if (envelope.expires_at < nowSecs + CALL_CLOCK_SKEW_SECS) {
    throw new Error(
      `onchain skill returned a call expiring in ${envelope.expires_at - nowSecs}s; it must stay ` +
        `valid at least ${CALL_CLOCK_SKEW_SECS}s or the customer pays and then gets "expired"`,
    );
  }
  if (envelope.expires_at > nowSecs + MAX_CALL_TTL_SECS) {
    throw new Error(
      `onchain skill returned a call valid for longer than ${MAX_CALL_TTL_SECS}s; every client refuses that`,
    );
  }

  // The envelope schema's base64 cap already rejects anything far over the wire
  // limit, though it is a character bound rather than an exact byte one - 1644
  // characters without padding decode to 1233 bytes. The budget check below is the
  // exact one, and it is stricter than the transport limit anyway.
  let compiled: CompiledMessageView;
  let alreadySigned: boolean;
  let bytes: Uint8Array;
  // The base64 decode is INSIDE the try, defensively rather than for a fault
  // that exists today: measured across every non-multiple-of-four length
  // `BASE64_REGEX` admits, kit's encoder TRUNCATES rather than throwing, so the
  // bad bytes simply fail to decode as a transaction one line below and get the
  // message written for that. Kept inside because a codec that ever starts
  // throwing would otherwise reach the operator as a bare decode-advice line,
  // and nothing about the call would be said.
  try {
    bytes = new Uint8Array(getBase64Encoder().encode(envelope.transaction));
    const transaction = getTransactionDecoder().decode(bytes);
    alreadySigned = Object.values(transaction.signatures).some((signature) => signature !== null);
    compiled = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    ) as unknown as CompiledMessageView;
  } catch (error) {
    throw new Error(
      `onchain skill returned bytes that are not a Solana transaction: ${describeError(error)}`,
    );
  }

  // REACHABLE, through transaction message v1: kit 6.8 decodes it fully, and a
  // v1 message has no `instructions` array at all - its compute budget rides a
  // message-level `config` instead. (An earlier comment here claimed the branch
  // was unreachable because kit's decoder throws on an unknown version. It does
  // not throw on v1; it understands it.)
  //
  // The message is accurate: `runStaticChecks` refuses a non-zero, non-legacy
  // version by name, because every budget rule in this verifier is
  // instruction-shaped and would look straight past a provider-chosen priority
  // fee in that config. Stopping the operator's own job here is the point.
  // Reading `undefined` as "no instructions" would be the alternative.
  if (!Array.isArray(compiled.instructions) || !Array.isArray(compiled.staticAccounts)) {
    throw new Error(
      'onchain skill returned a transaction whose message version this build cannot read; the client would refuse it',
    );
  }
  if (alreadySigned) {
    throw new Error(
      'onchain skill returned a signed transaction; the customer signs, so the call must be unsigned',
    );
  }
  // The client strips this call's compute-unit limit and price and adds its own,
  // so the real budget is the transport limit minus what that swap costs. A call
  // that only fits without the overhead is refused on the client AFTER the
  // customer has paid, so the operator should hear about it from their own
  // failed job instead - but charging the full overhead flatly would refuse
  // calls that recompile to the same size, which is 5% of the byte budget taken
  // from exactly the routed traffic that sits near the limit.
  const budget = MAX_WIRE_TRANSACTION_BYTES - clientBudgetOverhead(compiled);
  if (bytes.length > budget) {
    throw new Error(
      `onchain skill returned a ${bytes.length}-byte transaction; the client rebuilds it with its ` +
        `own compute budget before signing, so a call must stay within ${budget} bytes`,
    );
  }
  // A builder that silently emitted nothing should be the OPERATOR's failed job,
  // not a call the customer pays for and signs for no effect.
  // Compute-budget instructions do not count: the client strips the pricing
  // ones and appends its own, so a call carrying nothing else would be signed
  // and land having done nothing.
  const acting = compiled.instructions.filter(
    (instruction) =>
      compiled.staticAccounts[instruction.programAddressIndex] !==
      COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
  );
  if (acting.length === 0) {
    throw new Error(
      'onchain skill returned a transaction with no instruction that acts, which would do nothing',
    );
  }
  if (compiled.instructions.length > MAX_INSTRUCTIONS_PER_CALL) {
    throw new Error(
      `onchain skill returned ${compiled.instructions.length} instructions; the client refuses more than ${MAX_INSTRUCTIONS_PER_CALL}`,
    );
  }
  // The account budget the client's rebuild actually leaves: Solana's own
  // `MAX_TX_ACCOUNT_LOCKS`, minus the ComputeBudget slot our two instructions
  // add when the call does not already reference that program.
  const referencesBudget = compiled.staticAccounts.includes(COMPUTE_BUDGET_PROGRAM_ADDRESS_STR);
  const accountBudget = MAX_TRANSACTION_ACCOUNTS - (referencesBudget ? 0 : 1);
  const accountCount = compiled.staticAccounts.length + lookedUpAccountCount(compiled);
  if (accountCount > accountBudget) {
    throw new Error(
      `onchain skill returned a call holding ${accountCount} accounts; the client adds its own ` +
        `compute budget before signing, so a call must stay within ${accountBudget} accounts`,
    );
  }

  // Indices the CLIENT resolves and refuses as `undecodable-transaction`. A
  // program id can never come from a lookup table - Solana requires it static -
  // so a program index past the static list is invalid whatever the message
  // version, and an account index past the static list plus the looked-up ones
  // resolves to nothing on either side.
  const resolvableAccounts = compiled.staticAccounts.length + lookedUpAccountCount(compiled);
  for (const instruction of compiled.instructions) {
    if (instruction.programAddressIndex >= compiled.staticAccounts.length) {
      throw new Error(
        `onchain skill built a call whose program index ${instruction.programAddressIndex} names ` +
          'no account in the message; a program id can never come from a lookup table',
      );
    }
    for (const accountIndex of instruction.accountIndices ?? []) {
      if (accountIndex >= resolvableAccounts) {
        throw new Error(
          `onchain skill built a call referencing account index ${accountIndex}, which resolves ` +
            `to nothing (the message holds ${resolvableAccounts} accounts)`,
        );
      }
    }
  }

  const feePayer = compiled.staticAccounts[0];
  if (feePayer !== envelope.signer) {
    throw new Error(
      `onchain skill built a call whose fee payer (${feePayer ?? 'none'}) is not the signer it names (${envelope.signer})`,
    );
  }

  // Every client refuses a call needing a second signature: the customer is the
  // only signer it will ever produce. A builder reaches this by accident -
  // System `CreateAccount` makes the new account a signer - so the operator
  // should hear it from their own failed job. The compiled header is the whole
  // story offline: kit leaves an unsigned message's signatures null, so the
  // `alreadySigned` check above cannot see this.
  //
  // Slightly STRICTER than the client in one shape: a second signer that no
  // instruction references is dropped by the client's rebuild, so the signed
  // transaction ends up with one signer and works. Refusing it here costs the
  // operator a job for a call that would have gone through - accepted
  // deliberately, because a declared signer nothing uses is a builder bug, and
  // the alternative is resolving every index offline to prove it unused.
  const signerCount = compiled.header?.numSignerAccounts;
  if (signerCount !== undefined && signerCount > 1) {
    throw new Error(
      `onchain skill built a call requiring ${signerCount} signatures; the customer is the only ` +
        'signer, so every client refuses it',
    );
  }

  const allowed = new Set<string>([...descriptor.programs, COMPUTE_BUDGET_PROGRAM_ADDRESS_STR]);
  for (const [index, instruction] of compiled.instructions.entries()) {
    const programAddress = compiled.staticAccounts[instruction.programAddressIndex];
    if (programAddress === undefined) {
      // The program is indexed through a lookup table, which this offline check
      // cannot resolve. The client resolves the tables and refuses it there.
      continue;
    }
    if (!allowed.has(programAddress)) {
      throw new Error(
        `onchain skill built a call touching ${programAddress}, which this capability never published in its "programs" list`,
      );
    }
    // A durable nonce is not a field: it is the FIRST instruction being System
    // `AdvanceNonceAccount`. Signed, such a call never expires, so every client
    // refuses it - and a card legitimately listing the System program sails
    // past the allowlist above.
    //
    // MIRRORS kit's `isAdvanceNonceAccountInstruction` exactly, because that is
    // what decides the client's answer: data of EXACTLY four bytes `04 00 00
    // 00`, exactly three accounts, and the recent-blockhashes sysvar second.
    // A looser rule here refuses shapes the client accepts, which is a false
    // refusal of the operator's own job - the one thing this gate must not do.
    if (
      index === 0 &&
      programAddress === SYSTEM_PROGRAM_ADDRESS_STR &&
      advancesNonce(instruction, compiled)
    ) {
      throw new Error(
        'onchain skill built a call with a durable-nonce lifetime; a signature for it would stay ' +
          'usable indefinitely, so every client refuses it',
      );
    }
    // Metas on a budget instruction the client KEEPS travel into the signed
    // transaction and skip the signer rules, so the client refuses them. A
    // pricing one is stripped before any of that, and refusing those would
    // reject real routed traffic.
    if (
      programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS_STR &&
      !isProviderBudgetInstruction(programAddress, instruction.data) &&
      (instruction.accountIndices ?? []).length > 0
    ) {
      throw new Error(
        'onchain skill attached accounts to a compute-budget instruction, which never takes any; ' +
          'every client refuses that',
      );
    }
    const issue = authorityShapeIssue(
      programAddress,
      instruction.data,
      descriptor.grants_authority === true,
    );
    if (issue) {
      throw new Error(
        `onchain skill built a call every client refuses (${issue.reason}): ${issue.detail}`,
      );
    }
  }

  return envelope;
}
