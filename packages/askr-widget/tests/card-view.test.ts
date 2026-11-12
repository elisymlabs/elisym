// @vitest-environment happy-dom
import {
  type CatalogItem,
  type ConnectorPlatform,
  type StoreConfig,
  buildCatalogItemEvent,
  buildConfigEvent,
  parseCatalogItem,
  parseConfig,
} from '@elisym/askr';
import { type MockInstance, afterEach, describe, expect, it, vi } from 'vitest';
import { type CardContext, cardPageUrl, renderCard } from '../src/ui/card-view';
import { httpsUrl } from '../src/ui/dom';
import { localSecs, makeStore, sign, testKey } from './fixtures';

const SHOP = 'https://shop.example';

function storeConfig(linkOrigins: string[] = []): StoreConfig {
  const store = makeStore({ linkOrigins });
  const config = parseConfig(
    sign(buildConfigEvent(store.configInput, store.owner.secretKey), store.owner),
  );
  if (!config) {
    throw new Error('config did not parse');
  }
  return config;
}

function catalogItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  const key = testKey();
  const item = parseCatalogItem(
    sign(
      buildCatalogItemEvent({
        d: 'scarf',
        title: 'Wool scarf',
        price: { amount: '49.9', currency: 'USD' },
        images: ['https://cdn.example/scarf.png'],
        url: 'https://shop.example/p/scarf',
        createdAt: localSecs() - 10,
      }),
      key,
    ),
    { role: 'catalog' },
  );
  if (!item) {
    throw new Error('item did not parse');
  }
  return { ...item, ...overrides };
}

function connectorConfig(platform: ConnectorPlatform, shopUrl: string | null = SHOP): StoreConfig {
  const store = makeStore({
    source:
      shopUrl === null ? { kind: 'connector', platform } : { kind: 'connector', platform, shopUrl },
  });
  const config = parseConfig(
    sign(buildConfigEvent(store.configInput, store.owner.secretKey), store.owner),
  );
  if (!config) {
    throw new Error('config did not parse');
  }
  return config;
}

function context(
  config: StoreConfig = storeConfig(),
  pageOrigin: string | undefined = SHOP,
): CardContext & { clicks: string[] } {
  const clicks: string[] = [];
  return {
    document,
    config,
    reportClick: (address) => clicks.push(address),
    pageOrigin,
    clicks,
  };
}

const SIZED: Partial<CatalogItem> = {
  options: [{ name: 'Size', values: ['S', 'M'] }],
  variants: [
    { id: '101', price: '49.9', available: true, values: ['S'] },
    { id: '102', price: '49.9', available: true, values: ['M'] },
  ],
};

const SINGLE: Partial<CatalogItem> = {
  options: [{ name: 'Title', values: ['Default Title'] }],
  variants: [{ id: '4242', price: '49.9', available: true, values: ['Default Title'] }],
};

function pick(card: HTMLElement, value: string): void {
  const select = card.querySelector('select');
  if (!select) {
    throw new Error('no selector');
  }
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

function cartButtonOf(card: HTMLElement): HTMLButtonElement {
  const button = card.querySelector<HTMLButtonElement>('button.cart');
  if (!button) {
    throw new Error('no cart button');
  }
  return button;
}

interface PendingFetch {
  fetchMock: MockInstance<typeof fetch>;
  answer: (status: number) => Promise<void>;
}

function pendingFetch(): PendingFetch {
  let settle: ((response: Response) => void) | undefined;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        settle = resolve;
      }),
  );
  const answer = async (status: number): Promise<void> => {
    settle?.(new Response(null, { status }));
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-busy]')).toBeNull();
    });
  };
  return { fetchMock, answer };
}

afterEach(() => {
  Reflect.deleteProperty(window, 'Askr');
  vi.restoreAllMocks();
});

describe('card links', () => {
  it('links the first r on a store origin, skipping links elsewhere', () => {
    const item = catalogItem({
      links: ['https://evil.example/p/scarf', 'https://shop.example/p/scarf'],
    });
    const card = renderCard(context(), item);
    const title = card.querySelector<HTMLAnchorElement>('a.card-title');
    expect(title?.href).toBe('https://shop.example/p/scarf');
    expect(title?.rel).toBe('noopener noreferrer');
  });

  it('renders no link at all when no r is on a store origin', () => {
    const item = catalogItem({ links: ['https://evil.example/p/scarf'] });
    const card = renderCard(context(), item);
    expect(card.querySelector('a')).toBeNull();
    expect(card.querySelector('span.card-title')?.textContent).toBe('Wool scarf');
    expect(cardPageUrl(item, storeConfig())).toBeUndefined();
  });

  it('accepts an r on a link-origin', () => {
    const item = catalogItem({ links: ['https://links.shop.example/p/scarf'] });
    expect(cardPageUrl(item, storeConfig())).toBeUndefined();
    expect(cardPageUrl(item, storeConfig(['https://links.shop.example']))).toBe(
      'https://links.shop.example/p/scarf',
    );
  });

  it('a click on the product link reports the handoff', () => {
    const ctx = context();
    const item = catalogItem();
    const card = renderCard(ctx, item);
    card
      .querySelector<HTMLAnchorElement>('a.card-title')
      ?.addEventListener('click', (event) => event.preventDefault());
    card.querySelector<HTMLAnchorElement>('a.card-title')?.click();
    expect(ctx.clicks).toEqual([item.address]);
  });
});

