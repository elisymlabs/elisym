import type { Address, Rpc, SolanaRpcApi, TransactionSigner } from '@solana/kit';
import type {
  PaymentRequestData,
  PaymentValidationError,
  VerifyOptions,
  VerifyResult,
} from '../types';

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
 * In Phase 2 the SDK no longer reads PROTOCOL_FEE_BPS / PROTOCOL_TREASURY
 * from constants. Callers supply this config so they can either pass
 * the bundled fallbacks or, in Phase 3, values fetched from the on-chain
 * elisym-config program.
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

  /** Create a payment request with auto-calculated protocol fee. */
  createPaymentRequest(
    recipientAddress: string,
    amount: number,
    config: ProtocolConfigInput,
    options?: { expirySecs?: number },
  ): PaymentRequestData;

  /**
   * Validate that a payment request has the correct recipient and protocol fee.
   * Returns a typed validation error if invalid, null if OK.
   */
  validatePaymentRequest(
    requestJson: string,
    config: ProtocolConfigInput,
    expectedRecipient?: string,
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
