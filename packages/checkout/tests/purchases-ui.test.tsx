// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cannedOffer, cannedPurchases, cannedSource, offerView } from '../scripts/fixtures/canned';
import { type Actions, Checkout } from '../src/app/Checkout';
import type { Screen } from '../src/app/controller';
import { PURCHASE_STATUS_LABELS, type Purchase, type PurchaseStatus } from '../src/app/history';
import type { View } from '../src/app/session';
import {
  type PurchasesSource,
  READ_FAILED_TEXT,
  REVOKE_DOWNLOAD_AFTER_MS,
} from '../src/app/ui/PurchasesStep';
import {
  OPEN_STATUS_LINES,
  PURCHASES_TEXT,
  PURCHASE_BADGES,
  PURCHASE_STATUS_NOTES,
  STEPPER_STAGES,
  feeLine,
  networkLabel,
  receiptField,
  receiptMoment,
  receiptText,
  shortId,
} from '../src/app/ui/text';

const NOW = 1_790_000_000;
const OFFER_VIEW = offerView(cannedOffer());

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

interface Counted extends PurchasesSource {
  reads: number;
  opened: string[];
}

/** A source that counts what it was asked; `purchases` may be held open. */
function counted(
  purchases: Promise<Purchase[]> | Purchase[],
  fresh?: (orderId: string) => Promise<Purchase | undefined>,
): Counted {
  const fallback = cannedSource(Array.isArray(purchases) ? purchases : []);
  const source: Counted = {
    reads: 0,
    opened: [],
    purchases: async () => {
      source.reads += 1;
      return purchases;
    },
    purchase: (orderId) => {
      source.opened.push(orderId);
      return (fresh ?? fallback.purchase)(orderId);
    },
  };
  return source;
}

function mount(
  source: PurchasesSource | undefined,
  options: { view?: View; screen?: Screen; onClose?: () => void } = {},
) {
  const container = document.createElement('div');
  document.body.append(container);
  const calls = { pay: 0, cancel: 0 };
  let settle: Promise<void> = Promise.resolve();
  const actions: Actions = {
    choosePayout: () => undefined,
    checkInWallet: async () => undefined,
    confirmOldPrompt: async () => undefined,
    cancelOldPrompt: () => undefined,
    setEmail: () => undefined,
    pay: () => {
      calls.pay += 1;
      return settle;
    },
    retry: () => settle,
    signAgain: () => settle,
    startOver: () => settle,
    cancel: () => {
      calls.cancel += 1;
    },
  };
  let view = 'view' in options ? options.view : OFFER_VIEW;
  const draw = (next?: View) => {
    if (next !== undefined) {
      view = next;
    }
    act(() => {
      render(
        <Checkout
          screen={options.screen ?? { kind: 'loading' }}
          {...(view === undefined ? {} : { view })}
          actions={actions}
          {...(source === undefined ? {} : { purchases: source })}
          {...(options.onClose === undefined ? {} : { onClose: options.onClose })}
        />,
        container,
      );
    });
  };
  draw();
  const button = (label: string) => {
    const all = [...container.querySelectorAll('button')];
    // A copy button holds its other labels hidden in the same cell: its name comes first.
    const found =
      all.find((each) => each.textContent?.trim() === label) ??
      all.find((each) => each.textContent?.trim().startsWith(label) === true) ??
      all.find((each) => each.textContent?.trim().endsWith(label) === true);
    if (found === undefined) {
      throw new Error(`no button "${label}" in: ${container.textContent ?? ''}`);
    }
    return found;
  };
  return {
    container,
    calls,
    draw,
    button,
    hold: (promise: Promise<void>) => {
      settle = promise;
    },
    click: (label: string) => act(() => button(label).click()),
    /** The button named `label` by its `aria-label`. */
    byLabel: (label: string) => {
      const found = [...container.querySelectorAll('button')].find(
        (each) => each.getAttribute('aria-label') === label,
      );
      if (found === undefined) {
        throw new Error(`no button labelled "${label}"`);
      }
      return found;
    },
    /** Every button named `label` by its `aria-label`. */
    allByLabel: (label: string) =>
      [...container.querySelectorAll('button')].filter(
        (each) => each.getAttribute('aria-label') === label,
      ),
    /** Open the history and wait for its read. */
    open: async () => {
      act(() => button('Your purchases').click());
      await flush();
    },
    /** Open the row of the order `orderId` (or the first) and wait for its fresh read. */
    openRow: async (orderId?: string) => {
      const selector =
        orderId === undefined ? '.purchase-row' : `.purchase-row[data-order="${orderId}"]`;
      act(() => container.querySelector<HTMLButtonElement>(selector)?.click());
      await flush();
    },
    region: () => container.querySelector('[data-purchases-region]'),
    detail: () => container.querySelector('.purchase-card'),
    nav: () => container.querySelector('.purchases-nav')?.outerHTML ?? '',
    has: (label: string) =>
      [...container.querySelectorAll('button')].some((each) => each.textContent?.trim() === label),
    card: () => container.querySelector('.card'),
    /** The card as markup, with the purchases box emptied: what does not depend on the data. */
    shell: () => {
      const card = container.querySelector('.card')?.cloneNode(true);
      if (!(card instanceof Element)) {
        throw new Error('no card');
      }
      card.querySelector('[data-purchases-region]')?.replaceChildren();
      return card.outerHTML;
    },
  };
}

