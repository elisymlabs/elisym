import { parseCaip19 } from '@elisym/commerce';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { USDC_DEVNET_CAIP19 } from '../../merchant-node/tests/admin/fixtures';
import { OrderRowView } from '../src/components/OrderRowView';
import { ProductsSection } from '../src/components/ProductsSection';
import { StoreSection } from '../src/components/StoreSection';
import { Totals } from '../src/components/Totals';
import { Warnings } from '../src/components/Warnings';
import { type History, type OrderRow, short } from '../src/lib/core';
import { type Mounted, mount } from './mount';

const USDC = parseCaip19(USDC_DEVNET_CAIP19);
if (USDC === undefined) {
  throw new Error('USDC devnet is a known asset');
}

/** The table's columns, in order: the last one holds the details toggle. */
const COLUMN = {
  date: 0,
  order: 1,
  customer: 2,
  total: 3,
  state: 4,
  credited: 5,
};

function row(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    key: 'buyer:order',
    buyerPubkey: 'b'.repeat(64),
    orderId: 'order-1',
    createdAt: 1_790_000_000,
    order: {
      type: 'order',
      storePubkey: 's'.repeat(64),
      orderId: 'order-1',
      items: [{ product: '30402:x:d', quantity: 1 }],
      total: { amount: '1', currency: 'USD' },
      email: 'buyer@example.com',
      customerRef: 'account-7',
    },
    product: 'Course',
    conflict: false,
    orderNotLoaded: false,
    claimCheck: 'matches',
    state: 'delivered',
    credits: [],
    refunds: [],
    reported: [],
    unlistedMedium: false,
    ...overrides,
  };
}

let mounted: Mounted | undefined;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function cells(orderRow: OrderRow): Promise<string[]> {
  mounted = await mount(
    <table>
      <tbody>
        <OrderRowView row={orderRow} />
      </tbody>
    </table>,
  );
  return [...mounted.container.querySelectorAll('td')].map((cell) => cell.textContent ?? '');
}

