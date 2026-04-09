import type {
  PaymentRequestData,
  VerifyResult,
  VerifyOptions,
  PaymentValidationError,
} from '../types';

/**
 * Pluggable payment strategy interface.
 * Implement this for each payment chain (Solana, Lightning, Cashu, EVM).
 */
export interface PaymentStrategy {
  readonly chain: string;

  /** Calculate protocol fee using basis-point math. */
  calculateFee(amount: number): number;

  /** Create a payment request with auto-calculated protocol fee. */
  createPaymentRequest(
    recipientAddress: string,
    amount: number,
    expirySecs?: number,
  ): PaymentRequestData;

  /**
   * Validate that a payment request has the correct recipient and protocol fee.
   * Returns a typed validation error if invalid, null if OK.
   */
  validatePaymentRequest(
    requestJson: string,
    expectedRecipient?: string,
  ): PaymentValidationError | null;

  /**
   * Build an unsigned transaction from a payment request.
   * Returns chain-specific transaction type. The caller is responsible for signing and sending.
   * @example For Solana: `const tx = await strategy.buildTransaction(...) as Transaction;`
   */
  buildTransaction(payerAddress: string, paymentRequest: PaymentRequestData): Promise<unknown>;

  /**
   * Verify a payment on-chain.
   * @param connection Chain-specific connection (e.g. Solana `Connection`).
   */
  verifyPayment(
    connection: unknown,
    paymentRequest: PaymentRequestData,
    options?: VerifyOptions,
  ): Promise<VerifyResult>;
}