const STATUSES: readonly PurchaseStatus[] = [
  'delivered',
  'refunded',
  'waiting_store',
  'paying',
  'blocked',
  'cancelled_paid',
];

/** A canned purchase of `status` (the canned list cycles through every status). */
function purchaseOf(status: PurchaseStatus, overrides: Partial<Purchase> = {}): Purchase {
  const found = cannedPurchases(6, NOW).find((each) => each.status === status);
  if (found === undefined) {
    throw new Error(`no ${status} purchase`);
  }
  return { ...found, ...overrides };
}

function kindOf(status: PurchaseStatus): 'delivered' | 'refunded' | 'open' {
  return status === 'delivered' || status === 'refunded' ? status : 'open';
}

/** The text a node shows on screen: without what only screen readers get. */
function visibleText(node: Element | null): string {
  const copy = node?.cloneNode(true);
  if (!(copy instanceof Element)) {
    return '';
  }
  for (const hidden of copy.querySelectorAll('.visually-hidden')) {
    hidden.remove();
  }
  return copy.textContent ?? '';
}

describe('the entry point (T1)', () => {
  it('is the same with no purchases and with forty, and reads nothing until clicked (H1)', () => {
    const none = counted([]);
    const many = counted(cannedPurchases(40, NOW));
    const empty = mount(none);
    const full = mount(many);
    expect(empty.has('Your purchases')).toBe(true);
    expect(empty.card()?.outerHTML).toBe(full.card()?.outerHTML);
    expect(none.reads + many.reads).toBe(0);
  });

  it('is never offered before a session: no button, no read on a refused page (H5)', () => {
    const source = counted(cannedPurchases(3, NOW));
    const ui = mount(source, {
      view: undefined,
      screen: { kind: 'refused', reason: 'ref_needs_verified_store' },
    });
    expect(ui.has('Your purchases')).toBe(false);
    expect(source.reads).toBe(0);
  });
});

describe('the purchases box (T2, T3)', () => {
  it('has one shell whatever it holds: loading, failed, none, one, forty, any detail (H2a, H3)', async () => {
    const shells: string[] = [];
    const loading = mount(counted(new Promise<Purchase[]>(() => undefined)));
    loading.click('Your purchases');
    // Drawn at once on the click, before any record is read back.
    expect(loading.container.textContent).toContain('Loading…');
    shells.push(loading.shell());
    const failed = mount(counted(Promise.reject(new Error('blocked'))));
    await failed.open();
    expect(failed.container.textContent).toContain(READ_FAILED_TEXT);
    shells.push(failed.shell());
    for (const count of [0, 1, 40]) {
      const ui = mount(counted(cannedPurchases(count, NOW)));
      await ui.open();
      expect(ui.container.textContent).not.toContain('Loading…');
      shells.push(ui.shell());
    }
    const long = cannedPurchases(1, NOW).map((purchase) => ({
      ...purchase,
      receipt: { ...purchase.receipt, product: 'P'.repeat(400), store: 'S'.repeat(300) },
    }));
    const opened = mount(counted(long));
    await opened.open();
    await opened.openRow();
    expect(opened.allByLabel(PURCHASES_TEXT.backToListLabel)).toHaveLength(1);
    shells.push(opened.shell());
    const base = purchaseOf('delivered');
    const sent = { ...base, receipt: { ...base.receipt, sent: { tx: '5'.repeat(88) } } };
    const checked = mount(counted([base], async () => sent));
    await checked.open();
    await checked.openRow();
    expect(checked.detail()?.textContent).toContain('Transaction sent');
    shells.push(checked.shell());
    const blocked = mount(counted([purchaseOf('blocked')]));
    await blocked.open();
    await blocked.openRow();
    expect(blocked.detail()?.textContent).toContain('Payment blocked by the recipient.');
    shells.push(blocked.shell());
    for (const shell of shells) {
      expect(shell).toBe(shells[0]);
    }
  });

  it('keeps one nav for every list state, and one for every detail (H2c)', async () => {
    const lists: string[] = [];
    const loading = mount(counted(new Promise<Purchase[]>(() => undefined)));
    loading.click('Your purchases');
    lists.push(loading.nav());
    const failed = mount(counted(Promise.reject(new Error('blocked'))));
    await failed.open();
    lists.push(failed.nav());
    for (const count of [0, 40]) {
      const ui = mount(counted(cannedPurchases(count, NOW)));
      await ui.open();
      lists.push(ui.nav());
    }
    for (const nav of lists) {
      expect(nav).toBe(lists[0]);
    }
    const details: string[] = [];
    for (const status of STATUSES) {
      const ui = mount(counted([purchaseOf(status)]));
      await ui.open();
      await ui.openRow();
      details.push(ui.nav());
    }
    for (const nav of details) {
      expect(nav).toBe(details[0]);
    }
    expect(details[0]).not.toBe(lists[0]);
  });

  it('draws the nav and its heading before the read, inside the box (H3)', async () => {
    const held = mount(counted(new Promise<Purchase[]>(() => undefined)));
    held.click('Your purchases');
    const heading = held.region()?.querySelector('h2[data-heading]');
    expect(heading?.textContent).toBe(PURCHASES_TEXT.title);
    expect(held.region()?.querySelector('[data-purchases-back]')).not.toBeNull();
    const loaded = mount(counted(cannedPurchases(3, NOW)));
    await loaded.open();
    expect(held.shell()).toBe(loaded.shell());
  });

  it('the box has a fixed height and scrolls inside, with no min or max height (H2b)', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/styles.css'), 'utf8');
    const rule = (selector: string) => {
      const match = new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
      return match?.[2] ?? '';
    };
    const region = rule('.purchases-region');
    expect(region).toMatch(/(^|\n)\s*height:\s*var\(--history-height\);/);
    expect(region).toMatch(/overflow(-y)?:\s*auto;/);
    expect(css).toMatch(/--history-height:\s*\d+px;/);
    for (const selector of ['.purchases-region', '.purchases', '.step', '.card', 'body']) {
      expect(rule(selector)).not.toMatch(/(min|max)-height/);
    }
    for (const selector of [
      '.purchases-nav',
      '.purchases-actions',
      '.purchase-list',
      '.purchase-row',
      '.purchase-card',
    ]) {
      expect(rule(selector)).not.toMatch(/(^|\n)\s*(min-|max-)?height:/);
    }
  });

  it('lists nothing with a note when there is nothing, and no export warning', async () => {
    const ui = mount(counted([]));
    await ui.open();
    expect(ui.container.textContent).toContain('No purchases from this store in this browser yet.');
    expect(ui.container.textContent).not.toContain('Keep it private');
    expect(ui.container.textContent).not.toContain('delivery');
    expect(ui.button('Download CSV').disabled).toBe(false);
  });
});

