// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cannedOffer, cannedPurchases, cannedSource, offerView } from '../scripts/fixtures/canned';
import { type Actions, Checkout } from '../src/app/Checkout';
import type { Screen } from '../src/app/controller';
import type { Purchase } from '../src/app/history';
import type { View } from '../src/app/session';
import {
  type PurchasesSource,
  READ_FAILED_TEXT,
  REVOKE_DOWNLOAD_AFTER_MS,
} from '../src/app/ui/PurchasesStep';
import { OPEN_STATUS_LINES } from '../src/app/ui/text';

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
    confirmOldPrompt: async () => undefined,
    cancelOldPrompt: () => undefined,
    setEmail: () => undefined,
    pay: () => {
      calls.pay += 1;
      return settle;
    },
    retry: () => settle,
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
  it('has one shell whatever it holds: loading, none, one, forty, one opened (H2a, H3)', async () => {
    const shells: string[] = [];
    const loading = mount(counted(new Promise<Purchase[]>(() => undefined)));
    loading.click('Your purchases');
    // Drawn at once on the click, before any record is read back.
    expect(loading.container.textContent).toContain('Loading…');
    shells.push(loading.shell());
    const failed = mount(counted(Promise.reject(new Error('blocked'))));
    failed.click('Your purchases');
    await flush();
    expect(failed.container.textContent).toContain(READ_FAILED_TEXT);
    shells.push(failed.shell());
    for (const count of [0, 1, 40]) {
      const ui = mount(counted(cannedPurchases(count, NOW)));
      ui.click('Your purchases');
      await flush();
      expect(ui.container.textContent).not.toContain('Loading…');
      shells.push(ui.shell());
    }
    const long = cannedPurchases(1, NOW).map((purchase) => ({
      ...purchase,
      receipt: { ...purchase.receipt, product: 'P'.repeat(400), store: 'S'.repeat(300) },
    }));
    const opened = mount(counted(long));
    opened.click('Your purchases');
    await flush();
    act(() => opened.container.querySelector<HTMLButtonElement>('.purchase-row')?.click());
    await flush();
    expect(opened.container.textContent).toContain('Back to the list');
    shells.push(opened.shell());
    for (const shell of shells) {
      expect(shell).toBe(shells[0]);
    }
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
    for (const selector of ['.purchase-list', '.purchase-row', '.purchase-detail']) {
      expect(rule(selector)).not.toMatch(/(^|\n)\s*(min-|max-)?height:/);
    }
  });

  it('lists nothing with a note when there is nothing, and no export warning', async () => {
    const ui = mount(counted([]));
    ui.click('Your purchases');
    await flush();
    expect(ui.container.textContent).toContain('No purchases from this store in this browser yet.');
    expect(ui.container.textContent).not.toContain('Keep it private');
    expect(ui.container.textContent).not.toContain('delivery');
    expect(ui.button('Download CSV').disabled).toBe(false);
  });
});

describe('the detail', () => {
  it('shows a sent transaction only once its check succeeded, and nothing late once closed (H12)', async () => {
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
    ui.click('Your purchases');
    await flush();
    // Opening the list asks for no receipt.
    expect(source.opened).toEqual([]);
    act(() => ui.container.querySelector<HTMLButtonElement>('.purchase-row')?.click());
    expect(source.opened).toEqual([purchase.orderId]);
    expect(ui.container.textContent).not.toContain('Transaction sent');
    const sent = { ...purchase, receipt: { ...purchase.receipt, sent: { tx: '5'.repeat(88) } } };
    await act(async () => checks[0]?.(sent));
    await flush();
    expect(ui.container.textContent).toContain('Transaction sent');
    // A second opening whose check ends after it closed draws nothing.
    ui.click('Back to the list');
    act(() => ui.container.querySelector<HTMLButtonElement>('.purchase-row')?.click());
    ui.click('Back to the list');
    await act(async () => checks[1]?.(sent));
    await flush();
    expect(ui.container.textContent).not.toContain('Transaction sent');
  });

  it('shows and copies a completed purchase with no delivery anywhere (M9)', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const tx = '7'.repeat(88);
    const [base] = cannedPurchases(1, NOW);
    if (base === undefined) {
      throw new Error('no purchase');
    }
    const purchase: Purchase = {
      ...base,
      receipt: { ...base.receipt, paid: { tx } },
    };
    const ui = mount(counted([purchase]));
    ui.click('Your purchases');
    await flush();
    act(() => ui.container.querySelector<HTMLButtonElement>('.purchase-row')?.click());
    await flush();
    const rows = [...ui.container.querySelectorAll('.receipt .receipt-line')].map(
      (row) => row.textContent ?? '',
    );
    expect(rows.some((row) => row.includes('Delivery'))).toBe(false);
    expect(ui.container.querySelector('.purchase-detail')?.textContent).toContain('Completed');
    expect(ui.container.querySelector('.purchase-detail')?.textContent).not.toContain('Delivered');
    expect(ui.container.querySelector('.receipt-text')?.lastElementChild?.textContent).toContain(
      tx.slice(0, 6),
    );
    await act(async () => ui.button('Copy receipt').click());
    const copied = String(writeText.mock.calls.at(-1)?.[0] ?? '');
    expect(copied).not.toContain('Delivery');
    expect(copied).toContain(tx);
  });

  it('says where an unfinished purchase stands, in the rows and the copy, never "Delivered on" (H11)', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const tx = '9'.repeat(88);
    for (const status of ['waiting_store', 'paying', 'blocked', 'cancelled_paid'] as const) {
      const [base] = cannedPurchases(1, NOW);
      if (base === undefined) {
        throw new Error('no purchase');
      }
      const purchase: Purchase = {
        ...base,
        status,
        receipt: {
          ...base.receipt,
          openStatus: status,
          answeredAt: NOW + 60,
          ...(status === 'paying' || status === 'blocked' ? {} : { paid: { tx } }),
        },
      };
      const ui = mount(counted([purchase]));
      ui.click('Your purchases');
      await flush();
      act(() => ui.container.querySelector<HTMLButtonElement>('.purchase-row')?.click());
      await flush();
      const shown = ui.container.querySelector('.receipt-text')?.textContent ?? '';
      expect(shown).toContain(`Status: ${OPEN_STATUS_LINES[status]}`);
      expect(shown).not.toContain('Delivered on');
      if (status === 'cancelled_paid') {
        expect(shown).not.toContain('waiting for the store');
      }
      if (purchase.receipt.paid !== undefined) {
        // The transaction stays the last thing shown.
        expect(
          ui.container.querySelector('.receipt-text')?.lastElementChild?.textContent,
        ).toContain(tx.slice(0, 6));
      }
      await act(async () => ui.button('Copy receipt').click());
      expect(String(writeText.mock.calls.at(-1)?.[0] ?? '')).toContain(
        `Status: ${OPEN_STATUS_LINES[status]}`,
      );
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
    ui.click('Your purchases');
    await flush();
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
    ui.click('Your purchases');
    await flush();
    act(() => ui.container.querySelector<HTMLButtonElement>('.purchase-row')?.click());
    await flush();
    const text = ui.container.querySelector('.purchase-detail')?.textContent ?? '';
    expect(text).toContain('Completed');
    expect(text).not.toContain('Status:');
    expect(text).not.toContain("Open this product's checkout");
  });
});

