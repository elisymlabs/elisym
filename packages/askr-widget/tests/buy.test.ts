// @vitest-environment happy-dom
import {
  type CatalogItem,
  type CatalogPayable,
  type StoreConfig,
  buildCatalogItemEvent,
  buildConfigEvent,
  parseCatalogItem,
  parseConfig,
} from '@elisym/askr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatClient } from '../src/client';
import { type BuyNote, pagePayCore, startBuy } from '../src/paycore';
import { type CardContext, renderCard } from '../src/ui/card-view';
import { WidgetView, noteText } from '../src/ui/element';
import { applyLanguage } from '../src/ui/strings';
import {
  FakeGateway,
  FakeRelay,
  MemoryStorage,
  localSecs,
  makeStore,
  sign,
  testKey,
} from './fixtures';

const PAYABLE: CatalogPayable = { naddr: 'naddr1course', network: 'devnet' };

function storeConfig(): StoreConfig {
  const store = makeStore();
  const config = parseConfig(
    sign(buildConfigEvent(store.configInput, store.owner.secretKey), store.owner),
  );
  if (!config) {
    throw new Error('config did not parse');
  }
  return config;
}

function course(overrides: Partial<CatalogItem> = {}): CatalogItem {
  const item = parseCatalogItem(
    sign(
      buildCatalogItemEvent({
        d: 'course',
        title: 'Course',
        price: { amount: '25', currency: 'USD' },
        createdAt: localSecs() - 10,
      }),
      testKey(),
    ),
  );
  if (!item) {
    throw new Error('item did not parse');
  }
  return { ...item, payable: PAYABLE, ...overrides };
}

interface Recorded {
  context: CardContext;
  clicks: string[];
  notes: BuyNote[];
}

function recorded(): Recorded {
  const clicks: string[] = [];
  const notes: BuyNote[] = [];
  return {
    context: {
      document,
      config: storeConfig(),
      reportClick: (address, kind) => clicks.push(`${kind} ${address}`),
      note: (note) => notes.push(note),
      pageOrigin: 'https://shop.example',
    },
    clicks,
    notes,
  };
}

/** A stand-in for checkout v4's global: `open` returns an EventTarget like the real handle. */
class FakeCheckout extends EventTarget {
  status(state: string): void {
    this.dispatchEvent(new CustomEvent('status', { detail: { state } }));
  }

  fail(): void {
    this.dispatchEvent(new CustomEvent('error', { detail: { reason: 'unavailable' } }));
  }
}

function installPayCore(open: (options: unknown) => unknown, version: unknown = 'v4'): void {
  Reflect.set(window, 'PayCore', Object.freeze({ version, open }));
}

function openingCheckout(): { calls: unknown[]; checkout: FakeCheckout } {
  const calls: unknown[] = [];
  const checkout = new FakeCheckout();
  installPayCore((options) => {
    calls.push(options);
    return checkout;
  });
  return { calls, checkout };
}

function buyButton(card: HTMLElement): HTMLButtonElement | null {
  return card.querySelector<HTMLButtonElement>('button.buy');
}

