import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Address, address, getAddressDecoder } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, SolanaPaymentStrategy } from '../src';
import {
  MIN_SETTLEMENT_RETENTION_MS,
  ProviderPaymentAcceptor,
  type SettlementStore,
  classifyRequestUsability,
} from '../src/payment/acceptor';
import { resetDegenerateReferenceCache } from '../src/payment/degenerate-reference';
import { createFileSettlementStore } from '../src/payment/fileSettlementStore';
import type { PaymentStrategy, ProtocolConfigInput } from '../src/payment/strategy';
import type { PaymentRequestData, VerifyResult } from '../src/types';

const ADDRESS_DECODER = getAddressDecoder();
function makeAddress(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return ADDRESS_DECODER.decode(bytes) as string;
}

const RECIPIENT = makeAddress();
const TREASURY = address(makeAddress()) as Address;
const SIG_A = 'A'.repeat(88);
const SIG_B = 'B'.repeat(88);

/**
 * `feeBps: 0` throughout, matched by `fee_amount: 0`. A non-zero fee is the
 * config-dependent half of the usability predicate, which answers
 * `inconclusive` before the acceptor reaches anything under test.
 */
const CONFIG: ProtocolConfigInput = { feeBps: 0, treasury: TREASURY };

function makeRequest(overrides: Partial<PaymentRequestData> = {}): PaymentRequestData {
  return {
    recipient: RECIPIENT,
    amount: 1_000_000,
    reference: makeAddress(),
    fee_address: TREASURY as string,
    fee_amount: 0,
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 3600,
    network: 'devnet',
    ...overrides,
  } as PaymentRequestData;
}

/** What the listing answers, newest first, in the shape the acceptor reads. */
let listedPages: { signature: string; err: unknown }[][] = [];
let listFailures = 0;
let listCalls = 0;

function makeRpc() {
  return {
    getSignaturesForAddress: vi.fn(() => ({
      send: async () => {
        listCalls += 1;
        if (listFailures > 0) {
          listFailures -= 1;
          throw new Error('rpc listing unavailable');
        }
        return listedPages.shift() ?? [];
      },
    })),
    getTransaction: vi.fn(() => ({ send: async () => null })),
  } as never;
}

/** Verifies exactly the signatures named, and nothing else. */
function strategyVerifying(...verifying: string[]): PaymentStrategy {
  return {
    chain: 'solana',
    verifyPayment: vi.fn(
      async (
        _rpc: unknown,
        _req: unknown,
        _cfg: unknown,
        options?: { txSignature?: string },
      ): Promise<VerifyResult> => {
        const asked = options?.txSignature;
        if (asked !== undefined && verifying.includes(asked)) {
          return { verified: true, txSignature: asked };
        }
        return { verified: false, error: 'not a payment for this request' };
      },
    ),
  } as unknown as PaymentStrategy;
}

let dir: string;
let store: SettlementStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elisym-acceptor-'));
  store = createFileSettlementStore(join(dir, 'settlements.json'));
  listedPages = [];
  listFailures = 0;
  listCalls = 0;
  resetDegenerateReferenceCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeAcceptor(strategy: PaymentStrategy): ProviderPaymentAcceptor {
  return new ProviderPaymentAcceptor({ strategy, rpc: makeRpc(), store });
}

describe('one settlement settles one job', () => {
  it('accepts a candidate from the window and binds it to the job', async () => {
    listedPages = [[{ signature: SIG_A, err: null }]];
    const result = await makeAcceptor(strategyVerifying(SIG_A)).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );

    expect(result).toEqual({ accepted: true, txSignature: SIG_A });
    expect(store.owner(SIG_A)).toBe('job-1');
  });

  it('refuses the same transaction to a second job', async () => {
    listedPages = [[{ signature: SIG_A, err: null }], [{ signature: SIG_A, err: null }]];
    const acceptor = makeAcceptor(strategyVerifying(SIG_A));
    await acceptor.accept({ paymentRequest: makeRequest(), jobIdentity: 'job-1' }, CONFIG);

    const second = await acceptor.accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-2' },
      CONFIG,
    );

    // Not `window-empty`: the window WAS looked at, and what it held belonged
    // to someone else. Saying "nobody paid" here is the terminal verdict this
    // whole rail exists to withhold.
    expect(second).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(store.owner(SIG_A)).toBe('job-1');
  });

  it("keeps walking past another job's candidate to the one that is ours", async () => {
    // No other fixture reaches this branch with a SECOND candidate behind the
    // skipped one, so `continue` and `break` are indistinguishable to all of
    // them - measured. And a stranger's transaction ahead of ours is the
    // ordinary case, not a pathology: the reference is public, and one transfer
    // can carry several jobs' references. With `break` the customer has paid,
    // their transfer sits one row lower in the same window, and the job refuses
    // forever.
    store.claim(SIG_B, 'job-other');
    listedPages = [
      [
        { signature: SIG_B, err: null },
        { signature: SIG_A, err: null },
      ],
    ];

    const result = await makeAcceptor(strategyVerifying(SIG_A)).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );

    expect(result).toEqual({ accepted: true, txSignature: SIG_A });
  });

  it('asks for the whole window, at the commitment the verdict depends on', async () => {
    // `windowFull` compares the page against `VERIFY_SIGNATURE_LIMIT` rather
    // than against what was actually requested, so "short page means the whole
    // history" holds only while the two numbers are the same one. Nothing else
    // holds them together - the mock ignores the options object entirely.
    //
    // `confirmed` is pinned for the other half of the same verdict: the RPC
    // default is `finalized`, where a payment confirmed seconds ago is not in
    // the listing at all and an empty window means nothing.
    const rpc = makeRpc();
    listedPages = [[]];
    const acceptor = new ProviderPaymentAcceptor({ strategy: strategyVerifying(), rpc, store });
    // The REFERENCE, spelled out rather than `expect.anything()`. `makeRequest`
    // mints a fresh reference per call while the recipient and the treasury are
    // module constants, so this one argument tells all three apart - and the
    // difference is the whole point of a reference: list the provider's own
    // wallet instead and the customer's transfer drowns in a busy history, goes
    // over the edge of the window, and the pass reads as an empty window. That
    // is `window-empty`, the one verdict a provider may close a paid job on.
    const request = makeRequest();

    await acceptor.accept({ paymentRequest: request, jobIdentity: 'job-1' }, CONFIG);

    expect(
      (rpc as unknown as { getSignaturesForAddress: ReturnType<typeof vi.fn> })
        .getSignaturesForAddress,
    ).toHaveBeenCalledWith(request.reference, {
      limit: DEFAULTS.VERIFY_SIGNATURE_LIMIT,
      commitment: 'confirmed',
    });
  });

  it('does not even verify a candidate that belongs to another job', async () => {
    // One invariant, two guards - this skip and the store's `consumed-by-other`
    // - and either one alone keeps `refuses the same transaction to a second
    // job` green. So each is pinned where it LIVES: removing this one has to
    // turn this fixture red, removing the other one the store fixture below.
    //
    // The discriminator is whether the strategy was ASKED, not what the pass
    // returned: sending somebody else's settlement to `verifyPayment` is the
    // step that leaves only the store between a stranger's transfer and a second
    // delivery.
    store.claim(SIG_A, 'job-1');
    listedPages = [[{ signature: SIG_A, err: null }]];
    const strategy = strategyVerifying(SIG_A);

    const result = await makeAcceptor(strategy).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-2' },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(strategy.verifyPayment).not.toHaveBeenCalled();
    expect(store.owner(SIG_A)).toBe('job-1');
  });

  it('claims the signature it ASKED about, not the one the strategy echoed', async () => {
    // An injected strategy is not trusted to name the settlement: echoing back
    // another job's transaction would redirect the de-duplication claim.
    const echoing = {
      chain: 'solana',
      verifyPayment: vi.fn(async () => ({ verified: true, txSignature: SIG_B })),
    } as unknown as PaymentStrategy;
    listedPages = [[{ signature: SIG_A, err: null }]];

    const result = await makeAcceptor(echoing).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );

    expect(result).toEqual({ accepted: true, txSignature: SIG_A });
    expect(store.owner(SIG_B)).toBeUndefined();
  });
});