describe('focus in Your purchases (fix 1, fix 2)', () => {
  it('opening a row focuses Back to the list; going back focuses that row', async () => {
    const purchases = cannedPurchases(3, NOW);
    const ui = mount(counted(purchases));
    ui.click('Your purchases');
    await flush();
    const second = ui.container.querySelectorAll<HTMLButtonElement>('.purchase-row')[1];
    act(() => second?.click());
    await flush();
    expect(document.activeElement?.textContent).toBe('Back to the list');
    ui.click('Back to the list');
    await flush();
    expect((document.activeElement as HTMLElement | null)?.dataset.order).toBe(
      purchases[1]?.orderId,
    );
  });

  it('a view a press brings while the list is open never moves focus out of it', async () => {
    const ui = mount(counted(cannedPurchases(3, NOW)));
    let release: () => void = () => undefined;
    ui.hold(new Promise<void>((resolve) => (release = resolve)));
    ui.click('Solflare');
    ui.click('Your purchases');
    await flush();
    const row = ui.container.querySelector<HTMLButtonElement>('.purchase-row');
    act(() => row?.focus());
    ui.draw({ kind: 'delivered' });
    expect(document.activeElement).toBe(row);
    release();
    await flush();
  });
});

describe('around the purchase on screen', () => {
  it('Back returns to the session’s view now, focus on the heading then the button (H13)', async () => {
    const ui = mount(counted(cannedPurchases(3, NOW)));
    ui.click('Your purchases');
    await flush();
    expect(document.activeElement?.textContent).toBe('Your purchases');
    expect(document.activeElement?.tagName).toBe('H2');
    // A completion arrives while the history is open: drawn under it.
    ui.draw({ kind: 'delivered' });
    expect(ui.container.textContent).not.toContain('Buy again');
    ui.click('Back');
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
    ui.click('Your purchases');
    await flush();
    ui.click('Back');
    release();
    await flush();
    expect(ui.calls).toEqual({ pay: 1, cancel: 0 });
  });

  it('posts no close while the history is used (H10)', async () => {
    const onClose = vi.fn();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const ui = mount(counted(cannedPurchases(2, NOW)), { onClose });
    ui.click('Your purchases');
    await flush();
    act(() => ui.container.querySelector<HTMLButtonElement>('.purchase-row')?.click());
    ui.click('Back to the list');
    await act(async () => ui.button('Download CSV').click());
    await flush();
    ui.click('Back');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('a read that failed', () => {
  it('says so in the same box, never "no purchases", and the download saves nothing', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const ui = mount(counted(Promise.reject(new Error('storage gone'))));
    ui.click('Your purchases');
    await flush();
    expect(ui.container.textContent).toContain(READ_FAILED_TEXT);
    expect(ui.container.textContent).not.toContain('No purchases');
    await act(async () => ui.button('Download CSV').click());
    await flush();
    expect(created).not.toHaveBeenCalled();
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
      startOver: async () => undefined,
      cancel: () => undefined,
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
    expect(container.textContent).toContain('Back');
    draw(OFFER_VIEW, 1);
    await flush();
    expect(container.querySelector('[data-purchases-region]')).toBeNull();
    expect(wallets()).toBe(true);
    expect(container.textContent).not.toContain('Choose wallet');
  });
});
