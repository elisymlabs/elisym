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
import { ADDED_MS, type CardContext, cardPageUrl, renderCard } from '../src/ui/card-view';
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
    reportClick: (address, kind) => clicks.push(`${kind} ${address}`),
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
  const choice = [...card.querySelectorAll<HTMLButtonElement>('button.choice')].find(
    (button) => button.textContent === value,
  );
  if (choice) {
    choice.click();
    return;
  }
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
    expect(ctx.clicks).toEqual([`link ${item.address}`]);
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
    const ctx = context();
    const item = catalogItem({ sku: 'SC-1' });
    const card = renderCard(ctx, item);
    expect(card.querySelector('button.cart')).toBeNull();
    const onAddToCart = vi.fn();
    Reflect.set(window, 'Askr', { onAddToCart });
    card.dispatchEvent(new Event('pointerenter'));
    const button = card.querySelector<HTMLButtonElement>('button.cart');
    expect(button).not.toBeNull();
    button?.click();
    expect(onAddToCart).toHaveBeenCalledWith({ d: 'scarf', sku: 'SC-1' });
    // The press counts as an add to cart, not a link open.
    expect(ctx.clicks).toEqual([`cart ${item.address}`]);
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
    expect(button.getAttribute('aria-label')).toBe('Add to cart');
    button.click();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Adding...');
    expect(button.getAttribute('aria-busy')).toBe('true');
    button.click();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://shop.example/cart/add.js');
    await answer(200);
    // It says added and takes no click for a moment (see "takes no click while it says added"),
    // aria-disabled rather than disabled, so a keyboard user keeps focus on it.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Added to cart');
    expect(ctx.clicks).toEqual([`cart ${item.address}`]);
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
    expect(cartButtonOf(card).getAttribute('aria-label')).toBe('Added to cart');
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
    expect(ctx.clicks).toEqual([`cart ${item.address}`]);
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
    expect(fresh.getAttribute('aria-label')).toBe('Add to cart');
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
    expect(cartButtonOf(card).getAttribute('aria-label')).toBe('Add to cart');
    expect(card.querySelector('.cart-failed')).not.toBeNull();
    card.remove();
  });

  it('opens the product page until the pick determines a variant', () => {
    const card = renderCard(context(connectorConfig('shopify')), catalogItem(SIZED));
    expect(card.querySelector('button.cart')).toBeNull();
    expect(card.querySelector('a.view')).not.toBeNull();
    pick(card, 'S');
    expect(card.querySelector('a.view')).toBeNull();
    expect(cartButtonOf(card).getAttribute('aria-label')).toBe('Add to cart');
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

describe('the cart button keeps its width', () => {
  function visibleLabel(button: HTMLButtonElement): string | undefined {
    return button.querySelector(`.cart-${button.dataset.state ?? ''}`)?.textContent ?? undefined;
  }

  it('holds all three labels in one button, the current one named and shown', () => {
    Reflect.set(window, 'Askr', { onAddToCart: () => undefined });
    const button = cartButtonOf(renderCard(context(), catalogItem(SINGLE)));
    expect([...button.querySelectorAll('.cart-label')].map((label) => label.textContent)).toEqual([
      'Add to cart',
      'Adding...',
      'Added',
    ]);
    expect(
      [...button.querySelectorAll('.cart-label')].every(
        (label) => label.getAttribute('aria-hidden') === 'true',
      ),
    ).toBe(true);
    expect(button.dataset.state).toBe('ready');
    expect(visibleLabel(button)).toBe('Add to cart');
    // A cart icon leads the label; a screen reader hears the label alone.
    expect(button.firstElementChild?.getAttribute('class')).toBe('cart-icon');
    expect(button.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it("says added after the host's hook takes the product, then offers to add again", () => {
    vi.useFakeTimers();
    try {
      const onAddToCart = vi.fn();
      Reflect.set(window, 'Askr', { onAddToCart });
      const button = cartButtonOf(renderCard(context(), catalogItem(SINGLE)));
      button.click();
      expect(onAddToCart).toHaveBeenCalledTimes(1);
      expect(button.dataset.state).toBe('done');
      expect(button.getAttribute('aria-label')).toBe('Added to cart');
      vi.advanceTimersByTime(ADDED_MS - 1);
      expect(button.dataset.state).toBe('done');
      vi.advanceTimersByTime(1);
      expect(button.dataset.state).toBe('ready');
      expect(button.getAttribute('aria-label')).toBe('Add to cart');
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes no click while it says added, and tells a screen reader', () => {
    vi.useFakeTimers();
    try {
      const onAddToCart = vi.fn();
      Reflect.set(window, 'Askr', { onAddToCart });
      const card = renderCard(context(), catalogItem(SINGLE));
      const button = cartButtonOf(card);
      const announcer = card.querySelector('.card-actions [role="status"]');
      expect(announcer?.textContent).toBe('');
      button.click();
      expect(announcer?.textContent).toBe('Added to cart');
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.disabled).toBe(false);
      vi.advanceTimersByTime(1000);
      button.click();
      expect(onAddToCart).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(ADDED_MS - 1001);
      expect(button.dataset.state).toBe('done');
      vi.advanceTimersByTime(1);
      expect(button.dataset.state).toBe('ready');
      expect(button.hasAttribute('aria-disabled')).toBe(false);
      expect(announcer?.textContent).toBe('');
      button.click();
      expect(onAddToCart).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hook that throws leaves the button ready: nothing says it was added', () => {
    Reflect.set(window, 'Askr', {
      onAddToCart: () => {
        throw new Error('the host cart failed');
      },
    });
    const button = cartButtonOf(renderCard(context(), catalogItem(SINGLE)));
    button.click();
    expect(button.dataset.state).toBe('ready');
  });

  it('a native add says added, then offers to add again', async () => {
    const { answer } = pendingFetch();
    const card = renderCard(context(connectorConfig('shopify')), catalogItem(SINGLE));
    document.body.append(card);
    const button = cartButtonOf(card);
    button.click();
    expect(button.dataset.state).toBe('busy');
    await answer(200);
    expect(button.dataset.state).toBe('done');
    await vi.waitFor(
      () => {
        expect(button.dataset.state).toBe('ready');
      },
      { timeout: ADDED_MS + 1000 },
    );
    card.remove();
  });

  it('short values are toggle buttons in a group named for the option', () => {
    const card = renderCard(context(connectorConfig('shopify')), catalogItem(SIZED));
    const group = card.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Size');
    expect(card.querySelector('.choice-name')?.textContent).toBe('Size');
    // The group's name is read once, from aria-label; the visible name is not read again.
    expect(card.querySelector('.choice-name')?.getAttribute('aria-hidden')).toBe('true');
    const choices = [...card.querySelectorAll<HTMLButtonElement>('button.choice')];
    expect(choices.map((choice) => choice.textContent)).toEqual(['S', 'M']);
    expect(choices.map((choice) => choice.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
    ]);
    choices[1]?.click();
    expect(choices.map((choice) => choice.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(card.querySelector('select')).toBeNull();
  });

  it('six short values are buttons, seven go in a select', () => {
    const option = (count: number) => {
      const values = Array.from({ length: count }, (_unused, index) => `V${index + 1}`);
      return catalogItem({
        options: [{ name: 'Size', values }],
        variants: values.map((value, index) => ({
          id: String(400 + index),
          price: '49.9',
          available: true,
          values: [value],
        })),
      });
    };
    const six = renderCard(context(connectorConfig('shopify')), option(6));
    expect(six.querySelectorAll('button.choice')).toHaveLength(6);
    const seven = renderCard(context(connectorConfig('shopify')), option(7));
    expect(seven.querySelector('button.choice')).toBeNull();
    expect(seven.querySelector('select')).not.toBeNull();
  });

  it('a tap on the picked value changes nothing: an add in flight keeps its button', () => {
    Reflect.set(window, 'Askr', { onAddToCart: () => undefined });
    const card = renderCard(context(), catalogItem(SIZED));
    pick(card, 'M');
    const button = cartButtonOf(card);
    pick(card, 'M');
    expect(cartButtonOf(card)).toBe(button);
  });

  it('many or long values go in a select named for the option, its placeholder showing it', () => {
    const many = Array.from({ length: 7 }, (_unused, index) => `Shade ${index + 1}`);
    const card = renderCard(
      context(connectorConfig('shopify')),
      catalogItem({
        options: [{ name: 'Colour', values: many }],
        variants: many.map((value, index) => ({
          id: String(200 + index),
          price: '49.9',
          available: true,
          values: [value],
        })),
      }),
    );
    const label = card.querySelector('label.selector');
    expect(label?.querySelector('.visually-hidden')?.textContent).toBe('Colour');
    expect(label?.querySelector('option')?.textContent).toBe('Choose Colour');
    expect(card.querySelector('button.choice')).toBeNull();
    const long = renderCard(
      context(connectorConfig('shopify')),
      catalogItem({
        options: [{ name: 'Fit', values: ['Regular fit, long', 'Slim'] }],
        variants: [
          { id: '301', price: '49.9', available: true, values: ['Regular fit, long'] },
          { id: '302', price: '49.9', available: true, values: ['Slim'] },
        ],
      }),
    );
    expect(long.querySelector('select')).not.toBeNull();
  });

  it('puts the photo on top, the badge over it, and the price beside the button', () => {
    Reflect.set(window, 'Askr', { onAddToCart: () => undefined });
    const card = renderCard(
      context(),
      catalogItem({ ...SINGLE, visibility: 'pre-order', images: ['https://cdn.example/a.png'] }),
    );
    expect(card.firstElementChild?.className).toBe('card-media');
    expect(card.querySelector('.card-media .label')?.textContent).toBe('Pre-order');
    const foot = card.querySelector('.card-foot');
    expect(foot?.querySelector('.price')).not.toBeNull();
    expect(foot?.querySelector('button.cart')).not.toBeNull();
    const plain = renderCard(
      context(),
      catalogItem({ ...SINGLE, visibility: 'pre-order', images: [] }),
    );
    expect(plain.querySelector('.card-media')).toBeNull();
    expect(plain.querySelector('.card-body .label')?.textContent).toBe('Pre-order');
  });
});

describe('the widget stylesheet', () => {
  it('shows only the current cart label and hides empty card rows', async () => {
    const { WIDGET_CSS } = await import('../src/ui/styles');
    expect(WIDGET_CSS).toContain(
      '.cart-label { grid-area: 1 / 1; text-align: center; visibility: hidden; }',
    );
    expect(WIDGET_CSS).toContain(".cart[data-state='done'] .cart-done { visibility: visible; }");
    expect(WIDGET_CSS).toContain('.card-options:empty { display: none; }');
    expect(WIDGET_CSS).toContain('.cards > .card:only-child { flex-basis: 100%; }');
    expect(WIDGET_CSS).toContain(':host([closing]) .panel { animation: askr-panel-out');
    expect(WIDGET_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/u,
    );
    // A plain color first, for a browser without color-mix.
    expect(WIDGET_CSS.indexOf('scrollbar-color: var(--cc-border) transparent;')).toBeLessThan(
      WIDGET_CSS.indexOf('scrollbar-color: color-mix('),
    );
    expect(WIDGET_CSS).toMatch(/@media \(max-width: 480px\) \{\s*\.launcher \{ width: 50px;/u);
    expect(WIDGET_CSS).toContain('min-width: 0; min-height: 36px; }');
  });
});
