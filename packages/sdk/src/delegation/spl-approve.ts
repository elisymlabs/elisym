/**
 * SPL-approve delegation rails (v1).
 *
 * The primitive: the USDC-account owner `approveChecked`s an agent's dedicated
 * delegate key for a bounded `cap`; the agent then, signing with its own
 * delegate key, autonomously `transferChecked`s up to `cap` without the owner
 * signing each action. SPL-Token enforces the ceiling: a delegate can only
 * Transfer/Burn up to `delegated_amount` and can never Approve/SetAuthority/
 * CloseAccount (all owner-only). `delegated_amount` only ratchets down per
 * action and never rises without a fresh owner `approve`.
 *
 * Honest bound: **max loss <= cap**. It is bounded-trust, not "can't steal":
 * within `cap` the agent chooses the destination, including its own account.
 *
 * Hard gates (enforced here, not display):
 * - the mint is the canonical USDC mint for the active network (resolved from
 *   `KNOWN_ASSETS`, never from an agent-supplied descriptor string);
 * - the source token account is the owner's ATA for that mint (derived here
 *   from `(owner, mint)`, never accepted verbatim);
 * - decimals ride in every `*Checked` instruction so the Token program rejects
 *   a mint/decimals mismatch on-chain.
 *
 * These builders return Kit instructions (mirroring `buildPaymentInstructions`):
 * the browser owner path bridges them through a wallet-adapter (noop signer),
 * the agent-host / de-risk path signs with a `KeyPairSigner`.
 */

import {
  APPROVE_CHECKED_DISCRIMINATOR,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  TRANSFER_CHECKED_DISCRIMINATOR,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getApproveCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getRevokeInstruction,
  getTransferCheckedInstruction,
  parseApproveCheckedInstruction,
  parseTransferCheckedInstruction,
} from '@solana-program/token';
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  address,
  isAddress,
  unwrapOption,
} from '@solana/kit';
import { type Asset, KNOWN_ASSETS, USDC_SOLANA_DEVNET, formatAssetAmount } from '../payment/assets';
import { calculateProtocolFee } from '../payment/fee';
import type { Signer } from '../payment/strategy';
import type { Network } from '../types';

/** u64 ceiling: SPL amounts are u64. */
const U64_MAX = (1n << 64n) - 1n;

function assertU64(value: bigint, label: string): void {
  if (typeof value !== 'bigint') {
    throw new Error(`${label} must be a bigint (subunits)`);
  }
  if (value < 0n) {
    throw new Error(`${label} cannot be negative`);
  }
  if (value > U64_MAX) {
    throw new Error(`${label} exceeds the u64 maximum (${U64_MAX})`);
  }
}

/**
 * Resolve the canonical USDC asset for the active network. Only devnet exists
 * today; mainnet USDC is a distinct mint/constant to add when mainnet lands.
 * Throwing (rather than defaulting) keeps a mainnet caller from silently
 * approving a devnet mint.
 */
export function resolveDelegationAsset(network: Network): Asset {
  if (network === 'devnet') {
    return USDC_SOLANA_DEVNET;
  }
  throw new Error(
    `Delegation is USDC-only and mainnet USDC is not wired yet (network: ${network}). ` +
      `Add the mainnet USDC constant to KNOWN_ASSETS before enabling it.`,
  );
}

function requireMint(asset: Asset): Address {
  if (!asset.mint) {
    throw new Error(
      `Delegation asset ${asset.symbol} has no mint (native coins cannot be delegated)`,
    );
  }
  return address(asset.mint);
}

/**
 * Derive the owner's associated token account for the delegation asset. This is
 * the source account for `approve`/`revoke`/`getDelegation`; deriving it (never
 * accepting a caller-supplied token account) is the "token account == owner's
 * ATA" gate.
 */
export async function deriveOwnerDelegationAta(owner: string, network: Network): Promise<Address> {
  if (!isAddress(owner)) {
    throw new Error(`Invalid owner address: ${owner}`);
  }
  const asset = resolveDelegationAsset(network);
  const mint = requireMint(asset);
  const [ata] = await findAssociatedTokenPda({
    owner: address(owner),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  });
  return ata;
}

export interface BuildApproveDelegateArgs {
  /**
   * The USDC-account owner (the customer). A noop signer in the browser (the
   * wallet-adapter signs at send time) or a `KeyPairSigner` in a script.
   */
  owner: Signer;
  /** The agent's delegate pubkey, taken from its card descriptor. */
  delegate: string;
  /**
   * Owner-set spend ceiling in USDC subunits. Cap provenance is an app-layer
   * guard: the owner must type/confirm this - never auto-submit a card's
   * `suggested_cap_subunits`.
   */
  capSubunits: bigint;
  /** Selects the canonical USDC mint. */
  network: Network;
  /**
   * Optional protocol fee charged to the owner at approve time: `feeBps` of the
   * cap, transferred owner -> `treasury` in USDC within the same transaction.
   * Source `feeBps`/`treasury` from `getProtocolConfig`. Omit (or feeBps 0) for
   * no fee. When charged it is a real USDC transfer, so the owner must hold it.
   */
  fee?: { feeBps: number; treasury: string };
}

