/**
 * Step two: the static gate. Everything here is decided from the decoded call
 * alone - no RPC, no simulation - so it is cheap, deterministic and fully
 * testable, and it refuses the shapes that must never reach a wallet.
 *
 * It is deliberately NOT the safety boundary. A program can do through CPI what
 * no static decoder can see, which is why the post-state assertion in
 * `ceilings.ts` exists. What this file buys is a fast, precise refusal with a
 * reason a human can act on.
 */

import { AccountRole, isSignerRole } from '@solana/kit';
import {
  CALL_CLOCK_SKEW_SECS,
  MAX_CALL_TTL_SECS,
  MAX_INSTRUCTIONS_PER_CALL,
  SYSTEM_PROGRAM_ADDRESS_STR,
} from './constants';
import { instructionsOf, type DecodedCall } from './decode';
import { refuse } from './errors';
import type { OnchainCallEnvelope, OnchainDescriptor } from './schema';
import { TOKEN_PROGRAM_IDS } from './token-account';
import type { OnchainRefusalReason } from './types';

/**
 * Compute budget instructions are allowed to appear without being declared on
 * the card. The ones that set what the customer PAYS are stripped and replaced
 * with the client's own, so a provider can never choose the priority fee; the
 * rest survive into the signed transaction, and are refused outright if they
 * carry account metas, which a real one never does.
 */
export const COMPUTE_BUDGET_PROGRAM_ADDRESS_STR = 'ComputeBudget111111111111111111111111111111';

/**
 * The only ComputeBudget instructions the client passes through.
 *
 * `RequestHeapFrame` (1) and `SetLoadedAccountsDataSizeLimit` (4) move no
 * lamports - they tell the runtime how much room the call needs - and dropping
 * them makes a program that asked for a bigger heap fail as "the call fails
 * against the current chain state", after the customer has paid.
 *
 * An ALLOWLIST rather than a denylist, because everything else in that program
 * sets what the CUSTOMER pays: `SetComputeUnitPrice` is the priority bid,
 * `SetComputeUnitLimit` is the quantity it is multiplied by, and the deprecated
 * `RequestUnits` carries a fee of its own. A simulation reports no fee figure
 * of its own for any of it, so none of it may be the provider's to choose - and a future variant that
 * prices anything must not survive by default in an SDK already published.
 */
export const CLIENT_PRESERVED_BUDGET_DISCRIMINATORS: readonly number[] = [1, 4];

/** Whether this instruction is one the client replaces with its own. */
export function isProviderBudgetInstruction(
  programAddress: string,
  data: ArrayLike<number> | undefined,
): boolean {
  if (programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS_STR) {
    return false;
  }
  // No data is no instruction this build can vouch for, so it goes with the rest.
  if (data === undefined || data.length === 0) {
    return true;
  }
  return !CLIENT_PRESERVED_BUDGET_DISCRIMINATORS.includes(data[0]);
}

const ATA_PROGRAM_ADDRESS_STR = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const MEMO_PROGRAM_ADDRESS_STR = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Programs a call may reach through CPI without the card naming them. These are
 * the plumbing every SPL flow goes through, and their effects are precisely
 * what the post-state assertion already bounds - so requiring each card to
 * enumerate them would add noise, not safety.
 */
export const ALWAYS_ALLOWED_PROGRAMS: readonly string[] = [
  SYSTEM_PROGRAM_ADDRESS_STR,
  ATA_PROGRAM_ADDRESS_STR,
  MEMO_PROGRAM_ADDRESS_STR,
  COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
  ...TOKEN_PROGRAM_IDS,
];

/** SPL Token instruction discriminators that hand authority away. */
const TOKEN_APPROVE = 4;
const TOKEN_SET_AUTHORITY = 6;
const TOKEN_APPROVE_CHECKED = 13;

/** System instruction discriminators (u32 LE) that reassign an account. */
const SYSTEM_ASSIGN = 1;
const SYSTEM_ASSIGN_WITH_SEED = 10;
/**
 * `Allocate` requires the account itself to sign, and the only signer this
 * verifier permits is the customer - so it can only ever target their own
 * wallet. `AllocateWithSeed` is not listed: it signs with the BASE, so it
 * targets a derived account, which costs the wallet nothing but the lamports
 * the diff already counts.
 */
const SYSTEM_ALLOCATE = 8;

interface EnvelopeCheckArgs {
  envelope: OnchainCallEnvelope;
  card: OnchainDescriptor;
  signer: string;
  /** Unix seconds. Injectable so the expiry rules are testable without a clock. */
  now: number;
}

