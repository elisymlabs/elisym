import { type ReactElement, act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { About } from '../src/components/About';
import { Charts } from '../src/components/Charts';
import { Dashboard } from '../src/components/Dashboard';
import { DashboardShell } from '../src/components/DashboardShell';
import { OrderDetails } from '../src/components/OrderDetails';
import { OrderRowView } from '../src/components/OrderRowView';
import { OrdersSection } from '../src/components/OrdersSection';
import { Overview } from '../src/components/Overview';
import { ProductsSection } from '../src/components/ProductsSection';
import { RecentOrders } from '../src/components/RecentOrders';
import { Stat } from '../src/components/Stat';
import { StatusStrip } from '../src/components/StatusStrip';
import { Totals } from '../src/components/Totals';
import { statusParts, unconfirmedPayments } from '../src/lib/charts';
import type { OrderRow, OrderState, Snapshot } from '../src/lib/core';
import { countText } from '../src/lib/count';
import { ordersCsv } from '../src/lib/csv';
import { STATE_ORDER, filterRows, rowNotes, stateCounts } from '../src/lib/orders';
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
    expect(STATE_ORDER).toContain('expired');
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

  it('names an expired order as uncredited once, and points to the orders command for a payment left over', async () => {
    mounted = await mount(<OrderDetails row={row('omega', 'expired')} />);
    const text = mounted.container.textContent ?? '';
    expect(text.split('no payment credited within 3 days')).toHaveLength(2);
    expect(text).toContain('the orders command lists any payment the node left unresolved');
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
    mounted = await mount(
      <StatusStrip
        parts={statusParts(stateCounts(ROWS))}
        unconfirmed={unconfirmedPayments(ROWS)}
      />,
    );
    const line = byId(mounted.container, 'status-reported');
    expect(line.textContent).toBe('1 payment reported, not confirmed by your node');
    expect(line.className).toContain('bg-warn-bg');
    expect(line.className).toContain('text-warn');
    await mounted.rerender(
      <StatusStrip
        parts={statusParts(stateCounts(ROWS.filter((row) => row.state !== 'payment_reported')))}
        unconfirmed={unconfirmedPayments(ROWS.filter((row) => row.state !== 'payment_reported'))}
      />,
    );
    expect(mounted.container.querySelector('#status-reported')).toBeNull();
    await mounted.rerender(
      <StatusStrip
        parts={statusParts(stateCounts([...ROWS, row('epsilon', 'payment_reported')]))}
        unconfirmed={unconfirmedPayments([...ROWS, row('epsilon', 'payment_reported')])}
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

describe('the dashboard pages', () => {
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

  function page(container: HTMLElement, name: string): HTMLElement {
    return byId(container, `page-${name}`);
  }

  it('shows one page at a time, keeping the others mounted, the open one marked current', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const container = await mountDashboard();
    expect(container.querySelector('nav[aria-label="Store"]')).not.toBeNull();
    expect(page(container, 'overview').hidden).toBe(false);
    expect(page(container, 'orders').hidden).toBe(true);
    expect(byId(container, 'orders').querySelectorAll('tr')).toHaveLength(4);
    expect(byId(container, 'nav-overview').getAttribute('aria-current')).toBe('page');
    await act(async () => byId(container, 'nav-orders').click());
    expect(page(container, 'overview').hidden).toBe(true);
    expect(page(container, 'orders').hidden).toBe(false);
    expect(byId(container, 'nav-orders').getAttribute('aria-current')).toBe('page');
    expect(byId(container, 'nav-overview').getAttribute('aria-current')).toBeNull();
  });

  it('moves focus to the opened page heading and to the top, from the nav or from a page', async () => {
    const scrolled = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const container = await mountDashboard();
    // Opening the dashboard takes no focus.
    expect(scrolled).not.toHaveBeenCalled();
    await act(async () => byId(container, 'nav-products').click());
    expect(document.activeElement).toBe(page(container, 'products').querySelector('h1'));
    expect(document.activeElement?.textContent).toBe('Products');
    expect(scrolled).toHaveBeenCalledWith({ top: 0 });
    await act(async () => byId(container, 'nav-overview').click());
    await act(async () => buttonNamed(container, 'View all').click());
    expect(page(container, 'orders').hidden).toBe(false);
    expect(document.activeElement).toBe(page(container, 'orders').querySelector('h1'));
  });

  it('shows the help, not a placeholder, on the Help page before the first read', async () => {
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
    expect(page(container, 'overview').querySelector('.skeleton')).not.toBeNull();
    await act(async () => byId(container, 'nav-help').click());
    expect(page(container, 'help').textContent).toContain('How to read what the admin shows');
    expect(page(container, 'help').querySelector('.skeleton')).toBeNull();
  });

  it('keeps the store name, its npub, its copy label, Refresh and Log out in the sidebar', async () => {
    const container = await mountDashboard();
    const sidebar = byId(container, 'store-sidebar');
    expect(sidebar.querySelector('#store-name')).not.toBeNull();
    expect(sidebar.querySelector('#store-pubkey')?.getAttribute('title')).toMatch(/^npub1/);
    expect(sidebar.querySelector('[aria-label="Copy npub"]')).not.toBeNull();
    expect(sidebar.textContent).toContain('Refresh');
    expect(sidebar.textContent).toContain('Log out');
  });

  it('says the status once, outside the sidebar, so it shows at every width', async () => {
    const container = await mountDashboard();
    const statuses = [...container.querySelectorAll('[role="status"]')];
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.textContent).toBe('Read 4 order messages');
    expect(byId(container, 'store-sidebar').contains(statuses[0] ?? null)).toBe(false);
    expect(container.querySelector('main')?.contains(statuses[0] ?? null)).toBe(true);
    // Above the pages, not after them.
    const order = (statuses[0] as Node).compareDocumentPosition(page(container, 'overview'));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says where to look when the store could not be read', async () => {
    mounted = await mount(
      <Dashboard
        state={{ pubkey: 'a'.repeat(64), status: 'Could not read', busy: false }}
        onRefresh={() => undefined}
        onMore={() => undefined}
        onLogOut={() => undefined}
      />,
    );
    expect(page(mounted.container, 'overview').textContent).toContain(
      'The status above says why. Press Refresh to read it again.',
    );
  });

  it('lets the sidebar scroll on a short window, and names the store in full on the phone bar', async () => {
    const container = await mountDashboard();
    expect(byId(container, 'store-sidebar').className.split(' ')).toContain('md:overflow-y-auto');
    const phoneName = container.querySelector(
      '[aria-controls="store-sidebar"]',
    )?.previousElementSibling;
    expect(phoneName?.getAttribute('title')).toBe(phoneName?.textContent ?? 'none');
  });

  it('counts the orders and products in the nav, and makes each page heading focusable', async () => {
    const container = await mountDashboard();
    expect(byId(container, 'nav-orders').textContent).toBe('Orders4');
    expect(byId(container, 'nav-overview').textContent).toBe('Overview');
    for (const id of ['overview', 'orders', 'products', 'store', 'help']) {
      expect(page(container, id).querySelector('h1')?.getAttribute('tabindex'), id).toBe('-1');
    }
  });
});

describe('the frame', () => {
  function page(container: HTMLElement, name: string): HTMLElement {
    return byId(container, `page-${name}`);
  }

  function shell(onSelect: (id: string) => void = () => undefined) {
    return (
      <DashboardShell
        name={undefined}
        unnamed="Your store"
        identity={{
          value: 'npub1' + 'q'.repeat(58),
          copyLabel: 'Copy your public id (safe to share)',
        }}
        status="Read"
        busy={false}
        onRefresh={() => undefined}
        onSignOut={() => undefined}
        signOutLabel="Sign out"
        pages={[
          {
            id: 'overview',
            label: 'Overview',
            icon: 'home',
            content: <h1 tabIndex={-1}>Overview</h1>,
          },
          {
            id: 'orders',
            label: 'Orders',
            icon: 'receipt',
            locked: 'Pay the first month to open this',
            content: <h1 tabIndex={-1}>Orders</h1>,
          },
        ]}
        active="overview"
        onSelect={onSelect}
      />
    );
  }

  it('shows a locked page with its reason, and does not open it', async () => {
    const chosen: string[] = [];
    mounted = await mount(shell((id) => chosen.push(id)));
    const { container } = mounted;
    const locked = byId(container, 'nav-orders');
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    const reason = locked.getAttribute('aria-describedby') ?? '';
    expect(byId(container, reason).textContent).toBe('Pay the first month to open this');
    await act(async () => locked.click());
    expect(chosen).toEqual([]);
    await act(async () => byId(container, 'nav-overview').click());
    expect(chosen).toEqual(['overview']);
    expect(byId(container, 'nav-overview').getAttribute('aria-disabled')).toBeNull();
    expect(byId(container, 'store-name').textContent).toBe('Your store');
  });

  it('on a phone, opens its menu, and closes it on Escape, outside, or a choice, focus back', async () => {
    mounted = await mount(shell());
    const { container } = mounted;
    const menu = container.querySelector('[aria-controls="store-sidebar"]');
    if (!(menu instanceof HTMLButtonElement)) {
      throw new Error('no menu button');
    }
    expect(menu.getAttribute('aria-label')).toBe('Open the menu');
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(menu.getAttribute('aria-controls')).toBe('store-sidebar');
    await act(async () => menu.click());
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(byId(container, 'store-sidebar').className).toContain('fixed');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
    await act(async () => menu.click());
    await act(async () => byId(container, 'sidebar-backdrop').click());
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
    // A choice of the page already open closes the menu, focus back on its button.
    await act(async () => menu.click());
    byId(container, 'nav-overview').focus();
    await act(async () => byId(container, 'nav-overview').click());
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#sidebar-backdrop')).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('returns focus to the menu button after a click outside, from wherever it was', async () => {
    mounted = await mount(shell());
    const { container } = mounted;
    const menu = container.querySelector('[aria-controls="store-sidebar"]');
    if (!(menu instanceof HTMLButtonElement)) {
      throw new Error('no menu button');
    }
    await act(async () => menu.click());
    byId(container, 'nav-overview').focus();
    expect(document.activeElement).toBe(byId(container, 'nav-overview'));
    await act(async () => byId(container, 'sidebar-backdrop').click());
    expect(document.activeElement).toBe(menu);
  });

  it('puts the page out of reach while the phone menu is open', async () => {
    mounted = await mount(shell());
    const { container } = mounted;
    const main = container.querySelector('main');
    const menu = container.querySelector('[aria-controls="store-sidebar"]');
    if (!(menu instanceof HTMLButtonElement) || main === null) {
      throw new Error('no frame');
    }
    expect(main.hasAttribute('inert')).toBe(false);
    await act(async () => menu.click());
    expect(main.hasAttribute('inert')).toBe(true);
    await act(async () => menu.click());
    expect(main.hasAttribute('inert')).toBe(false);
  });

  it('a page chosen in the menu with no heading leaves focus on the menu button', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    let active = 'overview';
    const render = () => (
      <DashboardShell
        name="Shop"
        unnamed="Your store"
        identity={{ value: 'npub1' + 'q'.repeat(58), copyLabel: 'Copy' }}
        status="Read"
        busy={false}
        onRefresh={() => undefined}
        onSignOut={() => undefined}
        signOutLabel="Sign out"
        pages={[
          { id: 'overview', label: 'Overview', icon: 'home', content: <h1 tabIndex={-1}>O</h1> },
          { id: 'plain', label: 'Plain', icon: 'box', content: <p>No heading</p> },
        ]}
        active={active}
        onSelect={(id) => {
          active = id;
        }}
      />
    );
    mounted = await mount(render());
    const { container } = mounted;
    const menu = container.querySelector('[aria-controls="store-sidebar"]');
    if (!(menu instanceof HTMLButtonElement)) {
      throw new Error('no menu button');
    }
    await act(async () => menu.click());
    await act(async () => byId(container, 'nav-plain').click());
    await mounted.rerender(render());
    expect(page(container, 'plain').hidden).toBe(false);
    expect(document.activeElement).toBe(menu);
  });

  it('closes the phone menu, and frees the page, when the window widens past the phone layout', async () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    const removed: unknown[] = [];
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: (_type: string, handler: (event: MediaQueryListEvent) => void) => {
            listener = handler;
          },
          removeEventListener: (_type: string, handler: unknown) => {
            removed.push(handler);
          },
        }) as unknown as MediaQueryList,
    );
    mounted = await mount(shell());
    const { container } = mounted;
    const menu = container.querySelector('[aria-controls="store-sidebar"]');
    if (!(menu instanceof HTMLButtonElement)) {
      throw new Error('no menu button');
    }
    await act(async () => menu.click());
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 768px)');
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(true);
    await act(async () => listener?.({ matches: false } as MediaQueryListEvent));
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    await act(async () => listener?.({ matches: true } as MediaQueryListEvent));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(false);
    // The listener goes with the menu.
    expect(removed).toContain(listener);
  });

  it('gives focus to the menu button only for a page chosen in the menu', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    let active = 'overview';
    const render = () => (
      <DashboardShell
        name="Shop"
        unnamed="Your store"
        identity={{ value: 'npub1' + 'q'.repeat(58), copyLabel: 'Copy' }}
        status="Read"
        busy={false}
        onRefresh={() => undefined}
        onSignOut={() => undefined}
        signOutLabel="Sign out"
        pages={[
          { id: 'overview', label: 'Overview', icon: 'home', content: <h1 tabIndex={-1}>O</h1> },
          { id: 'second', label: 'Second', icon: 'box', content: <h1 tabIndex={-1}>S</h1> },
          { id: 'plain', label: 'Plain', icon: 'receipt', content: <p>No heading</p> },
        ]}
        active={active}
        onSelect={(id) => {
          active = id;
        }}
      />
    );
    mounted = await mount(render());
    const { container } = mounted;
    const menu = container.querySelector('[aria-controls="store-sidebar"]');
    if (!(menu instanceof HTMLButtonElement)) {
      throw new Error('no menu button');
    }
    // From the menu, to a page with a heading: the heading has it.
    await act(async () => menu.click());
    await act(async () => byId(container, 'nav-second').click());
    await mounted.rerender(render());
    expect(document.activeElement?.textContent).toBe('S');
    // Then from the sidebar itself, to a page with none: focus stays where it was.
    const nav = byId(container, 'nav-plain');
    nav.focus();
    await act(async () => nav.click());
    await mounted.rerender(render());
    expect(document.activeElement).toBe(nav);
  });

  it('describes a locked page once: its reason out of the button name', async () => {
    mounted = await mount(shell());
    const reason = byId(mounted.container, 'nav-orders-locked');
    expect(reason.getAttribute('aria-hidden')).toBe('true');
    expect(byId(mounted.container, 'nav-orders').getAttribute('aria-describedby')).toBe(
      'nav-orders-locked',
    );
  });
});

