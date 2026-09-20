import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SolanaPaymentStrategy } from '@elisym/sdk';
import { getAddressDecoder } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobLedger, type LedgerEntry } from '../src/ledger.js';
import {
  REFERENCE_SCAN_DEADLINE_MS,
  REFERENCE_SCAN_WINDOW,
  PaymentRecovery,
} from '../src/payment-recovery.js';

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
/** Counted so a fixture can assert the reference was never listed AT ALL. */
let listCalls = 0;
/** How much wall clock a SUCCESSFUL listing burns, without burning any. */
let listingCostsMs = 0;
/** The same, for the on-chain protocol-config read that precedes the scan. */
let configCostsMs = 0;
let clockSkewMs = 0;

vi.mock('@solana/kit', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createSolanaRpc: vi.fn().mockReturnValue({
      getSignaturesForAddress: vi.fn(() => ({
        send: async () => {
          listCalls += 1;
          clockSkewMs += listingCostsMs;
          return listedSignatures;
        },
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
    async () => {
      clockSkewMs += configCostsMs;
      return { feeBps: 0, treasury: TREASURY };
    },
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

/**
 * The clock is a SPY rather than vitest's fake timers: the code under test
 * awaits real promises and sleeps between retries, and a frozen timer loop never
 * lets those resolve. Skewing `Date.now` lets a listing cost half a minute of
 * budget without costing the suite half a minute.
 */
const realDateNow = Date.now.bind(Date);
let clock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elisym-unusable-'));
  ledgerPath = join(dir, 'jobs.json');
  logs.length = 0;
  listedSignatures = [];
  transactionsBySignature = new Map();
  listCalls = 0;
  listingCostsMs = 0;
  configCostsMs = 0;
  clockSkewMs = 0;
  clock = vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + clockSkewMs);
});

afterEach(() => {
  clock.mockRestore();
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

  describe('a listing that outlived the budget it was given', () => {
    it('is inconclusive, not an empty history', async () => {
      // The budget is checked inside the candidate loop, and an EMPTY page means
      // that loop never runs. `listReferenceCandidates` reads the clock only in
      // its `catch`, so a listing that succeeds after the whole budget is spent
      // reaches the verdict with nothing standing between it and `none` - which
      // on this rail is what fails a paying customer's job as "the customer did
      // not pay".
      seedLedger();
      listedSignatures = [];
      listingCostsMs = REFERENCE_SCAN_DEADLINE_MS + 1_000;

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(),
        PRICE,
        log,
      );

      expect(outcome).toBe('deferred');
      // Named, because `deferred` alone is reachable through several gates: only
      // the scan says this, and with an empty page only the check after the loop
      // can say it.
      expect(logs.join('\n')).toContain('ran out of time');
    });

    it('still gives the scan its whole budget after a slow config read', async () => {
      // The protocol config is its own on-chain fetch and refreshes every tick.
      // Counted against the scan's budget, a slow one spends the whole allowance
      // before the scan starts - and the scan then answers as though it had
      // looked. Here the payment is sitting on the reference in plain sight.
      seedLedger();
      configCostsMs = REFERENCE_SCAN_DEADLINE_MS + 1_000;
      listedSignatures = [{ signature: REAL_SIGNATURE, err: null }];
      transactionsBySignature.set(REAL_SIGNATURE, payingTransaction());

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(),
        PRICE,
        log,
      );

      expect(outcome).toBe('verified');
      expect(entryUnderTest().payment_signature).toBe(REAL_SIGNATURE);
    });
  });

  describe('a pass the operator has already stopped', () => {
    it('does not list anything, and cannot reach a verdict', async () => {
      // `runtime.stop()` aborts the recovery signal, but the tick in flight
      // plays out to the end. The signal used to reach the scan only through
      // the verification closure - which an EMPTY listing never calls - so an
      // abandoned pass could still walk down to `no-payment` and fail a paid
      // job. The acceptor reads the signal wherever it reads the clock; this is
      // the same policy on this rail.
      seedLedger();
      listedSignatures = [];
      const controller = new AbortController();
      controller.abort();

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(),
        PRICE,
        log,
        controller.signal,
      );

      expect(outcome).toBe('deferred');
      expect(listCalls).toBe(0);
    });

    it("does not re-verify the job's own settlement either", async () => {
      // The step before the scan, and the comment above the deadline claims it
      // is bounded by the same budget. It was not: the own-signature
      // re-verification read neither the clock nor the signal, and spent its
      // whole retry budget of a slot shared with live intake after the operator
      // had stopped the agent.
      //
      // The discriminator is the LOG, not the outcome: unbounded, the abort
      // surfaces as an exception out of the verification and the pass defers
      // with a different sentence.
      seedLedger(REAL_SIGNATURE);
      transactionsBySignature.set(REAL_SIGNATURE, payingTransaction());
      const controller = new AbortController();
      controller.abort();

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(),
        PRICE,
        log,
        controller.signal,
      );

      expect(outcome).toBe('deferred');
      expect(logs.join('\n')).toContain('ran out of time');
      expect(logs.join('\n')).not.toContain('re-verification error');
    });
  });

  describe('a reference flooded with transactions that failed on chain', () => {
    it('is a truncated history, not an empty one', async () => {
      // `windowFull` is counted on the RAW page, before the failed transactions
      // are dropped - and nothing measured that. Counted after the filter, a
      // full window of deliberately failing transfers reads as "nothing on this
      // reference at all", which is the terminal verdict. The flood costs an
      // attacker a few thousand lamports per transaction.
      seedLedger();
      listedSignatures = Array.from({ length: REFERENCE_SCAN_WINDOW }, (_unused, index) => ({
        signature: `${index}`.padStart(88, 'F'),
        err: { InstructionError: [0, 'Custom'] },
      }));

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(),
        PRICE,
        log,
      );

      expect(outcome).toBe('deferred');
      expect(logs.join('\n')).toContain('truncated');
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

    it.each([
      ['empty string', ''],
      ['null', null],
    ])(
      'fails a job whose claimed settlement is a %s, like one with none at all',
      async (_label, unusable) => {
        // The carve-out asks whether the job OWNS a settlement, and it asks with
        // `isUsableSignature` rather than `!== undefined`: a hand-edited ledger
        // carries these, and they own nothing. Read as ownership, the job is
        // deferred to the 24-hour cutoff with a log naming a settlement that is
        // not there, instead of failing now with the real reason.
        seedLedger(unusable, RECIPIENT);

        const outcome = await recovery.reVerifyPayment(
          entryUnderTest(),
          paymentRequestJson(RECIPIENT),
          PRICE,
          log,
        );

        expect(outcome).toBe('corrupt-state');
      },
    );

    it('defers a job that already owns a settlement, rather than killing it', async () => {
      // The carve-out, and its reason is easy to get wrong. It is NOT that such
      // a job can re-verify its own signature - measured, it cannot: the
      // denylist inside `verifyPayment` refuses the signature path too, and the
      // outcome here is `deferred`, never `verified`. The reason is that the
      // denylist GROWS between releases, so a job settled under an older build
      // can be re-read as degenerate by a newer one - and a deferral is
      // recoverable by rolling the SDK back inside the window, where a terminal
      // verdict is recoverable by nothing.
      seedLedger(REAL_SIGNATURE, RECIPIENT);
      listedSignatures = [];
      transactionsBySignature.set(REAL_SIGNATURE, payingTransaction());

      const outcome = await recovery.reVerifyPayment(
        entryUnderTest(),
        paymentRequestJson(RECIPIENT),
        PRICE,
        log,
      );

      expect(outcome).toBe('deferred');
      // Still owns what it owned: nothing was released on the way through.
      expect(entryUnderTest().payment_signature).toBe(REAL_SIGNATURE);
      // And the reference was never LISTED. This is the half the outcome cannot
      // show: carving the CHECK out instead of the ACTION also answers
      // `deferred` here, having first listed an address the payment is computed
      // from - for `reference === recipient` that is the provider's own wallet,
      // which is always full, so the operator is told their own address is a
      // flood hiding the payment.
      expect(listCalls).toBe(0);
    });
  });
});
