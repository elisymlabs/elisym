import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SolanaPaymentStrategy } from '@elisym/sdk';
import { getAddressDecoder } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobLedger, type LedgerEntry } from '../src/ledger.js';
import { PaymentRecovery } from '../src/payment-recovery.js';

/**
 * Lives in its own file because it replaces `createSolanaRpc`, and because the
 * stand it needs is the opposite of the denylist fixtures': there the port is
 * dead and every listing fails, here the listing has to SUCCEED and hand back
 * exactly what a rewriting proxy would.
 *
 * `address`, `signature` and `isAddress` come through REAL on purpose - a
 * permissive stand-in accepts values `@solana/kit` rejects, and the falsy
 * dispatch these fixtures turn on lives behind them.
 */
let listedSignatures: unknown[] = [];
let transactionsBySignature = new Map<unknown, unknown>();

vi.mock('@solana/kit', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createSolanaRpc: vi.fn().mockReturnValue({
      getSignaturesForAddress: vi.fn(() => ({
        send: async () => listedSignatures,
      })),
      // Keyed by the signature ASKED FOR, and answering for the unusable one
      // too: a stub that only knew the real signature would send the mutant
      // down the "candidate did not verify" path, where it agrees with the
      // fixed code and proves nothing.
      getTransaction: vi.fn((asked: unknown) => ({
        send: async () => transactionsBySignature.get(asked) ?? null,
      })),
      getGenesisHash: vi.fn(() => ({ send: async () => 'genesis-unused-here' })),
    }),
  };
});

const ADDRESS_DECODER = getAddressDecoder();
function makeAddress(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return ADDRESS_DECODER.decode(bytes) as string;
}

const RECIPIENT = makeAddress();
const REFERENCE = makeAddress();
const PAYER = makeAddress();
const TREASURY = makeAddress();
const PRICE = 1_000_000;
/** The settlement actually sitting on the reference - what a correct scan claims. */
const REAL_SIGNATURE = '5'.repeat(88);

/**
 * `fee_amount: 0` alongside `feeBps: 0` on purpose: a non-zero fee is refused
 * before the strategy ever dispatches on the signature, and both versions would
 * then agree for a reason that has nothing to do with the gate under test.
 */
function paymentRequestJson(reference: string = REFERENCE): string {
  return JSON.stringify({
    recipient: RECIPIENT,
    amount: PRICE,
    reference,
    fee_address: TREASURY,
    fee_amount: 0,
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 3600,
    network: 'devnet',
  });
}

/** A transaction that verifies as payment for the request above. */
function payingTransaction() {
  return {
    meta: {
      err: null,
      preBalances: [10_000_000n, 0n, 0n, 0n],
      postBalances: [10_000_000n - BigInt(PRICE), BigInt(PRICE), 0n, 0n],
      preTokenBalances: undefined,
      postTokenBalances: undefined,
      loadedAddresses: undefined,
    },
    transaction: {
      message: { accountKeys: [PAYER, RECIPIENT, TREASURY, REFERENCE] },
    },
  };
}

let dir: string;
let ledgerPath: string;
let ledger: JobLedger;
let recovery: PaymentRecovery;
const logs: string[] = [];
const log = (msg: string) => {
  logs.push(msg);
};

const JOB_ID = 'job-under-test';

/**
 * Seeds the ledger FILE and loads it, rather than building the entry in
 * memory. Two reasons, and both are load-bearing: an unusable
 * `payment_signature` is the hand-edited shape no API writes, and
 * `claimPaymentSignature` looks the job up in the ledger - handed a synthetic
 * object it answers `unknown-job`, and every version defers for that reason
 * instead of the one under test.
 */
function seedLedger(paymentSignature?: unknown, reference: string = REFERENCE): void {
  const entry: Record<string, unknown> = {
    job_id: JOB_ID,
    status: 'paid',
    input: 'input',
    input_type: 'text',
    tags: [],
    customer_id: 'customer-1',
    payment_request: paymentRequestJson(reference),
    created_at: Date.now(),
    retry_count: 0,
  };
  if (paymentSignature !== undefined) {
    entry.payment_signature = paymentSignature;
  }
  writeFileSync(ledgerPath, JSON.stringify({ [JOB_ID]: entry }), 'utf-8');
  ledger = new JobLedger(ledgerPath);
  recovery = new PaymentRecovery(
    ledger,
    'devnet',
    async () => ({ feeBps: 0, treasury: TREASURY }),
    new SolanaPaymentStrategy(),
  );
}