describe('card images', () => {
  it('shows an https image only', () => {
    expect(renderCard(context(), catalogItem()).querySelector('img')?.src).toBe(
      'https://cdn.example/scarf.png',
    );
    for (const image of ['http://cdn.example/scarf.png', 'javascript:alert(1)', 'data:,x']) {
      expect(
        renderCard(context(), catalogItem({ images: [image] })).querySelector('img'),
      ).toBeNull();
    }
  });

  it('httpsUrl keeps https and drops every other scheme or garbage', () => {
    expect(httpsUrl('https://a.example/x')).toBe('https://a.example/x');
    expect(httpsUrl('http://a.example/x')).toBeUndefined();
    expect(httpsUrl('not a url')).toBeUndefined();
    expect(httpsUrl(undefined)).toBeUndefined();
  });
});

describe('card pick reason', () => {
  it('renders the reason as text', () => {
    const card = renderCard(context(), catalogItem(), 'Warm <b>and</b> soft');
    expect(card.querySelector('.reason')?.textContent).toBe('Warm <b>and</b> soft');
    expect(card.querySelector('.reason b')).toBeNull();
    expect(renderCard(context(), catalogItem()).querySelector('.reason')).toBeNull();
  });
});

describe('card add-to-cart', () => {
  it('shows the hook button when the host sets its hook after the card rendered', () => {
    const card = renderCard(context(), catalogItem({ sku: 'SC-1' }));
    expect(card.querySelector('button.cart')).toBeNull();
    const onAddToCart = vi.fn();
    Reflect.set(window, 'Askr', { onAddToCart });
    card.dispatchEvent(new Event('pointerenter'));
    const button = card.querySelector<HTMLButtonElement>('button.cart');
    expect(button).not.toBeNull();
    button?.click();
    expect(onAddToCart).toHaveBeenCalledWith({ d: 'scarf', sku: 'SC-1' });
  });

  it('drops the button again when the host removes its hook, on focus too', () => {
    Reflect.set(window, 'Askr', { onAddToCart: () => undefined });
    const card = renderCard(context(), catalogItem());
    expect(card.querySelector('button.cart')).not.toBeNull();
    Reflect.deleteProperty(window, 'Askr');
    card.dispatchEvent(new Event('focusin'));
    expect(card.querySelector('button.cart')).toBeNull();
  });
});

