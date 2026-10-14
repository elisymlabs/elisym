import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { About } from '../src/components/About';
import { Dashboard } from '../src/components/Dashboard';
import { OrderDetails } from '../src/components/OrderDetails';
import { OrderRowView } from '../src/components/OrderRowView';
import { OrdersSection } from '../src/components/OrdersSection';
import { ProductsSection } from '../src/components/ProductsSection';
import { RecentOrders } from '../src/components/RecentOrders';
import { Stat } from '../src/components/Stat';
import { StatusStrip } from '../src/components/StatusStrip';
import { Totals } from '../src/components/Totals';
import { statusParts } from '../src/lib/charts';
import type { OrderRow, OrderState, Snapshot } from '../src/lib/core';
import { countText } from '../src/lib/count';
import { ordersCsv } from '../src/lib/csv';
import { filterRows, stateCounts } from '../src/lib/orders';
import { type Mounted, buttonNamed, byId, mount } from './mount';

function row(id: string, state: OrderState, overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    key: `buyer:${id}`,
    buyerPubkey: 'b'.repeat(64),
    orderId: id,
    createdAt: 1_790_000_000,
    order: {
      type: 'order',
      storePubkey: 's'.repeat(64),
      orderId: id,
      items: [{ product: '30402:x:d', quantity: 1 }],
      total: { amount: '1', currency: 'USD' },
      email: `${id}@example.com`,
      customerRef: `ref-${id}`,
    },
    product: `Product ${id}`,
    conflict: false,
    orderNotLoaded: false,
    claimCheck: 'matches',
    state,
    credits: [],
    refunds: [],
    reported: [],
    unlistedMedium: false,
    ...overrides,
  };
}

const ROWS: OrderRow[] = [
  row('alpha', 'delivered', { createdAt: 1_790_000_100 }),
  row('beta', 'ordered', { createdAt: 1_790_000_300 }),
  row('gamma', 'delivered', { createdAt: 1_790_000_200 }),
  row('delta', 'payment_reported', { createdAt: 1_790_000_000 }),
];

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    storePubkey: 'a'.repeat(64),
    store: {
      name: 'Shop',
      relays: ['wss://relay.example.com'],
      noInboxList: false,
      payoutMediums: [],
    },
    history: { rows: ROWS, totals: { perAsset: [], unknownAsset: [] } },
    products: [],
    allProducts: {
      lines: [
        { address: '30402:s:a', d: 'lamp', title: 'Desk lamp', price: '1 USD', onSale: true },
        { address: '30402:s:b', d: 'chair', title: 'Old chair', price: '2 USD', onSale: false },
        { address: '30402:s:c', d: 'mug', title: 'Coffee mug', price: '3 USD', onSale: true },
      ],
      incomplete: false,
    },
    warnings: [],
    more: false,
    ...overrides,
  };
}

let mounted: Mounted | undefined;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

function orderIds(container: HTMLElement): string[] {
  return [...byId(container, 'orders').querySelectorAll('[title]')]
    .map((element) => element.getAttribute('title') ?? '')
    .filter((title) => ROWS.some((candidate) => candidate.orderId === title));
}