describe('a caller that has already given up', () => {
  it('runs neither step 1 nor step 2', async () => {
    // The two steps before the listing are covered for each other by a sticky
    // `deadlineHit` flag: any surviving check stops the listing, so removing
    // BOTH of these leaves every other fixture green - measured. What it costs
    // is what the docstring for `signal` promises: an abandoned pass still
    // spends `retriesForOwnSettlement` plus `retriesPerCandidate` verifications
    // at `intervalMs` apart, which is tens of seconds of work for a caller that
    // is no longer there.
    store.claim(SIG_A, 'job-1');
    const strategy = strategyVerifying(SIG_A);

    const result = await makeAcceptor(strategy).accept(
      {
        paymentRequest: makeRequest(),
        jobIdentity: 'job-1',
        txSignature: SIG_A,
        signal: AbortSignal.abort(),
      },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(strategy.verifyPayment).not.toHaveBeenCalled();
    expect(listCalls).toBe(0);
  });
});

describe('a caller that leaves DURING the pass', () => {
  it('gives up at step 2, not only at step 1', async () => {
    // `deadlineHit` is sticky, so a signal that was already aborted when
    // `accept` was called is caught by step 1 and every later check is
    // indistinguishable. The ordinary case is the other one: step 1 spends its
    // own retry budget - five verifications two seconds apart by default - and
    // the abort lands inside it.
    store.claim(SIG_A, 'job-1');
    const controller = new AbortController();
    const strategy = {
      chain: 'solana',
      verifyPayment: vi.fn(async () => {
        controller.abort();
        return { verified: false, error: 'not yet indexed' };
      }),
    } as unknown as PaymentStrategy;

    const result = await makeAcceptor(strategy).accept(
      {
        paymentRequest: makeRequest(),
        jobIdentity: 'job-1',
        txSignature: SIG_B,
        signal: controller.signal,
      },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    // Step 1 ran and step 2 did not: one call, not two.
    expect(strategy.verifyPayment).toHaveBeenCalledTimes(1);
    expect(listCalls).toBe(0);
  });

  it('does not list a window for a pass abandoned during step 2', async () => {
    // The check before the listing, which the row above cannot reach: there
    // step 1 is what aborts, here step 2 is.
    const controller = new AbortController();
    const strategy = {
      chain: 'solana',
      verifyPayment: vi.fn(async () => {
        controller.abort();
        return { verified: false, error: 'not yet indexed' };
      }),
    } as unknown as PaymentStrategy;
    listedPages = [[{ signature: SIG_A, err: null }]];

    const result = await makeAcceptor(strategy).accept(
      {
        paymentRequest: makeRequest(),
        jobIdentity: 'job-1',
        txSignature: SIG_B,
        signal: controller.signal,
      },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(listCalls).toBe(0);
  });

  it('stops walking candidates the moment the caller leaves', async () => {
    // The check inside the walk. Two candidates, and the abort lands while the
    // first is being verified: the second must not be asked about.
    const controller = new AbortController();
    const strategy = {
      chain: 'solana',
      verifyPayment: vi.fn(async () => {
        controller.abort();
        return { verified: false, error: 'not yet indexed' };
      }),
    } as unknown as PaymentStrategy;
    listedPages = [
      [
        { signature: SIG_A, err: null },
        { signature: SIG_B, err: null },
      ],
    ];

    const result = await makeAcceptor(strategy).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', signal: controller.signal },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(strategy.verifyPayment).toHaveBeenCalledTimes(1);
  });
});

describe('the signature the customer sent', () => {
  it('is accepted and bound, without listing anything', async () => {
    const result = await makeAcceptor(strategyVerifying(SIG_A)).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', txSignature: SIG_A },
      CONFIG,
    );

    expect(result).toEqual({ accepted: true, txSignature: SIG_A });
    expect(store.owner(SIG_A)).toBe('job-1');
    expect(listCalls).toBe(0);
  });

  it('marks the pass when it does not verify, so an empty window cannot follow', async () => {
    // The signature may simply not be indexed yet. Without the mark the verdict
    // would land on `window-empty` for a customer who paid a minute ago.
    listedPages = [[]];
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', txSignature: SIG_A },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
  });
});

describe('a claim the disk refuses', () => {
  /** Verifies anything, and cannot write. */
  function unwritableStore(): SettlementStore {
    return {
      claim: () => 'not-persisted',
      owner: () => undefined,
      claimedSignature: () => undefined,
      prune: () => 0,
    };
  }

  it('refuses the payment rather than deliver against a claim that is not there', async () => {
    listedPages = [[{ signature: SIG_A, err: null }]];
    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(SIG_A),
      rpc: makeRpc(),
      store: unwritableStore(),
    });

    const result = await acceptor.accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'not-persisted' });
  });

  it('refuses at STEP 2 as well, where the customer named the signature', async () => {
    // Same contract one step up: the payment verified, the claim did not reach
    // disk, and the job must not be delivered. Only the step-4 path had a
    // fixture, and the two differ by which input named the signature.
    listedPages = [[]];
    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(SIG_A),
      rpc: makeRpc(),
      store: unwritableStore(),
    });

    const result = await acceptor.accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', txSignature: SIG_A },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'not-persisted' });
    expect(listCalls).toBe(0);
  });

  it('marks the pass at STEP 2 when the claim is lost, not only at step 4', async () => {
    // The same asymmetry one step up, and the other half of it: here the claim
    // is not refused by the disk but LOST to another job, and the mark is all
    // that keeps the verdict off `window-empty`. Step 4 has its own fixture for
    // this and argued for it - a public store interface is implemented by
    // people who are not us - while step 2, where the signature came from the
    // CUSTOMER, had none.
    const losing: SettlementStore = {
      claim: () => 'consumed-by-other',
      owner: () => undefined,
      claimedSignature: () => undefined,
      prune: () => 0,
    };
    listedPages = [[]];
    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(SIG_A),
      rpc: makeRpc(),
      store: losing,
    });

    const result = await acceptor.accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', txSignature: SIG_A },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(result).not.toMatchObject({ reason: 'window-empty' });
    // The window WAS read, and read empty: without the mark this pass is
    // exactly the shape a provider may close a paid job on.
    expect(listCalls).toBe(1);
  });

  it('accepts anyway when the job already owned that settlement', async () => {
    // The one exception, and it is not generosity: the signature is already
    // persistent and already this job's, so the claim here only refreshes a
    // timestamp. A disk refusal does not get to undo proven ownership.
    const owning: SettlementStore = {
      ...unwritableStore(),
      claimedSignature: () => SIG_A,
    };
    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(SIG_A),
      rpc: makeRpc(),
      store: owning,
    });

    const result = await acceptor.accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );

    expect(result).toEqual({ accepted: true, txSignature: SIG_A });
  });
});

describe('a third-party store whose reverse view disagrees', () => {
  it("does not skip the job's OWN signature when it turns up in the window", async () => {
    // The walk skips a candidate that belongs to ANOTHER job, not one that
    // merely has an owner. With the file-backed store the difference never
    // shows - `claimedSignature` names it and step 1 settles it first - but the
    // interface is public, and a store whose reverse view is a second source
    // can answer `undefined` there while the forward index still attributes the
    // signature to this job. Reading the guard as "has an owner" throws the
    // job's own payment away and reports inconclusive forever.
    const divergent: SettlementStore = {
      claim: (signature, jobIdentity) => store.claim(signature, jobIdentity),
      owner: (signature) => store.owner(signature),
      claimedSignature: () => undefined,
      prune: (retentionMs) => store.prune(retentionMs),
    };
    store.claim(SIG_A, 'job-1');
    listedPages = [[{ signature: SIG_A, err: null }]];

    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(SIG_A),
      rpc: makeRpc(),
      store: divergent,
    });
    const result = await acceptor.accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );

    expect(result).toEqual({ accepted: true, txSignature: SIG_A });
  });
});