describe('the words for whose numbers they are', () => {
  it('notes a reported payment as not confirmed only when no credit confirms it', () => {
    const reported = row('r', 'payment_reported');
    expect(rowNotes(reported)).toContain('not confirmed by your node');
    const credited = row('c', 'payment_reported', {
      credits: [{ tx: 't', amount: '1000000', fee: '0', medium: 'solana' }],
    });
    expect(rowNotes(credited)).not.toContain('not confirmed by your node');
  });

  it('say "your node" for a store run by the merchant, "your store" in the cloud, in each view', async () => {
    const reported = [row('r', 'payment_reported')];
    const unnamedAsset = [
      row('u', 'delivered', { credits: [{ tx: 't', amount: '7', fee: '0', medium: 'mystery' }] }),
    ];
    for (const [source, words] of [
      ['self-hosted', 'your node'],
      ['cloud', 'your store'],
    ] as const) {
      const text = async (node: ReactElement, id?: string) => {
        mounted = await mount(node);
        const shown =
          id === undefined
            ? (mounted.container.textContent ?? '')
            : (byId(mounted.container, id).textContent ?? '');
        await mounted.unmount();
        mounted = undefined;
        return shown;
      };
      expect(
        await text(
          <Totals
            history={{ rows: [], totals: { perAsset: [], unknownAsset: [] } }}
            source={source}
          />,
          'totals',
        ),
      ).toContain(`by ${words}`);
      expect(
        await text(
          <Charts rows={unnamedAsset} nowSeconds={1_790_000_500} source={source} />,
          'uncharted',
        ),
      ).toContain(`in an asset ${words} did not name`);
      expect(
        await text(
          <Charts rows={reported} nowSeconds={1_790_000_500} source={source} />,
          'status-reported',
        ),
      ).toBe(`1 payment reported, not confirmed by ${words}`);
      expect(
        await text(
          <Charts rows={[]} nowSeconds={1_790_000_500} source={source} />,
          'credited-empty',
        ),
      ).toContain(`once ${words} confirms it`);
      expect(
        await text(<Overview snapshot={snapshot()} onTab={() => undefined} source={source} />),
      ).toContain(`what ${words} confirmed on chain`);
      const orders = await text(
        <OrdersSection
          snapshot={snapshot()}
          busy={false}
          onMore={() => undefined}
          source={source}
        />,
      );
      expect(orders).toContain(`Credited by ${words}`);
      expect(orders).toContain(
        source === 'cloud'
          ? 'Every order of your store, with what your store credited for it.'
          : 'Every order your inbox relays hold, with what your node credited for it.',
      );
    }
  });
});