describe('an order row', () => {
  it('shows the email, the reference and the buyer under the customer', async () => {
    const texts = await cells(row());
    expect(texts[COLUMN.customer]).toBe(`buyer@example.comref account-7${short('b'.repeat(64))}`);
    expect(texts[COLUMN.total]).toBe('1 USDmatches the listing');
    expect(texts[COLUMN.order]).toBe('Courseorder-1');
  });

  it('says when the claimed total differs from the listing', async () => {
    expect((await cells(row({ claimCheck: 'differs' })))[COLUMN.total]).toContain(
      'differs from the listing',
    );
  });

  it('marks a refund as a refund, never as money received', async () => {
    const texts = await cells(
      row({
        state: 'refunded',
        refunds: [{ tx: 'refund-tx-0000000000000', amount: '250000', asset: USDC }],
      }),
    );
    expect(texts[COLUMN.credited]).toBe(`refund 0.25 USDC${short('refund-tx-0000000000000')}`);
    expect(texts[COLUMN.state]).toBe('Refunded');
  });

  it('names the network of a credit in an unknown asset', async () => {
    const texts = await cells(
      row({
        credits: [
          { tx: 'credit-tx-00000000000000', amount: '7', medium: 'solana-devnet', fee: '0' },
        ],
      }),
    );
    expect(texts[COLUMN.credited]).toBe(
      `7 subunits (solana-devnet), asset unknown${short('credit-tx-00000000000000')}`,
    );
  });

  it('names the network of a fee in an unknown asset', async () => {
    const texts = await cells(
      row({
        credits: [
          { tx: 'credit-tx-00000000000000', amount: '7', medium: 'solana-devnet', fee: '2' },
        ],
      }),
    );
    expect(texts[COLUMN.credited]).toContain(
      'elisym fee 2 subunits (solana-devnet), asset unknown',
    );
  });

  it('shows no fee line in the details of a credit without a fee', async () => {
    mounted = await mount(
      <table>
        <tbody>
          <OrderRowView
            row={row({
              credits: [
                {
                  tx: 'credit-tx-00000000000000',
                  amount: '1000000',
                  asset: USDC,
                  medium: 'solana-devnet',
                  fee: '0',
                },
              ],
            })}
          />
        </tbody>
      </table>,
    );
    const toggle = mounted.container.querySelector('button[aria-expanded]');
    if (!(toggle instanceof HTMLButtonElement)) {
      throw new Error('no details toggle');
    }
    await act(async () => toggle.click());
    const details = mounted.container.querySelectorAll('tr')[1]?.textContent ?? '';
    expect(details).toContain('credited 1 USDC');
    expect(details).not.toContain('fee');
  });

  it('shows a reported transaction while nothing is credited', async () => {
    const texts = await cells(
      row({
        state: 'payment_reported',
        reported: [{ medium: 'solana-devnet', tx: 'reported-transaction-id' }],
      }),
    );
    expect(texts[COLUMN.credited]).toBe('reported...ction-id');
    expect(texts[COLUMN.state]).toBe('Payment reportednot confirmed by your node');
  });

  it('shows a plain order with no note on its state', async () => {
    const texts = await cells(row({ state: 'ordered' }));
    expect(texts[COLUMN.state]).toBe('Ordered');
  });

  it('shows an expired order as not paid in time, with nothing credited', async () => {
    const texts = await cells(row({ state: 'expired' }));
    expect(texts[COLUMN.state]).toBe('Expiredno payment credited within 3 days');
    expect(texts[COLUMN.credited]).toBe('');
  });

  it('notes a conflict, an order not loaded and a receipt in an unlisted medium', async () => {
    const texts = await cells(
      row({ conflict: true, orderNotLoaded: true, unlistedMedium: true, order: undefined }),
    );
    expect(texts[COLUMN.order]).toContain('conflict: different orders under this id');
    expect(texts[COLUMN.state]).toContain('order not loaded');
    expect(texts[COLUMN.state]).toContain('receipt in a medium the store no longer lists');
    expect(texts[COLUMN.total]).toBe('');
  });

  it('opens the full details of an order, and closes them', async () => {
    mounted = await mount(
      <table>
        <tbody>
          <OrderRowView
            row={row({
              credits: [
                {
                  tx: 'credit-tx-00000000000000',
                  amount: '1000000',
                  asset: USDC,
                  medium: 'solana-devnet',
                  explorer: 'https://explorer.example/tx/credit',
                  fee: '10000',
                },
              ],
            })}
          />
        </tbody>
      </table>,
    );
    const toggle = mounted.container.querySelector('button[aria-expanded]');
    if (!(toggle instanceof HTMLButtonElement)) {
      throw new Error('no details toggle');
    }
    expect(mounted.container.querySelectorAll('tr')).toHaveLength(1);
    expect(mounted.container.textContent).toContain('1 USDCelisym fee 0.01 USDC');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = mounted.container.querySelectorAll('tr');
    expect(rows).toHaveLength(2);
    const details = rows[1]?.textContent ?? '';
    expect(details).toContain('b'.repeat(64));
    expect(details).toContain('credit-tx-00000000000000');
    expect(details).toContain('credited 1 USDCof which elisym fee 0.01 USDC');
    expect(rows[1]?.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    // The details pane loads no picture either: nothing a buyer wrote is fetched.
    expect(mounted.container.querySelector('img')).toBeNull();
    await act(async () => toggle.click());
    expect(mounted.container.querySelectorAll('tr')).toHaveLength(1);

    // A click anywhere on the row opens it; a click on its transaction link does not.
    const link = mounted.container.querySelector('a');
    link?.addEventListener('click', (event) => event.preventDefault());
    await act(async () => link?.click());
    expect(mounted.container.querySelectorAll('tr')).toHaveLength(1);
    await act(async () => mounted?.container.querySelector('td')?.click());
    expect(mounted.container.querySelectorAll('tr')).toHaveLength(2);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the dashboard sections', () => {
  it('shows a single warning', async () => {
    mounted = await mount(<Warnings texts={['only warning']} />);
    expect(mounted.container.querySelectorAll('li')).toHaveLength(1);
    expect(mounted.container.textContent).toBe('only warning');
  });

  it('lists every warning', async () => {
    mounted = await mount(<Warnings texts={['first warning', 'second warning']} />);
    expect(mounted.container.querySelectorAll('li')).toHaveLength(2);
    expect(mounted.container.textContent).toBe('first warningsecond warning');
  });

  it('totals a credit in an unknown asset, and never says nothing was credited then', async () => {
    const history: History = {
      rows: [row()],
      totals: { perAsset: [], unknownAsset: [{ medium: 'solana-devnet', subunits: '7' }] },
    };
    mounted = await mount(<Totals history={history} />);
    expect(mounted.container.textContent).toContain('7 subunits');
    expect(mounted.container.textContent).toContain('asset unknown (solana-devnet)');
    expect(mounted.container.textContent).not.toContain('nothing credited yet');
  });

  it('says when the store has no payout list', async () => {
    mounted = await mount(
      <StoreSection
        store={{ relays: ['wss://relay.example.com'], noInboxList: false, payoutMediums: [] }}
      />,
    );
    expect(mounted.container.textContent).toContain('no payout list found');
  });

  it('shows each product with its price', async () => {
    mounted = await mount(
      <ProductsSection
        products={{
          lines: [
            { address: '30402:x:d', d: 'd', title: 'Course', price: '1.5 USD', onSale: true },
          ],
          incomplete: false,
        }}
      />,
    );
    expect(mounted.container.querySelector('li')?.textContent).toContain('1.5 USD');
  });
});
