import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Address, address, getAddressDecoder } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      { ...CONFIG },
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

  it('refuses a retention short enough to free a still-verifiable settlement', () => {
    expect(() => store.prune(MIN_SETTLEMENT_RETENTION_MS - 1)).toThrow(/at least/);
    expect(store.prune(MIN_SETTLEMENT_RETENTION_MS)).toBe(0);
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