function entryUnderTest(): LedgerEntry {
  const found = ledger.allEntries().find((candidate) => candidate.job_id === JOB_ID);
  if (!found) {
    throw new Error('fixture seeded no entry');
  }
  return found;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elisym-unusable-'));
  ledgerPath = join(dir, 'jobs.json');
  logs.length = 0;
  listedSignatures = [];
  transactionsBySignature = new Map();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a signature the ledger cannot key a claim on', () => {
  describe("the entry's own claimed settlement", () => {
    it.each([
      ['empty string', ''],
      ['null', null],
    ])('scans past a %s and claims the settlement that exists', async (_label, unusable) => {
      seedLedger(unusable);
      listedSignatures = [{ signature: REAL_SIGNATURE, err: null }];
      transactionsBySignature.set(REAL_SIGNATURE, payingTransaction());

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(),
        PRICE,
        log,
      );

      expect(outcome).toBe('verified');
      // Keyed on the settlement that exists, so a second job carrying this
      // reference can no longer settle against the same transaction.
      expect(entryUnderTest().payment_signature).toBe(REAL_SIGNATURE);
      expect(ledger.paymentSignatureOwner(REAL_SIGNATURE)).toBe(JOB_ID);
    });
  });

  describe('a candidate the node listed', () => {
    it('defers instead of claiming a blank the node reported', async () => {
      // No `payment_signature` at all: with an unusable one present the
      // `'none'` branch is short-circuited into the same `deferred` both
      // versions give, and the second half of the gate goes unproven.
      seedLedger();
      listedSignatures = [{ signature: '', err: null }];
      // The blank ANSWERS as a payment - this is the rewriting proxy, not a
      // transaction that is simply missing.
      transactionsBySignature.set('', payingTransaction());

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(),
        PRICE,
        log,
      );

      expect(outcome).toBe('deferred');
      expect(entryUnderTest().payment_signature).toBeUndefined();
      expect(ledger.paymentSignatureOwner('')).toBeUndefined();
    });

    it('does not call the window empty after skipping one', async () => {
      // Same listing, read for the other half of the gate: skipping a candidate
      // without recording that we did would let the scan report `none` - "the
      // reference's whole history is empty" - about a window it did not finish.
      seedLedger();
      listedSignatures = [{ signature: '', err: null }];
      transactionsBySignature.set('', null);

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(),
        PRICE,
        log,
      );

      expect(outcome).toBe('deferred');
    });
  });

  describe('a reference the payment is computed from', () => {
    it('fails the job now instead of deferring it for a day', async () => {
      // Listing this reference lists the provider's own wallet, so the
      // customer's transfer is not findable and no amount of waiting helps.
      // Honest about what this buys: not money - the denylist inside
      // `verifyPayment` would refuse the re-verification anyway - but the shape
      // of the ending. Without it the job is deferred to the 24h cutoff and
      // then fails as "the agent did not recover".
      seedLedger(undefined, RECIPIENT);

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(RECIPIENT),
        PRICE,
        log,
      );

      expect(outcome).toBe('corrupt-state');
    });

    it('fails a job that already owns a settlement the same way', async () => {
      // Measured rather than assumed. The tempting gate here - "this job can
      // re-verify its own settlement, so leave it alone" - describes a path
      // that does not exist: the denylist inside `verifyPayment` sits ahead of
      // both its branches, so the signature path refuses too. With the gate the
      // entry deferred to the 24h cutoff and died as "the agent did not
      // recover"; without it, it fails here naming the real problem.
      seedLedger(REAL_SIGNATURE, RECIPIENT);
      listedSignatures = [];
      transactionsBySignature.set(REAL_SIGNATURE, payingTransaction());

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(RECIPIENT),
        PRICE,
        log,
      );

      expect(outcome).toBe('corrupt-state');
    });
  });
});