afterEach(() => {
  Reflect.deleteProperty(window, 'PayCore');
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("the page's checkout", () => {
  it('counts only a v4 PayCore with an open function', () => {
    expect(pagePayCore(window)).toBeUndefined();
    installPayCore(() => undefined, 'v3');
    expect(pagePayCore(window)).toBeUndefined();
    Reflect.set(window, 'PayCore', { version: 'v4', open: 'not a function' });
    expect(pagePayCore(window)).toBeUndefined();
    Reflect.set(window, 'PayCore', 'v4');
    expect(pagePayCore(window)).toBeUndefined();
    const hostile = {};
    Object.defineProperty(hostile, 'version', {
      get: () => {
        throw new Error('no');
      },
    });
    Reflect.set(window, 'PayCore', hostile);
    expect(pagePayCore(window)).toBeUndefined();
    installPayCore(() => undefined);
    expect(pagePayCore(window)).toBeDefined();
  });

  it('calls open on the PayCore object itself, with the naddr and network only', () => {
    const calls: unknown[] = [];
    const payCore = {
      version: 'v4',
      open(this: unknown, options: unknown) {
        calls.push([this, options]);
        return new FakeCheckout();
      },
    };
    Reflect.set(window, 'PayCore', payCore);
    const found = pagePayCore(window);
    if (!found) {
      throw new Error('no PayCore');
    }
    startBuy(
      found,
      { naddr: 'naddr1x', network: 'mainnet' },
      {
        note: () => undefined,
        opened: () => undefined,
        paid: () => undefined,
      },
    );
    expect(calls).toEqual([[payCore, { product: 'naddr1x', network: 'mainnet' }]]);
  });
});

describe('Buy on a card', () => {
  it('shows Buy for a payable on-sale product when the page loaded v4, and opens the checkout', () => {
    const { calls } = openingCheckout();
    const { context, clicks, notes } = recorded();
    const item = course();
    const card = renderCard(context, item);
    const buy = buyButton(card);
    expect(buy?.textContent).toBe('Buy');
    expect(buy?.type).toBe('button');
    buy?.click();
    expect(calls).toEqual([{ product: 'naddr1course', network: 'devnet' }]);
    expect(clicks).toEqual([`buy ${item.address}`]);
    expect(notes).toEqual([]);
  });

  it('passes the listing network as it is', () => {
    const { calls } = openingCheckout();
    renderCard(recorded().context, course({ payable: { naddr: 'naddr1m', network: 'mainnet' } }))
      .querySelector<HTMLButtonElement>('button.buy')
      ?.click();
    expect(calls).toEqual([{ product: 'naddr1m', network: 'mainnet' }]);
  });

  it('tells each milestone once, counts the payment once, and claims no cause for an error', () => {
    const { checkout } = openingCheckout();
    const { context, clicks, notes } = recorded();
    const item = course();
    buyButton(renderCard(context, item))?.click();
    checkout.status('ordered');
    checkout.status('paying');
    expect(notes).toEqual([]);
    checkout.status('paid');
    checkout.status('paid');
    checkout.status('completed');
    checkout.status('completed');
    checkout.status('refused');
    checkout.status('refused');
    checkout.fail();
    checkout.fail();
    checkout.dispatchEvent(new CustomEvent('status', { detail: null }));
    checkout.dispatchEvent(new Event('status'));
    expect(notes).toEqual(['paid', 'completed', 'refused', 'error']);
    expect(clicks).toEqual([`buy ${item.address}`, `paid ${item.address}`]);
  });

  it('counts the payment when the checkout reports completed without paid first', () => {
    const { checkout } = openingCheckout();
    const { context, clicks, notes } = recorded();
    const item = course();
    buyButton(renderCard(context, item))?.click();
    checkout.status('completed');
    checkout.status('paid');
    expect(notes).toEqual(['completed', 'paid']);
    expect(clicks).toEqual([`buy ${item.address}`, `paid ${item.address}`]);
  });

  it('counts the payment from paid alone, and from completed alone', () => {
    for (const state of ['paid', 'completed']) {
      const { checkout } = openingCheckout();
      const { context, clicks, notes } = recorded();
      const item = course();
      buyButton(renderCard(context, item))?.click();
      checkout.status(state);
      expect(notes).toEqual([state]);
      expect(clicks).toEqual([`buy ${item.address}`, `paid ${item.address}`]);
    }
  });

  it('a second checkout tells its own milestones again', () => {
    const first = new FakeCheckout();
    const second = new FakeCheckout();
    const handles = [first, second];
    installPayCore(() => handles.shift());
    const { context, notes } = recorded();
    const buy = buyButton(renderCard(context, course()));
    buy?.click();
    first.status('paid');
    buy?.click();
    second.status('paid');
    expect(notes).toEqual(['paid', 'paid']);
  });

  it('a busy checkout says a payment is already open; any other throw says it could not open', () => {
    const { context, clicks, notes } = recorded();
    installPayCore(() => {
      throw Object.assign(new Error('busy'), { code: 'busy' });
    });
    const card = renderCard(context, course());
    buyButton(card)?.click();
    installPayCore(() => {
      throw new TypeError('bad options');
    });
    buyButton(card)?.click();
    installPayCore(() => {
      throw 'not an error';
    });
    buyButton(card)?.click();
    installPayCore(() => {
      throw Object.assign(new Error('other'), { code: 'ERR_OTHER' });
    });
    buyButton(card)?.click();
    expect(notes).toEqual(['busy', 'open-failed', 'open-failed', 'open-failed']);
    expect(clicks).toEqual([]);
  });

  it('an open that returns no checkout says it could not open', () => {
    installPayCore(() => ({ addEventListener: 'no' }));
    const { context, clicks, notes } = recorded();
    buyButton(renderCard(context, course()))?.click();
    expect(notes).toEqual(['open-failed']);
    expect(clicks).toEqual([]);
  });

  it('PayCore gone by the time of the press says it could not open', () => {
    openingCheckout();
    const { context, notes } = recorded();
    const card = renderCard(context, course());
    Reflect.deleteProperty(window, 'PayCore');
    buyButton(card)?.click();
    expect(notes).toEqual(['open-failed']);
  });

  it('no Buy without v4 on the page, for a sold-out or pre-order product, or without payable', () => {
    const { context } = recorded();
    expect(buyButton(renderCard(context, course()))).toBeNull();
    installPayCore(() => new FakeCheckout(), 'v3');
    expect(buyButton(renderCard(context, course()))).toBeNull();
    openingCheckout();
    const soldOut = renderCard(context, course({ visibility: 'sold-out' }));
    expect(buyButton(soldOut)).toBeNull();
    expect(soldOut.querySelector('.label.sold-out')).not.toBeNull();
    expect(buyButton(renderCard(context, course({ visibility: 'pre-order' })))).toBeNull();
    const { payable: _dropped, ...plain } = course();
    expect(buyButton(renderCard(context, plain))).toBeNull();
  });

  it('Buy wins over the host cart hook', () => {
    openingCheckout();
    Reflect.set(window, 'Askr', { addToCart: () => undefined });
    const card = renderCard(recorded().context, course());
    expect(buyButton(card)).not.toBeNull();
    expect(card.querySelectorAll('button.cart')).toHaveLength(1);
    Reflect.deleteProperty(window, 'Askr');
  });

  it('shows Buy once v4 loads after the card rendered, and drops it when v4 goes', () => {
    const { context } = recorded();
    const card = renderCard(context, course());
    expect(buyButton(card)).toBeNull();
    openingCheckout();
    card.dispatchEvent(new Event('pointerenter'));
    expect(buyButton(card)).not.toBeNull();
    Reflect.deleteProperty(window, 'PayCore');
    card.dispatchEvent(new Event('focusin'));
    expect(buyButton(card)).toBeNull();
  });

  it('says once on the console why payable cards show no Buy', async () => {
    vi.resetModules();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fresh = await import('../src/ui/card-view');
    const { context } = recorded();
    fresh.renderCard(context, course());
    fresh.renderCard(context, course());
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain('checkout v4');
    const { payable: _dropped, ...plain } = course();
    vi.resetModules();
    const again = await import('../src/ui/card-view');
    again.renderCard(context, plain);
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe('Buy notes', () => {
  it('the client keeps notes in order, publishes nothing for them, and tells its listeners', () => {
    const relay = new FakeRelay();
    const client = new ChatClient({
      owner: makeStore().owner.pubkey,
      connect: relay.connect,
      gateway: new FakeGateway(testKey(), testKey().pubkey),
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    });
    const seen: number[] = [];
    client.subscribe((snapshot) => seen.push(snapshot.notes.length));
    client.note('paid');
    client.note('completed');
    expect(client.snapshot().notes).toEqual([
      { id: 1, note: 'paid' },
      { id: 2, note: 'completed' },
    ]);
    expect(seen).toEqual([0, 1, 2]);
    expect(relay.publishAttempts).toEqual([]);
    client.stop();
  });

  it('the log shows each note once, in the widget language', () => {
    const view = new WidgetView(
      document,
      () => undefined,
      () => undefined,
    );
    const notes = [{ id: 1, note: 'paid' as const }];
    view.update({ phase: 'ready', branding: true, notes, turns: [] });
    view.update({
      phase: 'ready',
      branding: true,
      notes: [...notes, { id: 2, note: 'refused' }],
      turns: [],
    });
    const shown = [...view.panel.querySelectorAll('.note')].map((note) => note.textContent);
    expect(shown).toEqual(['Payment received', 'This product cannot be bought here right now']);
    expect(view.panel.querySelector('.note')?.getAttribute('lang')).toBe('en');
  });

  it("a note shows in the widget's own language", () => {
    const view = new WidgetView(
      document,
      () => undefined,
      () => undefined,
      () => ['de'],
    );
    view.update({ phase: 'ready', branding: true, notes: [{ id: 1, note: 'paid' }], turns: [] });
    const note = view.panel.querySelector('.note');
    expect(note?.textContent).toBe('Zahlung erhalten');
    expect(note?.getAttribute('lang')).toBe('de');
    applyLanguage('en');
  });

  it("a Buy press on an answer's card reaches the client's log", async () => {
    installPayCore(() => {
      throw Object.assign(new Error('busy'), { code: 'busy' });
    });
    const client = new ChatClient({
      owner: makeStore().owner.pubkey,
      connect: new FakeRelay().connect,
      gateway: new FakeGateway(testKey(), testKey().pubkey),
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    });
    const item = course();
    vi.spyOn(client, 'resolveCards').mockResolvedValue(new Map([[item.address, item]]));
    const view = new WidgetView(
      document,
      () => client,
      () => undefined,
    );
    client.subscribe((snapshot) => view.update({ ...snapshot, config: storeConfig() }));
    view.update({
      phase: 'ready',
      branding: true,
      notes: [],
      config: storeConfig(),
      turns: [
        {
          askId: 'a'.repeat(32),
          text: 'A course?',
          askedAt: 0,
          answer: {
            type: 'answer',
            ask_id: 'a'.repeat(32),
            session_end: localSecs() + 86_400,
            text: '',
            components: [{ type: 'products', picks: [{ address: item.address }] }],
            chips: [],
          },
        },
      ],
    });
    await vi.waitFor(() => {
      expect(view.panel.querySelector('button.buy')).not.toBeNull();
    });
    view.panel.querySelector<HTMLButtonElement>('button.buy')?.click();
    expect(client.snapshot().notes).toEqual([{ id: 1, note: 'busy' }]);
    expect(view.panel.querySelector('.note')?.textContent).toBe('A payment is already open');
    client.stop();
  });

  it('every note has its own text in every language', () => {
    const all: BuyNote[] = ['busy', 'open-failed', 'paid', 'completed', 'refused', 'error'];
    for (const language of ['en', 'ru', 'es', 'de', 'fr', 'pt', 'it', 'zh', 'ja', 'ko']) {
      applyLanguage(language);
      const texts = all.map((note) => noteText(note));
      expect(new Set(texts).size).toBe(all.length);
      expect(texts.every((text) => text.length > 0)).toBe(true);
    }
    applyLanguage('en');
    expect(noteText('busy')).toBe('A payment is already open');
    expect(noteText('open-failed')).toBe('Checkout could not open');
    expect(noteText('error')).toBe('Checkout unavailable right now');
    expect(noteText('completed')).toBe('Order complete');
  });
});
