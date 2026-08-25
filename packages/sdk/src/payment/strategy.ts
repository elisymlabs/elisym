import type { Address, Rpc, SolanaRpcApi, TransactionSigner } from '@solana/kit';
import type {
  Network,
  PaymentRequestData,
  PaymentValidationError,
  VerifyOptions,
  VerifyResult,
} from '../types';
import type { Asset } from './assets';

/**
 * Pluggable signer used by `PaymentStrategy.buildTransaction`.
 *
 * Aliased to Solana Kit's `TransactionSigner` so callers can pass a hot
 * `KeyPairSigner`, an external KMS-backed signer, a hardware-wallet adapter,
 * or any other implementation that conforms to the Solana Kit signer contract
 * (TransactionPartialSigner / TransactionSendingSigner / TransactionModifyingSigner).
 *
 * Exposing the alias here lets downstream packages depend on `@elisym/sdk`'s
 * abstraction instead of importing Kit directly when wiring custom signers.
 */
export type Signer = TransactionSigner;

/**
 * Protocol fee + treasury inputs for building a payment request.
 *
 * Callers must supply this config explicitly - the SDK does not bundle a
 * fallback. The canonical source is `getProtocolConfig(rpc, programId)`,
 * which reads the on-chain elisym-config program; tests and offline tools
 * may pass fixture values directly.
 */
export interface ProtocolConfigInput {
  /** Protocol fee in basis points (300 = 3%). Must be a non-negative integer. */
  feeBps: number;
  /** Solana address of the protocol treasury. */
  treasury: Address;
}

/**
 * Pluggable payment strategy interface.
 * Implement this for each payment chain (Solana, Lightning, Cashu, EVM).
 *
 * The interface is intentionally generic about the on-chain transaction type
 * (`unknown` for build/verify inputs) so future chains can plug in without
 * pulling Solana types into shared code paths.
 */
export interface PaymentStrategy {
  readonly chain: string;

  /** Calculate protocol fee using basis-point math. */
  calculateFee(amount: number, config: ProtocolConfigInput): number;

  /**
   * Create a payment request with auto-calculated protocol fee. `network` is
   * required on the write side (D7): the API cannot infer it - the program id
   * is cluster-ambiguous - and a request without it would be auto-rejected as
   * legacy-devnet by every mainnet customer.
   */
  createPaymentRequest(
    recipientAddress: string,
    amount: number,
    config: ProtocolConfigInput,
    network: Network,
    options?: { expirySecs?: number },
  ): PaymentRequestData;

  /**
   * Validate that a payment request has the correct recipient and protocol fee.
   * Returns a typed validation error if invalid, null if OK.
   *
   * `network` is the CUSTOMER's network and is required: a request whose
   * `network` (absent = devnet, legacy) differs from it is rejected before any
   * money check. An optional param that skips the check when absent would
   * silently degrade to per-consumer enforcement.
   *
   * `options.expectedAsset` binds the currency the same way `expectedRecipient`
   * binds the destination: pass the asset the caller agreed to pay and a
   * request debiting a different one is refused. Assets that do not exist on
   * `network` are rejected regardless, with or without it.
   */
  validatePaymentRequest(
    requestJson: string,
    config: ProtocolConfigInput,
    network: Network,
    expectedRecipient?: string,
    options?: { maxAmountLamports?: bigint; expectedAsset?: Asset },
  ): PaymentValidationError | null;

  /**
   * Build and sign a transaction from a payment request using a `Signer`.
   *
   * The `Signer` parameter is intentionally the abstract interface, not a
   * concrete `KeyPairSigner`, so callers can plug in external signers
   * (KMS, hardware wallet, ElizaOS approval Action) without holding the
   * raw secret key in process memory.
   *
   * Returns a chain-specific signed transaction value. The caller is
   * responsible for sending it (e.g. via `rpc.sendTransaction(...).send()`).
   */
  buildTransaction(
    paymentRequest: PaymentRequestData,
    payerSigner: Signer,
    rpc: Rpc<SolanaRpcApi>,
    config: ProtocolConfigInput,
    options: BuildTransactionOptions,
  ): Promise<unknown>;

  /**
   * Verify a payment on-chain.
   */
  verifyPayment(
    rpc: Rpc<SolanaRpcApi>,
    paymentRequest: PaymentRequestData,
    config: ProtocolConfigInput,
    options?: VerifyOptions,
  ): Promise<VerifyResult>;
}

/**
 * Knobs for `PaymentStrategy.buildTransaction`. `programId` and `network` are
 * required; the rest default to values chosen for typical Solana mainnet
 * conditions - override those when the caller knows peak fees are elevated,
 * when running against a private cluster with no priority-fee samples, or
 * when bundling multiple payment instructions.
 */
export interface BuildTransactionOptions {
  /**
   * elisym-config program ID for the active cluster (resolve via
   * `getProtocolProgramId(network)`). Used to derive the `NetworkStats` PDA
   * targeted by the appended `increment_stats` instruction. Required - a
   * silent default would be a landmine for localnet and any future
   * per-cluster id divergence.
   */
  programId: Address;
  /**
   * The cluster the supplied RPC points at. Threaded into the priority-fee
   * estimator's cache discriminator - nothing else in the inputs identifies
   * the cluster (the program id is cluster-ambiguous by D4).
   */
  network: Network;
  /**
   * Compute-unit limit attached to the transaction. Defaults to 200 000 -
   * comfortable headroom for two SystemProgram transfers + a few extra ops.
   */
  computeUnitLimit?: number;
  /**
   * Per-CU priority-fee override in microLamports. When omitted, the
   * strategy queries `getRecentPrioritizationFees`, sorts by percentile, and
   * uses that value (cached for 10s). Pass an explicit value to skip the
   * RPC call or override the percentile heuristic during traffic spikes.
   */
  priorityFeeMicroLamports?: bigint;
  /**
   * Percentile of the recent priority-fee distribution to charge when
   * `priorityFeeMicroLamports` is not supplied. 50 = median, 75 = upper
   * quartile (default), 90 = aggressive.
   */
  priorityFeePercentile?: number;
  /**
   * Nostr job request event id (hex) to embed in an SPL Memo instruction
   * with payload `elisym:v1:<jobEventId>`. Off-chain indexers join the memo
   * back to the originating job for per-provider/per-capability analytics.
   * Memo is omitted when this option is absent; the protocol tag is still
   * attached either way.
   */
  jobEventId?: string;
}