describe('one way back (N1)', () => {
  const noOtherBack = (ui: ReturnType<typeof mount>) => {
    const names = [...ui.container.querySelectorAll('button')].map(
      (each) => each.textContent?.trim() ?? '',
    );
    expect(names).not.toContain('Back');
    expect(names).not.toContain('Back to the list');
    expect(ui.card()?.querySelector('[data-purchases-button]')).toBeNull();
  };

  it('the list: one "Back to checkout", no other back, no footer link', async () => {
    const loading = mount(counted(new Promise<Purchase[]>(() => undefined)));
    loading.click('Your purchases');
    const uis = [loading];
    for (const source of [counted([]), counted(cannedPurchases(40, NOW))]) {
      const ui = mount(source);
      await ui.open();
      uis.push(ui);
    }
    const failed = mount(counted(Promise.reject(new Error('gone'))));
    await failed.open();
    uis.push(failed);
    for (const ui of uis) {
      const backs = ui.container.querySelectorAll('[data-purchases-back]');
      expect(backs).toHaveLength(1);
      expect(backs[0]?.getAttribute('aria-label')).toBe('Back to checkout');
      expect(backs[0]?.getAttribute('title')).toBe('Back to checkout');
      expect(backs[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('←');
      noOtherBack(ui);
    }
  });

  it('a detail: one "Back to your purchases", showing "Your purchases"', async () => {
    const ui = mount(counted(cannedPurchases(3, NOW)));
    await ui.open();
    await ui.openRow();
    const backs = ui.container.querySelectorAll('[data-purchases-back]');
    expect(backs).toHaveLength(1);
    expect(backs[0]?.getAttribute('aria-label')).toBe('Back to your purchases');
    expect(
      visibleText(backs[0] ?? null)
        .replace('←', '')
        .trim(),
    ).toBe('Your purchases');
    expect(ui.allByLabel('Back to checkout')).toHaveLength(0);
    noOtherBack(ui);
  });

  it('closed again: the footer link is back', async () => {
    const ui = mount(counted(cannedPurchases(3, NOW)));
    await ui.open();
    ui.click('←');
    expect(ui.card()?.querySelector('[data-purchases-button]')).not.toBeNull();
    expect(ui.region()).toBeNull();
  });
});

describe('focus in Your purchases (N2)', () => {
  it('opening focuses the heading; a row focuses its way back; back focuses that row', async () => {
    const purchases = cannedPurchases(3, NOW);
    const ui = mount(counted(purchases));
    await ui.open();
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.textContent).toBe('Your purchases');
    await ui.openRow(purchases[1]?.orderId);
    expect(document.activeElement).toBe(ui.byLabel('Back to your purchases'));
    act(() => ui.byLabel('Back to your purchases').click());
    await flush();
    expect((document.activeElement as HTMLElement | null)?.dataset.order).toBe(
      purchases[1]?.orderId,
    );
  });

  it('moves no focus on open or back while the frame does not have focus', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const purchases = cannedPurchases(3, NOW);
    const ui = mount(counted(purchases));
    await ui.open();
    await ui.openRow(purchases[1]?.orderId);
    expect(ui.detail()).not.toBeNull();
    expect(document.activeElement).not.toBe(ui.byLabel('Back to your purchases'));
    act(() => ui.byLabel('Back to your purchases').click());
    await flush();
    expect(ui.detail()).toBeNull();
    expect((document.activeElement as HTMLElement | null)?.dataset.order).toBeUndefined();
  });

  it('the list’s way back closes the history and focuses the footer link', async () => {
    const ui = mount(counted(cannedPurchases(3, NOW)));
    await ui.open();
    act(() => ui.byLabel('Back to checkout').click());
    expect(ui.region()).toBeNull();
    expect(document.activeElement?.hasAttribute('data-purchases-button')).toBe(true);
  });

  it('a view a press brings while the list is open never moves focus out of it', async () => {
    const ui = mount(counted(cannedPurchases(3, NOW)));
    let release: () => void = () => undefined;
    ui.hold(new Promise<void>((resolve) => (release = resolve)));
    ui.click('Solflare');
    await ui.open();
    const row = ui.container.querySelector<HTMLButtonElement>('.purchase-row');
    act(() => row?.focus());
    ui.draw({ kind: 'delivered' });
    expect(document.activeElement).toBe(row);
    release();
    await flush();
  });
});

