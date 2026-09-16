/**
 * The SDK verifier's contract: `verifyPayment` is STATELESS, and one on-chain
 * transaction can therefore satisfy it for SEVERAL distinct payment requests.
 * De-duplicating a settlement across jobs is the PROVIDER's responsibility,
 * not the verifier's. These tests pin that contract down so it cannot drift.
 *
 * Why it is stateless (packages/sdk/src/payment/solana.ts):
 *   `checkTxDiff` / `checkTokenBalanceDiff` bind a payment request to a
 *   transaction by TWO facts only:
 *     1. the request's random `reference` key appears somewhere in the tx's
 *        account keys (a pure presence check - see the "possible replay" guard);
 *     2. the recipient's balance delta is `>= expectedNet` (and, when a fee
 *        applies, the treasury delta is `>= expectedFee`).
 *   Neither the transferred AMOUNT nor the transaction SIGNATURE is bound to the
 *   reference, and the SDK holds no state with which to dedup a signature across
 *   requests. So a customer who holds two payment requests to the same provider
 *   (same asset, and any prices whose net is `<= the single amount they actually
 *   transfer`) can build ONE transfer, attach BOTH references as read-only
 *   accounts, and have the ONE transfer verify for BOTH requests. On elisym
 *   mainnet `feeBps = 0`, so the treasury leg vanishes and the check reduces to
 *   "reference present + recipient got >= net once".
 *
 * Where the hole is actually closed: `@elisym/cli`'s provider runtime claims the
 * settlement signature for exactly one job before accepting the payment -
 * `JobLedger.claimPaymentSignature` in packages/cli/src/ledger.ts, wired through
 * `AgentRuntime.claimSettlementSignature`; the end-to-end proof lives in
 * packages/cli/tests/runtime-payment-dedup.test.ts. A verifier that is honest
 * about being stateless is fine; a provider that forgets which transactions it
 * already accepted is not. Every `verified: true` below therefore carries the
 * SAME `txSignature`, which is precisely the value the provider de-duplicates on
 * - so these assertions must keep passing.
 *
 * The RPC fixture mirrors the real `getTransaction(..., encoding: 'json')`
 * response shape the code actually consumes: `accountKeys` as base58 strings,
 * `pre/postBalances` as the bigint `Lamports` @solana/kit returns, and
 * `pre/postTokenBalances` entries carrying `accountIndex`, `mint`, `owner`, and
 * `uiTokenAmount.amount`. (Fixtures kinder than the node have hidden real bugs
 * in this repo before, so the shape is kept faithful.)
 */
import {
  type Address,
  type Blockhash,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  getAddressDecoder,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  ProtocolConfigInput,
  SolanaPaymentStrategy,
  USDC_SOLANA_DEVNET,
  calculateProtocolFee,
} from '../src';

const ADDRESS_BYTES = 32;
const ADDRESS_DECODER = getAddressDecoder();

