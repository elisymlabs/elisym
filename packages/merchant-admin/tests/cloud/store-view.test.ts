import { describe, expect, it } from 'vitest';
import { explainAnswer } from '../../src/cloud/lib/errors';
import { billingUrlFrom } from '../../src/cloud/lib/origin';
import {
  billingPageUrl,
  cardRefusalText,
  cryptoRefusalText,
  stripeSessionUrl,
} from '../../src/cloud/lib/rails';
import { checkoutReturnOf } from '../../src/cloud/lib/start';
import { shownTime, storeViewOf } from '../../src/cloud/lib/store-view';

const VIEW = {
  tier: 'starter',
  tierName: 'Starter',
  network: 'mainnet',
  activated: false,
  launch: 'console',
  paidUntil: null,
  partner: null,
  payBy: null,
  rails: {
    card: { open: true },
    crypto: { open: false, refusal: { code: 'card_subscription_live' } },
  },
  sale: { withdrawnAt: null, ownerWithdrawn: false, held: false, stopped: false },
  exporting: false,
  exportStopped: null,
  export: null,
};

describe('the owner view as the console reads it', () => {
  it('takes a well-formed view', () => {
    expect(storeViewOf(VIEW)).toEqual({
      tier: 'starter',
      tierName: 'Starter',
      network: 'mainnet',
      activated: false,
      launch: 'console',
      paidUntil: undefined,
      partner: undefined,
      payBy: undefined,
      card: { open: true, refusal: undefined },
      crypto: { open: false, refusal: { code: 'card_subscription_live' } },
      withdrawn: false,
      withdrawnAt: undefined,
      ownerWithdrawn: false,
      held: false,
      stopped: false,
      exporting: false,
      exportStopped: undefined,
      exported: undefined,
    });
    expect(storeViewOf({ ...VIEW, exporting: true })?.exporting).toBe(true);
    expect(storeViewOf({ ...VIEW, exportStopped: 'resign' })?.exportStopped).toBe('resign');
    expect(storeViewOf({ ...VIEW, exportStopped: 'revoked' })?.exportStopped).toBe('revoked');
    for (const bad of [undefined, 'other', true]) {
      expect(storeViewOf({ ...VIEW, exportStopped: bad }), String(bad)).toBeUndefined();
    }
    expect(
      storeViewOf({ ...VIEW, partner: { partnerId: 'p1', paidUntil: 1_800_000_000 } })?.partner,
    ).toEqual({ paidUntil: 1_800_000_000 });
    expect(storeViewOf({ ...VIEW, partner: { paidUntil: null } })?.partner).toEqual({
      paidUntil: undefined,
    });
    expect(
      storeViewOf({
        ...VIEW,
        sale: { withdrawnAt: 1_800_000_000, ownerWithdrawn: true, held: true, stopped: true },
        export: { exportedAt: 1_800_000_100, archiveReady: true, destroyAt: 1_800_600_000 },
      }),
    ).toMatchObject({
      withdrawn: true,
      withdrawnAt: 1_800_000_000,
      ownerWithdrawn: true,
      held: true,
      stopped: true,
      exported: { exportedAt: 1_800_000_100, archiveReady: true, destroyAt: 1_800_600_000 },
    });
    expect(
      storeViewOf({
        ...VIEW,
        export: { exportedAt: null, archiveReady: false, destroyAt: null },
      })?.exported,
    ).toEqual({ exportedAt: undefined, archiveReady: false, destroyAt: undefined });
    expect(
      storeViewOf({
        ...VIEW,
        paidUntil: 1_800_000_000,
        payBy: 1_800_086_400,
        rails: { ...VIEW.rails, card: { open: false, refusal: { code: 'card_from', from: 5 } } },
      }),
    ).toMatchObject({
      paidUntil: 1_800_000_000,
      payBy: 1_800_086_400,
      card: { open: false, refusal: { code: 'card_from', from: 5 } },
    });
  });

  it('refuses any field that is not what it must be', () => {
    for (const broken of [
      { ...VIEW, tier: 1 },
      { ...VIEW, tierName: undefined },
      { ...VIEW, sale: { ...VIEW.sale, ownerWithdrawn: 'yes' } },
      { ...VIEW, sale: { ...VIEW.sale, held: undefined } },
      { ...VIEW, sale: { ...VIEW.sale, stopped: 1 } },
      { ...VIEW, export: undefined },
      { ...VIEW, exporting: undefined },
      { ...VIEW, exporting: 'yes' },
      { ...VIEW, export: { exportedAt: 'x', archiveReady: true, destroyAt: null } },
      { ...VIEW, export: { exportedAt: null, archiveReady: 'yes', destroyAt: null } },
      { ...VIEW, export: { exportedAt: null, archiveReady: true, destroyAt: -5 } },
      { ...VIEW, network: undefined },
      { ...VIEW, activated: 'no' },
      { ...VIEW, launch: 'anyone' },
      { ...VIEW, paidUntil: '1' },
      { ...VIEW, paidUntil: 1.5 },
      { ...VIEW, payBy: 'soon' },
      { ...VIEW, partner: undefined },
      { ...VIEW, partner: 'p1' },
      { ...VIEW, partner: { paidUntil: 'soon' } },
      { ...VIEW, rails: undefined },
      { ...VIEW, rails: { card: VIEW.rails.card } },
      { ...VIEW, rails: { ...VIEW.rails, card: { open: 'yes' } } },
      { ...VIEW, rails: { ...VIEW.rails, card: { open: false, refusal: { code: 1 } } } },
      {
        ...VIEW,
        rails: { ...VIEW.rails, card: { open: false, refusal: { code: 'card_from', from: '5' } } },
      },
      { ...VIEW, paidUntil: 1e13 },
      { ...VIEW, paidUntil: -1 },
      { ...VIEW, payBy: 253_402_300_800 },
      {
        ...VIEW,
        rails: { ...VIEW.rails, card: { open: false, refusal: { code: 'card_from', from: 1.5 } } },
      },
      {
        ...VIEW,
        rails: { ...VIEW.rails, card: { open: false, refusal: { code: 'card_from', from: 1e13 } } },
      },
      { ...VIEW, sale: { withdrawnAt: 'yesterday' } },
      null,
      [],
    ]) {
      expect(storeViewOf(broken), JSON.stringify(broken)).toBeUndefined();
    }
  });

  it('shows a time as its UTC day and minute, up to the last one a date can show', () => {
    expect(shownTime(1_800_000_000)).toBe('2027-01-15 08:00 UTC');
    expect(storeViewOf({ ...VIEW, paidUntil: 253_402_300_799 })?.paidUntil).toBe(253_402_300_799);
    expect(shownTime(253_402_300_799)).toBe('9999-12-31 23:59 UTC');
  });
});