describe('the detail: one flat card (N3)', () => {
  it('has no nested card, no Store row, no "Receipt" title, and the help only for screen readers', async () => {
    const ui = mount(counted([purchaseOf('delivered')]));
    await ui.open();
    await ui.openRow();
    const region = ui.region();
    expect(region?.querySelectorAll('.purchase-card')).toHaveLength(1);
    for (const selector of [
      '.receipt',
      '.receipt-title',
      '.receipt-text',
      '.copy-button',
      '.purchase-card .purchase-card',
    ]) {
      expect(region?.querySelector(selector)).toBeNull();
    }
    const shown = visibleText(ui.detail());
    expect(shown).not.toContain('Store:');
    expect(shown).not.toMatch(/receipt$/i);
    expect(shown.toUpperCase()).not.toContain('RECEIPT\n');
    expect(ui.detail()?.querySelector('.receipt-title')).toBeNull();
    // "Completed" only in the badge.
    expect(shown.split('Completed')).toHaveLength(2);
    expect(ui.detail()?.querySelector('.status-badge')?.textContent).toBe('Completed');
    expect(shown).not.toContain(PURCHASES_TEXT.orderHelp);
    const copyOrder = ui.byLabel('Copy order number');
    const described = copyOrder.getAttribute('aria-describedby') ?? '';
    const help = ui.container.querySelector(`[id="${described}"]`);
    expect(help?.textContent).toBe(PURCHASES_TEXT.orderHelp);
    expect(help?.classList.contains('visually-hidden')).toBe(true);
    const helpers = [...ui.container.querySelectorAll('*')].filter(
      (node) => node.childElementCount === 0 && node.textContent === PURCHASES_TEXT.orderHelp,
    );
    expect(helpers).toEqual([help]);
  });
});

describe('Download CSV (N4)', () => {
  it('is on the list while loading, with none and with many, never in a detail', async () => {
    const loading = mount(counted(new Promise<Purchase[]>(() => undefined)));
    loading.click('Your purchases');
    expect(loading.has('Download CSV')).toBe(true);
    for (const count of [0, 40]) {
      const ui = mount(counted(cannedPurchases(count, NOW)));
      await ui.open();
      expect(ui.has('Download CSV')).toBe(true);
      expect(ui.region()?.querySelector('.purchases-actions')).not.toBeNull();
    }
    const detail = mount(counted(cannedPurchases(3, NOW)));
    await detail.open();
    await detail.openRow();
    expect(detail.has('Download CSV')).toBe(false);
  });
});

describe('the fee line', () => {
  it('names the elisym fee a purchase includes, and nothing when it has none', async () => {
    const base = purchaseOf('delivered');
    const asset = base.receipt.paying?.asset;
    if (asset === undefined) {
      throw new Error('a canned purchase names its coin');
    }
    const ui = mount(counted([{ ...base, feeAmount: '490000' }]));
    await ui.open();
    await ui.openRow();
    const line = ui.detail()?.querySelector('[data-fee-line]');
    expect(line?.textContent).toBe(feeLine(asset, 490_000n));
    expect(line?.textContent).toBe('Includes elisym fee 0.49 USDC');
    const plain = mount(counted([base]));
    await plain.open();
    await plain.openRow();
    expect(plain.detail()?.querySelector('[data-fee-line]')).toBeNull();
  });
});

describe('the order number (N5)', () => {
  it('copies the full id, not its short form, and says so', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const purchase = purchaseOf('delivered');
    const ui = mount(counted([purchase]));
    await ui.open();
    await ui.openRow();
    const full = receiptField(purchase.receipt.orderId);
    expect(ui.detail()?.querySelector('.mono')?.textContent).toBe(shortId(full));
    expect(ui.detail()?.querySelector('.mono')?.getAttribute('title')).toBe(
      `${full}. ${PURCHASES_TEXT.orderHelp}`,
    );
    expect(shortId(full)).not.toBe(full);
    await act(async () => ui.byLabel('Copy order number').click());
    await flush();
    expect(writeText).toHaveBeenCalledWith(full);
    const said = [...ui.container.querySelectorAll('[role="status"]')].map(
      (each) => each.textContent,
    );
    expect(said).toContain('Order number copied.');
    // Both glyphs share one cell: the button never changes size.
    const options = ui.byLabel('Copy order number').querySelectorAll('.label-option');
    expect(options).toHaveLength(2);
    expect([...options].map((option) => option.getAttribute('data-current'))).toEqual([
      'false',
      'true',
    ]);
  });

  it('shows and selects the full id when the clipboard is refused', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const purchase = purchaseOf('delivered');
    const ui = mount(counted([purchase]));
    await ui.open();
    await ui.openRow();
    await act(async () => ui.byLabel('Copy order number').click());
    await flush();
    const full = receiptField(purchase.receipt.orderId);
    const value = ui.detail()?.querySelector('.mono');
    expect(value?.textContent).toBe(full);
    expect(window.getSelection()?.toString()).toBe(full);
  });
});