function makeAddress(): Address {
  const bytes = new Uint8Array(ADDRESS_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return ADDRESS_DECODER.decode(bytes);
}

const TEST_FEE_BPS = 300;
const TEST_TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy' as Address;
const CONFIG: ProtocolConfigInput = { feeBps: TEST_FEE_BPS, treasury: TEST_TREASURY };

const payment = new SolanaPaymentStrategy();

const FAST = { retries: 1, intervalMs: 5 };

/** Shared building blocks: one provider, two concurrent same-price jobs. */
const recipient = makeAddress();
const payer = makeAddress();
const referenceA = makeAddress(); // provider-generated for job A
const referenceB = makeAddress(); // provider-generated for job B (distinct)
const amount = 100_000_000;
const feeAmount = calculateProtocolFee(amount, TEST_FEE_BPS);
const netAmount = amount - feeAmount;

/** Two payment requests: same recipient / amount / asset, distinct references. */
function makeRequest(reference: Address, overrides?: Record<string, unknown>) {
  return {
    recipient,
    amount,
    reference,
    fee_address: TEST_TREASURY,
    fee_amount: feeAmount,
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 600,
    ...overrides,
  };
}

/**
 * A realistic native-SOL `getTransaction(json)` fixture for ONE transaction that
 * moves `net` to the recipient and `fee` to the treasury exactly once, while
 * carrying BOTH references as read-only accounts.
 */
function makeSharedSolTx(references: Address[]) {
  const keys: Address[] = [payer, recipient, ...references, TEST_TREASURY];
  const startingPayerBalance = 1_000_000_000n;
  const pre = keys.map((key) => (key === payer ? startingPayerBalance : 0n));
  const post = keys.map((key) => {
    if (key === payer) {
      return startingPayerBalance - BigInt(amount);
    }
    if (key === recipient) {
      return BigInt(netAmount); // credited ONCE
    }
    if (key === TEST_TREASURY) {
      return BigInt(feeAmount); // credited ONCE
    }
    return 0n;
  });
  return {
    slot: 1n,
    blockTime: BigInt(Math.floor(Date.now() / 1000)),
    meta: {
      err: null,
      fee: 5000n,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: [],
      postTokenBalances: [],
      logMessages: [],
      rewards: [],
      status: { Ok: null },
    },
    transaction: {
      message: {
        accountKeys: keys,
        recentBlockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi' as Blockhash,
      },
      signatures: [],
    },
    version: 0,
  };
}

interface SplTokenBalance {
  accountIndex: number;
  mint: Address;
  owner: Address;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}

/**
 * A realistic SPL (USDC) `getTransaction(json)` fixture for ONE TransferChecked
 * of `net` to the recipient ATA and `fee` to the treasury ATA, carrying BOTH
 * references as read-only accounts. Token deltas surface via pre/postTokenBalances
 * keyed by owner + mint, exactly as the verifier reads them.
 */
function makeSharedUsdcTx(references: Address[]) {
  const mint = USDC_SOLANA_DEVNET.mint as Address;
  const recipientAta = makeAddress();
  const treasuryAta = makeAddress();
  const payerAta = makeAddress();
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
  // Reference presence is checked against `accountKeys` (bounded by preBalances
  // length), so both references must appear here with a matching lamports entry.
  const keys: Address[] = [
    payer,
    payerAta,
    recipientAta,
    treasuryAta,
    tokenProgram,
    mint,
    ...references,
  ];
  const pre = keys.map((key) => (key === payer ? 1_000_000_000n : 0n));
  const post = [...pre]; // lamports barely move; the token legs carry the value

  const tokenAmount = (amountRaw: number): SplTokenBalance['uiTokenAmount'] => ({
    amount: String(amountRaw),
    decimals: USDC_SOLANA_DEVNET.decimals,
    uiAmount: amountRaw / 10 ** USDC_SOLANA_DEVNET.decimals,
    uiAmountString: String(amountRaw / 10 ** USDC_SOLANA_DEVNET.decimals),
  });

  const preTokenBalances: SplTokenBalance[] = [
    { accountIndex: 2, mint, owner: recipient, uiTokenAmount: tokenAmount(0) },
    { accountIndex: 3, mint, owner: TEST_TREASURY, uiTokenAmount: tokenAmount(0) },
  ];
  const postTokenBalances: SplTokenBalance[] = [
    { accountIndex: 2, mint, owner: recipient, uiTokenAmount: tokenAmount(netAmount) },
    { accountIndex: 3, mint, owner: TEST_TREASURY, uiTokenAmount: tokenAmount(feeAmount) },
  ];

  return {
    slot: 1n,
    blockTime: BigInt(Math.floor(Date.now() / 1000)),
    meta: {
      err: null,
      fee: 5000n,
      preBalances: pre,
      postBalances: post,
      preTokenBalances,
      postTokenBalances,
      logMessages: [],
      rewards: [],
      status: { Ok: null },
    },
    transaction: {
      message: {
        accountKeys: keys,
        recentBlockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi' as Blockhash,
      },
      signatures: [],
    },
    version: 0,
  };
}

/** RPC whose `getTransaction` returns `tx` for any signature. */
function rpcReturningTx(tx: unknown, sharedSig?: string): Rpc<SolanaRpcApi> {
  const wrap = <T>(value: T) => ({ send: () => Promise.resolve(value) });
  return {
    getLatestBlockhash: () =>
      wrap({ value: { blockhash: 'mock' as Blockhash, lastValidBlockHeight: 1n } }),
    getTransaction: () => wrap(tx),
    // Both references resolve the SAME on-chain signature, because both are
    // attached to the single shared transaction.
    getSignaturesForAddress: () =>
      wrap(sharedSig ? [{ signature: sharedSig as Signature, err: null }] : []),
  } as unknown as Rpc<SolanaRpcApi>;
}

describe("SDK contract: verifyPayment is stateless - dedup is the provider's job", () => {
  describe('native SOL, signature path', () => {
    it('one SOL transfer verifies BOTH request A and request B, under one signature', async () => {
      const sharedTx = makeSharedSolTx([referenceA, referenceB]);
      const sharedSignature = 'sharedDoublePaySig' as Signature;
      const rpc = rpcReturningTx(sharedTx);

      const resultA = await payment.verifyPayment(rpc, makeRequest(referenceA), CONFIG, {
        txSignature: sharedSignature,
        ...FAST,
      });
      const resultB = await payment.verifyPayment(rpc, makeRequest(referenceB), CONFIG, {
        txSignature: sharedSignature,
        ...FAST,
      });

      // The provider received `net` exactly ONCE, yet both requests verify -
      // that is the documented statelessness, not a bug in the verifier. Both
      // results name the SAME signature, which is the handle the CLI provider
      // uses to let only the first job consume it.
      expect(resultA.verified).toBe(true);
      expect(resultB.verified).toBe(true);
      expect(resultA.txSignature).toBe(sharedSignature);
      expect(resultB.txSignature).toBe(sharedSignature);
      expect(resultA.txSignature).toBe(resultB.txSignature);
    });

    it('CONTROL: a request whose reference is NOT in the tx is rejected (replay guard)', async () => {
      // Confirms the only binding the SDK offers is reference PRESENCE: a third
      // job whose reference was not pre-embedded in the shared tx cannot ride it.
      const sharedTx = makeSharedSolTx([referenceA, referenceB]);
      const rpc = rpcReturningTx(sharedTx);
      const referenceC = makeAddress();

      const resultC = await payment.verifyPayment(rpc, makeRequest(referenceC), CONFIG, {
        txSignature: 'sharedDoublePaySig' as Signature,
        ...FAST,
      });
      expect(resultC.verified).toBe(false);
      expect(resultC.error).toContain('Reference key not found');
    });
  });

  describe('native SOL, reference-scan path', () => {
    it('getSignaturesForAddress path also verifies BOTH requests, same signature', async () => {
      const sharedTx = makeSharedSolTx([referenceA, referenceB]);
      const sharedSignature = 'sharedRefScanSig';
      const rpc = rpcReturningTx(sharedTx, sharedSignature);

      // No txSignature -> the SDK takes the reference-scan path for each request.
      const resultA = await payment.verifyPayment(rpc, makeRequest(referenceA), CONFIG, FAST);
      const resultB = await payment.verifyPayment(rpc, makeRequest(referenceB), CONFIG, FAST);

      // Same contract on the scan path, and the same shared signature reaches
      // the provider's de-duplication gate.
      expect(resultA.verified).toBe(true);
      expect(resultB.verified).toBe(true);
      expect(resultA.txSignature).toBe(sharedSignature);
      expect(resultB.txSignature).toBe(sharedSignature);
    });
  });

  describe('SPL USDC, signature path', () => {
    it('one USDC TransferChecked verifies BOTH request A and request B', async () => {
      const usdcOverride = {
        asset: {
          chain: 'solana',
          token: 'usdc',
          mint: USDC_SOLANA_DEVNET.mint,
          decimals: USDC_SOLANA_DEVNET.decimals,
        },
      };
      const sharedTx = makeSharedUsdcTx([referenceA, referenceB]);
      const sharedSignature = 'sharedUsdcDoublePaySig' as Signature;
      const rpc = rpcReturningTx(sharedTx);

      const resultA = await payment.verifyPayment(
        rpc,
        makeRequest(referenceA, usdcOverride),
        CONFIG,
        { txSignature: sharedSignature, ...FAST },
      );
      const resultB = await payment.verifyPayment(
        rpc,
        makeRequest(referenceB, usdcOverride),
        CONFIG,
        { txSignature: sharedSignature, ...FAST },
      );

      // The recipient ATA gained `net` exactly ONCE, yet both requests verify.
      // The SPL path is stateless in exactly the same way as the native one.
      expect(resultA.verified).toBe(true);
      expect(resultB.verified).toBe(true);
      expect(resultA.txSignature).toBe(resultB.txSignature);
    });
  });

  describe('SPL USDC, reference-scan path', () => {
    it('USDC reference-scan path also verifies BOTH requests', async () => {
      const usdcOverride = {
        asset: {
          chain: 'solana',
          token: 'usdc',
          mint: USDC_SOLANA_DEVNET.mint,
          decimals: USDC_SOLANA_DEVNET.decimals,
        },
      };
      const sharedTx = makeSharedUsdcTx([referenceA, referenceB]);
      const rpc = rpcReturningTx(sharedTx, 'sharedUsdcRefScanSig');

      const resultA = await payment.verifyPayment(
        rpc,
        makeRequest(referenceA, usdcOverride),
        CONFIG,
        FAST,
      );
      const resultB = await payment.verifyPayment(
        rpc,
        makeRequest(referenceB, usdcOverride),
        CONFIG,
        FAST,
      );

      // Both verify off the shared signature; the provider, not the SDK, is
      // what stops the second job from being delivered for it.
      expect(resultA.verified).toBe(true);
      expect(resultB.verified).toBe(true);
      expect(resultA.txSignature).toBe(resultB.txSignature);
    });
  });
});
