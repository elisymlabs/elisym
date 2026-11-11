// @vitest-environment happy-dom
import {
  type CatalogItem,
  type StoreConfig,
  buildCatalogItemEvent,
  buildConfigEvent,
  parseCatalogItem,
  parseConfig,
} from '@elisym/comcore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CardContext, cardPageUrl, renderCard } from '../src/ui/card-view';
import { httpsUrl } from '../src/ui/dom';
import { localSecs, makeStore, sign, testKey } from './fixtures';

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

function context(config: StoreConfig = storeConfig()): CardContext & { clicks: string[] } {
  const clicks: string[] = [];
  return {
    document,
    config,
    reportClick: (address) => clicks.push(address),
    pageOrigin: 'https://shop.example',
    clicks,
  };
}

afterEach(() => {
  Reflect.deleteProperty(window, 'ComCore');
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
    Reflect.set(window, 'ComCore', { onAddToCart });
    card.dispatchEvent(new Event('pointerenter'));
    const button = card.querySelector<HTMLButtonElement>('button.cart');
    expect(button).not.toBeNull();
    button?.click();
    expect(onAddToCart).toHaveBeenCalledWith({ d: 'scarf', sku: 'SC-1' });
  });

  it('drops the button again when the host removes its hook, on focus too', () => {
    Reflect.set(window, 'ComCore', { onAddToCart: () => undefined });
    const card = renderCard(context(), catalogItem());
    expect(card.querySelector('button.cart')).not.toBeNull();
    Reflect.deleteProperty(window, 'ComCore');
    card.dispatchEvent(new Event('focusin'));
    expect(card.querySelector('button.cart')).toBeNull();
  });
});