describe('Copy receipt (N6)', () => {
  it('copies exactly the receipt text, for every status', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const tx = '9'.repeat(88);
    for (const status of STATUSES) {
      const base = purchaseOf(status);
      const purchase: Purchase = {
        ...base,
        receipt: {
          ...base.receipt,
          ...(status === 'paying' || status === 'blocked' ? {} : { paid: { tx } }),
        },
      };
      const ui = mount(counted([purchase]));
      await ui.open();
      await ui.openRow();
      await act(async () => ui.button('Copy receipt').click());
      const copied = String(writeText.mock.calls.at(-1)?.[0] ?? '');
      expect(copied).toBe(receiptText(purchase.receipt, kindOf(status)));
      expect(copied).toContain(`Store: ${purchase.receipt.store}`);
      if (kindOf(status) === 'open') {
        expect(copied).toContain(`Status: ${OPEN_STATUS_LINES[status as 'paying']}`);
        expect(copied).toContain('Ordered on');
      }
      if (purchase.receipt.paid !== undefined) {
        expect(copied).toContain(`Transaction: ${tx}`);
      }
      document.body.replaceChildren();
    }
  });

  it('copies "Transaction sent" once the check found it', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const base = purchaseOf('delivered');
    const sent = { ...base, receipt: { ...base.receipt, sent: { tx: '5'.repeat(88) } } };
    const ui = mount(counted([base], async () => sent));
    await ui.open();
    await ui.openRow();
    await act(async () => ui.button('Copy receipt').click());
    expect(writeText).toHaveBeenCalledWith(receiptText(sent.receipt, 'delivered'));
    expect(String(writeText.mock.calls.at(-1)?.[0])).toContain(
      `Transaction sent: ${'5'.repeat(88)}`,
    );
  });

  it('shows and selects the full receipt when the clipboard is refused', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const purchase = purchaseOf('refunded');
    const ui = mount(counted([purchase]));
    await ui.open();
    await ui.openRow();
    expect(ui.detail()?.querySelector('.purchase-receipt-full')).toBeNull();
    await act(async () => ui.button('Copy receipt').click());
    await flush();
    const full = ui.detail()?.querySelector('.purchase-receipt-full');
    expect(full?.textContent).toBe(receiptText(purchase.receipt, 'refunded'));
    expect(window.getSelection()?.toString()).toBe(receiptText(purchase.receipt, 'refunded'));
  });
});

