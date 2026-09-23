import {
  NATIVE_ASSET_SENTINEL,
  deriveAssetStatsAddress,
  deriveEventAuthorityAddress,
  deriveNetworkStatsAddress,
  getIncrementStatsV2Instruction,
} from '@elisym/config-client';
import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
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
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getProtocolConfig } from '../config/onchain';
import { PAYMENT_DEFAULTS, ELISYM_PROTOCOL_TAG, PAYMENT_LIMITS } from '../constants';
import type {
  Network,
  PaymentAssetRef,
  PaymentRequestData,
  PaymentValidationError,
  VerifyOptions,
  VerifyResult,
} from '../types';
import type { LoadedAddresses } from './account-keys';
import { mergeAccountKeys } from './account-keys';
import {
  type Asset,
  NATIVE_SOL,
  assetKey,
  resolveAssetFromPaymentRequest,
  splAssetsForNetwork,
} from './assets';
import { degenerateReference, degenerateReferenceSync } from './degenerate-reference';
import { assertExpiry, assertLamports, calculateProtocolFee, validateExpiry } from './fee';
import { estimatePriorityFeeMicroLamports } from './priorityFee';
import { isReadableTokenRow, readBalance } from './read-balance';
import { parsePaymentRequest } from './schema';
import type {
  BuildTransactionOptions,
  PaymentStrategy,
  ProtocolConfigInput,
  Signer,
} from './strategy';

