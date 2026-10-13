import { parseCaip19 } from '@elisym/commerce';
import { afterEach, describe, expect, it } from 'vitest';
import { USDC_DEVNET_CAIP19 } from '../../merchant-node/tests/admin/fixtures';
import { OrderRowView } from '../src/components/OrderRowView';
import { ProductsSection } from '../src/components/ProductsSection';
import { StoreSection } from '../src/components/StoreSection';
import { Totals } from '../src/components/Totals';
import { Warnings } from '../src/components/Warnings';
import type { History, OrderRow } from '../src/lib/core';
import { type Mounted, mount } from './mount';

const USDC = parseCaip19(USDC_DEVNET_CAIP19);
if (USDC === undefined) {
  throw new Error('USDC devnet is a known asset');
}

/** The table's columns, in order. */
const COLUMN = {
  time: 0,
  order: 1,
  product: 2,
  claim: 3,
  email: 4,
  ref: 5,
  state: 6,
  credited: 7,
  transaction: 8,
  buyer: 9,
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
  it('puts the email and the reference each in its own column', async () => {
    const texts = await cells(row());
    expect(texts[COLUMN.email]).toBe('buyer@example.com');
    expect(texts[COLUMN.ref]).toBe('account-7');
    expect(texts[COLUMN.claim]).toBe('1 USDmatches the listing');
  });

  it('says when the claimed total differs from the listing', async () => {
    expect((await cells(row({ claimCheck: 'differs' })))[COLUMN.claim]).toContain(
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
    expect(texts[COLUMN.credited]).toBe('refund 0.25 USDC');
    expect(texts[COLUMN.state]).toBe('refunded');
  });

  it('names the network of a credit in an unknown asset', async () => {
    const texts = await cells(
      row({ credits: [{ tx: 'credit-tx-00000000000000', amount: '7', medium: 'solana-devnet' }] }),
    );
    expect(texts[COLUMN.credited]).toBe('7 subunits (solana-devnet), asset unknown');
  });

  it('shows a reported transaction while nothing is credited', async () => {
    const texts = await cells(
      row({
        state: 'payment_reported',
        reported: [{ medium: 'solana-devnet', tx: 'reported-transaction-id' }],
      }),
    );
    expect(texts[COLUMN.transaction]).toBe('reported...ction-id');
    expect(texts[COLUMN.state]).toBe('payment reported (not confirmed by your node)');
  });

  it('notes a conflict, an order not loaded and a receipt in an unlisted medium', async () => {
    const texts = await cells(
      row({ conflict: true, orderNotLoaded: true, unlistedMedium: true, order: undefined }),
    );
    expect(texts[COLUMN.order]).toContain('conflict: different orders under this id');
    expect(texts[COLUMN.state]).toContain('order not loaded');
    expect(texts[COLUMN.state]).toContain('receipt in a medium the store no longer lists');
    expect(texts[COLUMN.claim]).toBe('');
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
