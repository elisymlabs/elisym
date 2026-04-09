import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { PROTOCOL_TREASURY, PROTOCOL_FEE_BPS, DEFAULTS, LIMITS } from '../constants';
import type {
  PaymentRequestData,
  VerifyResult,
  VerifyOptions,
  PaymentValidationError,
} from '../types';
import { calculateProtocolFee, validateExpiry, assertExpiry, assertLamports } from './fee';
import type { PaymentStrategy } from './strategy';

function isValidSolanaAddress(address: string): boolean {
  try {
    void new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export class SolanaPaymentStrategy implements PaymentStrategy {
  readonly chain = 'solana';

  calculateFee(amount: number): number {
    return calculateProtocolFee(amount);
  }

  createPaymentRequest(
    recipientAddress: string,
    amount: number,
    expirySecs: number = DEFAULTS.PAYMENT_EXPIRY_SECS,
  ): PaymentRequestData {
    try {
      void new PublicKey(recipientAddress);
    } catch {
      throw new Error(`Invalid Solana address: ${recipientAddress}`);
    }
    assertLamports(amount, 'payment amount');
    if (amount === 0) {
      throw new Error('Invalid payment amount: 0. Must be positive.');
    }
    if (!Number.isInteger(expirySecs) || expirySecs <= 0 || expirySecs > LIMITS.MAX_TIMEOUT_SECS) {
      throw new Error(
        `Invalid expiry: ${expirySecs}. Must be integer 1-${LIMITS.MAX_TIMEOUT_SECS}.`,
      );
    }
    const feeAmount = calculateProtocolFee(amount);
    const reference = Keypair.generate().publicKey.toBase58();

    return {
      recipient: recipientAddress,
      amount,
      reference,
      fee_address: PROTOCOL_TREASURY,
      fee_amount: feeAmount,
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: expirySecs,
    };
  }

  validatePaymentRequest(
    requestJson: string,
    expectedRecipient?: string,
  ): PaymentValidationError | null {
    let data: PaymentRequestData;
    try {
      data = JSON.parse(requestJson);
    } catch (e) {
      return { code: 'invalid_json', message: `Invalid payment request JSON: ${e}` };
    }

    if (typeof data.amount !== 'number' || !Number.isInteger(data.amount) || data.amount <= 0) {
      return {
        code: 'invalid_amount',
        message: `Invalid amount in payment request: ${data.amount}`,
      };
    }
    if (typeof data.recipient !== 'string' || !data.recipient) {
      return { code: 'missing_recipient', message: 'Missing recipient in payment request' };
    }
    if (!isValidSolanaAddress(data.recipient)) {
      return {
        code: 'invalid_recipient_address',
        message: `Invalid Solana address for recipient: ${data.recipient}`,
      };
    }
    if (typeof data.reference !== 'string' || !data.reference) {
      return { code: 'missing_reference', message: 'Missing reference in payment request' };
    }
    if (!isValidSolanaAddress(data.reference)) {
      return {
        code: 'invalid_reference_address',
        message: `Invalid Solana address for reference: ${data.reference}`,
      };
    }

    if (expectedRecipient && data.recipient !== expectedRecipient) {
      return {
        code: 'recipient_mismatch',
        message:
          `Recipient mismatch: expected ${expectedRecipient}, got ${data.recipient}. ` +
          `Provider may be attempting to redirect payment.`,
      };
    }

    const expiryError = validateExpiry(data.created_at, data.expiry_secs);
    if (expiryError) {
      const code = expiryError.includes('future')
        ? ('future_timestamp' as const)
        : ('expired' as const);
      return { code, message: expiryError };
    }

    const expectedFee = calculateProtocolFee(data.amount);

    const { fee_address, fee_amount } = data;
    const hasFeeAddress = typeof fee_address === 'string' && fee_address.length > 0;
    const hasFeeAmount = typeof fee_amount === 'number' && fee_amount > 0;

    // Branch 1: fee present and valid - verify address and amount
    if (hasFeeAddress && hasFeeAmount) {
      if (fee_address !== PROTOCOL_TREASURY) {
        return {
          code: 'fee_address_mismatch',
          message:
            `Fee address mismatch: expected ${PROTOCOL_TREASURY}, got ${fee_address}. ` +
            `Provider may be attempting to redirect fees.`,
        };
      }
      if (fee_amount !== expectedFee) {
        return {
          code: 'fee_amount_mismatch',
          message:
            `Fee amount mismatch: expected ${expectedFee} lamports ` +
            `(${PROTOCOL_FEE_BPS}bps of ${data.amount}), got ${fee_amount}. ` +
            `Provider may be tampering with fee.`,
        };
      }
      return null;
    }

    // Branch 2: fee entirely absent - reject
    if (!hasFeeAddress && (fee_amount === null || fee_amount === undefined || fee_amount === 0)) {
      return {
        code: 'missing_fee',
        message:
          `Payment request missing protocol fee (${PROTOCOL_FEE_BPS}bps). ` +
          `Expected fee: ${expectedFee} lamports to ${PROTOCOL_TREASURY}.`,
      };
    }

    // Branch 3: partial fee params (one present, other missing/zero) - reject
    return {
      code: 'invalid_fee_params',
      message:
        `Invalid fee params in payment request. ` +
        `Expected fee: ${expectedFee} lamports to ${PROTOCOL_TREASURY}.`,
    };
  }

  /**
   * Build an unsigned transaction from a payment request.
   * The caller must set `recentBlockhash` and `feePayer` on the
   * returned Transaction before signing and sending.
   */
  async buildTransaction(
    payerAddress: string,
    paymentRequest: PaymentRequestData,
  ): Promise<Transaction> {
    assertLamports(paymentRequest.amount, 'payment amount');
    if (paymentRequest.amount === 0) {
      throw new Error('Invalid payment amount: 0. Must be positive.');
    }
    if (
      paymentRequest.fee_amount !== null &&
      paymentRequest.fee_amount !== undefined &&
      (!Number.isInteger(paymentRequest.fee_amount) || paymentRequest.fee_amount < 0)
    ) {
      throw new Error(
        `Invalid fee amount: ${paymentRequest.fee_amount}. Must be a non-negative integer (lamports).`,
      );
    }
    assertExpiry(paymentRequest.created_at, paymentRequest.expiry_secs);

    if (paymentRequest.fee_address && paymentRequest.fee_address !== PROTOCOL_TREASURY) {
      throw new Error(
        `Invalid fee address: expected ${PROTOCOL_TREASURY}, got ${paymentRequest.fee_address}. ` +
          `Cannot build transaction with redirected fees.`,
      );
    }

    const payerPubkey = new PublicKey(payerAddress);
    const recipient = new PublicKey(paymentRequest.recipient);
    const reference = new PublicKey(paymentRequest.reference);
    const feeAddress = paymentRequest.fee_address
      ? new PublicKey(paymentRequest.fee_address)
      : null;
    const feeAmount = paymentRequest.fee_amount ?? 0;

    // Both amount and feeAmount are validated integers (lamports), so subtraction is exact.
    const providerAmount =
      feeAddress && feeAmount > 0 ? paymentRequest.amount - feeAmount : paymentRequest.amount;

    if (providerAmount <= 0) {
      throw new Error(
        `Fee amount (${feeAmount}) exceeds or equals total amount (${paymentRequest.amount}). Cannot create transaction with non-positive provider amount.`,
      );
    }

    // Provider transfer with reference key (for payment detection)
    const transferIx = SystemProgram.transfer({
      fromPubkey: payerPubkey,
      toPubkey: recipient,
      lamports: providerAmount,
    });
    // Append reference as read-only non-signer so provider can detect via getSignaturesForAddress
    transferIx.keys.push({
      pubkey: reference,
      isSigner: false,
      isWritable: false,
    });

    const tx = new Transaction().add(transferIx);

    // Fee transfer
    if (feeAddress && feeAmount > 0) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payerPubkey,
          toPubkey: feeAddress,
          lamports: feeAmount,
        }),
      );
    }

    return tx;
  }

  async verifyPayment(
    connection: unknown,
    paymentRequest: PaymentRequestData,
    options?: VerifyOptions,
  ): Promise<VerifyResult> {
    if (
      !connection ||
      typeof (connection as Record<string, unknown>).getTransaction !== 'function'
    ) {
      return { verified: false, error: 'Invalid connection: expected Solana Connection instance' };
    }
    const conn = connection as Connection;

    if (!paymentRequest.reference || !paymentRequest.recipient) {
      return { verified: false, error: 'Missing required fields in payment request' };
    }
    if (!Number.isInteger(paymentRequest.amount) || paymentRequest.amount <= 0) {
      return {
        verified: false,
        error: `Invalid payment amount: ${paymentRequest.amount}. Must be a positive integer.`,
      };
    }

    // No expiry check here - verification confirms on-chain payment regardless of timing.
    // Expiry is enforced before payment in validatePaymentRequest() and buildTransaction().

    if (
      paymentRequest.fee_amount !== null &&
      paymentRequest.fee_amount !== undefined &&
      (!Number.isInteger(paymentRequest.fee_amount) || paymentRequest.fee_amount < 0)
    ) {
      return {
        verified: false,
        error: `Invalid fee_amount: ${paymentRequest.fee_amount}. Must be a non-negative integer.`,
      };
    }

    const expectedFee = calculateProtocolFee(paymentRequest.amount);
    const feeAmount = paymentRequest.fee_amount ?? 0;

    if (expectedFee > 0) {
      if (feeAmount < expectedFee) {
        return {
          verified: false,
          error: `Protocol fee ${feeAmount} below required ${expectedFee} (${PROTOCOL_FEE_BPS}bps of ${paymentRequest.amount})`,
        };
      }
      if (!paymentRequest.fee_address) {
        return { verified: false, error: 'Missing fee address in payment request' };
      }
      if (paymentRequest.fee_address !== PROTOCOL_TREASURY) {
        return { verified: false, error: `Invalid fee address: ${paymentRequest.fee_address}` };
      }
    }

    // Both amount and feeAmount are validated integers (lamports), so subtraction is exact.
    const expectedNet = paymentRequest.amount - feeAmount;

    if (expectedNet <= 0) {
      return {
        verified: false,
        error: `Fee amount (${feeAmount}) exceeds or equals total amount (${paymentRequest.amount})`,
      };
    }

    // If tx signature provided, verify by signature
    if (options?.txSignature) {
      return this._verifyBySignature(
        conn,
        options.txSignature,
        paymentRequest.reference,
        paymentRequest.recipient,
        expectedNet,
        feeAmount,
        options?.retries ?? DEFAULTS.VERIFY_RETRIES,
        options?.intervalMs ?? DEFAULTS.VERIFY_INTERVAL_MS,
      );
    }

    // Otherwise verify by reference key
    return this._verifyByReference(
      conn,
      paymentRequest.reference,
      paymentRequest.recipient,
      expectedNet,
      feeAmount,
      options?.retries ?? DEFAULTS.VERIFY_BY_REF_RETRIES,
      options?.intervalMs ?? DEFAULTS.VERIFY_BY_REF_INTERVAL_MS,
    );
  }

  private async _verifyBySignature(
    connection: Connection,
    txSignature: string,
    referenceKey: string,
    recipientAddress: string,
    expectedNet: number,
    expectedFee: number,
    retries: number,
    intervalMs: number,
  ): Promise<VerifyResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const tx = await connection.getTransaction(txSignature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });

        if (!tx?.meta || tx.meta.err) {
          if (attempt < retries - 1) {
            await new Promise((r) => setTimeout(r, intervalMs));
            continue;
          }
          return {
            verified: false,
            error: tx?.meta?.err ? 'Transaction failed on-chain' : 'Transaction not found',
          };
        }

        const accountKeys = tx.transaction.message.getAccountKeys();
        const balanceCount = tx.meta.preBalances.length;
        // Map address -> original index to preserve balance array correspondence.
        const keyToIdx = new Map<string, number>();
        for (let i = 0; i < Math.min(accountKeys.length, balanceCount); i++) {
          const key = accountKeys.get(i);
          if (key) {
            keyToIdx.set(key.toBase58(), i);
          }
        }

        if (!keyToIdx.has(referenceKey)) {
          return {
            verified: false,
            error: 'Reference key not found in transaction - possible replay',
          };
        }

        const recipientIdx = keyToIdx.get(recipientAddress);
        if (recipientIdx === undefined) {
          return { verified: false, error: 'Recipient not found in transaction' };
        }

        const recipientDelta =
          (tx.meta.postBalances[recipientIdx] ?? 0) - (tx.meta.preBalances[recipientIdx] ?? 0);
        if (recipientDelta < expectedNet) {
          return {
            verified: false,
            error: `Recipient received ${recipientDelta}, expected >= ${expectedNet}`,
          };
        }

        if (expectedFee > 0) {
          const treasuryIdx = keyToIdx.get(PROTOCOL_TREASURY);
          if (treasuryIdx === undefined) {
            return { verified: false, error: 'Treasury not found in transaction' };
          }
          const treasuryDelta =
            (tx.meta.postBalances[treasuryIdx] ?? 0) - (tx.meta.preBalances[treasuryIdx] ?? 0);
          if (treasuryDelta < expectedFee) {
            return {
              verified: false,
              error: `Treasury received ${treasuryDelta}, expected >= ${expectedFee}`,
            };
          }
        }

        return { verified: true, txSignature };
      } catch (err) {
        lastError = err;
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, intervalMs));
        }
      }
    }
    return {
      verified: false,
      error: `Verification failed after ${retries} retries: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
    };
  }

  private async _verifyByReference(
    connection: Connection,
    referenceKey: string,
    recipientAddress: string,
    expectedNet: number,
    expectedFee: number,
    retries: number,
    intervalMs: number,
  ): Promise<VerifyResult> {
    const reference = new PublicKey(referenceKey);
    let lastError: unknown;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const signatures = await connection.getSignaturesForAddress(reference, {
          limit: DEFAULTS.VERIFY_SIGNATURE_LIMIT,
        });
        const validSigs = signatures.filter((s) => !s.err);

        if (validSigs.length > 0) {
          const txResults = await Promise.all(
            validSigs.map((s) =>
              connection
                .getTransaction(s.signature, {
                  maxSupportedTransactionVersion: 0,
                  commitment: 'confirmed',
                })
                .then((tx) => ({ sig: s.signature, tx }))
                .catch(() => ({
                  sig: s.signature,
                  tx: null as Awaited<ReturnType<Connection['getTransaction']>>,
                })),
            ),
          );

          for (const { sig, tx } of txResults) {
            if (!tx?.meta || tx.meta.err) {
              continue;
            }

            const accountKeys = tx.transaction.message.getAccountKeys();
            const balanceCount = tx.meta.preBalances.length;
            // Map address -> original index to preserve balance array correspondence.
            const keyToIdx = new Map<string, number>();
            for (let i = 0; i < Math.min(accountKeys.length, balanceCount); i++) {
              const key = accountKeys.get(i);
              if (key) {
                keyToIdx.set(key.toBase58(), i);
              }
            }

            const recipientIdx = keyToIdx.get(recipientAddress);
            if (recipientIdx === undefined) {
              continue;
            }

            const recipientDelta =
              (tx.meta.postBalances[recipientIdx] ?? 0) - (tx.meta.preBalances[recipientIdx] ?? 0);
            if (recipientDelta < expectedNet) {
              continue;
            }

            if (expectedFee > 0) {
              const treasuryIdx = keyToIdx.get(PROTOCOL_TREASURY);
              if (treasuryIdx === undefined) {
                continue;
              }
              const treasuryDelta =
                (tx.meta.postBalances[treasuryIdx] ?? 0) - (tx.meta.preBalances[treasuryIdx] ?? 0);
              if (treasuryDelta < expectedFee) {
                continue;
              }
            }

            return { verified: true, txSignature: sig };
          }
        }
      } catch (err) {
        lastError = err;
      }

      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
    return {
      verified: false,
      error: lastError
        ? `Verification failed: ${lastError instanceof Error ? lastError.message : 'unknown error'}`
        : 'No matching transaction found for reference key',
    };
  }
}
