import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ElisymBuy } from '../src';

describe('server rendering', () => {
  it('runs with no DOM at all', () => {
    expect(typeof document).toBe('undefined');
  });

  it('writes the element with its attributes and no script', () => {
    const html = renderToString(
      createElement(ElisymBuy, {
        product: 'naddr1qqtestproduct',
        network: 'mainnet',
        theme: 'dark',
        collectEmail: false,
        customerRef: 'user_42',
      }),
    );
    expect(html).toBe(
      '<elisym-buy product="naddr1qqtestproduct" network="mainnet" theme="dark" customer-ref="user_42" strict-origin=""></elisym-buy>',
    );
    expect(html).not.toContain('<script');
  });

  it('writes a present, empty reference while a required one is not known yet', () => {
    const html = renderToString(
      createElement(ElisymBuy, { product: 'naddr1qqtestproduct', requireCustomerRef: true }),
    );
    expect(html).toBe('<elisym-buy product="naddr1qqtestproduct" customer-ref=""></elisym-buy>');
  });
});
