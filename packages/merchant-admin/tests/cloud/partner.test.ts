import { describe, expect, it } from 'vitest';
import { STATUS_TEXT, partnerViewOf } from '../../src/cloud/lib/partner';

const USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MERCHANT = {
  tenantId: 'aaaaaaaaaaaa',
  tier: 'starter',
  tierName: 'Starter',
  network: 'mainnet',
  status: 'on_sale',
  activatedAt: 1_800_000_000,
  paidUntil: null,
  volume: { orders: 2, paid: { [USDC]: '3500000' } },
};
const VIEW = {
  partnerId: 'p000000000001',
  paidUntil: 1_800_000_000,
  volumeSince: 1_797_408_000,
  volume: { orders: 2, paid: { [USDC]: '3500000' } },
  merchants: [MERCHANT, { ...MERCHANT, tenantId: 'cccccccccccc', status: 'invited', volume: null }],
};

describe('the partner view as the console reads it', () => {
  it('takes a well-formed view', () => {
    expect(partnerViewOf(VIEW)).toEqual({
      partnerId: 'p000000000001',
      paidUntil: 1_800_000_000,
      volumeSince: 1_797_408_000,
      volume: { orders: 2, paid: [[USDC, '3500000']] },
      merchants: [
        {
          tenantId: 'aaaaaaaaaaaa',
          tier: 'starter',
          tierName: 'Starter',
          network: 'mainnet',
          status: 'on_sale',
          paidUntil: undefined,
          volume: { orders: 2, paid: [[USDC, '3500000']] },
        },
        {
          tenantId: 'cccccccccccc',
          tier: 'starter',
          tierName: 'Starter',
          network: 'mainnet',
          status: 'invited',
          paidUntil: undefined,
          volume: undefined,
        },
      ],
    });
    expect(partnerViewOf({ ...VIEW, paidUntil: null, merchants: [] })).toMatchObject({
      paidUntil: undefined,
      merchants: [],
    });
  });

  it('refuses any field that is not what it must be', () => {
    for (const broken of [
      { ...VIEW, partnerId: 1 },
      { ...VIEW, paidUntil: 'soon' },
      { ...VIEW, volumeSince: null },
      { ...VIEW, volume: null },
      { ...VIEW, volume: { orders: -1, paid: {} } },
      { ...VIEW, volume: { orders: 1.5, paid: {} } },
      { ...VIEW, volume: { orders: 1, paid: [] } },
      { ...VIEW, volume: { orders: 1, paid: { [USDC]: 5 } } },
      { ...VIEW, volume: { orders: 1, paid: { [USDC]: '1.5' } } },
      { ...VIEW, volume: { orders: 1, paid: { [USDC]: '01' } } },
      { ...VIEW, merchants: undefined },
      { ...VIEW, merchants: [{ ...MERCHANT, tierName: 1 }] },
      { ...VIEW, merchants: [{ ...MERCHANT, status: 'gone' }] },
      { ...VIEW, merchants: [{ ...MERCHANT, tenantId: 7 }] },
      { ...VIEW, merchants: [{ ...MERCHANT, tier: null }] },
      { ...VIEW, merchants: [{ ...MERCHANT, network: undefined }] },
      { ...VIEW, merchants: [{ ...MERCHANT, paidUntil: -1 }] },
      { ...VIEW, merchants: [{ ...MERCHANT, volume: { orders: 'x', paid: {} } }] },
      { ...VIEW, merchants: [MERCHANT, null] },
      null,
    ]) {
      expect(partnerViewOf(broken), JSON.stringify(broken)).toBeUndefined();
    }
  });

  it('names every status', () => {
    expect(Object.keys(STATUS_TEXT).sort()).toEqual(
      ['held', 'invited', 'off_sale', 'on_sale', 'setting_up', 'stopped'].sort(),
    );
  });
});
