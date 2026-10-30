// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NATIVE_SOL } from '@elisym/pay-core';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRANDS,
  type Brand,
  DEFAULT_BRAND,
  brandForHost,
  checkoutTitle,
  footerText,
} from '../src/app/brand';
import { type Actions, Checkout } from '../src/app/Checkout';
import { FEE_HIDES_EIP3009, problemText } from '../src/app/ui/text';

const PARTNER: Brand = { name: 'Acme Pay', poweredBy: false, fileSlug: 'acme' };
const REGISTRY: ReadonlyMap<string, Brand> = new Map([
  ['pay.elisym.network', DEFAULT_BRAND],
  ['pay.acme.example', PARTNER],
]);

const NO_ACTIONS: Actions = {
  setEmail: () => undefined,
  pay: async () => undefined,
  retry: async () => undefined,
  signAgain: async () => undefined,
  resend: async () => undefined,
  startOver: async () => undefined,
  choosePayout: () => undefined,
  confirmOldPrompt: async () => undefined,
  cancelOldPrompt: () => undefined,
  cancel: () => undefined,
  checkInWallet: async () => undefined,
};

const MOUNTED: HTMLElement[] = [];

afterEach(() => {
  for (const container of MOUNTED.splice(0)) {
    render(null, container);
    container.remove();
  }
});

function footerOf(brand?: Brand): string | undefined {
  const container = document.createElement('div');
  document.body.append(container);
  MOUNTED.push(container);
  act(() => {
    render(
      <Checkout
        screen={{ kind: 'loading' }}
        actions={NO_ACTIONS}
        {...(brand === undefined ? {} : { brand })}
      />,
      container,
    );
  });
  return container.querySelector('.footer')?.textContent ?? undefined;
}

describe('brand by Host', () => {
  it('pay.elisym.network is the default brand, in any case', () => {
    expect(BRANDS.get('pay.elisym.network')).toBe(DEFAULT_BRAND);
    expect(brandForHost('pay.elisym.network')).toBe(DEFAULT_BRAND);
    expect(brandForHost('PAY.Elisym.Network')).toBe(DEFAULT_BRAND);
  });

  it("every registered brand's file name start is a plain slug", () => {
    for (const brand of BRANDS.values()) {
      expect(brand.fileSlug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    }
    expect(DEFAULT_BRAND.fileSlug).toBe('elisym');
  });

  it('a registered partner host gets its own brand, and only that host', () => {
    expect(brandForHost('pay.acme.example', REGISTRY)).toBe(PARTNER);
    expect(brandForHost('Pay.Acme.Example', REGISTRY)).toBe(PARTNER);
    expect(brandForHost('evil.pay.acme.example', REGISTRY)).toBe(DEFAULT_BRAND);
    expect(brandForHost('pay.acme.example.evil', REGISTRY)).toBe(DEFAULT_BRAND);
  });

  it('an unknown host (a preview, localhost, an inherited key) keeps "by Elisym"', () => {
    for (const host of ['localhost', '127.0.0.1', 'checkout-abc.vercel.app', 'constructor', '']) {
      expect(brandForHost(host, REGISTRY)).toBe(DEFAULT_BRAND);
    }
    expect(DEFAULT_BRAND.poweredBy).toBe(true);
  });

  it('the title and the footer follow the brand', () => {
    expect(checkoutTitle(DEFAULT_BRAND)).toBe('Pay Core checkout');
    expect(checkoutTitle(PARTNER)).toBe('Acme Pay checkout');
    expect(footerText(DEFAULT_BRAND)).toBe(
      'Checkout by Elisym · payments go straight to the store',
    );
    expect(footerText(PARTNER)).toBe('Payments go straight to the store');
  });

  it('the checkout footer shows the brand it is given, the default one when none', () => {
    expect(footerOf()).toBe(footerText(DEFAULT_BRAND));
    expect(footerOf(DEFAULT_BRAND)).toBe(footerText(DEFAULT_BRAND));
    const partner = footerOf(PARTNER);
    expect(partner).toBe(footerText(PARTNER));
    expect(partner).not.toContain('Elisym');
  });

  it('the page carries no brand of its own: the title is set from the brand at start', () => {
    const html = readFileSync(join(__dirname, '../src/app/index.html'), 'utf8');
    expect(html).toContain('<title>Checkout</title>');
    expect(html).not.toMatch(/elisym|pay core/i);
    const main = readFileSync(join(__dirname, '../src/app/main.tsx'), 'utf8');
    expect(main).toContain('document.title = checkoutTitle(brand)');
    expect(main).toContain('brand={brand}');
    expect(main).toContain('brandForHost(location.hostname)');
  });

  it('fee wording names no brand, and never reads as the gas "network fee"', () => {
    const asset = NATIVE_SOL;
    const texts = [
      FEE_HIDES_EIP3009,
      problemText({ reason: 'fee_config_unavailable' }, asset, 'solana'),
      problemText({ reason: 'fee_config_invalid' }, asset, 'solana'),
      problemText(
        { reason: 'retry_blocked', cause: 'fee_config_unavailable', chain: 'Base' },
        asset,
        'eip3009',
      ),
      problemText(
        { reason: 'retry_blocked', cause: 'fee_config_invalid', chain: 'Base' },
        asset,
        'eip3009',
      ),
    ];
    expect(texts).toEqual([
      'Ethereum, Arbitrum and Base are not offered while a fee is taken from the price.',
      'The payment fee terms could not be read. Nothing was paid; try again in a moment.',
      'The payment fee configuration cannot be used right now. Nothing was paid.',
      expect.stringMatching(
        /^The payment fee terms could not be read, so nothing new was signed\. Try again in a moment\. /,
      ),
      expect.stringMatching(
        /^The payment fee configuration cannot be used right now, so nothing new was signed\. /,
      ),
    ]);
    for (const text of texts) {
      expect(text).not.toMatch(/elisym|network fee/i);
    }
  });
});