interface StaticCheckArgs {
  decoded: DecodedCall;
  card: OnchainDescriptor;
  signer: string;
}

/**
 * Bind the envelope to the card and the wallet. Decided from the envelope
 * alone, so it runs BEFORE the transaction is decoded and its lookup tables are
 * fetched - a call addressed to another wallet, or one that expired, should not
 * buy the provider a round of `getMultipleAccounts` work on the client.
 */
export function runEnvelopeChecks(args: EnvelopeCheckArgs): void {
  const { envelope, card, signer, now } = args;

  if (envelope.network !== card.network) {
    refuse(
      'wrong-network',
      `the call was built for ${envelope.network} but this capability is a ${card.network} capability`,
    );
  }
  if (envelope.signer !== signer) {
    refuse('wrong-signer', 'the call was built for a different wallet than the one signing');
  }
  if (envelope.expires_at <= now) {
    refuse('expired', 'the call has expired - ask the capability for a fresh one');
  }
  if (envelope.expires_at > now + MAX_CALL_TTL_SECS + CALL_CLOCK_SKEW_SECS) {
    refuse(
      'expiry-too-far',
      `the call claims to stay valid for longer than ${MAX_CALL_TTL_SECS} seconds`,
    );
  }
}

/**
 * Run every rule decidable from the decoded transaction. Throws
 * `OnchainRefusalError` on the first violation; returns nothing - the caller
 * keeps using the decoded call it passed in.
 */
export function runStaticChecks(args: StaticCheckArgs): void {
  const { decoded, card, signer } = args;

  if (decoded.signedBy.length > 0) {
    refuse(
      'already-signed',
      'the call arrived with a signature already attached; only unsigned calls are accepted',
    );
  }

  const feePayer = decoded.message.feePayer.address;
  if (feePayer !== signer) {
    refuse('foreign-fee-payer', `the call pays its fee from ${feePayer}, not from your wallet`);
  }

  // Transaction message v1 moves the compute budget OUT of the instruction list
  // and into a message-level `config` - `priorityFeeLamports`,
  // `computeUnitLimit`, `heapSize`, `loadedAccountsDataSizeLimit`. Every budget
  // rule in this file is instruction-shaped, so none of them sees it: a v1 call
  // naming a 1 SOL priority fee passes this gate untouched.
  //
  // It cannot reach a wallet today, because `simulateCall` rebuilds at version
  // 0 and drops the config wholesale - but that is an accident of a hard-coded
  // version, not a rule, and the natural refactor ("preserve the caller's
  // version") would hand the provider an unbounded, invisible charge past every
  // check the two-pass design exists to impose. The silent drop is also wrong
  // in the other direction: a v1 call legitimately asking for a bigger heap
  // loses that ask and fails as `simulation-failed`, the false refusal
  // `CLIENT_PRESERVED_BUDGET_DISCRIMINATORS` exists to prevent.
  //
  // Refused by name until the rebuild carries the config through and the budget
  // rules read it. `malformed-instruction` is the reason because its headline is
  // exactly what happened: this call is not shaped in a way elisym can sign.
  const version = (decoded.message as { version?: unknown }).version;
  if (version !== 0 && version !== 'legacy') {
    refuse(
      'malformed-instruction',
      `the call is a version ${String(version)} transaction message, which carries its compute ` +
        'budget in a form this client does not check - ask the capability to build a version 0 call',
    );
  }

  if (!('blockhash' in decoded.message.lifetimeConstraint)) {
    refuse(
      'durable-nonce-lifetime',
      'the call uses a durable nonce, so a signature would stay usable indefinitely',
    );
  }

  const instructions = instructionsOf(decoded);
  // Counted over instructions that DO something: a call carrying only
  // compute-budget instructions passes a bare length check and then has the
  // pricing ones stripped, leaving a transaction that acts on nothing.
  //
  // Either way it is a call the customer PAID for, and every honest thing this
  // verifier says about it helps sell it - no value moves, no program is named,
  // nothing lands in `unattributed` - so both clients present it as delivered
  // and an MCP agent signs it with no human in the loop.
  const acting = instructions.filter(
    (instruction) => instruction.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
  );
  if (acting.length === 0) {
    refuse('malformed-instruction', 'the call does nothing: it carries no instruction that acts');
  }
  if (instructions.length > MAX_INSTRUCTIONS_PER_CALL) {
    refuse(
      'too-many-instructions',
      `the call has ${instructions.length} instructions (limit ${MAX_INSTRUCTIONS_PER_CALL})`,
    );
  }

  const allowed = new Set<string>(card.programs);
  for (const instruction of instructions) {
    const programAddress = instruction.programAddress;
    if (programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS_STR) {
      // Only for the budget instructions the client KEEPS. Those survive into
      // the signed transaction taking their account metas with them, so a meta
      // there would skip the signer check below and reach the wallet: the
      // customer signs, and the send fails for want of a signature they cannot
      // produce, after they have paid. The refusal names the SHAPE rather than
      // the signature, because a writable non-signer meta is refused by this
      // rule too and "someone else must sign" would be false.
      //
      // A PRICING instruction is stripped in `simulateCall`, so its metas reach
      // neither the rebuild, nor the watched set, nor the wallet - and refusing
      // them was a false refusal of real traffic. Measured over 2,369 mainnet
      // transactions: 43 of the 904 carrying compute-budget instructions attach
      // account metas, and all 43 attach them to a pricing discriminator. Real
      // Jupiter routes are among them, which is the flagship case for this
      // whole feature.
      if (
        !isProviderBudgetInstruction(programAddress, instruction.data) &&
        (instruction.accounts ?? []).length > 0
      ) {
        refuse(
          'malformed-instruction',
          'the call attaches accounts to a compute-budget instruction, which never takes any',
        );
      }
      continue;
    }
    if (!allowed.has(programAddress)) {
      refuse(
        'program-not-on-card',
        `the call touches ${programAddress}, which this capability never published`,
      );
    }
    for (const account of instruction.accounts ?? []) {
      if (isSignerRole(account.role as AccountRole) && account.address !== signer) {
        refuse('extra-signer-required', `the call also needs a signature from ${account.address}`);
      }
    }
    assertAuthorityShapeDeclared(programAddress, instruction.data, card);
  }
}