function chip(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button[aria-pressed]')].find((button) =>
    button.textContent?.startsWith(label),
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`no chip ${label}`);
  }
  return found;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('order filters', () => {
  it('counts the rows in each state', () => {
    expect(stateCounts([...ROWS, row('omega', 'expired')])).toEqual({
      ordered: 1,
      expired: 1,
      payment_reported: 1,
      delivered: 2,
      released: 0,
      refunded: 0,
    });
  });

  it('filters by state, and searches ids, product, email, reference and buyer, any case', () => {
    expect(filterRows(ROWS, 'delivered', '').map((one) => one.orderId)).toEqual(['alpha', 'gamma']);
    expect(filterRows(ROWS, 'all', '  GAMMA@Example ').map((one) => one.orderId)).toEqual([
      'gamma',
    ]);
    expect(filterRows(ROWS, 'all', 'ref-beta').map((one) => one.orderId)).toEqual(['beta']);
    expect(filterRows(ROWS, 'all', 'product delta').map((one) => one.orderId)).toEqual(['delta']);
    expect(filterRows(ROWS, 'all', 'b'.repeat(10))).toHaveLength(4);
    expect(filterRows(ROWS, 'ordered', 'alpha')).toEqual([]);
  });

  it('the chips and the search narrow the table, and the count says so', async () => {
    mounted = await mount(
      <OrdersSection snapshot={snapshot()} busy={false} onMore={() => undefined} />,
    );
    const { container } = mounted;
    expect(orderIds(container)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    expect(chip(container, 'Completed').textContent).toBe('Completed2');
    expect(
      container.querySelector('button[aria-pressed]:not([aria-pressed="false"])')?.textContent,
    ).toBe('All4');
    await act(async () => chip(container, 'Completed').click());
    expect(orderIds(container)).toEqual(['alpha', 'gamma']);
    expect(chip(container, 'Completed').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('2 of 4 loaded orders');
    const search = container.querySelector('input[type="search"]');
    if (!(search instanceof HTMLInputElement)) {
      throw new Error('no search');
    }
    await type(search, 'gamma');
    expect(orderIds(container)).toEqual(['gamma']);
    await type(search, 'nothing-like-this');
    expect(container.textContent).toContain('No order matches these filters.');
    await act(async () => chip(container, 'All').click());
    await type(search, '');
    expect(orderIds(container)).toHaveLength(4);
    expect(container.textContent).toContain('4 loaded orders');
  });
});

describe('the CSV under a filter', () => {
  it('exports every loaded order, whatever the filters', async () => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (blob instanceof Blob) {
        blobs.push(blob);
      }
      return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mounted = await mount(
      <OrdersSection snapshot={snapshot()} busy={false} onMore={() => undefined} />,
    );
    const { container } = mounted;
    await act(async () => chip(container, 'Completed').click());
    expect(orderIds(container)).toEqual(['alpha', 'gamma']);
    await act(async () => buttonNamed(container, 'Download CSV').click());
    expect(await blobs[0]?.text()).toBe(ordersCsv(ROWS));
  });
});

describe('the order details', () => {
  it('names a reported payment as unconfirmed once, not twice', async () => {
    mounted = await mount(<OrderDetails row={row('delta', 'payment_reported')} />);
    const text = mounted.container.textContent ?? '';
    expect(text.split('not confirmed by your node')).toHaveLength(2);
  });

  it('names an expired order as not paid in time once, and says nothing is to be done', async () => {
    mounted = await mount(<OrderDetails row={row('omega', 'expired')} />);
    const text = mounted.container.textContent ?? '';
    expect(text.split('not paid within 3 days')).toHaveLength(2);
    expect(text).toContain('nothing to do');
  });
});

describe('readable small text', () => {
  it('draws a hint on a tinted card in text-2, and in text-3 only on a plain one', async () => {
    mounted = await mount(
      <>
        <Stat label="USDC credited" value="1 USDC" hint="solana" tone="accent" />
        <Stat label="Payment reported" value="1" hint="not confirmed" tone="warn" />
        <Stat label="Orders loaded" value="1" hint="plain hint" />
      </>,
    );
    const hints = [...mounted.container.querySelectorAll('p')].filter((paragraph) =>
      ['solana', 'not confirmed', 'plain hint'].includes(paragraph.textContent ?? ''),
    );
    expect(hints.map((hint) => hint.className.includes('text-text-2'))).toEqual([
      true,
      true,
      false,
    ]);
    expect(hints[2]?.className).toContain('text-text-3');
  });

  it('draws chip counts in full color: text-3 on a plain chip, inherited on the pressed one', async () => {
    mounted = await mount(
      <OrdersSection snapshot={snapshot()} busy={false} onMore={() => undefined} />,
    );
    const pressed = chip(mounted.container, 'All').querySelector('span');
    const plain = chip(mounted.container, 'Completed').querySelector('span');
    expect(plain?.className).toContain('text-text-3');
    expect(pressed?.className).not.toContain('text-text-3');
    for (const count of [pressed, plain]) {
      expect(count?.className).not.toMatch(/opacity-/);
    }
  });

  it('draws every placeholder in text-3, never the faint browser default', async () => {
    mounted = await mount(
      <>
        <OrdersSection snapshot={snapshot()} busy={false} onMore={() => undefined} />
        <ProductsSection products={snapshot().allProducts} />
      </>,
    );
    const inputs = [...mounted.container.querySelectorAll('input[placeholder]')];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.className).toContain('placeholder:text-text-3');
    }
  });
});