describe('a candidate that verified but lost the race for the claim', () => {
  it('marks the pass, so the window cannot be called empty', async () => {
    // Reachable only through a store whose forward view and `claim` disagree -
    // the acceptor skips such a candidate first when they agree - which is
    // exactly why it needs a fixture: a public interface is implemented by
    // people who are not us. Without the mark the walk ends with nothing
    // recorded and the verdict lands on `window-empty`, the one a provider may
    // read as "nobody paid", about a transaction that verified.
    const losing: SettlementStore = {
      claim: () => 'consumed-by-other',
      owner: () => undefined,
      claimedSignature: () => undefined,
      prune: () => 0,
    };
    listedPages = [[{ signature: SIG_A, err: null }]];
    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(SIG_A),
      rpc: makeRpc(),
      store: losing,
    });

    const result = await acceptor.accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(result).not.toMatchObject({ reason: 'window-empty' });
    // And the pass says WHY. This is the most informative sentence the walk can
    // produce, and it used to be dropped on the floor - the operator got
    // whatever earlier candidate happened to fail, or nothing.
    expect(result).toMatchObject({
      error: expect.stringContaining('already bound to another job'),
    });
  });
});

describe('what may become a terminal "nobody paid"', () => {
  it('says window-empty only for a window it read whole and found empty', async () => {
    // The first listing attempt FAILS and the second comes back short and
    // empty, which is both legal and the only shape where this matters: the
    // pass has read a whole window, so the verdict stands, and `lastError`
    // holds the first attempt's complaint. Without that the fixture cannot see
    // the leak at all - `toEqual` ignores a key whose value is `undefined`, so
    // a verdict built as `{reason, error: lastError}` passes it whenever
    // nothing ever set `lastError`. Measured: with a clean listing the leaking
    // shape is green.
    listFailures = 1;
    listedPages = [[]];
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );

    expect(listCalls).toBe(2);
    // `toEqual`, not `toMatchObject`: the docstring promises no `error` on this
    // verdict, and a partial match is true of a shape carrying one.
    expect(result).toEqual({ accepted: false, reason: 'window-empty' });
  });

  it('never says it when a candidate failed to verify', async () => {
    // "Not a payment" and "I could not read the chain" arrive as the same
    // `{verified: false}`, so a throttling RPC must not read as "nobody paid".
    listedPages = [[{ signature: SIG_A, err: null }]];
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );
    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
  });

  it('never says it when the window came back full', async () => {
    // 25 failed transactions: all dropped, the walk is empty and there is
    // nothing to mark - but the real payment could be hiding behind the flood.
    listedPages = [
      Array.from({ length: 25 }, (_, index) => ({ signature: `F${index}`, err: { some: 'err' } })),
    ];
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );
    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
  });

  it.each([[''], [null]])(
    'never says it when the node reported an unusable signature (%s)',
    async (unusable) => {
      // Two things at once, and the second is the one no fixture measured: the
      // pass is marked, AND the blank is never handed to `verifyPayment`. Its
      // falsy dispatch reads `''` as "no signature given" and takes the
      // REFERENCE path, which comes back with whatever transaction is newest on
      // that reference - a stranger's, if one is there. Checked as
      // `isUsableSignature` rather than `=== undefined` for exactly that, and
      // the verdict alone cannot tell the two apart.
      //
      // Unlike a failed transaction, this one was never LOOKED AT - it is an
      // untrusted answer, not a fact about the chain. A proxy blanking a page
      // would otherwise manufacture the one verdict a provider may act on.
      listedPages = [[{ signature: unusable as unknown as string, err: null }]];
      const strategy = strategyVerifying();
      const result = await makeAcceptor(strategy).accept(
        { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
        CONFIG,
      );
      expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
      expect(strategy.verifyPayment).not.toHaveBeenCalled();
    },
  );

  it('never says it when the listing failed every attempt', async () => {
    listFailures = 3;
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );
    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
  });

  it('never says it when no listing attempt was made at all', async () => {
    listedPages = [[]];
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', budget: { listAttempts: 0 } },
      CONFIG,
    );
    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(listCalls).toBe(0);
  });

  it('never says it when the caller aborted', async () => {
    // A pass the caller gave up on has seen less than the whole window, so it
    // gets the same treatment as one that ran out of budget. Without this the
    // `signal` on the public input would be a promise of cancellation that
    // nothing keeps.
    listedPages = [[]];
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', signal: AbortSignal.abort() },
      CONFIG,
    );
    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(listCalls).toBe(0);
  });

  it('never says it when the budget ran out while the listing was in flight', async () => {
    // Budgets are 200ms against a 400ms listing, not 20 against 40: the check
    // before the listing has to be FALSE when the pass starts, and on a loaded
    // machine the few milliseconds between `accept` and that call are not a
    // safe margin - measured at 2-5ms, which a tight budget turns into a flake.
    // The gap every step-boundary check misses: an empty page means the
    // candidate loop never runs, so nothing after the listing looks at the
    // clock again. A pass that blew its deadline must not be able to report
    // the one verdict a provider may act on.
    listedPages = [[]];
    const slowRpc = {
      getSignaturesForAddress: vi.fn(() => ({
        send: async () => {
          listCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 400));
          return [];
        },
      })),
      getTransaction: vi.fn(() => ({ send: async () => null })),
    } as never;
    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(),
      rpc: slowRpc,
      store,
    });

    const result = await acceptor.accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', budget: { deadlineMs: 200 } },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(listCalls).toBe(1);
  });

  it('never says it when the caller aborted while the listing was in flight', async () => {
    // Same gap, reached the other way. The existing abort test passes an
    // already-aborted signal, which is caught at step 1 and never reaches here.
    const controller = new AbortController();
    const abortingRpc = {
      getSignaturesForAddress: vi.fn(() => ({
        send: async () => {
          listCalls += 1;
          controller.abort();
          return [];
        },
      })),
      getTransaction: vi.fn(() => ({ send: async () => null })),
    } as never;
    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(),
      rpc: abortingRpc,
      store,
    });

    const result = await acceptor.accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', signal: controller.signal },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(listCalls).toBe(1);
  });

  it('never says it when the deadline had already passed', async () => {
    listedPages = [[]];
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', budget: { deadlineMs: 0 } },
      CONFIG,
    );
    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
  });
});

describe("the job's own settlement", () => {
  it('is checked first, without listing anything', async () => {
    store.claim(SIG_A, 'job-1');
    const result = await makeAcceptor(strategyVerifying(SIG_A)).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );

    expect(result).toEqual({ accepted: true, txSignature: SIG_A });
    expect(listCalls).toBe(0);
  });

  it('keeps the job inconclusive when its own settlement stops verifying', async () => {
    // The pass is NOT marked imperfect by a step-1 failure, which is what keeps
    // this rule from being inert - but a job that owns a settlement can never
    // be told "nobody paid".
    store.claim(SIG_A, 'job-1');
    listedPages = [[]];
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );
    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
  });
});