/**
 * The fast path for the two shapes that hand standing authority away. The
 * post-state assertion catches these no matter how they are reached; naming
 * them here turns "your balance changed in a way we refuse" into "this call
 * grants an approval and the capability never said it would".
 */
function assertAuthorityShapeDeclared(
  programAddress: string,
  rawData: ArrayLike<number> | undefined,
  card: OnchainDescriptor,
): void {
  const issue = authorityShapeIssue(programAddress, rawData, card.grants_authority === true);
  if (issue) {
    refuse(issue.reason, issue.detail);
  }
}

/**
 * The same rule as a value, so the PROVIDER gate can apply it offline.
 *
 * `validateProviderCall` exists so an operator whose builder emits a shape
 * every client refuses fails their own job instead of the customer paying
 * first, and this is the largest such shape: an undeclared `Approve` costs the
 * customer a paid job and an unsignable call. Returning the issue rather than
 * throwing lets the provider raise a plain `Error` and the client a typed
 * refusal, off one definition.
 */
export function authorityShapeIssue(
  programAddress: string,
  rawData: ArrayLike<number> | undefined,
  grantsAuthority: boolean,
): { reason: OnchainRefusalReason; detail: string } | undefined {
  if (rawData === undefined || rawData.length === 0) {
    return undefined;
  }
  // Copied into a plain array view: kit hands instruction data over as a
  // read-only branded buffer, which DataView will not take directly.
  const data = Uint8Array.from(rawData);
  if (TOKEN_PROGRAM_IDS.includes(programAddress)) {
    const discriminator = data[0];
    if (
      !grantsAuthority &&
      (discriminator === TOKEN_APPROVE || discriminator === TOKEN_APPROVE_CHECKED)
    ) {
      return {
        reason: 'authority-grant-not-declared',
        detail:
          'the call approves a delegate on your token account, which this capability never published',
      };
    }
    if (discriminator === TOKEN_SET_AUTHORITY) {
      return {
        reason: 'account-authority-changed',
        detail:
          'the call changes the authority of a token account - never signed, whatever the capability declares',
      };
    }
    // Closing an account, and Token-2022's withdraw-excess-lamports, both move
    // SOL that the token amount never shows. Neither is refused here: the
    // post-state diff counts those lamports against the ceilings, which is the
    // check that holds however the call reaches them.
    return undefined;
  }
  if (programAddress === SYSTEM_PROGRAM_ADDRESS_STR && data.length >= 4) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const discriminator = view.getUint32(0, true);
    if (discriminator === SYSTEM_ASSIGN || discriminator === SYSTEM_ASSIGN_WITH_SEED) {
      return {
        reason: 'account-authority-changed',
        detail: 'the call reassigns one of your accounts to another program - never signed',
      };
    }
    if (discriminator === SYSTEM_ALLOCATE) {
      return {
        reason: 'account-authority-changed',
        detail:
          'the call allocates data on your wallet account, which would stop it paying fees or ' +
          'sending SOL - never signed',
      };
    }
  }
  return undefined;
}
