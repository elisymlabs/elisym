import { describe, expect, it } from 'vitest';
import { EMPTY_PRODUCTS_DIGEST, setupSteps } from '../../src/cloud/lib/setup-steps';
import { productsDigest } from '../../src/cloud/lib/status';
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

const current = (steps: ReturnType<typeof setupSteps>) =>
  steps.filter((step) => step.state === 'current').map((step) => step.key);

describe('the setup steps', () => {
  it('match the empty digest to an empty set', async () => {
    expect(await productsDigest({})).toBe(EMPTY_PRODUCTS_DIGEST);
  });

  it('walk a self-serve store from paying to launch, by what the store keeps', () => {
    const paid = { effectivePaidUntil: 1_800_000_000, storePubkey: 'b'.repeat(64) };
    const kept = status().kept;
    expect(setupSteps(status(), false).map((step) => [step.key, step.state])).toEqual([
      ['plan', 'done'],
      ['key', 'done'],
      ['pay', 'current'],
      ['name', 'next'],
      ['payouts', 'next'],
      ['products', 'next'],
      ['install', 'next'],
      ['launch', 'next'],
    ]);
    // Paid, store key not made yet: still paying (preparing).
    expect(current(setupSteps(status({ effectivePaidUntil: 1_800_000_000 }), false))).toEqual([
      'pay',
    ]);
    expect(current(setupSteps(status(paid), false))).toEqual(['name']);
    const named = { ...paid, kept: { ...kept, name: 'Shop' } };
    expect(current(setupSteps(status(named), false))).toEqual(['payouts']);
    const paidTo = {
      ...named,
      kept: { ...named.kept, payoutList: { id: 'f'.repeat(64), createdAt: 1 } },
    };
    expect(current(setupSteps(status(paidTo), false))).toEqual(['products']);
    const stocked = { ...paidTo, kept: { ...paidTo.kept, productsDigest: 'a'.repeat(64) } };
    expect(current(setupSteps(status(stocked), false))).toEqual(['launch']);
    expect(current(setupSteps(status({ ...stocked, runState: 'starting' }), false))).toEqual([]);
  });

  it('open only the plan, key and pay steps before the store key is made, then any', () => {
    const locked = (steps: ReturnType<typeof setupSteps>) =>
      steps.filter((step) => step.locked).map((step) => step.key);
    expect(locked(setupSteps(status({ effectivePaidUntil: 1 }), false))).toEqual([
      'name',
      'payouts',
      'products',
      'install',
      'launch',
    ]);
    expect(locked(setupSteps(status({ storePubkey: 'b'.repeat(64) }), false))).toEqual([]);
  });

  it('give an invited store no plan or pay step', () => {
    const steps = setupSteps(status(), true);
    expect(steps.map((step) => step.key)).toEqual([
      'key',
      'name',
      'payouts',
      'products',
      'install',
      'launch',
    ]);
    expect(current(steps)).toEqual(['name']);
  });

  it('go on past a step done out of order', () => {
    // Products kept before the payouts: the payouts are still current.
    const steps = setupSteps(
      status({
        effectivePaidUntil: 1,
        storePubkey: 'b'.repeat(64),
        kept: { ...status().kept, name: 'Shop', productsDigest: 'a'.repeat(64) },
      }),
      false,
    );
    expect(current(steps)).toEqual(['payouts']);
    expect(steps.find((step) => step.key === 'products')?.state).toBe('done');
  });
});