describe('a filter whose orders are gone', () => {
  it('keeps the chosen state chip, pressed, at 0 after a refresh moves its orders', async () => {
    const reported = snapshot();
    mounted = await mount(
      <OrdersSection snapshot={reported} busy={false} onMore={() => undefined} />,
    );
    const { container } = mounted;
    await act(async () => chip(container, 'Payment reported').click());
    expect(orderIds(container)).toEqual(['delta']);
    const moved = ROWS.map((one) =>
      one.orderId === 'delta' ? { ...one, state: 'delivered' as const } : one,
    );
    await mounted.rerender(
      <OrdersSection
        snapshot={snapshot({ history: { rows: moved, totals: reported.history.totals } })}
        busy={false}
        onMore={() => undefined}
      />,
    );
    const kept = chip(container, 'Payment reported');
    expect(kept.getAttribute('aria-pressed')).toBe('true');
    expect(kept.textContent).toBe('Payment reported0');
    expect(container.textContent).toContain('No order matches these filters.');
  });
});

describe('an order row click', () => {
  async function mountRow() {
    mounted = await mount(
      <table>
        <tbody>
          <OrderRowView row={ROWS[0] as OrderRow} />
        </tbody>
      </table>,
    );
    return mounted.container;
  }

  it('does not toggle while text is selected', async () => {
    const container = await mountRow();
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'alpha' } as Selection);
    await act(async () => container.querySelector('td')?.click());
    expect(container.querySelectorAll('tr')).toHaveLength(1);
  });

  it('opens on the first click of a double-click and ignores the second', async () => {
    const container = await mountRow();
    const cell = container.querySelector('td');
    await act(async () => {
      cell?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      cell?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    });
    expect(container.querySelectorAll('tr')).toHaveLength(2);
  });
});

describe('the products tab', () => {
  it('filters on sale and sold out, and searches titles and ids', async () => {
    mounted = await mount(<ProductsSection products={snapshot().allProducts} />);
    const { container } = mounted;
    const titles = () =>
      [...byId(container, 'products').querySelectorAll('li')].map(
        (item) => item.querySelector('[title]')?.getAttribute('title') ?? '',
      );
    expect(titles()).toEqual(['Desk lamp', 'Old chair', 'Coffee mug']);
    expect(container.textContent).toContain('3 products, 2 on sale');
    await act(async () => chip(container, 'Sold out').click());
    expect(titles()).toEqual(['Old chair']);
    await act(async () => chip(container, 'On sale').click());
    expect(titles()).toEqual(['Desk lamp', 'Coffee mug']);
    const search = container.querySelector('input[type="search"]');
    if (!(search instanceof HTMLInputElement)) {
      throw new Error('no search');
    }
    await type(search, '  MUG ');
    expect(titles()).toEqual(['Coffee mug']);
    await type(search, 'chair');
    expect(container.textContent).toContain('No product matches these filters.');
  });

  it('says 1 product, not 1 products', async () => {
    const one = snapshot().allProducts?.lines.slice(0, 1) ?? [];
    mounted = await mount(<ProductsSection products={{ lines: one, incomplete: false }} />);
    expect(mounted.container.textContent).toContain('1 product, 1 on sale');
    expect(countText(2, 'order')).toBe('2 orders');
    expect(countText(0, 'order')).toBe('0 orders');
    expect(countText(1, 'order')).toBe('1 order');
  });
});