describe('a request that cannot be paid at all', () => {
  it('is terminal, and is decided before any network call', async () => {
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest({ amount: 0 }), jobIdentity: 'job-1' },
      CONFIG,
    );
    expect(result).toMatchObject({ accepted: false, reason: 'unusable-request' });
    expect(listCalls).toBe(0);
  });

  it('is NOT terminal for a job that already owns a settlement', async () => {
    // The carve-out. "Terminal only if it could not have been paid under any
    // configuration" holds within one version of this SDK, and both lists grow.
    // Growing one must never destroy money on a job whose settlement is already
    // claimed and was once verified.
    store.claim(SIG_A, 'job-1');
    const result = await makeAcceptor(strategyVerifying(SIG_A)).accept(
      { paymentRequest: makeRequest({ amount: 0 }), jobIdentity: 'job-1' },
      CONFIG,
    );
    expect(result).toEqual({ accepted: true, txSignature: SIG_A });
    expect(listCalls).toBe(0);
  });

  it('does not treat an EMPTY claimed signature as a settlement worth carving out', async () => {
    // The carve-out asks whether the job owns a settlement, and it asks with
    // `isUsableSignature`: a hand-edited index carries an empty string, which
    // owns nothing. Read as ownership, a request that cannot be paid at all
    // stops being terminal and the entry is polled to the cutoff instead of
    // failing now with the real reason. The fixture that seeds an empty
    // signature elsewhere covers steps 1 and 6, never this read.
    const path = join(dir, 'empty-carve-out.json');
    writeFileSync(
      path,
      JSON.stringify({ version: 1, settlements: { '': { job: 'job-1', at: Date.now() } } }),
      'utf-8',
    );
    const seeded = createFileSettlementStore(path);
    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(),
      rpc: makeRpc(),
      store: seeded,
    });

    const result = await acceptor.accept(
      { paymentRequest: makeRequest({ amount: 0 }), jobIdentity: 'job-1' },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'unusable-request' });
  });

  it('is inconclusive, not accepted, when the carved-out job has a degenerate reference', async () => {
    // The OTHER half of the carve-out, and it lands differently from the row
    // above: the real verifier runs the same degenerate-reference check ahead of
    // both its branches, so step 1 cannot accept either and the pass ends
    // `inconclusive` - a recoverable verdict, which is the whole point of
    // carving the step-0 refusal out.
    //
    // Written against the REAL strategy deliberately. An injected one that
    // verifies anything answers `accepted: true` here and would pin the
    // opposite of what ships.
    //
    // And the assertion that carries it is `getTransaction` never being called,
    // not the verdict: with the degenerate check taken out of `verifyPayment`
    // the verdict is STILL `inconclusive` - the retries simply run out against
    // an RPC that answers `null` - and this fixture then goes red by TIMEOUT
    // rather than by measurement. A hung fixture is not a killed mutant.
    store.claim(SIG_A, 'job-1');
    const rpc = makeRpc();
    const acceptor = new ProviderPaymentAcceptor({
      strategy: new SolanaPaymentStrategy(),
      rpc,
      store,
    });

    const result = await acceptor.accept(
      {
        paymentRequest: makeRequest({ reference: RECIPIENT }),
        jobIdentity: 'job-1',
        // A one-shot budget, so the mutant answers in milliseconds and this
        // fixture goes red on the ASSERTION below. Left at the defaults it
        // spends five retries two seconds apart and dies of the vitest timeout
        // instead - a hang, which proves nothing.
        budget: { retriesForOwnSettlement: 1, retriesPerCandidate: 1, intervalMs: 0 },
      },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(listCalls).toBe(0);
    expect(
      (rpc as unknown as { getTransaction: ReturnType<typeof vi.fn> }).getTransaction,
    ).not.toHaveBeenCalled();
  });

  it('is terminal for an asset nothing can resolve, and does not throw on it', async () => {
    // Step 0 runs the usability predicate FIRST and the reference check second,
    // and that order is load-bearing rather than tidy: the reference check
    // resolves the asset inside itself and THROWS on one it does not know.
    // Reversed, this call leaves `accept` as an exception rather than a verdict
    // and takes the provider's loop with it - measured. Nothing else in this
    // file reaches step 0 with an unresolvable asset.
    const result = await makeAcceptor(strategyVerifying()).accept(
      {
        paymentRequest: makeRequest({
          asset: { chain: 'solana', token: 'nosuch', decimals: 6 },
        } as never),
        jobIdentity: 'job-1',
      },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'unusable-request' });
    expect(listCalls).toBe(0);
  });

  it('answers inconclusive - never terminal - for a fee the config disagrees with', async () => {
    // The fee rate lives on-chain and changes without a client release, so a
    // request incompatible with today's fee is polled until its own expiry
    // rather than killed.
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest({ fee_amount: 0 }), jobIdentity: 'job-1' },
      { feeBps: 300, treasury: TREASURY },
    );
    expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
    expect(listCalls).toBe(0);
  });

  it('refuses a reference the payment is computed from', async () => {
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest({ reference: RECIPIENT }), jobIdentity: 'job-1' },
      CONFIG,
    );
    expect(result).toMatchObject({ accepted: false, reason: 'degenerate_reference' });
    expect(listCalls).toBe(0);
  });
});

