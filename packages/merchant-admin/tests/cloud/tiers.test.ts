// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { UNREACHABLE } from '../../src/cloud/lib/api';
import {
  type TierCard,
  canStart,
  fetchTiers,
  paidBy,
  tierCardsFrom,
} from '../../src/cloud/lib/tiers';

const STARTER = {
  id: 'starter',
  name: 'Starter',
  price: '$29/mo',
  selfServe: true,
  limits: { products: 100, ordersPerMonth: 2000 },
  display: {},
  ownRpc: false,
  payable: { card: false, crypto: true },
};
const ENTERPRISE = {
  id: 'high-risk',
  name: 'Enterprise',
  price: 'from $499/mo',
  selfServe: false,
  limits: { products: 1200 },
  display: { products: 'No cap', ordersPerMonth: 'No cap' },
  ownRpc: true,
  payable: { card: false, crypto: false },
};

describe('the plan catalog as the admin reads it', () => {
  it('reads every field of every tier', () => {
    expect(tierCardsFrom({ tiers: [STARTER, ENTERPRISE] })).toEqual([
      {
        id: 'starter',
        name: 'Starter',
        price: '$29/mo',
        selfServe: true,
        limits: { products: 100, ordersPerMonth: 2000 },
        display: {},
        ownRpc: false,
        payable: { card: false, crypto: true },
      },
      {
        id: 'high-risk',
        name: 'Enterprise',
        price: 'from $499/mo',
        selfServe: false,
        limits: { products: 1200 },
        display: { products: 'No cap', ordersPerMonth: 'No cap' },
        ownRpc: true,
        payable: { card: false, crypto: false },
      },
    ]);
  });

  it('refuses a body that is not a catalog, or any tier with a field not what it must be', () => {
    const broken: ((tier: Record<string, unknown>) => void)[] = [
      (tier) => {
        tier.id = 1;
      },
      (tier) => {
        tier.name = '';
      },
      (tier) => {
        delete tier.price;
      },
      (tier) => {
        tier.selfServe = 'true';
      },
      (tier) => {
        tier.limits = { products: -1 };
      },
      (tier) => {
        tier.limits = { products: 1, ordersPerMonth: 1.5 };
      },
      (tier) => {
        tier.display = { products: 3 };
      },
      (tier) => {
        tier.display = null;
      },
      (tier) => {
        tier.ownRpc = undefined;
      },
      (tier) => {
        tier.payable = { card: true };
      },
      (tier) => {
        tier.payable = 'card';
      },
    ];
    for (const breakIt of broken) {
      const tier: Record<string, unknown> = JSON.parse(JSON.stringify(STARTER));
      breakIt(tier);
      expect(tierCardsFrom({ tiers: [ENTERPRISE, tier] }), JSON.stringify(tier)).toBeUndefined();
    }
    for (const body of [{}, { tiers: { starter: STARTER } }, null, 'tiers']) {
      expect(tierCardsFrom(body), JSON.stringify(body)).toBeUndefined();
    }
  });

  it('starts only a self-serve tier with a way to pay, and words the ways', () => {
    const cards = tierCardsFrom({ tiers: [STARTER, ENTERPRISE] }) ?? [];
    const [starter, enterprise] = cards;
    expect(starter !== undefined && canStart(starter)).toBe(true);
    expect(enterprise !== undefined && canStart(enterprise)).toBe(false);
    const unpaid: TierCard | undefined =
      starter === undefined ? undefined : { ...starter, payable: { card: false, crypto: false } };
    expect(unpaid !== undefined && canStart(unpaid)).toBe(false);
    // Payable is not enough: a tier that is not self-serve never starts here.
    const paidEnterprise: TierCard | undefined =
      enterprise === undefined
        ? undefined
        : { ...enterprise, payable: { card: true, crypto: true } };
    expect(paidEnterprise !== undefined && canStart(paidEnterprise)).toBe(false);
    expect(paidBy({ card: true, crypto: true })).toBe('Pay by card or in stablecoins');
    expect(paidBy({ card: true, crypto: false })).toBe('Pay by card');
    expect(paidBy({ card: false, crypto: true })).toBe('Pay in stablecoins');
    expect(paidBy({ card: false, crypto: false })).toBeUndefined();
  });
});

describe('reading the catalog', () => {
  it('asks the API origin for /tiers with no auth and no cache', async () => {
    const asked: Request[] = [];
    const answer = await fetchTiers('https://api.cloud.example/ignored/path', async (request) => {
      asked.push(request);
      return Response.json({ tiers: [STARTER] });
    });
    expect(answer).toEqual({ status: 200, body: { tiers: [STARTER] } });
    expect(asked.map((request) => request.url)).toEqual(['https://api.cloud.example/tiers']);
    expect(asked[0]?.method).toBe('GET');
    expect(asked[0]?.headers.get('authorization')).toBeNull();
    expect(asked[0]?.cache).toBe('no-store');
  });

  it('keeps a body that is not JSON as text, and a failed fetch is unreachable', async () => {
    expect(
      await fetchTiers(
        'https://api.cloud.example',
        async () => new Response('down', { status: 502 }),
      ),
    ).toEqual({ status: 502, body: 'down' });
    expect(
      await fetchTiers('https://api.cloud.example', () => Promise.reject(new Error('offline'))),
    ).toEqual(UNREACHABLE);
  });
});
