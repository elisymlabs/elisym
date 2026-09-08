/**
 * The verifier: the single path by which a client may sign a capability's call.
 *
 * It lives in the SDK so the browser and the MCP agent run identical logic - a
 * refusal in one is a refusal in the other, in the same words. Steps 1 to 8 of
 * `docs/plans/onchain-action-skills.md` in order:
 *
 *   parse -> decode (+ lookup tables) -> bind to the card -> static shape ->
 *   recompile under our control -> simulate -> assert both ceilings -> sign.
 *
 * What it does NOT do, ever: judge whether a program is trustworthy. It bounds
 * what a call can take and shows honestly what it found. Clients must carry
 * that disclaimer in the primary flow, not in a footnote.
 */

import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import type { Network } from '../types';
import { analyzeStateChange, assertCeilings } from './ceilings';
import {
  ALWAYS_ALLOWED_PROGRAMS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
  runEnvelopeChecks,
  runStaticChecks,
} from './checks';
import { DEFAULT_INCIDENTAL_LAMPORTS, MAX_INCIDENTAL_LAMPORTS } from './constants';
import { decodeCallTransaction, instructionsOf } from './decode';
import { describeError, OnchainRefusalError, refuse } from './errors';
import { isWithinU64, parseOnchainCallEnvelope, type OnchainDescriptor } from './schema';
import { simulateCall } from './simulate';
import type { OnchainCallFacts, OnchainCeilings, OnchainVerifyResult } from './types';

/**
 * Same rule the descriptor schema applies, re-checked for a hand-built card.
 *
 * The digit pattern alone is weaker than the schema: 20 digits admits values up
 * to ~1e20, and the schema pairs the pattern with `isWithinU64`. Both clients
 * call `defaultCeilings` directly to seed their limit boxes, so a hand-built
 * card carrying '99999999999999999999' would put a ceiling no chain can express
 * in front of a customer as though the capability had published it.
 */
const SUBUNITS_PATTERN = /^\d{1,20}$/;

function publishesSubunits(value: string): boolean {
  return SUBUNITS_PATTERN.test(value) && isWithinU64(value);
}

export interface VerifyOnchainCallArgs {
  /** The job's result: the JSON text a capability returned, or the parsed object. */
  envelope: unknown;
  /** The capability's published promise, from its card. */
  card: OnchainDescriptor;
  /** The wallet that would sign. */
  signer: Address;
  /** The client's own network. A card from the other network is refused. */
  network: Network;
  rpc: Rpc<SolanaRpcApi>;
  /** Client bounds. Defaults come from the card and may only be tightened. */
  ceilings?: Partial<OnchainCeilings>;
  /** Unix seconds. Injectable so expiry rules are testable without a clock. */
  now?: number;
}

/**
 * The bounds a client starts from: the capability's own published ceilings, and
 * a fixed allowance for fee and rent that no card gets to raise.
 */
export function defaultCeilings(card: OnchainDescriptor): OnchainCeilings {
  // Guarded HERE rather than in `resolveCeilings`, because both clients call
  // this one directly to seed their own limit boxes - before the verifier runs
  // at all. A card built by hand rather than parsed can carry a ceiling `BigInt`
  // will not take, and an unguarded throw there surfaces as a raw `SyntaxError`
  // instead of the refusal written for exactly this case.
  if (!publishesSubunits(card.max_per_call_subunits)) {
    refuse('malformed-card', 'the capability published a spend ceiling that is not a number');
  }
  if (!publishesSubunits(card.max_authority_subunits)) {
    refuse('malformed-card', 'the capability published an authority ceiling that is not a number');
  }
  return {
    spendSubunits: BigInt(card.max_per_call_subunits),
    authoritySubunits: BigInt(card.max_authority_subunits),
    incidentalLamports: DEFAULT_INCIDENTAL_LAMPORTS,
  };
}

/**
 * Resolve the bounds actually applied. The two the CARD publishes may only be
 * lowered - raising one is ignored rather than honoured, so a UI bug cannot
 * quietly widen the promise the user was shown. The incidental allowance is the
 * client's own, not the card's, so it may be raised as well as lowered, up to
 * `MAX_INCIDENTAL_LAMPORTS`.
 */
function resolveCeilings(
  card: OnchainDescriptor,
  overrides: Partial<OnchainCeilings> | undefined,
): OnchainCeilings {
  const defaults = defaultCeilings(card);
  return {
    spendSubunits: lower(defaults.spendSubunits, overrides?.spendSubunits),
    authoritySubunits: lower(defaults.authoritySubunits, overrides?.authoritySubunits),
    incidentalLamports: lower(
      MAX_INCIDENTAL_LAMPORTS,
      overrides?.incidentalLamports ?? defaults.incidentalLamports,
    ),
  };
}