describe('inputs the acceptor refuses to start on', () => {
  it.each([[''], [null], [undefined]])('throws on jobIdentity %s', async (bad) => {
    await expect(
      makeAcceptor(strategyVerifying()).accept(
        { paymentRequest: makeRequest(), jobIdentity: bad as unknown as string },
        CONFIG,
      ),
    ).rejects.toThrow(/jobIdentity/);
  });

  it.each([[Number.NaN], [-1], [1.5]])('throws on a feeBps of %s', async (bad) => {
    // The last check before an INJECTED strategy is handed the request. With a
    // rate that is not a non-negative integer the fee gate inside the predicate
    // is skipped whole (`NaN > 0` is merely false), and a payment is accepted
    // with no fee check at all. `SolanaPaymentStrategy` catches it again; the
    // interface does not require that of anyone else.
    //
    // Only `NaN` and `-1` discriminate: `1.5 > 0` holds, so that row would be
    // refused by `calculateProtocolFee` even with this check gone, and its
    // message matches the same pattern. It is here as the third shape of "not a
    // non-negative integer", not as a measurement of this line.
    await expect(
      makeAcceptor(strategyVerifying()).accept(
        { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
        { feeBps: bad as number, treasury: TREASURY },
      ),
    ).rejects.toThrow(/feeBps/);
  });

  it.each([[''], [null]])('throws on a txSignature of %s', async (bad) => {
    // Falsy there means `verifyPayment` dispatches to the REFERENCE path and
    // comes back with a stranger's signature this job may not claim.
    await expect(
      makeAcceptor(strategyVerifying()).accept(
        {
          paymentRequest: makeRequest(),
          jobIdentity: 'job-1',
          txSignature: bad as unknown as string,
        },
        CONFIG,
      ),
    ).rejects.toThrow(/txSignature/);
  });
});

describe('the store contract', () => {
  it('throws rather than key a claim on an unusable signature', () => {
    expect(() => store.claim('', 'job-1')).toThrow(/signature/);
    expect(() => store.claim(SIG_A, '')).toThrow(/jobIdentity/);
  });

  it('lets the same job re-claim what it already holds', () => {
    expect(store.claim(SIG_A, 'job-1')).toBe('claimed');
    expect(store.claim(SIG_A, 'job-1')).toBe('claimed');
  });

  it('releases the previous signature when a job claims a second one', () => {
    store.claim(SIG_A, 'job-1');
    store.claim(SIG_B, 'job-1');
    expect(store.claimedSignature('job-1')).toBe(SIG_B);
    expect(store.owner(SIG_A)).toBeUndefined();
  });

  it('refreshes the timestamp when a job re-claims what it already holds', () => {
    // The JSDoc of the record says `at` is "refreshed on re-claim, drives
    // retention". Without that, a long-lived job that keeps re-claiming its own
    // settlement is swept out from under itself once the original claim ages
    // past the retention - and the transaction it recorded is free again.
    const path = join(dir, 'refresh.json');
    const seeded = createFileSettlementStore(path);
    const old = Date.now() - MIN_SETTLEMENT_RETENTION_MS - 60_000;
    writeFileSync(
      path,
      JSON.stringify({ version: 1, settlements: { [SIG_A]: { job: 'job-1', at: old } } }),
      'utf-8',
    );

    expect(seeded.claim(SIG_A, 'job-1')).toBe('claimed');

    expect(seeded.prune(MIN_SETTLEMENT_RETENTION_MS)).toBe(0);
    expect(seeded.owner(SIG_A)).toBe('job-1');
  });

  it('refuses a signature another job already holds, and does not move it', () => {
    // The second guard of the de-duplication invariant. The acceptor skips such
    // a candidate before it ever reaches here, which is exactly why this half is
    // pinned at the store: a `SettlementStore` is public, and an acceptor is not
    // the only thing that may call `claim`.
    expect(store.claim(SIG_A, 'job-1')).toBe('claimed');

    expect(store.claim(SIG_A, 'job-2')).toBe('consumed-by-other');
    expect(store.owner(SIG_A)).toBe('job-1');
    expect(store.claimedSignature('job-2')).toBeUndefined();
  });

  it('keeps a settlement the file names __proto__ as an ordinary key', () => {
    // The READ path, which the fresh-index rows below do not reach. Written as
    // raw JSON rather than through `JSON.stringify`: an object literal with a
    // `__proto__:` key sets the prototype instead of the key, so the fixture
    // would ship an empty index and prove nothing.
    //
    // With `{}` in place of `Object.create(null)` the assignment REPLACES the
    // prototype, the entry disappears from `Object.entries`, and the reverse
    // lookup stops finding a settlement the file plainly records - which is the
    // job being told to pay again.
    const path = join(dir, 'proto-key.json');
    writeFileSync(
      path,
      `{"version":1,"settlements":{"__proto__":{"job":"job-1","at":${Date.now()}}}}`,
      'utf-8',
    );
    const seeded = createFileSettlementStore(path);

    expect(seeded.claimedSignature('job-1')).toBe('__proto__');
    expect(seeded.owner('__proto__')).toBe('job-1');
  });

  it('releases a settlement older than the retention, and keeps a fresh one', () => {
    // The deleting half of `prune` is otherwise dead for this whole suite: every
    // other row either refuses the retention or passes an infinite one, so the
    // `delete` and the counter could both be removed with the file green.
    const path = join(dir, 'aging.json');
    const now = Date.now();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        settlements: {
          [SIG_A]: { job: 'job-1', at: now - MIN_SETTLEMENT_RETENTION_MS - 1_000 },
          [SIG_B]: { job: 'job-2', at: now },
        },
      }),
      'utf-8',
    );
    const seeded = createFileSettlementStore(path);

    expect(seeded.prune(MIN_SETTLEMENT_RETENTION_MS)).toBe(1);
    expect(seeded.owner(SIG_A)).toBeUndefined();
    expect(seeded.owner(SIG_B)).toBe('job-2');
    // And it was WRITTEN, not merely dropped from the one read that computed it.
    expect(createFileSettlementStore(path).owner(SIG_A)).toBeUndefined();
  });

  it('refuses to read an index it cannot parse, instead of treating it as empty', () => {
    // The failure this whole file prevents: an index read as empty reports every
    // signature as unclaimed, and one transfer carrying several jobs'
    // references settles them all over again. A truncated file is not exotic -
    // `rename` buys atomic visibility, not durability - so refusing to start is
    // the direction that cannot lose money.
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{"version":1,"settlements":{"AAA":{"job":', 'utf-8');

    expect(() => createFileSettlementStore(path)).toThrow(/not readable JSON/);
  });

  it.each([
    ['a null settlements map', { version: 1, settlements: null }],
    ['an array where the map belongs', { version: 1, settlements: [] }],
    ['a number where the map belongs', { version: 1, settlements: 42 }],
    ['no settlements map at all', { version: 1 }],
    ['a top-level array', []],
    ['no version at all', { settlements: {} }],
  ])('refuses %s rather than read it as empty', (_label, contents) => {
    // `typeof null` and `typeof []` are both `'object'`, which is exactly how
    // these walked through the first version of this guard.
    const path = join(dir, `shape-${String(_label).replace(/\W+/g, '-')}.json`);
    writeFileSync(path, JSON.stringify(contents), 'utf-8');

    expect(() => createFileSettlementStore(path)).toThrow(/not a settlement index|format version/);
  });

  it.each([[Number.NaN], [undefined], ['30 days' as unknown as number]])(
    'refuses a retention of %s',
    (bad) => {
      expect(() => store.prune(bad as number)).toThrow(/at least/);
    },
  );

  it('keeps a settlement for thirty days, which is what the reasoning rests on', () => {
    // Every other retention fixture is self-referential (`MIN`, `MIN - 1`), so
    // the constant could be a second and the file would stay green. The number
    // is the claim: a signature dropped from the index has to be unverifiable
    // on-chain by then, and a public RPC keeps two to three days.
    expect(MIN_SETTLEMENT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('allows an infinite retention - "never release anything"', () => {
    expect(store.prune(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('refuses an index written by a different format version', () => {
    // Same class without the crash: a future layout read by today's rules
    // reports its settlements as unclaimed.
    const path = join(dir, 'v2.json');
    writeFileSync(path, JSON.stringify({ version: 2, settlements: {} }), 'utf-8');

    expect(() => createFileSettlementStore(path)).toThrow(/format version 2/);
  });

  it('refuses a path it could not read at all, which is not an absent one', () => {
    // ENOENT is the ONE absence, and the discriminator is otherwise killed by
    // nothing - measured. A directory where the file belongs (EISDIR), a file
    // owned by another uid (EACCES), a volume mounted read-only: reading any of
    // those as an empty index reports every settlement as unclaimed, and one
    // transfer carrying several jobs' references settles them all again.
    const path = join(dir, 'as-a-directory.json');
    mkdirSync(path);

    expect(() => createFileSettlementStore(path)).toThrow(/EISDIR|illegal operation/);
  });

  it('cannot have a claim swallowed by a temporary somebody else guessed', () => {
    // The write half of the blocking-node class, and the CLI's two indexes have
    // the same pair of fixtures. A predictable temporary is a path another user
    // can put a FIFO on: `writeFileSync` onto one never returns, and with a
    // reader draining it, it returns having written nothing - `claim` then says
    // `claimed` about a record that is not on disk, which is exactly what the
    // interface promises it never does.
    //
    // The DRAINER is what makes this a measurement rather than a hang.
    const path = join(dir, 'guessable.json');
    const store = createFileSettlementStore(path);
    // Three plausible schemes, not one: the point is that NO name can be
    // guessed, and a fixture that plants a single one measures only that
    // scheme. These are the two this file has used and the one the CLI's
    // sibling fixtures use.
    const guessed = [
      join(dir, `.guessable.json.${process.pid}.tmp`),
      join(dir, '.guessable.json.tmp'),
      `${path}.tmp`,
    ];
    for (const candidate of guessed) {
      execFileSync('mkfifo', [candidate]);
    }
    // ONE drainer per pipe, not one loop over three: `readFileSync` on a FIFO
    // blocks at OPEN until a writer arrives, so a single child sits on the first
    // name forever and the other two become traps that HANG the run instead of
    // failing it. Measured - with the loop, two of these three schemes timed the
    // suite out instead of naming a test.
    const drainers = guessed.map((candidate) =>
      spawn(
        process.execPath,
        [
          '-e',
          `const fs=require('fs');
           const loop=()=>{ try { fs.readFileSync(${JSON.stringify(candidate)}); } catch {} setImmediate(loop); };
           loop();`,
        ],
        { detached: true, stdio: 'ignore' },
      ),
    );
    try {
      expect(store.claim(SIG_A, 'job-1')).toBe('claimed');

      // Asserted on the DISK, before reopening the store: with a guessable name
      // the write goes into the pipe and the rename leaves a FIFO where the
      // index belongs, so a second `createFileSettlementStore` would die on the
      // node-type gate instead - red for a reason next door to this one.
      expect(statSync(path).isFile()).toBe(true);
      const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as {
        settlements: Record<string, { job: string }>;
      };
      expect(onDisk.settlements[SIG_A]?.job).toBe('job-1');
      for (const candidate of guessed) {
        expect(statSync(candidate).isFIFO()).toBe(true);
      }
    } finally {
      for (const drainer of drainers) {
        // `-0` would signal OUR OWN process group, which is the vitest run.
        if (drainer.pid === undefined) {
          drainer.kill('SIGKILL');
          continue;
        }
        try {
          process.kill(-drainer.pid);
        } catch {
          drainer.kill('SIGKILL');
        }
      }
    }
  });

  it('refuses an index path that is a node which blocks', () => {
    // Same reasoning as the unreadable path above, and the reason it needs its
    // own row: this one does not fail the read at all. `readFileSync` on a FIFO
    // takes the whole event loop with it, so neither the ENOENT branch nor the
    // constructor's refusal would ever run.
    //
    // The WRITER is what makes this a measurement: it feeds a perfectly valid
    // index, so without the gate the constructor SUCCEEDS and this row goes red
    // on its assertion. Without a writer the ungated build hangs the whole run
    // instead - measured, and a hung run has killed nothing.
    const path = join(dir, 'piped.json');
    execFileSync('mkfifo', [path]);
    const writer = spawn(
      process.execPath,
      [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(
          JSON.stringify({ version: 1, settlements: {} }),
        )});`,
      ],
      { detached: true, stdio: 'ignore' },
    );
    try {
      expect(() => createFileSettlementStore(path)).toThrow(/pipe, socket or device/);
    } finally {
      // `-0` would signal OUR OWN process group, which is the vitest run.
      if (writer.pid === undefined) {
        writer.kill('SIGKILL');
      } else {
        try {
          process.kill(-writer.pid);
        } catch {
          writer.kill('SIGKILL');
        }
      }
    }
  });

  it('starts clean when the file is merely absent', () => {
    // ENOENT is the one absence, and it must stay distinguishable from a file
    // that could not be read.
    expect(() => createFileSettlementStore(join(dir, 'fresh.json'))).not.toThrow();
  });

  it.each([
    ['null', null],
    ['a numeric string', '0'],
    ['a boolean', true],
  ])('keeps a settlement whose timestamp is %s', (_label, at) => {
    // `0` would be older than any cutoff, so the next prune would release a
    // binding settlement. Holding one too long costs nothing.
    //
    // An ABSENT field is deliberately not one of these rows: `undefined <
    // cutoff` is false, so a missing `at` survives however the value is read,
    // and a fixture built on it is green with the type check removed. Each of
    // these three coerces to something SMALLER than the cutoff instead - and
    // the numeric string is why `?? Date.now()` is not enough either.
    const path = join(dir, `no-timestamp-${String(_label).replace(/\W+/g, '-')}.json`);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, settlements: { [SIG_A]: { job: 'job-1', at } } }),
      'utf-8',
    );
    const seeded = createFileSettlementStore(path);

    expect(seeded.prune(MIN_SETTLEMENT_RETENTION_MS)).toBe(0);
    expect(seeded.owner(SIG_A)).toBe('job-1');
  });

  it('hands back an empty signature it was seeded with, and the acceptor ignores it', async () => {
    // `claimedSignature` returns what the forward index attributes RIGHT NOW,
    // empty string included: filtering here would make this fixture vacuous and
    // let "an unusable signature counts as the job's own settlement" survive.
    // The acceptor is what has to reject it.
    const path = join(dir, 'empty-key.json');
    writeFileSync(
      path,
      JSON.stringify({ version: 1, settlements: { '': { job: 'job-1', at: Date.now() } } }),
      'utf-8',
    );
    const seeded = createFileSettlementStore(path);
    expect(seeded.claimedSignature('job-1')).toBe('');

    listedPages = [[]];
    const strategy = strategyVerifying();
    const acceptor = new ProviderPaymentAcceptor({
      strategy,
      rpc: makeRpc(),
      store: seeded,
    });
    const result = await acceptor.accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );

    // Treated as "owns nothing": the window was read whole and was empty, so
    // the verdict is the terminal one rather than the `inconclusive` a real
    // settlement would have forced.
    expect(result).toMatchObject({ accepted: false, reason: 'window-empty' });
    // And STEP 1 never handed the blank to `verifyPayment`. The verdict alone
    // cannot see that: a strategy asked about `''` answers `{verified: false}`,
    // which marks nothing and lands on the same `window-empty`. What the blank
    // would actually do there is take the falsy dispatch down the REFERENCE
    // path and come back with whatever transaction is newest on that reference
    // - a stranger's, if one is there. Measured: without this line, reading the
    // gate as `!== undefined` passes the whole file.
    expect(strategy.verifyPayment).not.toHaveBeenCalled();
  });

  it.each([['__proto__'], ['toString'], ['constructor']])(
    "does not mistake %s for somebody else's claim on a fresh index",
    (inherited) => {
      // A plain object literal answers these from `Object.prototype`, so the
      // store would report a signature nobody ever claimed as already bound.
      // The read path was fixed first; this is the path a first run takes.
      const fresh = createFileSettlementStore(join(dir, `proto-${inherited}.json`));

      expect(fresh.owner(inherited)).toBeUndefined();
      expect(fresh.claim(inherited, 'job-1')).toBe('claimed');
    },
  );

  it('answers not-persisted when the disk refuses the write, rather than throwing', () => {
    // The only source of `not-persisted` in the store that ships - every other
    // fixture for that outcome injects a store that cannot write. The branch it
    // feeds (step 1, step 2 and step 4 of `accept`, the member of
    // `SettlementClaim`, and the paragraph of documentation telling providers to
    // handle it separately) rested on a try/catch no test entered.
    if (process.getuid?.() === 0) {
      return; // root ignores the mode bits, so there is nothing to refuse
    }
    const locked = join(dir, 'locked');
    const path = join(locked, 'settlements.json');
    const store = createFileSettlementStore(path);
    chmodSync(locked, 0o500);
    try {
      expect(store.claim(SIG_A, 'job-1')).toBe('not-persisted');
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it.each([
    ['a job that is not a string', { job: 42, at: Date.now() }],
    ['an empty job identity', { job: '', at: Date.now() }],
    // `null` is the row that carries the object guard: reading `.job` off it
    // THROWS, so without that guard the whole index refuses to load over one
    // hand-edited entry. A bare string is dropped by that SAME guard (`typeof
    // 'nonsense' !== 'object'`) - measured, it stays green with the job guard
    // removed too, so it is covered twice and discriminates neither.
    ['a null record', null],
    ['a record that is a bare string', 'nonsense'],
  ])('drops %s instead of admitting it to the index', (_label, record) => {
    // A hand-edited or half-written record must not become an owner: the
    // acceptor skips any candidate whose `owner` is neither undefined nor this
    // job, so an entry keyed on a bogus identity would put that signature out
    // of every job's reach permanently, and `claim` would answer
    // `consumed-by-other` about a claim nobody made.
    const path = join(dir, `bad-record-${String(_label).replace(/\W+/g, '-')}.json`);
    writeFileSync(path, JSON.stringify({ version: 1, settlements: { [SIG_A]: record } }), 'utf-8');
    const seeded = createFileSettlementStore(path);

    expect(seeded.owner(SIG_A)).toBeUndefined();
    expect(seeded.claim(SIG_A, 'job-1')).toBe('claimed');
  });

  it('writes the index owner-only, which is the first line of the file', () => {
    // The index names which job a transfer paid for, so the mode is a property
    // of the file and not of the temporary it was written through - and
    // `writeFileSync`'s `mode` is a REQUEST, filtered by the umask, which is
    // why the store chmods after writing. Nothing else measured either.
    if (process.getuid?.() === 0) {
      return; // root's umask games do not tell us anything here
    }
    // In a directory the STORE creates, not the one `mkdtemp` made: that one is
    // 0o700 whatever this file does, and asserting on it would pass against any
    // `STORE_DIR_MODE` at all.
    //
    // What this row pins is the PAIR: `writeFileSync`'s `mode` is a request the
    // umask filters, so the store chmods after writing, and removing BOTH turns
    // this red. Removing the chmod ALONE kills nothing in THIS file and cannot:
    // an ordinary umask strips no bit from 0o600, and the temporary now carries
    // a random suffix, so there is never a stale one to reuse. It does turn
    // `settlement-store-write-atomicity.test.ts` red, but only because that
    // file injects its failure THROUGH `chmodSync`. Measured, not assumed.
    const made = join(dir, 'made-by-the-store');
    const path = join(made, 'modes.json');
    const seeded = createFileSettlementStore(path);
    seeded.claim(SIG_A, 'job-1');

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(made).mode & 0o777).toBe(0o700);
  });

  it('refuses a retention that is a string, however numeric it looks', () => {
    // A relational test coerces, so `'2592000000' >= MIN` is true. Only the
    // `typeof` half keeps a string out.
    expect(() => store.prune('2592000000' as unknown as number)).toThrow(/at least/);
  });

  it('releases nothing at all on an infinite retention', () => {
    // Seeded, because on an empty index `toBe(0)` is true however the cutoff is
    // computed - a sign error would pass unnoticed.
    store.claim(SIG_A, 'job-1');

    expect(store.prune(Number.POSITIVE_INFINITY)).toBe(0);
    expect(store.owner(SIG_A)).toBe('job-1');
  });

  it('refuses a retention short enough to free a still-verifiable settlement', () => {
    expect(() => store.prune(MIN_SETTLEMENT_RETENTION_MS - 1)).toThrow(/at least/);
    expect(store.prune(MIN_SETTLEMENT_RETENTION_MS)).toBe(0);
  });
});

describe('the usability predicate against the real verifier', () => {
  /**
   * The parity the predicate's own docstring promises. It MIRRORS the
   * verifier's preconditions rather than being extracted from them, so the two
   * can drift - and one direction costs money: `unusable-request` is terminal,
   * so anything the predicate calls unpayable had better be something the real
   * verifier also refuses without even asking the chain.
   *
   * The discriminator is whether the RPC was TOUCHED, not what came back.
   * `verifyPayment` reports "I could not reach the chain" as the same
   * `{verified: false}` it uses for "this is not a payment", so asserting on
   * that alone is true for every input and proves nothing.
   */
  const realStrategy = new SolanaPaymentStrategy();
  let getTransaction: ReturnType<typeof vi.fn>;

  function spyingRpc() {
    getTransaction = vi.fn(() => ({
      send: () => Promise.reject(new Error('reached the chain')),
    }));
    return { getTransaction, getSignaturesForAddress: getTransaction } as never;
  }

  it.each([
    ['a missing reference', { reference: undefined }],
    ['a missing recipient', { recipient: undefined }],
    ['a zero amount', { amount: 0 }],
    ['a non-integer amount', { amount: 1.5 }],
    ['a negative fee amount', { fee_amount: -1 }],
    ['an unresolvable asset', { asset: { chain: 'solana', token: 'nosuch', decimals: 6 } }],
  ])('refuses %s in both, and never asks the chain', async (_label, overrides) => {
    const request = makeRequest(overrides as never);
    const rpc = spyingRpc();

    expect(classifyRequestUsability(request, CONFIG)).toBe('unusable-request');
    const verified = await realStrategy.verifyPayment(rpc, request, CONFIG, {
      txSignature: SIG_A,
      retries: 1,
      intervalMs: 0,
    });

    expect(verified.verified).toBe(false);
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it('is STRICTER than the verifier about the reference format, and that is the safe way', async () => {
    // The one place the two deliberately disagree, so it gets a name rather
    // than a row. `verifyPayment` only tests the reference for truthiness
    // (`solana.ts`), so a malformed one sends it to the chain to look for a
    // transaction that cannot exist; the predicate checks the format and calls
    // it terminal.
    //
    // Terminal is right here: an address that is not an address can never
    // appear in any transaction, so no amount of waiting finds a payment. The
    // direction is what matters - the predicate refusing MORE than the verifier
    // costs a job that was unpayable anyway, while refusing less would let a
    // terminal verdict land on a request the verifier would have taken.
    const request = makeRequest({ reference: 'not-an-address' } as never);
    const rpc = spyingRpc();

    expect(classifyRequestUsability(request, CONFIG)).toBe('unusable-request');
    await realStrategy.verifyPayment(rpc, request, CONFIG, {
      txSignature: SIG_A,
      retries: 1,
      intervalMs: 0,
    });

    expect(getTransaction).toHaveBeenCalled();
  });

  it('sends a request it calls payable to the chain', async () => {
    // The control. Without it every row above would pass against a verifier
    // that refused everything, and the drift worth catching - the predicate
    // calling something terminal that the verifier would have accepted - is
    // exactly what would go unnoticed.
    const request = makeRequest();
    const rpc = spyingRpc();

    expect(classifyRequestUsability(request, CONFIG)).toBeUndefined();
    await realStrategy.verifyPayment(rpc, request, CONFIG, {
      txSignature: SIG_A,
      retries: 1,
      intervalMs: 0,
    });

    expect(getTransaction).toHaveBeenCalled();
  });
});

describe('the usability predicate mirrors the verifier, and says so', () => {
  it.each([
    ['a missing reference', { reference: undefined }],
    ['a null reference', { reference: null }],
    ['a malformed reference', { reference: 'not-an-address' }],
    ['a missing recipient', { recipient: undefined }],
    ['a non-integer amount', { amount: 1.5 }],
    ['a negative fee amount', { fee_amount: -1 }],
  ])('calls %s unusable', (_label, overrides) => {
    expect(classifyRequestUsability(makeRequest(overrides as never), CONFIG)).toBe(
      'unusable-request',
    );
  });

  it('passes a request the verifier would accept', () => {
    expect(classifyRequestUsability(makeRequest(), CONFIG)).toBeUndefined();
  });

  it('calls a zero-fee request with no fee address payable, which is the mainnet shape', () => {
    // `feeBps` is 0 on the deployed mainnet program, and a zero-fee request may
    // leave `fee_address` out entirely. Reading the gate as `>= 0` instead of
    // `> 0` makes exactly that request `inconclusive` forever - measured - and
    // every fixture in this file carries a fee address, so nothing saw it.
    expect(
      classifyRequestUsability(
        makeRequest({ fee_address: undefined, fee_amount: undefined }),
        CONFIG,
      ),
    ).toBeUndefined();
  });

  it('calls a request paying EXACTLY the fee payable, which is every request under a live fee', () => {
    // The positive control the live-fee half never had. Every `toBeUndefined`
    // in this file runs at `feeBps: 0`, where the gate is skipped whole - so
    // `feeAmount < expectedFee` read as `<=` leaves the file green, and that
    // mutant makes a correctly built request `inconclusive` FOREVER the moment
    // governance sets a non-zero rate. `createPaymentRequest` stamps
    // `fee_amount` at exactly `calculateProtocolFee`, so the boundary is the
    // ordinary case rather than an edge.
    expect(
      classifyRequestUsability(makeRequest({ fee_amount: 30_000 }), {
        feeBps: 300,
        treasury: TREASURY,
      }),
    ).toBeUndefined();
  });

  it.each([
    ['a missing fee address', { fee_address: undefined }],
    ['a fee address that is not the treasury', { fee_address: makeAddress() }],
  ])('answers inconclusive - never terminal - for %s under a live fee', (_label, overrides) => {
    // Both fee-address shapes, and neither is terminal: the rate and the
    // treasury both live on-chain and rotate without a client release, so a
    // request incompatible with today's config is polled until its own expiry
    // rather than killed.
    //
    // The first row pins an OUTCOME, not a removable branch: with the
    // `!fee_address` line taken out the next one answers the same, because
    // `undefined !== treasury`. Measured, and said in the source too.
    expect(
      classifyRequestUsability(makeRequest({ fee_amount: 30_000, ...overrides }), {
        feeBps: 300,
        treasury: TREASURY,
      }),
    ).toBe('inconclusive');
  });

  it('does not throw on a fee rate that is not a number', () => {
    // `expectedFee` is computed inside the `feeBps > 0` gate on purpose, so a
    // negative or NaN rate cannot make the predicate throw.
    expect(() =>
      classifyRequestUsability(makeRequest(), { feeBps: Number.NaN, treasury: TREASURY }),
    ).not.toThrow();
  });
});

describe('what the acceptor actually hands the verifier', () => {
  /** Records every call the acceptor makes, and never verifies anything. */
  function recordingStrategy(
    seen: { rpc: unknown; request: unknown; config: unknown; options: unknown }[],
  ) {
    return {
      chain: 'solana',
      verifyPayment: vi.fn(
        async (
          rpc: unknown,
          request: unknown,
          config: unknown,
          options?: unknown,
        ): Promise<VerifyResult> => {
          seen.push({ rpc, request, config, options });
          return { verified: false, error: 'not a payment for this request' };
        },
      ),
    } as unknown as PaymentStrategy;
  }

  it('hands it the connection, the request, the live config and the budget', async () => {
    // The most consequential line in `accept`, and nothing looked at it: every
    // other fixture drives the mock by `options.txSignature` alone. Hand the
    // verifier a request with the amount rewritten, or a config with the fee
    // rate zeroed, and it verifies a payment nobody made at the price nobody
    // agreed to - with the whole suite green.
    //
    // All FOUR arguments, the connection included: a strategy handed some other
    // rpc verifies nothing this provider was paid on, and the first version of
    // this fixture measured three of the four.
    const seen: { rpc: unknown; request: unknown; config: unknown; options: unknown }[] = [];
    // A non-zero rate on purpose: with `feeBps: 0` a config that has been
    // blanked on the way in is indistinguishable from the real one. Same for
    // the interval - a fixture that passes 0 cannot tell a collapse to 0 apart.
    const liveFee: ProtocolConfigInput = { feeBps: 300, treasury: TREASURY };
    const request = makeRequest({ fee_amount: 30_000 });
    const rpc = makeRpc();
    listedPages = [[{ signature: SIG_A, err: null }]];

    await new ProviderPaymentAcceptor({ strategy: recordingStrategy(seen), rpc, store }).accept(
      {
        paymentRequest: request,
        jobIdentity: 'job-1',
        budget: { retriesPerCandidate: 2, intervalMs: 50 },
      },
      liveFee,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.rpc).toBe(rpc);
    expect(seen[0]?.request).toEqual(request);
    expect(seen[0]?.config).toEqual(liveFee);
    expect(seen[0]?.options).toMatchObject({ txSignature: SIG_A, retries: 2, intervalMs: 50 });
  });

  it('spends the own-settlement budget only on step 1, and asks the three steps in order', async () => {
    // Two named fields of the public input, defaulting to 5 and 3, and swapping
    // them left every fixture green: nothing told them apart. Step 1 asks about
    // evidence the job already owns and is worth waiting on; steps 2 and 3 ask
    // about a signature a counterparty chose and about a stranger's transaction
    // out of a public listing.
    //
    // All three signatures differ, so this also pins the SUBJECT of each step -
    // the order the source argues for in words, measured here for the first
    // time.
    const SIG_C = 'C'.repeat(88);
    store.claim(SIG_A, 'job-1');
    const seen: { rpc: unknown; request: unknown; config: unknown; options: unknown }[] = [];
    listedPages = [[{ signature: SIG_C, err: null }]];

    await makeAcceptor(recordingStrategy(seen)).accept(
      {
        paymentRequest: makeRequest(),
        jobIdentity: 'job-1',
        txSignature: SIG_B,
        budget: { retriesForOwnSettlement: 7, retriesPerCandidate: 2, intervalMs: 0 },
      },
      CONFIG,
    );

    expect(
      seen.map((call) => call.options as { txSignature?: string; retries?: number }),
    ).toMatchObject([
      { txSignature: SIG_A, retries: 7 },
      { txSignature: SIG_B, retries: 2 },
      { txSignature: SIG_C, retries: 2 },
    ]);
  });

  it("asks step 1 about the job's OWN settlement, never the signature the customer sent", async () => {
    // The order the source argues for in words - own evidence first, the most
    // counterparty-controlled input last - and no fixture reached step 1 with a
    // customer-supplied signature in hand, so "verify what we already own" and
    // "verify what they told us" were the same measurement.
    store.claim(SIG_A, 'job-1');
    const asked: (string | undefined)[] = [];
    const recording = {
      chain: 'solana',
      verifyPayment: vi.fn(
        async (
          _rpc: unknown,
          _request: unknown,
          _config: unknown,
          options?: { txSignature?: string },
        ): Promise<VerifyResult> => {
          asked.push(options?.txSignature);
          return { verified: true, txSignature: options?.txSignature };
        },
      ),
    } as unknown as PaymentStrategy;

    const result = await makeAcceptor(recording).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', txSignature: SIG_B },
      CONFIG,
    );

    expect(asked).toEqual([SIG_A]);
    expect(result).toEqual({ accepted: true, txSignature: SIG_A });
    // And the customer's signature is not claimed along the way.
    expect(store.owner(SIG_B)).toBeUndefined();
  });

  it('re-claims its own settlement THROUGH the store, refreshing the retention clock', async () => {
    // The store fixture for this refresh calls `claim` directly, so nothing
    // obliged production to reach it: drop the re-claim as "we already own it"
    // and the suite stays green while `at` stops moving. A job long enough to
    // outlive the retention window then has its signature swept out from under
    // it by the next prune, and that transaction is free to pay for a second
    // job.
    const path = join(dir, 'refresh-through-accept.json');
    const stale = Date.now() - MIN_SETTLEMENT_RETENTION_MS - 60_000;
    writeFileSync(
      path,
      JSON.stringify({ version: 1, settlements: { [SIG_A]: { job: 'job-1', at: stale } } }),
      'utf-8',
    );
    const seeded = createFileSettlementStore(path);
    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(SIG_A),
      rpc: makeRpc(),
      store: seeded,
    });

    expect(
      await acceptor.accept({ paymentRequest: makeRequest(), jobIdentity: 'job-1' }, CONFIG),
    ).toEqual({ accepted: true, txSignature: SIG_A });

    // Nothing to sweep: the claim above moved the timestamp forward.
    expect(seeded.prune(MIN_SETTLEMENT_RETENTION_MS)).toBe(0);
    expect(seeded.owner(SIG_A)).toBe('job-1');
  });

  it('refuses a reference equal to the protocol treasury, which only the CONFIG names', async () => {
    // `fee_address` is omitted on purpose: with it present the same address
    // reaches the denylist from the REQUEST, and routing the recipient in place
    // of the config treasury stays invisible. Omitted is also the shape mainnet
    // actually sends, since the fee rate there is zero.
    const result = await makeAcceptor(strategyVerifying()).accept(
      {
        paymentRequest: makeRequest({
          reference: TREASURY as string,
          fee_address: undefined,
          fee_amount: undefined,
        }),
        jobIdentity: 'job-1',
      },
      CONFIG,
    );

    expect(result).toMatchObject({ accepted: false, reason: 'degenerate_reference' });
  });
});
