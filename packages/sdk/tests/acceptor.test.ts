import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Address, address, getAddressDecoder } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SolanaPaymentStrategy } from '../src';
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

describe('what may become a terminal "nobody paid"', () => {
  it('says window-empty only for a window it read whole and found empty', async () => {
    listedPages = [[]];
    const result = await makeAcceptor(strategyVerifying()).accept(
      { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
      CONFIG,
    );
    expect(result).toMatchObject({ accepted: false, reason: 'window-empty' });
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
      // Unlike a failed transaction, this one was never LOOKED AT - it is an
      // untrusted answer, not a fact about the chain. A proxy blanking a page
      // would otherwise manufacture the one verdict a provider may act on.
      listedPages = [[{ signature: unusable as unknown as string, err: null }]];
      const result = await makeAcceptor(strategyVerifying()).accept(
        { paymentRequest: makeRequest(), jobIdentity: 'job-1' },
        CONFIG,
      );
      expect(result).toMatchObject({ accepted: false, reason: 'inconclusive' });
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
    // The gap every step-boundary check misses: an empty page means the
    // candidate loop never runs, so nothing after the listing looks at the
    // clock again. A pass that blew its deadline must not be able to report
    // the one verdict a provider may act on.
    listedPages = [[]];
    const slowRpc = {
      getSignaturesForAddress: vi.fn(() => ({
        send: async () => {
          listCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 60));
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
      { paymentRequest: makeRequest(), jobIdentity: 'job-1', budget: { deadlineMs: 20 } },
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

  it('starts clean when the file is merely absent', () => {
    // ENOENT is the one absence, and it must stay distinguishable from a file
    // that could not be read.
    expect(() => createFileSettlementStore(join(dir, 'fresh.json'))).not.toThrow();
  });

  it('keeps a settlement whose timestamp is unreadable', () => {
    // `0` would be older than any cutoff, so the next prune would release a
    // binding settlement. Holding one too long costs nothing.
    const path = join(dir, 'no-timestamp.json');
    writeFileSync(
      path,
      JSON.stringify({ version: 1, settlements: { [SIG_A]: { job: 'job-1' } } }),
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
    const acceptor = new ProviderPaymentAcceptor({
      strategy: strategyVerifying(),
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

  it('does not throw on a fee rate that is not a number', () => {
    // `expectedFee` is computed inside the `feeBps > 0` gate on purpose, so a
    // negative or NaN rate cannot make the predicate throw.
    expect(() =>
      classifyRequestUsability(makeRequest(), { feeBps: Number.NaN, treasury: TREASURY }),
    ).not.toThrow();
  });
});