function lower(bound: bigint, override: bigint | undefined): bigint {
  if (override === undefined) {
    return bound;
  }
  // A negative override is a caller that computed a remaining budget and went
  // past zero. It means "nothing left", never "use the published ceiling".
  if (override < 0n) {
    return 0n;
  }
  return override < bound ? override : bound;
}

/**
 * Bind the programs the simulation actually reached to the card, not just the
 * top-level instructions. A capability that lists one program is otherwise a
 * license for that program to call anything, which is not what its card says.
 *
 * The ubiquitous system programs are allowed without being listed: every SPL
 * flow goes through them, their effects are exactly what the post-state
 * assertion already covers, and requiring each card to enumerate them would
 * make the promise noise rather than signal.
 */
function assertInnerProgramsDeclared(innerPrograms: readonly string[], card: OnchainDescriptor) {
  const allowed = new Set<string>([...card.programs, ...ALWAYS_ALLOWED_PROGRAMS]);
  for (const programId of innerPrograms) {
    if (!allowed.has(programId)) {
      refuse(
        'program-not-on-card',
        `the call reaches ${programId} inside another program, and this capability never published it`,
      );
    }
  }
}

export async function verifyOnchainCall(args: VerifyOnchainCallArgs): Promise<OnchainVerifyResult> {
  const { card, signer, network, rpc } = args;
  const now = args.now ?? Math.floor(Date.now() / 1000);

  try {
    const ceilings = resolveCeilings(card, args.ceilings);
    if (card.network !== network) {
      refuse(
        'wrong-network',
        `this capability publishes ${card.network} calls but the wallet is on ${network}`,
      );
    }
    const envelope = parseOnchainCallEnvelope(args.envelope);
    if (envelope === null) {
      refuse(
        'malformed-envelope',
        'the capability did not return a call in the shape elisym understands',
      );
    }

    // Bind the envelope BEFORE touching the chain: a call for another wallet or
    // an expired one is refused without buying the provider any RPC work.
    runEnvelopeChecks({ envelope, card, signer, now });

    const decoded = await decodeCallTransaction(envelope.transaction, rpc);
    runStaticChecks({ decoded, card, signer });

    const simulated = await simulateCall({ decoded, signer, network, rpc });
    assertInnerProgramsDeclared(simulated.innerPrograms, card);
    const change = analyzeStateChange({
      pre: simulated.pre,
      post: simulated.post,
      signer,
      writable: simulated.writable,
      feeLamports: simulated.feeLamports,
    });

    // Both read the same list: the call's own instructions, minus the
    // ComputeBudget ones. Counting the unfiltered list would report 21
    // instructions next to a single program. Note this under-counts by any
    // budget instruction the client keeps (a heap-frame request): those are in
    // the signed transaction but carry no authority and touch no account, so
    // naming them among the programs a call "touches" would be noise.
    //
    // `programs` is deduplicated and `instructionCount` is not, because they
    // answer different questions. Every client renders the former as "programs
    // it calls", where an ATA-create plus a transfer - two instructions on one
    // program, the commonest shape there is - must read as one program, not two.
    const calledPrograms = instructionsOf(decoded)
      .map((instruction) => instruction.programAddress)
      .filter((programAddress) => programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS_STR);
    const facts: OnchainCallFacts = {
      programs: [...new Set(calledPrograms)],
      innerPrograms: simulated.innerPrograms,
      instructionCount: calledPrograms.length,
      deltas: change.deltas,
      grants: change.grants,
      feeLamports: simulated.feeLamports,
      unitsConsumed: simulated.unitsConsumed,
      unattributed: change.unattributed,
      ...(envelope.explain ? { explain: envelope.explain } : {}),
    };

    try {
      assertCeilings({ change, card, ceilings, feeLamports: simulated.feeLamports });
    } catch (error) {
      // Re-thrown with the facts attached: a customer told "this moves more
      // than you allowed" should see WHAT it moves, not just the verdict.
      if (error instanceof OnchainRefusalError) {
        throw new OnchainRefusalError(error.reason, error.message, facts);
      }
      throw error;
    }

    return {
      ok: true,
      transaction: simulated.transaction,
      lifetime: simulated.lifetime,
      signer,
      facts,
      ceilings,
    };
  } catch (error) {
    if (error instanceof OnchainRefusalError) {
      return {
        ok: false,
        reason: error.reason,
        detail: error.message,
        ...(error.facts ? { facts: error.facts } : {}),
      };
    }
    // Anything else is the chain connection failing mid-verification. It is
    // still a refusal: a call we could not finish checking is never signed.
    return {
      ok: false,
      reason: 'rpc-unavailable',
      detail: `the call could not be checked against the chain (${describeError(error)})`,
    };
  }
}
