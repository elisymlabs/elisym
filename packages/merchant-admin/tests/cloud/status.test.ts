import { describe, expect, it } from 'vitest';
import { productsDigest, statusReadOf } from '../../src/cloud/lib/status';

const DIGEST_EMPTY = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

/** A status as cloud-api answers it (its route test's snapshot). */
function answer(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'aaaaaaaaaaaa',
    tier: 'starter',
    tierName: 'Starter',
    effectivePaidUntil: null,
    storePubkey: 'b'.repeat(64),
    productCount: 0,
    pending: false,
    kept: { name: null, rails: [], payoutList: null, productsDigest: DIGEST_EMPTY },
    ownerRefusal: null,
    resignInFlight: false,
    lastProblems: { store: null, 'owner-events': null, products: null },
    runState: 'not_launched',
    gates: {
      activation: 'not_paid',
      noCyclePending: true,
      homeReady: true,
      storeSetUp: false,
      domainSet: false,
    },
    usage: { month: '2027-01', paidOrders: 0, ordersPerMonth: 2000, products: 100 },
    ...overrides,
  };
}

describe('the products digest (the vectors cloud-api tests too)', () => {
  it('hashes the set with its names sorted as strings, integer-like ones too', async () => {
    expect(await productsDigest({ b: '2', a: '1' })).toBe(
      '21f76dfbfe6dfe21f762080ef484112cf2952974cef30741fd1931e1c6d92112',
    );
    expect(await productsDigest({})).toBe(DIGEST_EMPTY);
    expect(await productsDigest({ a: 'c', 2: 'b', 10: 'a' })).toBe(
      '55437579e3e6a9e07966f54fefa9e5c83e1b3798c0f90c80e50200ed0625d924',
    );
  });
});

describe('reading the status', () => {
  it('reads every field, nulls as none', () => {
    expect(statusReadOf(answer())).toEqual({
      gone: false,
      tier: 'starter',
      tierName: 'Starter',
      effectivePaidUntil: undefined,
      storePubkey: 'b'.repeat(64),
      productCount: 0,
      pending: false,
      kept: { name: undefined, rails: [], payoutList: undefined, productsDigest: DIGEST_EMPTY },
      ownerRefusal: undefined,
      resignInFlight: false,
      lastProblems: { store: undefined, 'owner-events': undefined, products: undefined },
      runState: 'not_launched',
      gates: {
        activation: 'not_paid',
        noCyclePending: true,
        homeReady: true,
        storeSetUp: false,
        domainSet: false,
      },
      usage: { month: '2027-01', paidOrders: 0, ordersPerMonth: 2000, products: 100 },
    });
  });

  it('reads a store set up, refused and unlimited', () => {
    const read = statusReadOf(
      answer({
        effectivePaidUntil: 1_800_000_000,
        storePubkey: null,
        kept: {
          name: 'Shop',
          rails: ['solana', 'base'],
          payoutList: { id: 'f'.repeat(64), createdAt: 1_800_000_000 },
          productsDigest: DIGEST_EMPTY,
        },
        ownerRefusal: 'resign',
        resignInFlight: true,
        lastProblems: { store: null, 'owner-events': null, products: ['products/x: bad'] },
        gates: {
          activation: null,
          noCyclePending: false,
          homeReady: false,
          storeSetUp: true,
          domainSet: true,
        },
        usage: { month: '2027-01', paidOrders: 3, ordersPerMonth: null, products: 1000 },
      }),
    );
    expect(read).toMatchObject({
      effectivePaidUntil: 1_800_000_000,
      storePubkey: undefined,
      kept: { name: 'Shop', rails: ['solana', 'base'], payoutList: { id: 'f'.repeat(64) } },
      ownerRefusal: 'resign',
      resignInFlight: true,
      lastProblems: { products: ['products/x: bad'] },
      gates: { activation: undefined, noCyclePending: false, storeSetUp: true, domainSet: true },
      usage: { ordersPerMonth: undefined, paidOrders: 3 },
    });
  });

  it('reads a store gone from its state alone', () => {
    expect(statusReadOf({ tenantId: 'aaaaaaaaaaaa', runState: 'gone' })).toEqual({ gone: true });
  });

  it('refuses an answer with any field not what it must be', () => {
    const broken: Record<string, unknown>[] = [
      { runState: 'flying' },
      { tier: 1 },
      { tierName: null },
      { effectivePaidUntil: -1 },
      { storePubkey: 'B'.repeat(64) },
      { productCount: 1.5 },
      { pending: 'no' },
      { kept: { name: null, rails: ['dogecoin'], payoutList: null, productsDigest: DIGEST_EMPTY } },
      { kept: { name: null, rails: [], payoutList: { id: 1 }, productsDigest: DIGEST_EMPTY } },
      {
        kept: {
          name: null,
          rails: [],
          payoutList: { id: 'f'.repeat(64), createdAt: 'yesterday' },
          productsDigest: DIGEST_EMPTY,
        },
      },
      { kept: { name: null, rails: [], payoutList: null, productsDigest: 'x' } },
      { ownerRefusal: 'maybe' },
      { resignInFlight: null },
      { lastProblems: { store: [1], 'owner-events': null, products: null } },
      { lastProblems: { store: null, 'owner-events': null } },
      {
        gates: {
          activation: 1,
          noCyclePending: true,
          homeReady: true,
          storeSetUp: true,
          domainSet: true,
        },
      },
      {
        gates: {
          activation: null,
          noCyclePending: 'yes',
          homeReady: true,
          storeSetUp: true,
          domainSet: true,
        },
      },
      { usage: { month: '2027-01', paidOrders: -1, ordersPerMonth: null, products: 1 } },
      { usage: { month: '2027-01', paidOrders: 0, ordersPerMonth: 'many', products: 1 } },
    ];
    for (const overrides of broken) {
      expect(statusReadOf(answer(overrides))).toBeUndefined();
    }
  });
});