describe('the overview', () => {
  it('shows only what was credited in the totals: the order counts are in the charts', async () => {
    mounted = await mount(<Totals history={snapshot().history} />);
    const totals = byId(mounted.container, 'totals');
    expect(totals.textContent).toBe('Creditednothing credited yetby your node');
    expect(totals.children).toHaveLength(1);
    expect(totals.className).toContain('grid-cols-1');
    expect(totals.className).toContain('lg:grid-cols-[repeat(auto-fit,minmax(240px,1fr))]');
  });

  it('puts reported payments in the warn colors on the status card, only when there are some', async () => {
    mounted = await mount(<StatusStrip parts={statusParts(stateCounts(ROWS))} />);
    const line = byId(mounted.container, 'status-reported');
    expect(line.textContent).toBe('1 payment reported, not confirmed by your node');
    expect(line.className).toContain('bg-warn-bg');
    expect(line.className).toContain('text-warn');
    await mounted.rerender(
      <StatusStrip
        parts={statusParts(stateCounts(ROWS.filter((row) => row.state !== 'payment_reported')))}
      />,
    );
    expect(mounted.container.querySelector('#status-reported')).toBeNull();
    await mounted.rerender(
      <StatusStrip
        parts={statusParts(stateCounts([...ROWS, row('epsilon', 'payment_reported')]))}
      />,
    );
    expect(byId(mounted.container, 'status-reported').textContent).toBe(
      '2 payments reported, not confirmed by your node',
    );
  });

  it('lists the newest orders first', async () => {
    mounted = await mount(<RecentOrders rows={ROWS} onViewAll={() => undefined} />);
    const products = [...mounted.container.querySelectorAll('li')].map(
      (item) => item.querySelector('p')?.textContent,
    );
    expect(products).toEqual(['Product beta', 'Product gamma', 'Product alpha', 'Product delta']);
  });

  it('lists at most five recent orders', async () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      row(`order-${index}`, 'ordered', { createdAt: 1_790_000_000 + index }),
    );
    mounted = await mount(<RecentOrders rows={many} onViewAll={() => undefined} />);
    expect(mounted.container.querySelectorAll('li')).toHaveLength(5);
  });

  it('opens the quickstart from Help in a new tab, never in the tab holding the key', async () => {
    mounted = await mount(<About />);
    expect(mounted.container.textContent).toContain('a credited payment minus its elisym fee');
    const link = mounted.container.querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('the dashboard tabs', () => {
  async function mountDashboard() {
    mounted = await mount(
      <Dashboard
        state={{
          pubkey: 'a'.repeat(64),
          snapshot: snapshot(),
          status: 'Read 4 order messages',
          busy: false,
        }}
        onRefresh={() => undefined}
        onMore={() => undefined}
        onLogOut={() => undefined}
      />,
    );
    return mounted.container;
  }

  function panel(container: HTMLElement, name: string): HTMLElement {
    return byId(container, `panel-${name}`);
  }

  it('shows one panel at a time, keeping the others mounted', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const container = await mountDashboard();
    expect(panel(container, 'overview').hidden).toBe(false);
    expect(panel(container, 'orders').hidden).toBe(true);
    expect(byId(container, 'orders').querySelectorAll('tr')).toHaveLength(4);
    await act(async () => byId(container, 'tab-orders').click());
    expect(panel(container, 'overview').hidden).toBe(true);
    expect(panel(container, 'orders').hidden).toBe(false);
    expect(byId(container, 'tab-orders').getAttribute('aria-selected')).toBe('true');
  });

  it('moves between tabs with the arrow keys and moves focus with a switch from a panel', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const container = await mountDashboard();
    const overview = byId(container, 'tab-overview');
    expect(overview.tabIndex).toBe(0);
    expect(byId(container, 'tab-orders').tabIndex).toBe(-1);
    await act(async () => {
      overview.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(panel(container, 'help').hidden).toBe(false);
    await act(async () => {
      byId(container, 'tab-help').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
    });
    expect(panel(container, 'overview').hidden).toBe(false);
    const press = async (tab: string, name: string) => {
      await act(async () => {
        byId(container, `tab-${tab}`).dispatchEvent(
          new KeyboardEvent('keydown', { key: name, bubbles: true }),
        );
      });
    };
    await press('overview', 'End');
    expect(panel(container, 'help').hidden).toBe(false);
    await press('help', 'ArrowRight');
    expect(panel(container, 'overview').hidden).toBe(false);
    await press('overview', 'ArrowRight');
    expect(panel(container, 'orders').hidden).toBe(false);
    await press('orders', 'Home');
    expect(panel(container, 'overview').hidden).toBe(false);
    await act(async () => buttonNamed(container, 'View all').click());
    expect(panel(container, 'orders').hidden).toBe(false);
    expect(document.activeElement).toBe(byId(container, 'tab-orders'));
  });

  it('shows the help, not a placeholder, on the Help tab before the first read', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    mounted = await mount(
      <Dashboard
        state={{ pubkey: 'a'.repeat(64), status: 'Reading the store...', busy: true }}
        onRefresh={() => undefined}
        onMore={() => undefined}
        onLogOut={() => undefined}
      />,
    );
    const { container } = mounted;
    expect(container.querySelector('.skeleton')).not.toBeNull();
    await act(async () => byId(container, 'tab-help').click());
    expect(container.textContent).toContain('About this page');
    expect(container.querySelector('.skeleton')).toBeNull();
  });

  it('points the tabs at no panel before the first read', async () => {
    mounted = await mount(
      <Dashboard
        state={{ pubkey: 'a'.repeat(64), status: 'Reading the store...', busy: true }}
        onRefresh={() => undefined}
        onMore={() => undefined}
        onLogOut={() => undefined}
      />,
    );
    expect(byId(mounted.container, 'tab-orders').getAttribute('aria-controls')).toBeNull();
  });
});
