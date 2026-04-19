import { getTransferSolInstruction } from '@solana-program/system';
import {
  type Address,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getAddressDecoder,
  isAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getProtocolConfig } from '../config/onchain';
import { DEFAULTS, LIMITS } from '../constants';
import type {
  PaymentRequestData,
  PaymentValidationError,
  VerifyOptions,
  VerifyResult,
} from '../types';
import { assertExpiry, assertLamports, calculateProtocolFee, validateExpiry } from './fee';
import type { PaymentStrategy, ProtocolConfigInput, Signer } from './strategy';

const REFERENCE_BYTE_LENGTH = 32;

function isValidSolanaAddress(value: string): boolean {
  return isAddress(value);
}

function generateReference(): string {
  const bytes = new Uint8Array(REFERENCE_BYTE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  return getAddressDecoder().decode(bytes);
}

function assertReference(reference: string): void {
  if (!isValidSolanaAddress(reference)) {
    throw new Error(`Invalid reference address: ${reference}`);
  }
}

function assertExpirySecs(expirySecs: number): void {
  if (!Number.isInteger(expirySecs) || expirySecs <= 0 || expirySecs > LIMITS.MAX_TIMEOUT_SECS) {
    throw new Error(`Invalid expiry: ${expirySecs}. Must be integer 1-${LIMITS.MAX_TIMEOUT_SECS}.`);
  }
}

function assertConfig(config: ProtocolConfigInput): void {
  if (!Number.isInteger(config.feeBps) || config.feeBps < 0) {
    throw new Error(`Invalid feeBps: ${config.feeBps}. Must be a non-negative integer.`);
  }
  if (typeof config.treasury !== 'string' || !isValidSolanaAddress(config.treasury)) {
    throw new Error(`Invalid treasury address: ${String(config.treasury)}`);
  }
}

export class SolanaPaymentStrategy implements PaymentStrategy {
  readonly chain = 'solana';

  calculateFee(amount: number, config: ProtocolConfigInput): number {
    assertConfig(config);
    return calculateProtocolFee(amount, config.feeBps);
  }

  createPaymentRequest(
    recipientAddress: string,
    amount: number,
    config: ProtocolConfigInput,
    options?: { expirySecs?: number },
  ): PaymentRequestData {
    assertConfig(config);
    if (!isValidSolanaAddress(recipientAddress)) {
      throw new Error(`Invalid Solana address: ${recipientAddress}`);
    }
    assertLamports(amount, 'payment amount');
    if (amount === 0) {
      throw new Error('Invalid payment amount: 0. Must be positive.');
    }
    const expirySecs = options?.expirySecs ?? DEFAULTS.PAYMENT_EXPIRY_SECS;
    assertExpirySecs(expirySecs);

    const feeAmount = calculateProtocolFee(amount, config.feeBps);
    const reference = generateReference();

    return {
      recipient: recipientAddress,
      amount,
      reference,
      fee_address: config.treasury,
      fee_amount: feeAmount,
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: expirySecs,
    };
  }

  validatePaymentRequest(
    requestJson: string,
    config: ProtocolConfigInput,
    expectedRecipient?: string,
  ): PaymentValidationError | null {
    assertConfig(config);
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

    const expectedFee = calculateProtocolFee(data.amount, config.feeBps);
    const treasury = config.treasury;

    // feeBps=0 is a legal on-chain state (set_fee_bps only enforces <= MAX_FEE_BPS).
    // createPaymentRequest still populates fee_address=treasury and fee_amount=0 in
    // that case, which does not match either of the hasFee branches below. Mirror the
    // `expectedFee > 0` guard in verifyPayment so both code paths agree.
    if (expectedFee === 0) {
      return null;
    }

    const { fee_address, fee_amount } = data;
    const hasFeeAddress = typeof fee_address === 'string' && fee_address.length > 0;
    const hasFeeAmount = typeof fee_amount === 'number' && fee_amount > 0;

    if (hasFeeAddress && hasFeeAmount) {
      if (fee_address !== treasury) {
        return {
          code: 'fee_address_mismatch',
          message:
            `Fee address mismatch: expected ${treasury}, got ${fee_address}. ` +
            `Provider may be attempting to redirect fees.`,
        };
      }
      if (fee_amount !== expectedFee) {
        return {
          code: 'fee_amount_mismatch',
          message:
            `Fee amount mismatch: expected ${expectedFee} lamports ` +
            `(${config.feeBps}bps of ${data.amount}), got ${fee_amount}. ` +
            `Provider may be tampering with fee.`,
        };
      }
      return null;
    }

    if (!hasFeeAddress && (fee_amount === null || fee_amount === undefined || fee_amount === 0)) {
      return {
        code: 'missing_fee',
        message:
          `Payment request missing protocol fee (${config.feeBps}bps). ` +
          `Expected fee: ${expectedFee} lamports to ${treasury}.`,
      };
    }

    return {
      code: 'invalid_fee_params',
      message:
        `Invalid fee params in payment request. ` +
        `Expected fee: ${expectedFee} lamports to ${treasury}.`,
    };
  }

  /**
   * Build, sign, and return a transaction for the supplied payment request.
   * The caller is responsible for sending it (e.g. via `rpc.sendTransaction`).
   *
   * The provider transfer instruction includes the payment reference as a
   * read-only, non-signer account so providers can detect the payment via
   * `getSignaturesForAddress(reference)`.
   */
  async buildTransaction(
    paymentRequest: PaymentRequestData,
    payerSigner: Signer,
    rpc: Rpc<SolanaRpcApi>,
    config: ProtocolConfigInput,
  ): Promise<Readonly<unknown>> {
    assertConfig(config);
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
    assertReference(paymentRequest.reference);
    assertExpiry(paymentRequest.created_at, paymentRequest.expiry_secs);

    const treasury = config.treasury;
    if (paymentRequest.fee_address && paymentRequest.fee_address !== treasury) {
      throw new Error(
        `Invalid fee address: expected ${treasury}, got ${paymentRequest.fee_address}. ` +
          `Cannot build transaction with redirected fees.`,
      );
    }

    const instructions = buildPaymentInstructions(paymentRequest, payerSigner);

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payerSigner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) =>
        appendTransactionMessageInstructions(
          instructions as Parameters<typeof appendTransactionMessageInstructions>[0],
          m,
        ),
    );

    return signTransactionMessageWithSigners(message);
  }

  async verifyPayment(
    rpc: Rpc<SolanaRpcApi>,
    paymentRequest: PaymentRequestData,
    config: ProtocolConfigInput,
    options?: VerifyOptions,
  ): Promise<VerifyResult> {
    assertConfig(config);
    if (!rpc || typeof (rpc as { getTransaction?: unknown }).getTransaction !== 'function') {
      return { verified: false, error: 'Invalid rpc: expected Solana Kit Rpc instance' };
    }

    if (!paymentRequest.reference || !paymentRequest.recipient) {
      return { verified: false, error: 'Missing required fields in payment request' };
    }
    if (!Number.isInteger(paymentRequest.amount) || paymentRequest.amount <= 0) {
      return {
        verified: false,
        error: `Invalid payment amount: ${paymentRequest.amount}. Must be a positive integer.`,
      };
    }

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

    const expectedFee = calculateProtocolFee(paymentRequest.amount, config.feeBps);
    const feeAmount = paymentRequest.fee_amount ?? 0;
    const treasury = config.treasury;

    if (expectedFee > 0) {
      if (feeAmount < expectedFee) {
        return {
          verified: false,
          error: `Protocol fee ${feeAmount} below required ${expectedFee} (${config.feeBps}bps of ${paymentRequest.amount})`,
        };
      }
      if (!paymentRequest.fee_address) {
        return { verified: false, error: 'Missing fee address in payment request' };
      }
      if (paymentRequest.fee_address !== treasury) {
        return { verified: false, error: `Invalid fee address: ${paymentRequest.fee_address}` };
      }
    }

    const expectedNet = paymentRequest.amount - feeAmount;
    if (expectedNet <= 0) {
      return {
        verified: false,
        error: `Fee amount (${feeAmount}) exceeds or equals total amount (${paymentRequest.amount})`,
      };
    }

    if (options?.txSignature) {
      return this._verifyBySignature(
        rpc,
        options.txSignature as Signature,
        paymentRequest.reference,
        paymentRequest.recipient,
        treasury,
        expectedNet,
        feeAmount,
        options?.retries ?? DEFAULTS.VERIFY_RETRIES,
        options?.intervalMs ?? DEFAULTS.VERIFY_INTERVAL_MS,
      );
    }

    return this._verifyByReference(
      rpc,
      paymentRequest.reference,
      paymentRequest.recipient,
      treasury,
      expectedNet,
      feeAmount,
      options?.retries ?? DEFAULTS.VERIFY_BY_REF_RETRIES,
      options?.intervalMs ?? DEFAULTS.VERIFY_BY_REF_INTERVAL_MS,
    );
  }

  private async _verifyBySignature(
    rpc: Rpc<SolanaRpcApi>,
    txSignature: Signature,
    referenceKey: string,
    recipientAddress: string,
    treasuryAddress: string,
    expectedNet: number,
    expectedFee: number,
    retries: number,
    intervalMs: number,
  ): Promise<VerifyResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const tx = await rpc
          .getTransaction(txSignature, {
            commitment: 'confirmed',
            encoding: 'json',
            maxSupportedTransactionVersion: 0,
          })
          .send();

        if (!tx?.meta || tx.meta.err) {
          if (attempt < retries - 1) {
            await waitMs(intervalMs);
            continue;
          }
          return {
            verified: false,
            error: tx?.meta?.err ? 'Transaction failed on-chain' : 'Transaction not found',
          };
        }

        const verdict = checkBalanceDiff({
          accountKeys: tx.transaction.message.accountKeys as readonly string[],
          preBalances: tx.meta.preBalances as readonly bigint[],
          postBalances: tx.meta.postBalances as readonly bigint[],
          referenceKey,
          recipientAddress,
          treasuryAddress,
          expectedNet,
          expectedFee,
        });
        if (verdict.ok) {
          return { verified: true, txSignature: txSignature as string };
        }
        return { verified: false, error: verdict.reason };
      } catch (err) {
        lastError = err;
        if (attempt < retries - 1) {
          await waitMs(intervalMs);
        }
      }
    }
    return {
      verified: false,
      error: `Verification failed after ${retries} retries: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
    };
  }

  private async _verifyByReference(
    rpc: Rpc<SolanaRpcApi>,
    referenceKey: string,
    recipientAddress: string,
    treasuryAddress: string,
    expectedNet: number,
    expectedFee: number,
    retries: number,
    intervalMs: number,
  ): Promise<VerifyResult> {
    let lastError: unknown;
    const reference = address(referenceKey);

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const signatures = await rpc
          .getSignaturesForAddress(reference, {
            limit: DEFAULTS.VERIFY_SIGNATURE_LIMIT,
          })
          .send();
        const validSigs = signatures.filter((entry) => !entry.err);

        if (validSigs.length > 0) {
          const fetchTransaction = (sig: Signature) =>
            rpc
              .getTransaction(sig, {
                commitment: 'confirmed',
                encoding: 'json',
                maxSupportedTransactionVersion: 0,
              })
              .send();
          type TransactionResult = Awaited<ReturnType<typeof fetchTransaction>>;
          const txResults = await Promise.all(
            validSigs.map((entry) =>
              fetchTransaction(entry.signature)
                .then((tx) => ({ sig: entry.signature, tx }))
                .catch(() => ({ sig: entry.signature, tx: null as TransactionResult })),
            ),
          );

          for (const { sig, tx } of txResults) {
            if (!tx?.meta || tx.meta.err) {
              continue;
            }
            const verdict = checkBalanceDiff({
              accountKeys: tx.transaction.message.accountKeys as readonly string[],
              preBalances: tx.meta.preBalances as readonly bigint[],
              postBalances: tx.meta.postBalances as readonly bigint[],
              referenceKey,
              recipientAddress,
              treasuryAddress,
              expectedNet,
              expectedFee,
            });
            if (verdict.ok) {
              return { verified: true, txSignature: sig as string };
            }
          }
        }
      } catch (err) {
        lastError = err;
      }

      if (attempt < retries - 1) {
        await waitMs(intervalMs);
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

interface BalanceDiffInput {
  accountKeys: readonly string[];
  preBalances: readonly bigint[];
  postBalances: readonly bigint[];
  referenceKey: string;
  recipientAddress: string;
  treasuryAddress: string;
  expectedNet: number;
  expectedFee: number;
}

type BalanceVerdict = { ok: true } | { ok: false; reason: string };

function checkBalanceDiff(input: BalanceDiffInput): BalanceVerdict {
  const balanceCount = input.preBalances.length;
  const keyToIdx = new Map<string, number>();
  for (let i = 0; i < Math.min(input.accountKeys.length, balanceCount); i++) {
    const key = input.accountKeys[i];
    if (key) {
      keyToIdx.set(String(key), i);
    }
  }

  if (!keyToIdx.has(input.referenceKey)) {
    return { ok: false, reason: 'Reference key not found in transaction - possible replay' };
  }
  const recipientIdx = keyToIdx.get(input.recipientAddress);
  if (recipientIdx === undefined) {
    return { ok: false, reason: 'Recipient not found in transaction' };
  }
  const recipientDelta = bigIntDelta(
    input.postBalances[recipientIdx],
    input.preBalances[recipientIdx],
  );
  if (recipientDelta < BigInt(input.expectedNet)) {
    return {
      ok: false,
      reason: `Recipient received ${recipientDelta.toString()}, expected >= ${input.expectedNet}`,
    };
  }

  if (input.expectedFee > 0) {
    const treasuryIdx = keyToIdx.get(input.treasuryAddress);
    if (treasuryIdx === undefined) {
      return { ok: false, reason: 'Treasury not found in transaction' };
    }
    const treasuryDelta = bigIntDelta(
      input.postBalances[treasuryIdx],
      input.preBalances[treasuryIdx],
    );
    if (treasuryDelta < BigInt(input.expectedFee)) {
      return {
        ok: false,
        reason: `Treasury received ${treasuryDelta.toString()}, expected >= ${input.expectedFee}`,
      };
    }
  }
  return { ok: true };
}

function bigIntDelta(post: bigint | undefined, pre: bigint | undefined): bigint {
  const postValue = post === undefined ? 0n : BigInt(post);
  const preValue = pre === undefined ? 0n : BigInt(pre);
  return postValue - preValue;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the System program transfer instructions for a payment request.
 *
 * Returns the provider-amount transfer (with the payment reference attached
 * as a read-only, non-signer account) and, if present, the protocol-fee
 * transfer. Exposed so callers and tests can inspect amounts before signing.
 *
 * Caller is responsible for validating `paymentRequest` upstream;
 * `buildTransaction` already does that before invoking this helper.
 */
export function buildPaymentInstructions(
  paymentRequest: PaymentRequestData,
  payerSigner: Signer,
): readonly unknown[] {
  const recipient = address(paymentRequest.recipient);
  const reference = address(paymentRequest.reference);
  const feeAmount = paymentRequest.fee_amount ?? 0;
  const providerAmount =
    paymentRequest.fee_address && feeAmount > 0
      ? paymentRequest.amount - feeAmount
      : paymentRequest.amount;

  if (providerAmount <= 0) {
    throw new Error(
      `Fee amount (${feeAmount}) exceeds or equals total amount (${paymentRequest.amount}). Cannot create transaction with non-positive provider amount.`,
    );
  }

  const providerTransferIx = getTransferSolInstruction({
    source: payerSigner,
    destination: recipient,
    amount: BigInt(providerAmount),
  });
  const providerTransferIxWithReference = {
    ...providerTransferIx,
    accounts: [...providerTransferIx.accounts, { address: reference, role: AccountRole.READONLY }],
  };

  const instructions: unknown[] = [providerTransferIxWithReference];
  if (paymentRequest.fee_address && feeAmount > 0) {
    instructions.push(
      getTransferSolInstruction({
        source: payerSigner,
        destination: address(paymentRequest.fee_address),
        amount: BigInt(feeAmount),
      }),
    );
  }
  return instructions;
}

/**
 * Convenience wrapper: fetch the on-chain protocol config first, then build a
 * payment request using its current fee/treasury values.
 *
 * Suitable for callers that want to "do the right thing" without managing the
 * config cache or the SolanaPaymentStrategy instance themselves. Uses the same
 * cache as `getProtocolConfig`, so back-to-back calls within the TTL only hit
 * RPC once.
 */
export async function createPaymentRequestWithOnchainConfig(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  recipient: string,
  amount: number,
  options?: { expirySecs?: number },
): Promise<PaymentRequestData> {
  const config = await getProtocolConfig(rpc, programId);
  const strategy = new SolanaPaymentStrategy();
  return strategy.createPaymentRequest(
    recipient,
    amount,
    { feeBps: config.feeBps, treasury: config.treasury },
    options,
  );
}