describe('status badges (N7)', () => {
  it('match the table in the row and the detail; notes only where the badge is short', async () => {
    const expected: Record<PurchaseStatus, [string, string]> = {
      delivered: ['Completed', 'success'],
      refunded: ['Refunded', 'neutral'],
      waiting_store: ['Waiting for the store', 'pending'],
      paying: ['Payment in progress', 'pending'],
      blocked: ['Payment blocked', 'problem'],
      cancelled_paid: ['Cancelled', 'problem'],
    };
    for (const status of STATUSES) {
      const purchase = purchaseOf(status, { thisProduct: true });
      const ui = mount(counted([purchase]));
      await ui.open();
      const row = ui.container.querySelector('.purchase-row .status-badge');
      expect([row?.textContent, row?.getAttribute('data-tone')]).toEqual(expected[status]);
      const label = PURCHASE_STATUS_LABELS[status];
      expect(row?.getAttribute('title')).toBe(label === expected[status][0] ? null : label);
      await ui.openRow();
      const badge = ui.detail()?.querySelector('.status-badge');
      expect([badge?.textContent, badge?.getAttribute('data-tone')]).toEqual(expected[status]);
      const notes = [...(ui.detail()?.querySelectorAll('.note') ?? [])].map(
        (note) => note.textContent,
      );
      const note = PURCHASE_STATUS_NOTES[status];
      expect(notes).toEqual(note === undefined ? [] : [note]);
      expect(note === undefined ? undefined : `${label}.`).toBe(note);
      document.body.replaceChildren();
    }
    expect(Object.keys(PURCHASE_BADGES).sort()).toEqual([...STATUSES].sort());
  });

  it('a row shows the product, its amount, the day and the badge', async () => {
    const purchase = purchaseOf('delivered');
    const ui = mount(counted([purchase]));
    await ui.open();
    const row = ui.container.querySelector('.purchase-row');
    expect(row?.querySelector('.purchase-product')?.textContent).toBe('Deposit 1 USD');
    expect(row?.querySelector('.purchase-product')?.getAttribute('title')).toBe('Deposit 1 USD');
    expect(row?.querySelector('.purchase-amount')?.textContent).toBe('49 USDC');
    expect(row?.querySelector('.purchase-day')?.textContent).toBe(
      new Date(purchase.createdAt * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' }),
    );
    expect(row?.textContent).not.toContain('Solana devnet');
  });
});

describe('the date and network (N8)', () => {
  it('dates the detail as its receipt does, the label in the title', async () => {
    const paidAt = NOW + 30;
    const cases: [PurchaseStatus, Partial<Purchase['receipt']>, string][] = [
      ['delivered', { paid: { tx: '1'.repeat(88), at: paidAt } }, 'Payment confirmed on'],
      ['delivered', {}, 'Completed on'],
      ['refunded', {}, 'Refunded on'],
      ['paying', {}, 'Ordered on'],
      ['waiting_store', { answeredAt: NOW + 99 }, 'Ordered on'],
    ];
    for (const [status, extra, label] of cases) {
      const base = purchaseOf(status);
      const purchase = { ...base, receipt: { ...base.receipt, ...extra } };
      const ui = mount(counted([purchase]));
      await ui.open();
      await ui.openRow();
      const time = ui.detail()?.querySelector('.purchase-meta time');
      const moment = receiptMoment(purchase.receipt, kindOf(status));
      expect(moment?.label).toBe(label);
      const firstDate = receiptText(purchase.receipt, kindOf(status))
        .split('\n')
        .find((line) => line.startsWith(`${label}: `));
      expect(`${label}: ${time?.textContent ?? ''}`).toBe(firstDate);
      expect(time?.getAttribute('title')).toBe(label);
      expect(time?.getAttribute('datetime')).toBe(new Date((moment?.at ?? 0) * 1000).toISOString());
      const paying = purchase.receipt.paying;
      if (paying === undefined) {
        throw new Error('no paying');
      }
      expect(ui.detail()?.querySelector('.purchase-meta')?.textContent).toBe(
        `${time?.textContent ?? ''} · ${networkLabel(paying.chain, paying.network)}`,
      );
      document.body.replaceChildren();
    }
  });

  it('dates a completed purchase with no finish moment by its order time', async () => {
    const base = purchaseOf('delivered', { createdAt: NOW - 1000 });
    const { answeredAt: _answeredAt, paid: _paid, ...rest } = base.receipt;
    const purchase: Purchase = { ...base, receipt: { ...rest, orderedAt: NOW - 500 } };
    expect(receiptMoment(purchase.receipt, 'delivered')).toBeUndefined();
    const ui = mount(counted([purchase]));
    await ui.open();
    await ui.openRow();
    const time = ui.detail()?.querySelector('.purchase-meta time');
    expect(time?.getAttribute('title')).toBe('Ordered on');
    expect(time?.getAttribute('datetime')).toBe(new Date((NOW - 500) * 1000).toISOString());
  });

  it('names no network, and no amount, for a purchase whose payout cannot be read', async () => {
    const base = purchaseOf('delivered');
    const { paying: _paying, ...receipt } = base.receipt;
    const ui = mount(counted([{ ...base, receipt }]));
    await ui.open();
    await ui.openRow();
    expect(ui.detail()?.querySelector('.purchase-meta')?.textContent).not.toContain('·');
    expect(ui.detail()?.querySelector('.purchase-total')).toBeNull();
  });
});

describe('the transaction row (N9, H12)', () => {
  it('shows a sent transaction only once its check succeeded, and nothing late once closed', async () => {
    const [purchase] = cannedPurchases(1, NOW);
    if (purchase === undefined) {
      throw new Error('no purchase');
    }
    const checks: ((now: Purchase) => void)[] = [];
    const source = counted(
      [purchase],
      () => new Promise<Purchase | undefined>((resolve) => checks.push(resolve)),
    );
    const ui = mount(source);
    await ui.open();
    // Opening the list asks for no receipt.
    expect(source.opened).toEqual([]);
    act(() => ui.container.querySelector<HTMLButtonElement>('.purchase-row')?.click());
    expect(source.opened).toEqual([purchase.orderId]);
    expect(ui.container.textContent).not.toContain('Transaction');
    const sent = { ...purchase, receipt: { ...purchase.receipt, sent: { tx: '5'.repeat(88) } } };
    await act(async () => checks[0]?.(sent));
    await flush();
    const facts = [...(ui.detail()?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent);
    expect(facts).toEqual(['Product', 'Order', 'Transaction sent']);
    // A second opening whose check ends after it closed draws nothing.
    act(() => ui.byLabel('Back to your purchases').click());
    act(() => ui.container.querySelector<HTMLButtonElement>('.purchase-row')?.click());
    act(() => ui.byLabel('Back to your purchases').click());
    await act(async () => checks[1]?.(sent));
    await flush();
    expect(ui.container.textContent).not.toContain('Transaction sent');
  });

  it('a paid purchase: "Transaction", linked to an https explorer, as text otherwise', async () => {
    const tx = '7'.repeat(88);
    const base = purchaseOf('delivered');
    const linked: Purchase = {
      ...base,
      receipt: { ...base.receipt, paid: { tx, explorer: `https://explorer.solana.com/tx/${tx}` } },
    };
    const ui = mount(counted([linked]));
    await ui.open();
    await ui.openRow();
    const facts = [...(ui.detail()?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent);
    expect(facts).toEqual(['Product', 'Order', 'Transaction']);
    const link = ui.detail()?.querySelector('dd a');
    expect(link?.getAttribute('href')).toBe(`https://explorer.solana.com/tx/${tx}`);
    expect(link?.textContent).toBe(`${tx.slice(0, 6)}…${tx.slice(-4)} ↗`);
    document.body.replaceChildren();
    const plain: Purchase = {
      ...base,
      receipt: { ...base.receipt, paid: { tx, explorer: `http://explorer.example/${tx}` } },
    };
    const other = mount(counted([plain]));
    await other.open();
    await other.openRow();
    expect(other.detail()?.querySelector('dd a')).toBeNull();
    expect(other.detail()?.querySelector(`dd span[title="${tx}"]`)?.textContent).toBe(
      `${tx.slice(0, 6)}…${tx.slice(-4)}`,
    );
  });
});

describe('the detail', () => {
  it('shows a completed purchase with no delivery anywhere (M9)', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const tx = '7'.repeat(88);
    const base = purchaseOf('delivered');
    const purchase: Purchase = { ...base, receipt: { ...base.receipt, paid: { tx } } };
    const ui = mount(counted([purchase]));
    await ui.open();
    await ui.openRow();
    expect(ui.detail()?.textContent).toContain('Completed');
    expect(ui.detail()?.textContent).not.toContain('Delivered');
    expect(ui.detail()?.textContent).not.toContain('Delivery');
    expect(ui.detail()?.querySelector('dl')?.lastElementChild?.textContent).toContain(
      tx.slice(0, 6),
    );
    await act(async () => ui.button('Copy receipt').click());
    const copied = String(writeText.mock.calls.at(-1)?.[0] ?? '');
    expect(copied).not.toContain('Delivery');
    expect(copied).toContain(tx);
  });

  it('says where an unfinished purchase stands: the badge on screen, the lines in the copy (H11)', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    for (const status of ['waiting_store', 'paying', 'blocked', 'cancelled_paid'] as const) {
      const base = purchaseOf(status);
      const purchase: Purchase = {
        ...base,
        receipt: { ...base.receipt, answeredAt: NOW + 60 },
      };
      const ui = mount(counted([purchase]));
      await ui.open();
      await ui.openRow();
      expect(ui.detail()?.querySelector('.status-badge')?.textContent).toBe(
        PURCHASE_BADGES[status].text,
      );
      expect(ui.detail()?.textContent).not.toContain('Delivered on');
      expect(ui.detail()?.textContent).not.toContain('Completed on');
      await act(async () => ui.button('Copy receipt').click());
      const copied = String(writeText.mock.calls.at(-1)?.[0] ?? '');
      expect(copied).toContain(`Status: ${OPEN_STATUS_LINES[status]}`);
      expect(copied).not.toContain('Delivered on');
      if (status === 'cancelled_paid') {
        expect(copied).not.toContain('waiting for the store');
      }
      document.body.replaceChildren();
    }
  });

  it('a purchase of another product in progress says to open its checkout', async () => {
    const purchase = cannedPurchases(4, NOW)[3];
    if (purchase === undefined) {
      throw new Error('no purchase');
    }
    expect(purchase).toMatchObject({ status: 'paying', thisProduct: false });
    const ui = mount(counted([purchase]));
    await ui.open();
    act(() => ui.container.querySelector<HTMLButtonElement>('.purchase-row')?.click());
    expect(ui.container.textContent).toContain("Open this product's checkout to follow it.");
  });
});

describe('the detail, as it stands now', () => {
  it('a paying row completed since: shown as completed, no Status line (fix 3)', async () => {
    const paying = cannedPurchases(4, NOW)[3];
    if (paying === undefined || paying.status !== 'paying') {
      throw new Error('no paying purchase');
    }
    const { openStatus: _status, ...receipt } = paying.receipt;
    const delivered: Purchase = {
      ...paying,
      status: 'delivered',
      receipt: { ...receipt, answeredAt: NOW + 60 },
    };
    const ui = mount(counted([paying], async () => delivered));
    await ui.open();
    await ui.openRow();
    const text = ui.detail()?.textContent ?? '';
    expect(ui.detail()?.querySelector('.status-badge')?.textContent).toBe('Completed');
    expect(text).not.toContain('Status:');
    expect(text).not.toContain("Open this product's checkout");
  });
});

describe('around the purchase on screen', () => {
  it('Back returns to the session’s view now, focus on the heading then the button (H13)', async () => {
    const ui = mount(counted(cannedPurchases(3, NOW)));
    await ui.open();
    expect(document.activeElement?.textContent).toBe('Your purchases');
    expect(document.activeElement?.tagName).toBe('H2');
    // A completion arrives while the history is open: drawn under it.
    ui.draw({ kind: 'delivered' });
    expect(ui.container.textContent).not.toContain('Buy again');
    act(() => ui.byLabel('Back to checkout').click());
    expect(ui.container.textContent).toContain('Buy again');
    expect(document.activeElement?.textContent?.trim()).toBe('Your purchases');
    expect(document.activeElement?.tagName).toBe('BUTTON');
  });

  it('a press running underneath is neither cancelled nor run again (H14)', async () => {
    const ui = mount(counted(cannedPurchases(1, NOW)));
    let release: () => void = () => undefined;
    ui.hold(new Promise<void>((resolve) => (release = resolve)));
    ui.click('Solflare');
    expect(ui.calls.pay).toBe(1);
    await ui.open();
    act(() => ui.byLabel('Back to checkout').click());
    release();
    await flush();
    expect(ui.calls).toEqual({ pay: 1, cancel: 0 });
  });

  it('posts nothing while the history is used: open, detail, copies, download, back (H10)', async () => {
    const onClose = vi.fn();
    const posted = vi.spyOn(window.parent, 'postMessage');
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const ui = mount(counted(cannedPurchases(2, NOW)), { onClose });
    await ui.open();
    await ui.openRow();
    await act(async () => ui.byLabel('Copy order number').click());
    await act(async () => ui.button('Copy receipt').click());
    act(() => ui.byLabel('Back to your purchases').click());
    await act(async () => ui.button('Download CSV').click());
    await flush();
    act(() => ui.byLabel('Back to checkout').click());
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });
});

describe('a read that failed', () => {
  it('says so in the same box, never "no purchases", and offers no download', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const ui = mount(counted(Promise.reject(new Error('storage gone'))));
    await ui.open();
    expect(ui.container.textContent).toContain(READ_FAILED_TEXT);
    expect(ui.container.textContent).not.toContain('No purchases');
    expect(ui.has('Download CSV')).toBe(false);
    expect(created).not.toHaveBeenCalled();
  });

  it('hands focus to its note when it removes the focused download button', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let reject: (error: Error) => void = () => undefined;
    const ui = mount(counted(new Promise<Purchase[]>((_resolve, fail) => (reject = fail))));
    ui.click('Your purchases');
    act(() => ui.button('Download CSV').focus());
    expect(document.activeElement?.textContent).toBe('Download CSV');
    await act(async () => reject(new Error('storage gone')));
    await flush();
    expect(ui.has('Download CSV')).toBe(false);
    expect(document.activeElement?.textContent).toBe(READ_FAILED_TEXT);
  });

  it('leaves focus where it is when the focused control is not the download button', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let reject: (error: Error) => void = () => undefined;
    const ui = mount(counted(new Promise<Purchase[]>((_resolve, fail) => (reject = fail))));
    ui.click('Your purchases');
    const back = ui.container.querySelector<HTMLButtonElement>('[data-purchases-back]');
    if (back === null) {
      throw new Error('no back button');
    }
    act(() => back.focus());
    expect(document.activeElement).toBe(back);
    await act(async () => reject(new Error('storage gone')));
    await flush();
    expect(ui.container.textContent).toContain(READ_FAILED_TEXT);
    expect(document.activeElement).toBe(back);
  });

  it('does not move focus to its note while the page itself has no focus', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let reject: (error: Error) => void = () => undefined;
    const ui = mount(counted(new Promise<Purchase[]>((_resolve, fail) => (reject = fail))));
    ui.click('Your purchases');
    act(() => ui.button('Download CSV').focus());
    expect(document.activeElement?.textContent).toBe('Download CSV');
    hasFocus.mockReturnValue(false);
    await act(async () => reject(new Error('storage gone')));
    await flush();
    expect(ui.has('Download CSV')).toBe(false);
    expect(document.activeElement?.textContent).not.toBe(READ_FAILED_TEXT);
  });
});