describe('card native add-to-cart', () => {
  it('Shopify: busy while adding, then added; the handoff is reported once', async () => {
    const { fetchMock, answer } = pendingFetch();
    const ctx = context(connectorConfig('shopify'));
    const item = catalogItem(SINGLE);
    const card = renderCard(ctx, item);
    document.body.append(card);
    const button = cartButtonOf(card);
    expect(button.textContent).toBe('Add to cart');
    button.click();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Adding...');
    expect(button.getAttribute('aria-busy')).toBe('true');
    button.click();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://shop.example/cart/add.js');
    await answer(200);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Added to cart');
    expect(ctx.clicks).toEqual([item.address]);
    card.remove();
  });

  it('WooCommerce: adds the determined variation through ?add-to-cart=', async () => {
    const { fetchMock, answer } = pendingFetch();
    const card = renderCard(context(connectorConfig('woocommerce')), catalogItem(SIZED));
    document.body.append(card);
    pick(card, 'M');
    cartButtonOf(card).click();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://shop.example/?add-to-cart=102');
    await answer(302);
    expect(cartButtonOf(card).textContent).toBe('Added to cart');
    card.remove();
  });

  it('WooCommerce under a path: adds on the shop path', async () => {
    const { fetchMock, answer } = pendingFetch();
    const card = renderCard(
      context(connectorConfig('woocommerce', `${SHOP}/store`)),
      catalogItem(SIZED),
    );
    document.body.append(card);
    pick(card, 'S');
    cartButtonOf(card).click();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://shop.example/store/?add-to-cart=101');
    await answer(200);
    card.remove();
  });

  it('a failed add leaves the product link with a notice, opening no window', async () => {
    const { answer } = pendingFetch();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const ctx = context(connectorConfig('shopify'));
    const item = catalogItem(SINGLE);
    const card = renderCard(ctx, item);
    document.body.append(card);
    cartButtonOf(card).click();
    await answer(422);
    expect(card.querySelector('button.cart')).toBeNull();
    expect(card.querySelector('.cart-failed')?.textContent).toBe('Could not add to cart');
    expect(card.querySelector<HTMLAnchorElement>('a.view')?.href).toBe(
      'https://shop.example/p/scarf',
    );
    // The answer came long after the click: a window opened now would be popup-blocked.
    expect(open).not.toHaveBeenCalled();
    expect(ctx.clicks).toEqual([item.address]);
    card.remove();
  });

  it('an answer for a button the card replaced meanwhile changes nothing', async () => {
    const { fetchMock, answer } = pendingFetch();
    const card = renderCard(context(connectorConfig('woocommerce')), catalogItem(SIZED));
    document.body.append(card);
    pick(card, 'M');
    const stale = cartButtonOf(card);
    stale.click();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The visitor picks another size while the first add is in flight.
    pick(card, 'S');
    const fresh = cartButtonOf(card);
    expect(fresh).not.toBe(stale);
    await answer(500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(card.querySelector('.cart-failed')).toBeNull();
    expect(card.querySelector('a.view')).toBeNull();
    expect(cartButtonOf(card)).toBe(fresh);
    expect(fresh.textContent).toBe('Add to cart');
    expect(fresh.disabled).toBe(false);
    card.remove();
  });

  it('a failed add without a product page restores the button for a retry', async () => {
    const { answer } = pendingFetch();
    const card = renderCard(
      context(connectorConfig('shopify')),
      catalogItem({ ...SINGLE, links: ['https://evil.example/p/scarf'] }),
    );
    document.body.append(card);
    cartButtonOf(card).click();
    await answer(500);
    expect(cartButtonOf(card).disabled).toBe(false);
    expect(cartButtonOf(card).textContent).toBe('Add to cart');
    expect(card.querySelector('.cart-failed')).not.toBeNull();
    card.remove();
  });

  it('opens the product page until the pick determines a variant', () => {
    const card = renderCard(context(connectorConfig('shopify')), catalogItem(SIZED));
    expect(card.querySelector('button.cart')).toBeNull();
    expect(card.querySelector('a.view')).not.toBeNull();
    pick(card, 'S');
    expect(card.querySelector('a.view')).toBeNull();
    expect(cartButtonOf(card).textContent).toBe('Add to cart');
  });

  it('never native for a * variant or a non-numeric id', () => {
    const any = catalogItem({
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [{ id: '201', price: '49.9', available: true, values: ['*'] }],
    });
    const anyCard = renderCard(context(connectorConfig('woocommerce')), any);
    pick(anyCard, 'M');
    expect(anyCard.querySelector('button.cart')).toBeNull();
    expect(anyCard.querySelector('a.view')).not.toBeNull();
    const named = catalogItem({
      ...SINGLE,
      variants: [{ id: 'gid-1', price: '49.9', available: true, values: ['Default Title'] }],
    });
    expect(
      renderCard(context(connectorConfig('shopify')), named).querySelector('button.cart'),
    ).toBe(null);
  });

  it('no native button off the connected domain, for a feed, or a non-connector store', () => {
    const item = catalogItem(SINGLE);
    for (const ctx of [
      context(connectorConfig('shopify'), 'https://other.example'),
      // A config naming no shop URL (the old two-value source): native stays off.
      context(connectorConfig('shopify', null)),
      { ...context(connectorConfig('shopify')), pageOrigin: undefined },
      context(connectorConfig('google', null)),
      // A feed names no shop URL (the reader voids one); native stays off even if it did.
      context({
        ...connectorConfig('google', null),
        source: { kind: 'connector', platform: 'google', shopUrl: SHOP },
      }),
      context(storeConfig()),
    ]) {
      const card = renderCard(ctx, item);
      expect(card.querySelector('button.cart')).toBeNull();
      expect(card.querySelector('a.view')).toBeNull();
    }
  });

  it("the host's hook wins over native", () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const onAddToCart = vi.fn();
    Reflect.set(window, 'Askr', { onAddToCart });
    const card = renderCard(context(connectorConfig('shopify')), catalogItem(SINGLE));
    cartButtonOf(card).click();
    expect(onAddToCart).toHaveBeenCalledWith({ d: 'scarf', variant: '4242' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
