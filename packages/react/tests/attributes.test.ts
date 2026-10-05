import { describe, expect, it } from 'vitest';
import { elementAttributes } from '../src/attributes';

const PRODUCT = 'naddr1qqtestproduct';

describe('elementAttributes', () => {
  it('maps every option to its kebab-case attribute', () => {
    expect(
      elementAttributes({
        product: PRODUCT,
        network: 'mainnet',
        theme: 'dark',
        display: 'inline',
        label: 'Deposit',
        collectEmail: true,
        strictOrigin: true,
        customerRef: 'user_42',
        className: 'buy',
      }),
    ).toEqual({
      product: PRODUCT,
      network: 'mainnet',
      theme: 'dark',
      display: 'inline',
      label: 'Deposit',
      'collect-email': '',
      'strict-origin': '',
      'customer-ref': 'user_42',
      class: 'buy',
    });
  });

  it('leaves out a false boolean instead of writing "false"', () => {
    const attributes = elementAttributes({
      product: PRODUCT,
      collectEmail: false,
      strictOrigin: false,
    });
    expect(attributes).toEqual({ product: PRODUCT });
    expect(Object.values(attributes)).not.toContain('false');
  });

  it('turns strict origin on with a reference, as the loader does', () => {
    expect(elementAttributes({ product: PRODUCT, customerRef: 'user_42' })).toEqual({
      product: PRODUCT,
      'customer-ref': 'user_42',
      'strict-origin': '',
    });
  });

  it('renders a present, empty reference while a required one is not known yet', () => {
    for (const customerRef of [undefined, '']) {
      expect(
        elementAttributes({ product: PRODUCT, requireCustomerRef: true, customerRef }),
      ).toEqual({ product: PRODUCT, 'customer-ref': '' });
    }
  });

  it('writes no reference at all when none is required and none is given', () => {
    for (const customerRef of [undefined, '']) {
      expect(elementAttributes({ product: PRODUCT, customerRef })).toEqual({ product: PRODUCT });
    }
  });
});
