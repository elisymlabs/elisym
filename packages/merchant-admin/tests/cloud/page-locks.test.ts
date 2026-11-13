import { describe, expect, it } from 'vitest';
import {
  NAME_FIRST,
  PAY_FIRST,
  PREPARING,
  PREPARING_PAID,
  READING,
  pageLocks,
} from '../../src/cloud/lib/page-locks';
import { EMPTY_PRODUCTS_DIGEST } from '../../src/cloud/lib/setup-steps';
import type { StoreStatus } from '../../src/cloud/lib/status';

function status(overrides: Partial<StoreStatus> = {}): StoreStatus {
  return {
    tier: 'starter',
    tierName: 'Starter',
    effectivePaidUntil: undefined,
    storePubkey: undefined,
    productCount: 0,
    pending: false,
    kept: {
      name: undefined,
      rails: [],
      payoutList: undefined,
      productsDigest: EMPTY_PRODUCTS_DIGEST,
    },
    ownerRefusal: undefined,
    resignInFlight: false,
    lastProblems: { store: undefined, 'owner-events': undefined, products: undefined },
    runState: 'not_launched',
    gates: {
      activation: 'not_paid',
      noCyclePending: true,
      homeReady: false,
      storeSetUp: false,
      domainSet: false,
    },
    usage: { month: '2027-01', paidOrders: 0, ordersPerMonth: 2000, products: 100 },
    ...overrides,
  };
}

const KEY = 'b'.repeat(64);
const SHUT_BEFORE_THE_KEY = ['orders', 'products', 'payouts', 'install', 'settings'];

describe('the pages a cloud store opens', () => {
  it('not paid: Overview, Plan & billing and Help; the rest wait for the first month', () => {
    const locks = pageLocks({ launched: false, invited: false, status: status() });
    expect(Object.keys(locks).sort()).toEqual([...SHUT_BEFORE_THE_KEY].sort());
    expect(new Set(Object.values(locks))).toEqual(new Set([PAY_FIRST]));
  });

  it('paid, its store key being made: the same pages, saying it is being prepared', () => {
    const locks = pageLocks({
      launched: false,
      invited: false,
      status: status({ effectivePaidUntil: 1_800_000_000 }),
    });
    expect(Object.keys(locks).sort()).toEqual([...SHUT_BEFORE_THE_KEY].sort());
    expect(new Set(Object.values(locks))).toEqual(new Set([PREPARING_PAID]));
  });

  it('invited (or paid by a partner), its key not made: no pay step, Plan & billing shut too', () => {
    for (const paid of [undefined, 1_800_000_000]) {
      const locks = pageLocks({
        launched: false,
        invited: true,
        status: status({ effectivePaidUntil: paid }),
      });
      expect(Object.keys(locks).sort()).toEqual([...SHUT_BEFORE_THE_KEY, 'billing'].sort());
      expect(new Set(Object.values(locks))).toEqual(new Set([PREPARING]));
    }
  });

  it('its key made: every page, Payouts only once the store keeps a name', () => {
    for (const invited of [false, true]) {
      expect(pageLocks({ launched: false, invited, status: status({ storePubkey: KEY }) })).toEqual(
        { payouts: NAME_FIRST },
      );
      expect(
        pageLocks({
          launched: false,
          invited,
          status: status({
            storePubkey: KEY,
            kept: { ...status().kept, name: 'Shop' },
          }),
        }),
      ).toEqual({});
    }
  });

  it('launched: every page, whatever the status says', () => {
    expect(pageLocks({ launched: true, invited: false, status: undefined })).toEqual({});
    expect(pageLocks({ launched: true, invited: true, status: status() })).toEqual({});
  });

  it('its status not read yet: only what needs no status opens', () => {
    const locks = pageLocks({ launched: false, invited: false, status: undefined });
    expect(Object.keys(locks).sort()).toEqual([...SHUT_BEFORE_THE_KEY].sort());
    expect(new Set(Object.values(locks))).toEqual(new Set([READING]));
  });
});