const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;
const DEFAULT_PRIORITY_FEE_PERCENTILE = 75;

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
  if (
    !Number.isInteger(expirySecs) ||
    expirySecs <= 0 ||
    expirySecs > PAYMENT_LIMITS.MAX_TIMEOUT_SECS
  ) {
    throw new Error(
      `Invalid expiry: ${expirySecs}. Must be integer 1-${PAYMENT_LIMITS.MAX_TIMEOUT_SECS}.`,
    );
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
    network: Network,
    options?: { expirySecs?: number; asset?: Asset },
  ): PaymentRequestData {
    assertConfig(config);
    if (!isValidSolanaAddress(recipientAddress)) {
      throw new Error(`Invalid Solana address: ${recipientAddress}`);
    }
    assertLamports(amount, 'payment amount');
    if (amount === 0) {
      throw new Error('Invalid payment amount: 0. Must be positive.');
    }
    const expirySecs = options?.expirySecs ?? PAYMENT_DEFAULTS.PAYMENT_EXPIRY_SECS;
    assertExpirySecs(expirySecs);

    const feeAmount = calculateProtocolFee(amount, config.feeBps);
    const reference = generateReference();
    const assetRef: PaymentAssetRef | undefined =
      options?.asset && options.asset !== NATIVE_SOL
        ? {
            chain: options.asset.chain,
            token: options.asset.token,
            mint: options.asset.mint,
            decimals: options.asset.decimals,
          }
        : undefined;

    return {
      recipient: recipientAddress,
      amount,
      reference,
      fee_address: config.treasury,
      fee_amount: feeAmount,
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: expirySecs,
      ...(assetRef ? { asset: assetRef } : {}),
      network,
    };
  }

  validatePaymentRequest(
    requestJson: string,
    config: ProtocolConfigInput,
    network: Network,
    expectedRecipient?: string,
    options?: { maxAmountLamports?: bigint; expectedAsset?: Asset },
  ): PaymentValidationError | null {
    assertConfig(config);
    const parsed = parsePaymentRequest(requestJson, {
      maxAmountLamports: options?.maxAmountLamports,
    });
    if (!parsed.ok) {
      if (parsed.error.code === 'invalid_json') {
        return { code: 'invalid_json', message: parsed.error.message };
      }
      if (parsed.error.code === 'amount_exceeds_max') {
        return { code: 'invalid_amount', message: parsed.error.message };
      }
      // Schema-level rejections collapse into invalid_amount/recipient/etc
      // but the precise field is preserved in the message.
      return { code: 'invalid_amount', message: parsed.error.message };
    }
    const data: PaymentRequestData = parsed.data;

    // Network gate FIRST, before any money check: a request settling on the
    // other cluster must never proceed to fee/recipient validation, and a
    // missing network means a pre-mainnet (devnet) provider (D7).
    const requestNetwork = data.network ?? 'devnet';
    if (requestNetwork !== network) {
      return {
        code: 'network_mismatch',
        message:
          `Network mismatch: this customer is on ${network}, but the payment request ` +
          `settles on ${requestNetwork}. Cross-network payments are not possible.`,
      };
    }

    // Reject payment requests that reference an asset the SDK doesn't know
    // about - the customer cannot safely build a transaction without knowing
    // the wire format (System transfer vs SPL TransferChecked).
    let requestAsset: Asset;
    try {
      requestAsset = resolveAssetFromPaymentRequest(data);
    } catch (error) {
      return {
        code: 'invalid_asset',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // Per-network membership. `resolveKnownAsset` is network-blind, so an asset
    // that exists only on the other cluster (the other network's USDC, or a
    // mainnet-only asset quoted to a devnet customer) resolves fine above and
    // would only fail in on-chain simulation - after the customer signed.
    if (
      requestAsset.mint !== undefined &&
      !splAssetsForNetwork(network).some((asset) => asset.mint === requestAsset.mint)
    ) {
      return {
        code: 'invalid_asset',
        message:
          `Asset ${requestAsset.symbol} (mint ${requestAsset.mint}) is not available on ` +
          `${network}. Refusing to proceed.`,
      };
    }

    // Currency bait-and-switch. The membership gate alone cannot catch this:
    // USDC and LSM are both legal on mainnet and both carry 6 decimals, so a
    // request that swaps one for the other passes every check above while
    // debiting a different currency for the same number. Callers that know
    // which asset they agreed to pay pass it here.
    const expectedAsset = options?.expectedAsset;
    if (expectedAsset && assetKey(requestAsset) !== assetKey(expectedAsset)) {
      return {
        code: 'asset_mismatch',
        message:
          `Asset mismatch: expected to pay ${expectedAsset.symbol}, but the payment request ` +
          `debits ${requestAsset.symbol}. Provider may be attempting a currency swap.`,
      };
    }

    // Defense in depth: the Zod schema only enforces base58 + length, not
    // the canonical 32-byte ed25519 check that `isAddress` performs.
    if (!isValidSolanaAddress(data.recipient)) {
      return {
        code: 'invalid_recipient_address',
        message: `Invalid Solana address for recipient: ${data.recipient}`,
      };
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

    // Ahead of the fee codes on purpose, and the trade is worth naming: those
    // are about diverting part of the customer's payment, and this preempts
    // them. A degenerate reference harms both sides and costs the customer the
    // WHOLE payment - the transfer can no longer be picked out - so it is first.
    // `recipient_mismatch` still goes ahead of both.
    if (degenerateReferenceSync(data, network, treasury) !== undefined) {
      return {
        code: 'degenerate_reference',
        message:
          `Reference key ${data.reference} is an address this payment is computed from. ` +
          `Verification lists the reference's history to find the transfer, so a payment to ` +
          `this request cannot be found again once other traffic pushes it out of the ` +
          `window. Ask the provider for a payment request with a fresh reference.`,
      };
    }

    // feeBps=0 is a legal on-chain state (set_fee_bps only enforces <= MAX_FEE_BPS).
    // createPaymentRequest still populates fee_address=treasury and fee_amount=0 in
    // that case. Do NOT skip the fee fields entirely: a hostile request could carry
    // fee_amount > 0 to an arbitrary fee_address, and downstream instruction
    // builders add that transfer verbatim - a silent diversion of part of the
    // customer's payment.
    if (expectedFee === 0) {
      if (typeof data.fee_amount === 'number' && data.fee_amount > 0) {
        return {
          code: 'fee_amount_mismatch',
          message:
            `Fee amount mismatch: expected 0 (feeBps=0), got ${data.fee_amount}. ` +
            `Provider may be attempting to divert funds via the fee transfer.`,
        };
      }
      if (
        typeof data.fee_address === 'string' &&
        data.fee_address.length > 0 &&
        data.fee_address !== treasury
      ) {
        return {
          code: 'fee_address_mismatch',
          message:
            `Fee address mismatch: expected ${treasury}, got ${data.fee_address}. ` +
            `Provider may be attempting to redirect fees.`,
        };
      }
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
    options: BuildTransactionOptions,
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

    const computeUnitLimit = options.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
    if (!Number.isInteger(computeUnitLimit) || computeUnitLimit <= 0) {
      throw new Error(`Invalid computeUnitLimit: ${computeUnitLimit}. Must be a positive integer.`);
    }
    // Build payment instructions first - this surfaces shape errors (e.g. fee
    // >= amount) and, for SPL assets, derives the ATAs, before any RPC
    // round-trip that depends on them.
    const paymentInstructions = await buildPaymentInstructions(paymentRequest, payerSigner, {
      jobEventId: options.jobEventId,
      programId: options.programId,
      treasury,
    });

    const priorityFeeMicroLamports =
      options.priorityFeeMicroLamports ??
      (await estimatePriorityFeeMicroLamports(rpc, {
        network: options.network,
        percentile: options.priorityFeePercentile ?? DEFAULT_PRIORITY_FEE_PERCENTILE,
      }));

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payerSigner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => setTransactionMessageComputeUnitLimit(computeUnitLimit, m),
      (m) => setTransactionMessageComputeUnitPrice(priorityFeeMicroLamports, m),
      (m) =>
        appendTransactionMessageInstructions(
          paymentInstructions as Parameters<typeof appendTransactionMessageInstructions>[0],
          m,
        ),
    );

    return signTransactionMessageWithSigners(message);
  }

  /**
   * Verify a Solana payment - see `PaymentStrategy.verifyPayment` for the
   * stateless contract this implements and the caller's de-duplication duty.
   *
   * Concretely: a transaction satisfies a request when its account keys contain
   * the request's `reference` and the recipient's balance delta is `>= net`
   * (plus the treasury's `>= fee` when a fee applies).
   */
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

    let asset: Asset;
    try {
      asset = resolveAssetFromPaymentRequest(paymentRequest);
    } catch (error) {
      return {
        verified: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const mint = asset.mint;

    // After the asset resolves (the check compares the mint and its token
    // program, so it throws without one) and before either path runs. Each path
    // is ruined differently, which is why the check sits ahead of both rather
    // than inside one: the REFERENCE path lists the reference's history, and a
    // degenerate one lists a whole wallet instead of this payment; the
    // SIGNATURE path fetches one transaction and checks the reference is in it,
    // which a degenerate reference turns into a tautology - any transfer
    // crediting the recipient enough would pass.
    if (
      (await degenerateReference(paymentRequest, paymentRequest.network ?? 'devnet', treasury)) !==
      undefined
    ) {
      return {
        verified: false,
        code: 'degenerate_reference',
        error:
          `Reference key ${paymentRequest.reference} is an address this payment is computed ` +
          `from, so listing it cannot single out this transfer.`,
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
        mint,
        options?.retries ?? PAYMENT_DEFAULTS.VERIFY_RETRIES,
        options?.intervalMs ?? PAYMENT_DEFAULTS.VERIFY_INTERVAL_MS,
      );
    }

    return this._verifyByReference(
      rpc,
      paymentRequest.reference,
      paymentRequest.recipient,
      treasury,
      expectedNet,
      feeAmount,
      mint,
      options?.retries ?? PAYMENT_DEFAULTS.VERIFY_BY_REF_RETRIES,
      options?.intervalMs ?? PAYMENT_DEFAULTS.VERIFY_BY_REF_INTERVAL_MS,
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
    mint: string | undefined,
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

        const verdict = checkTxDiff({
          accountKeys: tx.transaction.message.accountKeys as readonly string[],
          loadedAddresses: tx.meta.loadedAddresses as LoadedAddresses | undefined,
          preBalances: tx.meta.preBalances as readonly bigint[],
          postBalances: tx.meta.postBalances as readonly bigint[],
          preTokenBalances: tx.meta.preTokenBalances as readonly TokenBalanceEntry[] | undefined,
          postTokenBalances: tx.meta.postTokenBalances as readonly TokenBalanceEntry[] | undefined,
          referenceKey,
          recipientAddress,
          treasuryAddress,
          expectedNet,
          expectedFee,
          mint,
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
    mint: string | undefined,
    retries: number,
    intervalMs: number,
  ): Promise<VerifyResult> {
    let lastError: unknown;
    const reference = address(referenceKey);

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const signatures = await rpc
          .getSignaturesForAddress(reference, {
            limit: PAYMENT_DEFAULTS.VERIFY_SIGNATURE_LIMIT,
          })
          .send();
        // NOT KILLED BY ANY VERDICT: drop this filter and a failed transaction
        // is still refused one screen below, by `tx.meta.err`. What it buys is
        // the round trip - one `getTransaction` per errored signature, against
        // a reference anyone can attach a failing transaction to - so that is
        // what the test asserts, rather than an outcome that does not move.
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
            const verdict = checkTxDiff({
              accountKeys: tx.transaction.message.accountKeys as readonly string[],
              loadedAddresses: tx.meta.loadedAddresses as LoadedAddresses | undefined,
              preBalances: tx.meta.preBalances as readonly bigint[],
              postBalances: tx.meta.postBalances as readonly bigint[],
              preTokenBalances: tx.meta.preTokenBalances as
                | readonly TokenBalanceEntry[]
                | undefined,
              postTokenBalances: tx.meta.postTokenBalances as
                | readonly TokenBalanceEntry[]
                | undefined,
              referenceKey,
              recipientAddress,
              treasuryAddress,
              expectedNet,
              expectedFee,
              mint,
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

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

interface TxDiffInput {
  accountKeys: readonly string[];
  /** Absent for a legacy transaction, and for a v0 one that used no table. */
  loadedAddresses?: LoadedAddresses;
  preBalances: readonly bigint[];
  postBalances: readonly bigint[];
  preTokenBalances?: readonly TokenBalanceEntry[];
  postTokenBalances?: readonly TokenBalanceEntry[];
  referenceKey: string;
  recipientAddress: string;
  treasuryAddress: string;
  expectedNet: number;
  expectedFee: number;
  /** SPL mint for token transfers. `undefined` => native SOL path. */
  mint?: string;
}

type BalanceVerdict = { ok: true } | { ok: false; reason: string };

function checkTxDiff(input: TxDiffInput): BalanceVerdict {
  // The two lamport arrays are indexed in lockstep - `pre[i]` and `post[i]` are
  // the same account - so a length mismatch means the pairing below cannot be
  // interpreted at all.
  //
  // THIS GUARD IS NOT COSMETIC, and it is not one-sided either. Both
  // directions were measured with it removed, and both ACCEPT a payment when
  // the slots that went missing are not ones the verifier happens to read:
  //
  //   pre=4 post=3, recipient and treasury still covered -> verified: true
  //   pre=4 post=5, reference inside the short prefix    -> verified: true
  //
  // `keyToIdx` is built over `min(keys.length, preBalances.length)`, so every
  // name inside that prefix pairs with a correct slot and nothing notices the
  // ones past it. The mismatches that do NOT slip through land as a refusal,
  // and there are three separate shapes of it, all measured: a reference past
  // the short prefix gives "Reference key not found - possible replay", while a
  // recipient or treasury slot past the end of a short `post` reads as
  // `undefined`, which `bigIntDelta` takes for `0n` and reports as "Recipient
  // received 0", "Recipient received -N" or "Treasury received 0". Every one of
  // those blames the customer for an answer WE could not read, and which one a
  // given page produces is a question of layout, not a safety property. So the
  // pairing is refused by name rather than read anyway.
  //
  // NATIVE ONLY, and that is the narrow half deliberately: the SPL path below
  // pairs accounts by owner and mint out of `pre/postTokenBalances` and opens
  // no lamport slot at all. A disagreement there cannot make a wrong slot read
  // as a payment - the worst it does is shorten the prefix `keyToIdx` is built
  // over, which loses the reference and REFUSES. Gating that path too would
  // refuse a USDC or LSM transfer the token balances prove, over an
  // inconsistency in arrays it never opens, and cost a paying customer their
  // delivery.
  // The containers first, because everything below indexes into them. An
  // array-like that is not an array - `{ length: 4 }`, a typed array - agrees
  // with itself on length, walks straight past the guard below, and hands back
  // `undefined` for every slot.
  if (!input.mint && (!Array.isArray(input.preBalances) || !Array.isArray(input.postBalances))) {
    return { ok: false, reason: 'Balance arrays are not arrays - cannot read a balance slot' };
  }
  if (!input.mint && input.preBalances.length !== input.postBalances.length) {
    return {
      ok: false,
      reason:
        `Balance arrays disagree on length (pre ${input.preBalances.length}, ` +
        `post ${input.postBalances.length}) - cannot pair an account with its balance`,
    };
  }
  const balanceCount = input.preBalances.length;
  // The LOOKED-UP addresses count as being in the transaction. Reading only
  // `accountKeys` means a v0 transaction that put the reference, the recipient
  // or the treasury in a lookup table - what a routing or swap-then-pay
  // composer builds - is rejected as "possible replay" though the customer
  // paid: fail-closed, and wrong. The concatenation order is the one the
  // balance arrays are indexed by, so the indices below stay aligned.
  const keys = mergeAccountKeys(input.accountKeys, input.loadedAddresses);
  const keyToIdx = new Map<string, number>();
  for (let i = 0; i < Math.min(keys.length, balanceCount); i++) {
    const key = keys[i];
    // The guard is load-bearing, and the reason is the one this file used to
    // get wrong: the addresses compared against this map have NOT all passed
    // `isAddress`. `verifyPayment` checks the request's `reference` and
    // `recipient` for PRESENCE only, at the top of the function - the format
    // checks live on the config treasury and, on the reference rail, on the
    // reference; the signature rail has none. `classifyRequestUsability` in `acceptor.ts`
    // says the same thing in the other direction.
    //
    // So a request whose reference is the four letters `null` reaches here
    // unscreened. Without the guard a null account key registers under exactly
    // that name, the presence check below - which is the whole of the
    // anti-replay on this rail - passes, and a stranger's transfer to the same
    // recipient for the same amount settles the job. Measured: the row named
    // `refuses a reference spelled the way a NULL account key stringifies`
    // answers `verified: true` with the guard dropped.
    if (key) {
      keyToIdx.set(String(key), i);
    }
  }

  if (!keyToIdx.has(input.referenceKey)) {
    return { ok: false, reason: 'Reference key not found in transaction - possible replay' };
  }

  if (input.mint) {
    return checkTokenBalanceDiff(input);
  }

  const recipientIdx = keyToIdx.get(input.recipientAddress);
  if (recipientIdx === undefined) {
    return { ok: false, reason: 'Recipient not found in transaction' };
  }
  const recipientDelta = bigIntDelta(
    input.postBalances[recipientIdx],
    input.preBalances[recipientIdx],
  );
  if (recipientDelta === null) {
    return { ok: false, reason: 'Recipient balance slot is unreadable' };
  }
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
    if (treasuryDelta === null) {
      return { ok: false, reason: 'Treasury balance slot is unreadable' };
    }
    if (treasuryDelta < BigInt(input.expectedFee)) {
      return {
        ok: false,
        reason: `Treasury received ${treasuryDelta.toString()}, expected >= ${input.expectedFee}`,
      };
    }
  }
  return { ok: true };
}

function checkTokenBalanceDiff(input: TxDiffInput): BalanceVerdict {
  const mint = input.mint;
  if (!mint) {
    return { ok: false, reason: 'Expected mint for SPL verification, got none' };
  }
  // ABSENT containers are empty ones - a native-only page carries none, and a
  // first-ever payment has no pre row because the token account is created
  // inside this transaction. A container or a row that is PRESENT and cannot
  // be read is a different thing, and the difference is money: matched by
  // owner and mint, an unreadable pre row is simply never found, the baseline
  // reads as absent, absent reads as zero, and whatever the recipient already
  // held verifies as this payment. Measured on a real mainnet transfer of 0.45
  // USDC against a price of 1.8 - refused from an honest node, verified with
  // the baseline row's `owner` removed. `quick-verify` had this rule and this
  // function did not.
  const preRaw: unknown = input.preTokenBalances ?? [];
  const postRaw: unknown = input.postTokenBalances ?? [];
  if (!Array.isArray(preRaw) || !Array.isArray(postRaw)) {
    return { ok: false, reason: 'Token balance lists are not lists - cannot read a baseline' };
  }
  if (!preRaw.every(isReadableTokenRow) || !postRaw.every(isReadableTokenRow)) {
    return {
      ok: false,
      reason: 'A token balance row is unreadable - cannot tell whose balance it is',
    };
  }
  const pre: readonly TokenBalanceEntry[] = preRaw;
  const post: readonly TokenBalanceEntry[] = postRaw;

  // `null` for "no account here", never a sentinel AMOUNT: `-1n` is also what a
  // token account that lost exactly one subunit between pre and post reports,
  // and reading that as a missing account sends the operator looking for an ATA
  // that exists while the real answer - the recipient was short-changed - never
  // reaches them. Both paths refuse the payment either way; only the sentence
  // the operator gets to act on differs.
  //
  // A THIRD answer beside those two, for the same reason: `'unreadable'` when
  // the row is there and its amount is not a number. `BigInt` takes `''` for
  // `0n` without complaint, so a blanked baseline used to read as zero here.
  const tokenDelta = (ownerAddress: string): bigint | null | 'unreadable' => {
    // Pre-entry may be absent when the ATA is created inside the same tx
    // (first-ever payment to this recipient). Missing => 0.
    const preEntry = pre.find((entry) => entry.owner === ownerAddress && entry.mint === mint);
    const postEntry = post.find((entry) => entry.owner === ownerAddress && entry.mint === mint);
    if (!postEntry) {
      return null;
    }
    const preAmount = preEntry ? readBalance(preEntry.uiTokenAmount?.amount) : 0n;
    const postAmount = readBalance(postEntry.uiTokenAmount?.amount);
    if (preAmount === null || postAmount === null) {
      return 'unreadable';
    }
    return postAmount - preAmount;
  };

  const recipientDelta = tokenDelta(input.recipientAddress);
  if (recipientDelta === 'unreadable') {
    return { ok: false, reason: 'Recipient token amount is unreadable' };
  }
  if (recipientDelta === null) {
    return { ok: false, reason: 'Recipient token account not found in transaction' };
  }
  if (recipientDelta < BigInt(input.expectedNet)) {
    return {
      ok: false,
      reason: `Recipient received ${recipientDelta.toString()} tokens, expected >= ${input.expectedNet}`,
    };
  }

  if (input.expectedFee > 0) {
    const treasuryDelta = tokenDelta(input.treasuryAddress);
    if (treasuryDelta === 'unreadable') {
      return { ok: false, reason: 'Treasury token amount is unreadable' };
    }
    if (treasuryDelta === null) {
      return { ok: false, reason: 'Treasury token account not found in transaction' };
    }
    if (treasuryDelta < BigInt(input.expectedFee)) {
      return {
        ok: false,
        reason: `Treasury received ${treasuryDelta.toString()} tokens, expected >= ${input.expectedFee}`,
      };
    }
  }
  return { ok: true };
}

/**
 * The change in one lamport slot, or `null` when either side cannot be read.
 *
 * An absent slot used to count as `0n` on both sides, and a present one went
 * through a bare `BigInt` - which takes `''`, `true` and `[]` for numbers
 * without throwing. Either way a slot nobody could read became a baseline of
 * zero, and the whole post balance became the payment.
 */
function bigIntDelta(post: unknown, pre: unknown): bigint | null {
  const postValue = readBalance(post);
  const preValue = readBalance(pre);
  if (postValue === null || preValue === null) {
    return null;
  }
  return postValue - preValue;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The customer's LAST look at the reference, and the half `validatePaymentRequest`
 * cannot take.
 *
 * That function is synchronous - the `PaymentStrategy` interface is - so it runs
 * only `degenerateReferenceSync` and never sees the DERIVED addresses: the stats
 * PDAs, the event authority, or a token account belonging to the recipient or
 * the treasury. The provider's verifier runs the full check and refuses such a
 * payment. Measured: `validatePaymentRequest` answers `null` for a reference
 * equal to the recipient's ATA while `verifyPayment` answers
 * `degenerate_reference` - so without this the customer pays, the transfer
 * cannot be singled out of that account's history, and the job is never
 * delivered. The money is gone and it went to the provider, which is what makes
 * a hand-crafted request worth someone's while.
 *
 * Here rather than in the schema because these addresses only exist once the
 * program id, the asset and the fee address are known - which is exactly what
 * this function already derives, one line above each check.
 */
function refuseDegenerateReferenceAgainst(
  reference: Address,
  derived: readonly (Address | undefined)[],
): void {
  // `candidate !== undefined` is redundant and stays for shape: `reference` is
  // an `Address`, so `undefined === reference` is never true. NOT KILLED BY ANY
  // TEST, and no test could be written for it.
  if (!derived.some((candidate) => candidate !== undefined && candidate === reference)) {
    return;
  }
  throw new Error(
    `Reference key ${reference} is an address this payment is computed from, so the transfer ` +
      `could not be singled out of that account's history afterwards. Ask the provider for a ` +
      `payment request with a fresh reference.`,
  );
}

/**
 * Build the transfer instructions for a payment request.
 *
 * For native SOL (no `paymentRequest.asset` or asset=NATIVE_SOL), emits System
 * program `TransferSol` instructions with the payment reference attached as a
 * read-only, non-signer account so providers can detect the payment via
 * `getSignaturesForAddress(reference)`.
 *
 * For SPL assets (USDC, LSM on Solana), emits:
 *   1. `CreateAssociatedTokenIdempotent` for the recipient ATA (funded by payer);
 *   2. `CreateAssociatedTokenIdempotent` for the treasury ATA if a protocol fee applies;
 *   3. `TransferChecked` from payer ATA to recipient ATA, with `reference` as an
 *      extra read-only account (canonical Solana Pay pattern);
 *   4. `TransferChecked` from payer ATA to treasury ATA if a fee applies.
 *
 * Every provider transfer instruction also carries `ELISYM_PROTOCOL_TAG` as a
 * read-only marker account so off-chain indexers can enumerate every elisym
 * transaction with a single `getSignaturesForAddress(ELISYM_PROTOCOL_TAG)`
 * call, regardless of fee size.
 *
 * If `options.jobEventId` is provided, an SPL Memo instruction with payload
 * `elisym:v1:<jobEventId>` is prepended so explorers display the originating
 * Nostr job id and indexers can join on-chain payments back to off-chain
 * job context.
 *
 * Async because SPL ATAs are PDAs and `findAssociatedTokenPda` is async.
 *
 * Caller is responsible for validating `paymentRequest` upstream - and that
 * means the caller of `buildTransaction`, not `buildTransaction` itself, which
 * checks only the config, the lamport amounts, the reference's shape, the
 * expiry and `fee_address === treasury`. The STATIC denylist (a reference equal
 * to the recipient, the treasury, the mint, the protocol tag, the system
 * program) is `validatePaymentRequest`'s, and nothing below calls it. Both
 * first-party callers do, before building.
 */
export async function buildPaymentInstructions(
  paymentRequest: PaymentRequestData,
  payerSigner: Signer,
  options: {
    jobEventId?: string;
    programId: Address;
    /**
     * The treasury from the on-chain config, when the caller has it.
     *
     * Optional only for compatibility, and what it costs to leave out is
     * specific: the degenerate-reference check below then cannot see the
     * treasury's TOKEN ACCOUNT unless the request happens to name the same
     * address in `fee_address`. A zero-fee request may omit `fee_address`
     * entirely - and `feeBps` is 0 on the deployed mainnet program - so a
     * third-party request built that way passes this check and is then refused
     * by the provider's verifier, after the customer has paid. Pass it.
     *
     * `buildTransaction` passes it for you; a direct caller is on their own.
     */
    treasury?: Address;
  },
): Promise<readonly unknown[]> {
  const recipient = address(paymentRequest.recipient);
  const reference = address(paymentRequest.reference);
  const protocolTag = address(ELISYM_PROTOCOL_TAG);
  const programId = options.programId;
  const feeAmount = paymentRequest.fee_amount ?? 0;
  // A POSITIVE fee needs a destination that exists, and the honest history is
  // worth writing down: before this branch a malformed `fee_address` THREW out
  // of `address()` further down, so nothing was signed. What this branch added
  // - deriving the fee owner's ATA through `isAddress(...) ? ... : undefined`
  // so a zero-fee request stays buildable - is what would otherwise turn that
  // throw into a silent skip, and a silent skip is the dangerous one:
  // `providerAmount` below subtracts the fee on the mere PRESENCE of the field
  // while the fee leg is built only for an address that parses, so the customer
  // would sign a transaction paying the recipient `amount - fee` and nobody the
  // fee. The provider's verifier then answers `Recipient received N, expected
  // >= amount` and the job can never be accepted. That silent skip is the SPL
  // branch's alone - on the native branch `address()` is still reached and
  // still throws - which is why the row that measures this builds a USDC
  // request. Refusing here keeps the old outcome on both and gives it a
  // sentence an operator can act on. A zero fee stays
  // payable: no leg is built either way, which is the request shape a
  // third-party provider issues on mainnet.
  if (paymentRequest.fee_address && feeAmount > 0 && !isAddress(paymentRequest.fee_address)) {
    throw new Error(
      `Invalid fee address: ${paymentRequest.fee_address}. A positive fee has no valid destination.`,
    );
  }
  const providerAmount =
    paymentRequest.fee_address && feeAmount > 0
      ? paymentRequest.amount - feeAmount
      : paymentRequest.amount;

  const asset = resolveAssetFromPaymentRequest(paymentRequest);
  const statsMint = asset.mint ? address(asset.mint) : NATIVE_ASSET_SENTINEL;
  const statsPda = await deriveNetworkStatsAddress(programId);
  const assetStatsPda = await deriveAssetStatsAddress(programId, statsMint);
  const eventAuthority = await deriveEventAuthorityAddress(programId);
  const incrementStatsIx = getIncrementStatsV2Instruction(
    {
      stats: statsPda,
      assetStats: assetStatsPda,
      payer: payerSigner,
      eventAuthority,
      program: programId,
      amount: BigInt(paymentRequest.amount),
      mint: statsMint,
    },
    { programAddress: programId },
  );

  refuseDegenerateReferenceAgainst(reference, [statsPda, assetStatsPda, eventAuthority]);

  if (providerAmount <= 0) {
    throw new Error(
      `Fee amount (${feeAmount}) exceeds or equals total amount (${paymentRequest.amount}). Cannot create transaction with non-positive provider amount.`,
    );
  }

  const memoInstruction = options.jobEventId
    ? getAddMemoInstruction({ memo: `elisym:v1:${options.jobEventId}` })
    : null;

  // Native SOL path - unchanged from the pre-USDC behaviour.
  if (!asset.mint) {
    const providerTransferIx = getTransferSolInstruction({
      source: payerSigner,
      destination: recipient,
      amount: BigInt(providerAmount),
    });
    const providerTransferIxWithMarkers = {
      ...providerTransferIx,
      accounts: [
        ...providerTransferIx.accounts,
        { address: reference, role: AccountRole.READONLY },
        { address: protocolTag, role: AccountRole.READONLY },
      ],
    };

    const instructions: unknown[] = [];
    if (memoInstruction) {
      instructions.push(memoInstruction);
    }
    instructions.push(providerTransferIxWithMarkers);
    if (paymentRequest.fee_address && feeAmount > 0) {
      instructions.push(
        getTransferSolInstruction({
          source: payerSigner,
          destination: address(paymentRequest.fee_address),
          amount: BigInt(feeAmount),
        }),
      );
    }
    instructions.push(incrementStatsIx);
    return instructions;
  }

  // SPL path. The owner token program comes from the asset registry: classic
  // SPL Token unless the asset declares a Token-2022 mint (LSM).
  const mint = address(asset.mint);
  const tokenProgram = asset.tokenProgram ? address(asset.tokenProgram) : TOKEN_PROGRAM_ADDRESS;
  const payerAddress = payerSigner.address;
  const [payerAta] = await findAssociatedTokenPda({
    owner: payerAddress,
    tokenProgram,
    mint,
  });
  const [recipientAta] = await findAssociatedTokenPda({
    owner: recipient,
    tokenProgram,
    mint,
  });

  const instructions: unknown[] = [];
  if (memoInstruction) {
    instructions.push(memoInstruction);
  }
  instructions.push(
    getCreateAssociatedTokenIdempotentInstruction(
      {
        payer: payerSigner,
        ata: recipientAta,
        owner: recipient,
        mint,
        tokenProgram,
      },
      { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
    ),
  );

  // Derived whenever there is an owner to derive one FOR, not only when a fee
  // leg gets built. `feeBps` is 0 on the deployed mainnet program, so every
  // mainnet SPL payment takes the zero-fee branch - while the provider's
  // denylist derives these accounts unconditionally. Gating the derivation on
  // the fee amount therefore left the commonest case unchecked on this side and
  // checked on the other, which is the customer paying for a job that can never
  // be delivered.
  //
  // Each owner is checked with `isAddress` first, exactly as the provider's
  // denylist does and for the same reason: `findAssociatedTokenPda` encodes its
  // owner and THROWS on a string that is not an address, and a malformed
  // `fee_address` on a zero-fee request is payable today - the fee leg is not
  // built at all, so nothing in this function used to look at the field. An
  // owner we cannot parse simply contributes no account to compare against.
  const feeOwner =
    paymentRequest.fee_address && isAddress(paymentRequest.fee_address)
      ? address(paymentRequest.fee_address)
      : undefined;
  let feeOwnerAta: Address | undefined;
  if (feeOwner) {
    [feeOwnerAta] = await findAssociatedTokenPda({ owner: feeOwner, tokenProgram, mint });
  }
  // And the treasury the CONFIG names, which a request may omit entirely: with
  // a zero fee `fee_address` is optional, and the provider's denylist reads the
  // treasury from the config rather than from the request.
  let configTreasuryAta: Address | undefined;
  // The mirror of the guard on `fee_address` above, which is a third party's
  // field. This one is the config's, and on every first-party path
  // `assertConfig` has already checked it - but this function is EXPORTED, and
  // the option's own docstring a few screens up says a direct caller is on
  // their own. Measured through that door: the row named `does not throw on a
  // malformed CONFIG treasury either` comes back from `findAssociatedTokenPda`
  // as a raw base58-length error with the guard removed.
  if (
    options.treasury !== undefined &&
    options.treasury !== feeOwner &&
    isAddress(options.treasury)
  ) {
    [configTreasuryAta] = await findAssociatedTokenPda({
      owner: options.treasury,
      tokenProgram,
      mint,
    });
  }

  if (feeOwner && feeOwnerAta && feeAmount > 0) {
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction(
        {
          payer: payerSigner,
          ata: feeOwnerAta,
          owner: feeOwner,
          mint,
          tokenProgram,
        },
        { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
      ),
    );
  }

  // The token halves, checked where they become known. The payer's own ATA is
  // not in the set: a reference equal to it is the CUSTOMER's account, which
  // the verifier's denylist does not carry either - it lists what the payment
  // is computed from on the receiving side.
  refuseDegenerateReferenceAgainst(reference, [recipientAta, feeOwnerAta, configTreasuryAta]);

  const providerTransferIx = getTransferCheckedInstruction(
    {
      source: payerAta,
      mint,
      destination: recipientAta,
      authority: payerSigner,
      amount: BigInt(providerAmount),
      decimals: asset.decimals,
    },
    { programAddress: tokenProgram },
  );
  const providerTransferIxWithMarkers = {
    ...providerTransferIx,
    accounts: [
      ...providerTransferIx.accounts,
      { address: reference, role: AccountRole.READONLY },
      { address: protocolTag, role: AccountRole.READONLY },
    ],
  };
  instructions.push(providerTransferIxWithMarkers);

  if (feeOwnerAta && paymentRequest.fee_address && feeAmount > 0) {
    instructions.push(
      getTransferCheckedInstruction(
        {
          source: payerAta,
          mint,
          destination: feeOwnerAta,
          authority: payerSigner,
          amount: BigInt(feeAmount),
          decimals: asset.decimals,
        },
        { programAddress: tokenProgram },
      ),
    );
  }

  instructions.push(incrementStatsIx);
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
  network: Network,
  recipient: string,
  amount: number,
  options?: { expirySecs?: number },
): Promise<PaymentRequestData> {
  const config = await getProtocolConfig(rpc, programId, network);
  const strategy = new SolanaPaymentStrategy();
  return strategy.createPaymentRequest(
    recipient,
    amount,
    { feeBps: config.feeBps, treasury: config.treasury },
    network,
    options,
  );
}