describe('the download (D3)', () => {
  it('a click while loading exports what is read, and lets the file go later (H9)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:purchases';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        clicks.push(this.download);
      },
    );
    let resolve: (purchases: Purchase[]) => void = () => undefined;
    const ui = mount(counted(new Promise<Purchase[]>((done) => (resolve = done))));
    ui.click('Your purchases');
    ui.click('Download CSV');
    expect(blobs).toHaveLength(0);
    await act(async () => resolve(cannedPurchases(3, NOW)));
    await act(async () => undefined);
    expect(blobs).toHaveLength(1);
    const text = await blobs[0]?.text();
    expect(text?.trimEnd().split('\r\n')).toHaveLength(4);
    expect(clicks[0]).toMatch(/^elisym-purchases-.*\.csv$/);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_DOWNLOAD_AFTER_MS);
    expect(revoke).toHaveBeenCalledWith('blob:purchases');
  });
});

describe('the card after a reset on reopen (D4)', () => {
  it('closes Your purchases and shows the wallets again', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const actions: Actions = {
      choosePayout: () => undefined,
      confirmOldPrompt: async () => undefined,
      cancelOldPrompt: () => undefined,
      setEmail: () => undefined,
      pay: async () => undefined,
      retry: async () => undefined,
      signAgain: async () => undefined,
      startOver: async () => undefined,
      cancel: () => undefined,
      checkInWallet: async () => undefined,
    };
    const source = counted(cannedPurchases(2, NOW));
    const draw = (view: View, resetCount: number) =>
      act(() => {
        render(
          <Checkout
            screen={{ kind: 'loading' }}
            view={view}
            actions={actions}
            purchases={source}
            resetCount={resetCount}
          />,
          container,
        );
      });
    const wallets = () =>
      [...container.querySelectorAll('button')].some(
        (each) => each.textContent?.trim().endsWith('Solflare') === true,
      );
    const changed = offerView(cannedOffer(), { problem: { reason: 'offer_changed' } });
    draw(changed, 0);
    expect(wallets()).toBe(false);
    act(() =>
      [...container.querySelectorAll('button')]
        .find((each) => each.textContent?.trim() === 'Your purchases')
        ?.click(),
    );
    await flush();
    expect(container.querySelector('.purchase-list, [data-purchases-region]')).not.toBeNull();
    // The same view drawn again changes nothing; a reset does.
    draw(OFFER_VIEW, 0);
    expect(container.querySelector('[data-purchases-region]')).not.toBeNull();
    draw(OFFER_VIEW, 1);
    await flush();
    expect(container.querySelector('[data-purchases-region]')).toBeNull();
    expect(wallets()).toBe(true);
    expect(container.textContent).not.toContain('Choose wallet');
  });
});

describe('themes and words', () => {
  it('defines the badge colors in every theme block', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/styles.css'), 'utf8');
    const blocks = [
      /:root \{([^}]*)\}/.exec(css)?.[1] ?? '',
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='light'\]\) \{([^}]*)\}/.exec(
        css,
      )?.[1] ?? '',
      /:root\[data-theme='dark'\] \{([^}]*)\}/.exec(css)?.[1] ?? '',
    ];
    for (const block of blocks) {
      expect(block).toMatch(/--success-background:\s*#[0-9a-f]{6};/);
      expect(block).toMatch(/--success-text:\s*#[0-9a-f]{6};/);
    }
  });

  it('never uses an em dash', () => {
    const values = [
      ...Object.values(PURCHASES_TEXT),
      ...Object.values(PURCHASE_BADGES).map((badge) => badge.text),
      ...Object.values(PURCHASE_STATUS_NOTES),
      ...STEPPER_STAGES,
    ];
    for (const value of values) {
      expect(value).not.toContain('—');
    }
  });
});