/**
 * The protocol fee (USDC subunits) charged to the owner when approving a
 * delegate: `feeBps` of the cap, rounded up like the payment fee. Exact only for
 * `feeBps <= 10000` (on-chain `MAX_FEE_BPS` is 1000). Guards the cap against
 * `Number.MAX_SAFE_INTEGER` before the `number`-based fee math, since a u64 cap
 * can otherwise exceed a safe double. Returns `0n` for `feeBps` 0 or a zero cap.
 */
export function delegationApproveFeeSubunits(capSubunits: bigint, feeBps: number): bigint {
  if (capSubunits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `delegation cap ${capSubunits} exceeds the safe-integer bound for fee computation`,
    );
  }
  return BigInt(calculateProtocolFee(Number(capSubunits), feeBps));
}

/**
 * Owner-signed `approveChecked` granting `delegate` up to `capSubunits` USDC on
 * the owner's ATA. Idempotently creates the owner ATA first so a standing
 * allowance can be granted even on a zero-balance account (the cap is decoupled
 * from balance). A fresh approve REPLACES any prior `delegated_amount` - a
 * social-engineered "top-up" is a re-grant, never an additive bump.
 */
export async function buildApproveDelegate(
  args: BuildApproveDelegateArgs,
): Promise<readonly unknown[]> {
  const asset = resolveDelegationAsset(args.network);
  const mint = requireMint(asset);
  if (!isAddress(args.delegate)) {
    throw new Error(`Invalid delegate address: ${args.delegate}`);
  }
  const delegate = address(args.delegate);
  assertU64(args.capSubunits, 'delegation cap');
  if (args.capSubunits <= 0n) {
    throw new Error('delegation cap must be positive; use revoke to clear an allowance');
  }
  if (delegate === args.owner.address) {
    throw new Error('delegate must differ from the owner');
  }
  const [ownerAta] = await findAssociatedTokenPda({
    owner: args.owner.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  });
  const instructions: unknown[] = [
    getCreateAssociatedTokenIdempotentInstruction(
      {
        payer: args.owner,
        ata: ownerAta,
        owner: args.owner.address,
        mint,
      },
      { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
    ),
    getApproveCheckedInstruction({
      source: ownerAta,
      mint,
      delegate,
      owner: args.owner,
      amount: args.capSubunits,
      decimals: asset.decimals,
    }),
  ];

  // Optional protocol fee (owner -> treasury, feeBps of the cap) appended AFTER
  // the approve so `approveChecked` stays at index [1] for `decodeApproveDelegate`.
  // The fee `transferChecked` uses the OWNER authority (not the delegate), so it
  // never touches `delegated_amount`; it just moves balance in the same tx.
  if (args.fee) {
    const feeSubunits = delegationApproveFeeSubunits(args.capSubunits, args.fee.feeBps);
    if (feeSubunits > 0n) {
      if (!isAddress(args.fee.treasury)) {
        throw new Error(`Invalid fee treasury address: ${args.fee.treasury}`);
      }
      const treasury = address(args.fee.treasury);
      const [treasuryAta] = await findAssociatedTokenPda({
        owner: treasury,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint,
      });
      instructions.push(
        getCreateAssociatedTokenIdempotentInstruction(
          { payer: args.owner, ata: treasuryAta, owner: treasury, mint },
          { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
        ),
        getTransferCheckedInstruction({
          source: ownerAta,
          mint,
          destination: treasuryAta,
          authority: args.owner,
          amount: feeSubunits,
          decimals: asset.decimals,
        }),
      );
    }
  }
  return instructions;
}

export interface BuildRevokeDelegateArgs {
  /** The USDC-account owner. */
  owner: Signer;
  /** Selects the canonical USDC mint (the owner ATA is derived from it). */
  network: Network;
}

/**
 * Owner-signed `revoke` clearing any delegate on the owner's ATA. Revoke only
 * stops FUTURE spend once it lands: between a grant/top-up and a confirmed
 * revoke the delegate can still spend the remaining cap (a front-run window).
 */
export async function buildRevokeDelegate(
  args: BuildRevokeDelegateArgs,
): Promise<readonly unknown[]> {
  const mint = requireMint(resolveDelegationAsset(args.network));
  const [ownerAta] = await findAssociatedTokenPda({
    owner: args.owner.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  });
  return [getRevokeInstruction({ source: ownerAta, owner: args.owner })];
}

export interface BuildDelegatedTransferArgs {
  /** The agent's dedicated delegate signer. */
  delegate: Signer;
  /** The owner's delegated USDC ATA (the source of funds). */
  source: string;
  /**
   * Destination token account (an ATA). The agent picks it - open destination -
   * so it may be the agent's own account (pull-to-self) or a payee's.
   */
  destination: string;
  /** Amount in subunits. On-chain the Token program caps it at the remaining `delegated_amount`. */
  amount: bigint;
  /** Selects the canonical USDC mint / decimals. */
  network: Network;
  /**
   * When set, prepend an idempotent create for the destination ATA (fee-paid by
   * the delegate). `owner` is the WALLET that owns `destination` - required
   * because ATA creation needs the owner, not just the derived account. Use for
   * pulls to an account that may not exist yet (e.g. the provider's own USDC
   * ATA on a fresh wallet); harmless when it already does.
   */
  ensureDestination?: { owner: string };
}

/**
 * The agent's capped `transferChecked`, signed by its delegate key, moving
 * `amount` USDC from the owner's delegated ATA to a destination the agent
 * chose. The Token program rejects anything above the remaining
 * `delegated_amount`; after this transfer the delegate has NO authority over
 * the output (the approve was on the source USDC account only).
 */
export async function buildDelegatedTransfer(
  args: BuildDelegatedTransferArgs,
): Promise<readonly unknown[]> {
  const asset = resolveDelegationAsset(args.network);
  const mint = requireMint(asset);
  assertU64(args.amount, 'delegated transfer amount');
  if (args.amount <= 0n) {
    throw new Error('delegated transfer amount must be positive');
  }
  if (!isAddress(args.source)) {
    throw new Error(`Invalid source token account: ${args.source}`);
  }
  if (!isAddress(args.destination)) {
    throw new Error(`Invalid destination token account: ${args.destination}`);
  }
  const instructions: unknown[] = [];
  if (args.ensureDestination) {
    if (!isAddress(args.ensureDestination.owner)) {
      throw new Error(`Invalid destination owner address: ${args.ensureDestination.owner}`);
    }
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction(
        {
          payer: args.delegate,
          ata: address(args.destination),
          owner: address(args.ensureDestination.owner),
          mint,
        },
        { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
      ),
    );
  }
  instructions.push(
    getTransferCheckedInstruction({
      source: address(args.source),
      mint,
      destination: address(args.destination),
      authority: args.delegate,
      amount: args.amount,
      decimals: asset.decimals,
    }),
  );
  return instructions;
}

export interface DelegationStatus {
  /** The current delegate address, or null if the account has none. */
  delegate: string | null;
  /**
   * Remaining approved amount in subunits (`delegated_amount`). 0 when there is
   * no delegate - the Token program clears the delegate once the amount hits 0.
   */
  remainingCap: bigint;
  /** The token account's on-chain mint. */
  mint: string;
  /** The account owner. */
  owner: string;
  /** Current token balance in subunits (the cap is decoupled from this). */
  balance: bigint;
}

/**
 * Read the live delegation on a token account. `ownerAta` is the owner's USDC
 * ATA (derive it with {@link deriveOwnerDelegationAta}). Read-only; safe for
 * clients and the MCP `get_delegation` tool.
 *
 * Returns `null` when the token account does not exist yet (a not-yet-created
 * ATA genuinely has no delegation). A real RPC/transport failure THROWS so a
 * caller never mistakes an outage for "no delegate" - the distinction matters
 * because this is the exposure-check surface a customer uses before deciding
 * whether they need to revoke. (Uses `fetchMaybeToken`, which returns
 * `{ exists: false }` for a missing account but still throws on RPC errors.)
 */
export async function getDelegation(
  rpc: Rpc<SolanaRpcApi>,
  ownerAta: string,
): Promise<DelegationStatus | null> {
  if (!isAddress(ownerAta)) {
    throw new Error(`Invalid token account address: ${ownerAta}`);
  }
  const account = await fetchMaybeToken(rpc, address(ownerAta));
  if (!account.exists) {
    return null;
  }
  const token = account.data;
  const delegate = unwrapOption(token.delegate);
  return {
    delegate: delegate ?? null,
    remainingCap: delegate ? token.delegatedAmount : 0n,
    mint: token.mint,
    owner: token.owner,
    balance: token.amount,
  };
}

export interface ApproveDelegateView {
  /** Owner's token account being delegated. */
  source: string;
  /** The token mint (on-chain truth). */
  mint: string;
  /** The delegate being granted authority. */
  delegate: string;
  /** The granted ceiling in subunits. */
  capSubunits: bigint;
  /** Decimals encoded in the checked instruction. */
  decimals: number;
  /** Display symbol resolved from the mint via KNOWN_ASSETS - NOT any descriptor string. */
  symbol: string;
  /** True when the mint is a recognized (canonical) asset. */
  recognized: boolean;
}

/**
 * Decode a built `approveChecked` instruction into a display view. This is the
 * transparency layer: because `spl-approve` is a single, known instruction, the
 * app shows EXACTLY what the user signs by decoding it. The asset name is
 * derived from the on-chain mint, so a hostile descriptor cannot relabel USDC.
 * The wallet's own simulation is the independent final check.
 *
 * `parseApproveCheckedInstruction` only checks the account count and data
 * length, NOT that the instruction actually targets the SPL Token program with
 * the ApproveChecked discriminator - so an arbitrary instruction whose 2nd
 * account happened to be the USDC mint would otherwise decode as a bogus
 * "grant". We assert both here so the "shows EXACTLY what you sign" promise
 * holds even if this helper is ever pointed at an instruction it did not build.
 */
export function decodeApproveDelegate(instruction: unknown): ApproveDelegateView {
  if (instruction === null || typeof instruction !== 'object') {
    throw new Error('decodeApproveDelegate expects a built approveChecked instruction object.');
  }
  const parsed = parseApproveCheckedInstruction(
    instruction as Parameters<typeof parseApproveCheckedInstruction>[0],
  );
  if (String(parsed.programAddress) !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error('Instruction is not an SPL Token instruction (unexpected program address).');
  }
  if (parsed.data.discriminator !== APPROVE_CHECKED_DISCRIMINATOR) {
    throw new Error('Instruction is not an SPL Token ApproveChecked (unexpected discriminator).');
  }
  const mint = String(parsed.accounts.mint.address);
  const known = KNOWN_ASSETS.find((asset) => asset.mint === mint);
  return {
    source: String(parsed.accounts.source.address),
    mint,
    delegate: String(parsed.accounts.delegate.address),
    capSubunits: parsed.data.amount,
    decimals: parsed.data.decimals,
    symbol: known?.symbol ?? 'tokens',
    recognized: known !== undefined,
  };
}

export interface DelegationFeeTransferView {
  /** Owner's token account the fee leaves (the delegated ATA). */
  source: string;
  /** The treasury's token account receiving the fee. */
  destination: string;
  /** The token mint (on-chain truth). */
  mint: string;
  /** Fee amount in subunits. */
  amount: bigint;
  /** Decimals encoded in the checked instruction. */
  decimals: number;
}

/**
 * Decode the built fee-transfer instruction (the `transferChecked` appended to a
 * fee-bearing approve) so a caller can verify EXACTLY what the owner signs -
 * destination treasury ATA, amount, mint - before sending. Mirrors
 * {@link decodeApproveDelegate}: asserts the SPL Token program + TransferChecked
 * discriminator so an arbitrary instruction cannot masquerade as the fee. This
 * matters most on the headless MCP path, which has no wallet simulation.
 */
export function decodeDelegationFeeTransfer(instruction: unknown): DelegationFeeTransferView {
  if (instruction === null || typeof instruction !== 'object') {
    throw new Error(
      'decodeDelegationFeeTransfer expects a built transferChecked instruction object.',
    );
  }
  const parsed = parseTransferCheckedInstruction(
    instruction as Parameters<typeof parseTransferCheckedInstruction>[0],
  );
  if (String(parsed.programAddress) !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error('Instruction is not an SPL Token instruction (unexpected program address).');
  }
  if (parsed.data.discriminator !== TRANSFER_CHECKED_DISCRIMINATOR) {
    throw new Error('Instruction is not an SPL Token TransferChecked (unexpected discriminator).');
  }
  return {
    source: String(parsed.accounts.source.address),
    destination: String(parsed.accounts.destination.address),
    mint: String(parsed.accounts.mint.address),
    amount: parsed.data.amount,
    decimals: parsed.data.decimals,
  };
}

/**
 * Human-readable grant summary for the exact-approve panel:
 * "Grant delegate <delegate> up to <N> USDC on your account."
 */
export function formatDelegationGrant(view: ApproveDelegateView): string {
  const known = KNOWN_ASSETS.find((asset) => asset.mint === view.mint);
  const amount = known
    ? formatAssetAmount(known, view.capSubunits)
    : `${view.capSubunits} subunits`;
  return `Grant delegate ${view.delegate} up to ${amount} on your account.`;
}
