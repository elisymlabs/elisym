/**
 * Verifier vocabulary: why a call was refused, what the client derived about
 * it, and the bounds it was judged against.
 *
 * The refusal reason is a closed union on purpose - the browser and MCP render
 * the same words for the same refusal, and a new reason is a deliberate,
 * type-checked addition rather than a new string somewhere in a client.
 */

import type { Address } from '@solana/kit';
import type { OnchainDescriptor, OnchainExplain } from './schema';

/**
 * The descriptor as a loaded skill carries it: the operator's block with the
 * asset and both ceilings resolved, but without `network`. The network is
 * stamped from the agent's wallet at `buildCard`, so a skill copied between a
 * devnet and a mainnet agent cannot lie about where it runs.
 */
export type SkillOnchainResolved = Omit<OnchainDescriptor, 'network'>;

/**
 * Why a call cannot be signed. Grouped by the stage that produces it, which is
 * also the order the verifier runs them in.
 */
export type OnchainRefusalReason =
  // the card itself
  | 'malformed-card'
  // envelope
  | 'malformed-envelope'
  | 'wrong-network'
  | 'wrong-signer'
  | 'expired'
  | 'expiry-too-far'
  // decode
  | 'undecodable-transaction'
  | 'lookup-table-unavailable'
  // static shape
  | 'already-signed'
  | 'foreign-fee-payer'
  | 'durable-nonce-lifetime'
  | 'extra-signer-required'
  | 'malformed-instruction'
  | 'too-many-instructions'
  | 'too-many-accounts'
  | 'oversized-transaction'
  | 'program-not-on-card'
  // simulation
  | 'simulation-failed'
  | 'post-state-unavailable'
  | 'rpc-unavailable'
  // bounds
  | 'spend-ceiling-exceeded'
  | 'unexpected-asset-outflow'
  | 'fee-ceiling-exceeded'
  | 'authority-grant-not-declared'
  | 'authority-ceiling-exceeded'
  | 'account-authority-changed';

/** Net movement of one asset out of (negative) or into (positive) the signer. */
export interface OnchainAssetDelta {
  /** SPL mint, or undefined for native SOL. */
  mint?: string;
  /** Signed subunits: negative leaves the signer, positive arrives. */
  subunits: bigint;
}

/** An approval the call would leave behind on one of the signer's accounts. */
export interface OnchainAuthorityGrant {
  /** The signer's token account the authority is granted over. */
  account: string;
  /** Who may then move the funds. */
  delegate: string;
  /** SPL mint of that account. */
  mint: string;
  /** How much the delegate may move, in the mint's subunits. */
  subunits: bigint;
}

/**
 * What the CLIENT derived about the call. Everything here comes from decoding
 * and simulating, never from the provider - except `explain`, which is carried
 * through so a UI can show it clearly labelled as the agent's own words.
 */
export interface OnchainCallFacts {
  /** Programs the top-level instructions target, in order of appearance. */
  programs: string[];
  /** Programs that appeared only inside the simulated CPIs. */
  innerPrograms: string[];
  instructionCount: number;
  /** Net asset movement for the signer, one entry per asset that moved. */
  deltas: OnchainAssetDelta[];
  /** Approvals the call would leave standing after it lands. */
  grants: OnchainAuthorityGrant[];
  /** Network fee the client will pay for this transaction, in lamports. */
  feeLamports: bigint;
  /** Compute units the simulation actually consumed. */
  unitsConsumed?: bigint;
  /**
   * Writable accounts the verifier could NOT attribute to the signer. The
   * ceilings say nothing about these: funds a program holds for the signer (a
   * lending position, a stake account, an escrow) live in accounts owned by
   * that program, and a withdrawal from one to a stranger moves nothing the
   * deltas can see. A client must surface this and must never describe a call
   * carrying any of them as moving nothing.
   */
  unattributed: string[];
  /**
   * Untrusted provider text. A client that shows it must put it beside the
   * derived facts and never instead of them; omitting it entirely is also a
   * valid choice, and the MCP client makes it.
   */
  explain?: OnchainExplain[];
}

/**
 * The bounds a call is judged against. Defaults come from the capability card;
 * a client may lower them and must never raise them silently.
 */
export interface OnchainCeilings {
  /** Max subunits of the card's asset that may leave the signer. */
  spendSubunits: bigint;
  /** Max subunits of the card's asset the call may authorize someone else to move. */
  authoritySubunits: bigint;
  /**
   * Max lamports that may leave for reasons other than the action itself.
   *
   * For a capability denominated in a TOKEN that is the network fee plus rent
   * for any account the call creates - SOL the customer never priced. For a
   * SOL-denominated capability only the fee rides here: every other lamport is
   * the asset the card is about, so it is bounded by `spendSubunits`. A native
   * capability whose calls create accounts must therefore price that rent into
   * `max_per_call` rather than expect this allowance to absorb it.
   *
   * A client may lower it, and may raise it as far as
   * `MAX_INCIDENTAL_LAMPORTS`; neither shipped client currently offers either,
   * so in practice the default is the bound.
   */
  incidentalLamports: bigint;
}

/** Outcome of `verifyOnchainCall`. */
export type OnchainVerifyResult =
  | {
      ok: true;
      /** Base64 wire transaction, unsigned, exactly as simulated. Sign this. */
      transaction: string;
      /**
       * The blockhash lifetime the verifier set. A caller confirms the send
       * against this bound rather than polling forever: past
       * `lastValidBlockHeight` the transaction can never land.
       */
      lifetime: { blockhash: string; lastValidBlockHeight: bigint };
      /** The address that must sign it. */
      signer: Address;
      facts: OnchainCallFacts;
      /** The bounds actually applied, after client overrides. */
      ceilings: OnchainCeilings;
    }
  | {
      ok: false;
      reason: OnchainRefusalReason;
      /** One sentence naming what failed. Safe to show; carries no provider text. */
      detail: string;
      /** Whatever was derived before the refusal, when anything was. */
      facts?: Partial<OnchainCallFacts>;
    };
