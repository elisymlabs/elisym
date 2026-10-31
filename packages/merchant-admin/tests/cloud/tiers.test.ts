import { describe, expect, it } from 'vitest';
import { startTierFrom } from '../../src/cloud/lib/tiers';

const STARTER = { id: 'starter', name: 'Starter', price: '$29/mo', selfServe: true };
const ENTERPRISE = { id: 'high-risk', name: 'Enterprise', price: 'from $499/mo', selfServe: false };

describe('the start tier as the console reads the catalog', () => {
  it('takes a self-serve tier the catalog names', () => {
    expect(startTierFrom({ tiers: [ENTERPRISE, STARTER] }, 'starter')).toEqual({
      name: 'Starter',
      price: '$29/mo',
    });
  });

  it('refuses anything else', () => {
    for (const [body, id] of [
      [{ tiers: { starter: STARTER } }, 'starter'],
      [{}, 'starter'],
      [{ tiers: [STARTER] }, 'business'],
      [{ tiers: [ENTERPRISE] }, 'high-risk'],
      [{ tiers: [{ ...STARTER, selfServe: 'true' }] }, 'starter'],
      [{ tiers: [{ ...STARTER, name: 1 }] }, 'starter'],
      [{ tiers: [{ ...STARTER, price: undefined }] }, 'starter'],
    ] as const) {
      expect(startTierFrom(body, id), JSON.stringify(body)).toBeUndefined();
    }
  });
});
