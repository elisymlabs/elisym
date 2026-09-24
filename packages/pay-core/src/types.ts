/**
 * The types a payment is described in.
 *
 * They live here rather than in the SDK because they are what a payer, a
 * verifier and a merchant all speak: the SDK re-exports them unchanged, so
 * nothing that imported them from `@elisym/sdk` has to move.
 */

export type Network = 'mainnet' | 'devnet';

/**
 * Wire-shape reference to an asset inside a payment request.
 *
 * Same shape as `Asset` minus the display-only `symbol` field. Absent = native
 * SOL (back-compat for payment requests published before multi-asset support).
 */
export interface PaymentAssetRef {
  chain: string;
  token: string;
  mint?: string;
  decimals: number;
}

export interface PaymentRequestData {
  recipient: string;
  /**
   * Total amount in subunits of the payment asset (must be positive integer).
   *
   * - For native SOL (asset absent / `token: 'sol'`): lamports (1e-9 SOL).
   * - For SPL USDC: 1e-6 USDC.
   */
  amount: number;
  reference: string;
  description?: string;
  fee_address?: string;
  fee_amount?: number;
  /** Creation timestamp (Unix seconds). */
  created_at: number;
  /** Expiry duration in seconds. */
  expiry_secs: number;
  /** Optional asset identifier. Absent => native SOL (back-compat). */
  asset?: PaymentAssetRef;
  /**
   * Solana network the request settles on. Always written by the SDK's
   * request-creation API; optional on the parse side - absent means devnet
   * (requests from pre-mainnet providers). `validatePaymentRequest` rejects a
   * request whose network differs from the customer's.
   */
  network?: Network;
}

/**
 * Outcome of a stateless on-chain payment verification - `verified: true` means
 * a transaction targeted this request and moved at least the expected amounts,
 * NOT that it is exclusive to this request. See `PaymentStrategy.verifyPayment`.
 */
export interface VerifyResult {
  verified: boolean;
  /**
   * The settlement signature that satisfied the request - the value a provider
   * de-duplicates on. Present on every success; absent on failure.
   */
  txSignature?: string;
  /**
   * Set only for refusals a caller can do something about. Absent does not mean
   * "verified": read `verified`, and treat `error` as the human-readable half.
   */
  code?: VerifyRefusalCode;
  error?: string;
}

export interface PaymentValidationError {
  code: PaymentValidationCode;
  message: string;
}

/**
 * Why a verification refused, where the caller can act on the answer.
 *
 * THIS LIST GROWS IN MINOR RELEASES. Do not write an exhaustive `switch` with
 * a `never` branch over it - match the members you handle and let the rest fall
 * through to whatever you do with `error`.
 */
export type VerifyRefusalCode = 'degenerate_reference';

export interface VerifyOptions {
  retries?: number;
  intervalMs?: number;
  txSignature?: string;
}

/**
 * Why a payment request was refused.
 *
 * THIS LIST GROWS IN MINOR RELEASES. Do not write an exhaustive `switch` with
 * a `never` branch over it - match the members you handle and show `message`
 * for the rest. No caller in this repository reads the code at all today; they
 * all relay `message`.
 */
export type PaymentValidationCode =
  | 'invalid_json'
  | 'invalid_amount'
  | 'missing_recipient'
  | 'invalid_recipient_address'
  | 'missing_reference'
  | 'invalid_reference_address'
  | 'recipient_mismatch'
  | 'network_mismatch'
  | 'expired'
  | 'future_timestamp'
  | 'fee_address_mismatch'
  | 'fee_amount_mismatch'
  | 'missing_fee'
  | 'invalid_fee_params'
  | 'invalid_asset'
  | 'asset_mismatch'
  | 'degenerate_reference'
  | 'unsupported_version'
  | 'unsupported_chain'
  | 'chain_mismatch'
  /** The request pays the customer's own address, which settles nothing. */
  | 'self_payment'
  /**
   * The CALLER's own bounds are unusable - a clock that is not a number, a fee
   * rate that is not a rate, an address that is not a string, a price that is
   * not a number of subunits. Not a statement about the request: nothing about
   * it was judged, because there was nothing to judge it against.
   */
  | 'invalid_bounds';