describe('the rails in the merchant words', () => {
  it('says why card or crypto is not open, and names a code it does not know', () => {
    expect(cardRefusalText({ code: 'card_from', from: 1_800_000_000 })).toBe(
      'Your paid time runs for a while yet: switch to card from 2027-01-15 08:00 UTC.',
    );
    expect(cardRefusalText({ code: 'card_from' })).toContain('closer to its end');
    for (const code of [
      'rail_off',
      'no_card_for_tier',
      'payment_window_closed',
      'card_subscription_live',
      'card_status_unknown',
      'owner_unconfirmed',
      'tenant_gone',
      'card_subscription_items',
    ]) {
      expect(cardRefusalText({ code }), code).not.toContain(code);
    }
    expect(cardRefusalText({ code: 'new_code' })).toBe('Card payment is not open (new_code).');
    for (const code of [
      'rail_off',
      'payment_window_closed',
      'card_subscription_live',
      'card_status_unknown',
      'tenant_gone',
    ]) {
      expect(cryptoRefusalText({ code }), code).not.toContain(code);
    }
    expect(cryptoRefusalText({ code: 'new_code' })).toBe('Crypto payment is not open (new_code).');
  });

  it("goes only to Stripe's own Checkout and Portal hosts, over https", () => {
    expect(stripeSessionUrl('https://checkout.stripe.com/c/cs_1')).toBe(
      'https://checkout.stripe.com/c/cs_1',
    );
    expect(stripeSessionUrl('https://billing.stripe.com/p/x')).toBe(
      'https://billing.stripe.com/p/x',
    );
    for (const value of [
      'http://checkout.stripe.com/c/cs_1',
      'https://checkout.stripe.com.evil.example/c',
      'https://evil.example/https://checkout.stripe.com',
      'https://user@checkout.stripe.com/c',
      'javascript:alert(1)',
      'https://stripe.com/',
      42,
      undefined,
    ]) {
      expect(stripeSessionUrl(value), String(value)).toBeUndefined();
    }
  });

  it("the billing page link carries the store's id as customer_ref", () => {
    expect(billingPageUrl('https://billing.example/pay', 'abc123abc123')).toBe(
      'https://billing.example/pay?customer_ref=abc123abc123',
    );
    expect(
      billingPageUrl('https://billing.example/pay?x=1&customer_ref=other', 'abc123abc123'),
    ).toBe('https://billing.example/pay?x=1&customer_ref=abc123abc123');
  });

  it('the billing page from config is none or https', () => {
    expect(billingUrlFrom(undefined)).toBeUndefined();
    expect(billingUrlFrom('')).toBeUndefined();
    expect(billingUrlFrom('https://billing.example/pay')).toBe('https://billing.example/pay');
    for (const value of ['http://billing.example', 'javascript:alert(1)', 'pay']) {
      expect(() => billingUrlFrom(value), value).toThrow('VITE_BILLING_URL');
    }
  });
});

describe('what an answer says', () => {
  it("shows the domain check's own reason, and no other detail", () => {
    expect(explainAnswer({ error: 'domain_check', detail: 'no TXT' }, 409)).toBe(
      'The domain check failed: no TXT',
    );
    expect(explainAnswer({ error: 'store_refused', detail: 'secret detail' }, 400)).not.toContain(
      'secret detail',
    );
    expect(explainAnswer({ error: 'card_from' }, 409)).toContain('closer to its end');
    expect(explainAnswer({ error: 'owner_unconfirmed' }, 409)).toContain(
      'confirmed your owner key',
    );
  });
});

describe('back from Stripe Checkout', () => {
  it("is read only on a store's page, done or cancelled, with that store's id", () => {
    expect(checkoutReturnOf('https://console.example/tenants/abc123abc123?checkout=done')).toEqual({
      tenantId: 'abc123abc123',
      outcome: 'done',
    });
    expect(
      checkoutReturnOf('https://console.example/tenants/abc123abc123?checkout=cancelled'),
    ).toEqual({ tenantId: 'abc123abc123', outcome: 'cancelled' });
    for (const url of [
      'https://console.example/tenants/abc123abc123',
      'https://console.example/tenants/abc123abc123?checkout=other',
      'https://console.example/tenants/abc?checkout=done',
      'https://console.example/tenants/abc123abc123/x?checkout=done',
      'https://console.example/?checkout=done',
      'https://console.example/start?checkout=done',
    ]) {
      expect(checkoutReturnOf(url), url).toBeUndefined();
    }
  });
});
