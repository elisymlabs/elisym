// @vitest-environment happy-dom
import { KIND_INBOX_RELAYS, buildProductEvent, buildStoreProfileEvent } from '@elisym/commerce';
import type { RelayClient } from '@elisym/commerce/buyer';
import type { NostrEvent } from 'nostr-tools';
import * as nip19 from 'nostr-tools/nip19';
import { finalizeEvent } from 'nostr-tools/pure';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import html from '../../src/admin/index.html?raw';
import { startAdmin } from '../../src/admin/page';
import type { WrapPool } from '../../src/admin/reader';
import {
  D,
  T0,
  USDC_DEVNET_CAIP19,
  deliveredBody,
  key,
  orderBody,
  selfCopyOf,
  wrapOf,
} from './fixtures';

const HOSTILE_EMAIL = '<img/src=x/onerror=alert(1)>@evil.example';
const HOSTILE_NAME = '<b>Shop</b>';

function storeEvents(store: ReturnType<typeof key>, owner: ReturnType<typeof key>): NostrEvent[] {
  return [
    finalizeEvent(
      buildStoreProfileEvent({ name: HOSTILE_NAME, ownerPubkey: owner.pubkey, createdAt: T0 }),
      store.secretKey,
    ),
    finalizeEvent(
      {
        kind: KIND_INBOX_RELAYS,
        created_at: T0,
        tags: [['relay', 'wss://relay.example.com']],
        content: '',
      },
      store.secretKey,
    ),
    finalizeEvent(
      buildProductEvent({
        d: D,
        title: 'Course',
        description: '',
        price: { amount: '1', currency: 'USD' },
        accept: [USDC_DEVNET_CAIP19],
        createdAt: T0 - 24 * 60 * 60,
      }),
      store.secretKey,
    ),
  ];
}

/**
 * A relay client that answers each filter as a relay would: by kind, author
 * and `#d`, at most 250 events per filter (a relay's result limit).
 */
function relayLike(events: NostrEvent[]): RelayClient {
  return {
    ...fakeClient([]),
    query: (_relays, filters) =>
      Promise.resolve(
        filters.flatMap((filter) =>
          events
            .filter(
              (event) =>
                (filter.kinds === undefined || filter.kinds.includes(event.kind)) &&
                (filter.authors === undefined || filter.authors.includes(event.pubkey)) &&
                (filter['#d'] === undefined ||
                  event.tags.some(
                    (tag) => tag[0] === 'd' && filter['#d']?.includes(tag[1] ?? '') === true,
                  )),
            )
            .slice(0, 250),
        ),
      ),
  };
}

function fakeClient(events: NostrEvent[]): RelayClient {
  return {
    query: () => Promise.resolve(events),
    publish: () => Promise.resolve({ accepted: [], failed: [] }),
    subscribe: () => ({ close: () => undefined }),
    close: () => undefined,
  };
}

/** Every relay holds `wraps`, and answers a page with those in its range. */
function fakePool(wraps: NostrEvent[]): WrapPool {
  return {
    subscribeEose(_relays, filter, params) {
      queueMicrotask(() => {
        for (const wrap of wraps) {
          if (wrap.created_at >= (filter.since ?? 0) && wrap.created_at <= (filter.until ?? 0)) {
            params.onevent?.(wrap);
          }
        }
        params.onclose?.(['closed automatically on eose']);
      });
      return { close: () => undefined };
    },
  };
}

/** The page's body, without the script that would start the real app. */
function loadPage(): void {
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
}

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`no #${id}`);
  }
  return found;
}

function keyInput(): HTMLInputElement {
  const input = byId('store-key');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('#store-key is not an input');
  }
  return input;
}

describe('the admin page', () => {
  beforeEach(loadPage);

  it('takes the key in a masked text field outside any form', () => {
    const input = keyInput();
    expect(input.type).toBe('text');
    expect(input.getAttribute('type')).toBe('text');
    expect(input.closest('form')).toBeNull();
    expect(document.querySelector('form')).toBeNull();
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.classList.contains('masked')).toBe(true);
  });

  it('refuses what is not a secret key, and keeps the dashboard closed', () => {
    startAdmin(document, {
      client: fakeClient([]),
      pool: fakePool([]),
      now: () => Math.floor(Date.now() / 1000),
      forget: () => undefined,
    });
    keyInput().value = 'npub1notakey';
    byId('open').click();
    expect(byId('login-error').textContent).toMatch(/not a secret key/);
    expect(byId('dashboard').hidden).toBe(true);
    expect(keyInput().value).toBe('');
  });

  it('shows the orders, with untrusted text as text only', async () => {
    const store = key();
    const owner = key();
    const buyer = key();
    const orderId = 'b3a7c2d4-0000-4000-8000-000000000001';
    const wraps = [
      wrapOf(
        orderBody(store, orderId, { email: HOSTILE_EMAIL, customerRef: 'user-42' }),
        buyer,
        store,
      ),
      selfCopyOf(deliveredBody(buyer, orderId, { caip19: USDC_DEVNET_CAIP19 }), store, buyer),
    ];
    startAdmin(document, {
      client: fakeClient(storeEvents(store, owner)),
      pool: fakePool(wraps),
      now: () => Math.floor(Date.now() / 1000),
      forget: () => undefined,
    });
    keyInput().value = nip19.nsecEncode(store.secretKey);
    byId('open').click();
    expect(keyInput().value).toBe('');
    await vi.waitFor(() => expect(byId('status').textContent).toMatch(/^Read 2 order messages/));

    expect(byId('store-pubkey').textContent).toBe(store.pubkey);
    expect(byId('store-name').textContent).toBe(HOSTILE_NAME);
    expect(byId('store-name').querySelector('b')).toBeNull();
    const rows = byId('orders').querySelectorAll('tr');
    expect(rows).toHaveLength(1);
    const text = rows[0]?.textContent ?? '';
    expect(text).toContain(HOSTILE_EMAIL);
    // The Ref column sits under its header, beside Email.
    const headers = [...document.querySelectorAll('thead th')].map((cell) => cell.textContent);
    const cells = [...(rows[0]?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent);
    expect(cells).toHaveLength(headers.length);
    expect(cells[headers.indexOf('Ref')]).toBe('user-42');
    expect(text).toContain('completed');
    expect(text).not.toContain('delivered');
    expect(text).toContain('1 USDC');
    expect(byId('orders').querySelector('img')).toBeNull();
    const link = byId('orders').querySelector('a');
    expect(link?.getAttribute('href')).toMatch(/^https:\/\/explorer\.solana\.com\/tx\//);
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(byId('totals').textContent).toContain('1 USDC');
    expect(byId('more-row').hidden).toBe(true);
  });

  it('keeps what it read when the relays do not answer a Refresh', async () => {
    const store = key();
    const owner = key();
    const buyer = key();
    const orderId = 'b3a7c2d4-0000-4000-8000-000000000003';
    let events = storeEvents(store, owner);
    const wraps = [wrapOf(orderBody(store, orderId), buyer, store)];
    startAdmin(document, {
      client: { ...fakeClient([]), query: () => Promise.resolve([...events]) },
      pool: fakePool(wraps),
      now: () => Math.floor(Date.now() / 1000),
      forget: () => undefined,
    });
    keyInput().value = nip19.nsecEncode(store.secretKey);
    byId('open').click();
    await vi.waitFor(() => expect(byId('orders').querySelectorAll('tr')).toHaveLength(1));

    events = [];
    byId('refresh').click();
    await vi.waitFor(() => expect(byId('warnings').textContent).toMatch(/did not answer/));
    expect(byId('orders').querySelectorAll('tr')).toHaveLength(1);
    expect(byId('store-name').textContent).toBe(HOSTILE_NAME);
  });

  it('reads the store again on Refresh, when it did not answer the first time', async () => {
    const store = key();
    const owner = key();
    const buyer = key();
    const orderId = 'b3a7c2d4-0000-4000-8000-000000000002';
    const events: NostrEvent[] = [];
    const wraps = [wrapOf(orderBody(store, orderId), buyer, store)];
    startAdmin(document, {
      client: { ...fakeClient([]), query: () => Promise.resolve([...events]) },
      pool: fakePool(wraps),
      now: () => Math.floor(Date.now() / 1000),
      forget: () => undefined,
    });
    keyInput().value = nip19.nsecEncode(store.secretKey);
    byId('open').click();
    await vi.waitFor(() => expect(byId('status').textContent).toMatch(/^Read 1 order messages/));
    expect(byId('orders').querySelectorAll('tr')).toHaveLength(0);
    expect(byId('warnings').textContent).toMatch(
      /1 orders name products with no listing found .*: they are hidden\./,
    );

    events.push(...storeEvents(store, owner));
    byId('refresh').click();
    await vi.waitFor(() => expect(byId('orders').querySelectorAll('tr')).toHaveLength(1));
    expect(byId('warnings').textContent).not.toMatch(/no listing found|No inbox list/);
    expect(byId('store-name').textContent).toBe(HOSTILE_NAME);
  });

  it('shows the product of each order, and each product on sale or sold out', async () => {
    const store = key();
    const owner = key();
    const buyer = key();
    const stopped = finalizeEvent(
      buildProductEvent({
        d: 'stopped',
        title: 'Old course',
        description: '',
        price: { amount: '5', currency: 'USD' },
        visibility: 'sold-out',
        accept: [USDC_DEVNET_CAIP19],
        createdAt: T0,
      }),
      store.secretKey,
    );
    const wraps = [
      wrapOf(orderBody(store, 'b3a7c2d4-0000-4000-8000-00000000c001'), buyer, store),
      wrapOf(
        orderBody(store, 'b3a7c2d4-0000-4000-8000-00000000c002', {
          items: [{ product: `30402:${store.pubkey}:stopped`, quantity: 1 }],
          total: { amount: '5', currency: 'USD' },
        }),
        buyer,
        store,
      ),
    ];
    startAdmin(document, {
      client: relayLike([...storeEvents(store, owner), stopped]),
      pool: fakePool(wraps),
      now: () => Math.floor(Date.now() / 1000),
      forget: () => undefined,
    });
    keyInput().value = nip19.nsecEncode(store.secretKey);
    byId('open').click();
    await vi.waitFor(() => expect(byId('orders').querySelectorAll('tr')).toHaveLength(2));
    const headers = [...document.querySelectorAll('thead th')].map((cell) => cell.textContent);
    const products = [...byId('orders').querySelectorAll('tr')].map(
      (row) => row.querySelectorAll('td')[headers.indexOf('Product')]?.textContent,
    );
    expect(products.sort()).toEqual(['Course', 'Old course']);
    expect(byId('products').textContent).toContain(`${D}: Course, 1 USD, on sale`);
    expect(byId('products').textContent).toContain('stopped: Old course, 5 USD, sold out');
  });

  it('M39: reads every ordered product among more listings than a relay answers at once, sharing one second', async () => {
    const store = key();
    const owner = key();
    const many = Array.from({ length: 300 }, (_, index) =>
      finalizeEvent(
        buildProductEvent({
          d: `p${index}`,
          title: `Product ${index}`,
          description: '',
          price: { amount: '1', currency: 'USD' },
          accept: [USDC_DEVNET_CAIP19],
          createdAt: T0,
        }),
        store.secretKey,
      ),
    );
    const ordered = [5, 120, 260, 299];
    const wraps = ordered.map((index) => {
      const buyer = key();
      return wrapOf(
        orderBody(store, `b3a7c2d4-0000-4000-8000-0000000d${String(index).padStart(4, '0')}`, {
          items: [{ product: `30402:${store.pubkey}:p${index}`, quantity: 1 }],
        }),
        buyer,
        store,
      );
    });
    startAdmin(document, {
      client: relayLike([...storeEvents(store, owner), ...many]),
      pool: fakePool(wraps),
      now: () => Math.floor(Date.now() / 1000),
      forget: () => undefined,
    });
    keyInput().value = nip19.nsecEncode(store.secretKey);
    byId('open').click();
    await vi.waitFor(() => expect(byId('orders').querySelectorAll('tr')).toHaveLength(4));
    expect(byId('warnings').textContent).not.toMatch(/no listing found/);
  });

  it('M41 M42: Refresh reads the listing of a product newly ordered, and again a repriced one', async () => {
    const store = key();
    const owner = key();
    const buyer = key();
    const listingOf = (d: string, amount: string, createdAt: number) =>
      finalizeEvent(
        buildProductEvent({
          d,
          title: d,
          description: '',
          price: { amount, currency: 'USD' },
          accept: [USDC_DEVNET_CAIP19],
          createdAt,
        }),
        store.secretKey,
      );
    const events = [...storeEvents(store, owner), listingOf('x', '2', T0)];
    const wraps = [wrapOf(orderBody(store, 'b3a7c2d4-0000-4000-8000-00000000e001'), buyer, store)];
    startAdmin(document, {
      client: relayLike(events),
      pool: fakePool(wraps),
      now: () => Math.floor(Date.now() / 1000),
      forget: () => undefined,
    });
    keyInput().value = nip19.nsecEncode(store.secretKey);
    byId('open').click();
    await vi.waitFor(() => expect(byId('orders').querySelectorAll('tr')).toHaveLength(1));
    expect(byId('products').textContent).not.toContain('x:');

    // X's first order arrives after the page opened, and the course is repriced.
    wraps.push(
      wrapOf(
        orderBody(store, 'b3a7c2d4-0000-4000-8000-00000000e002', {
          items: [{ product: `30402:${store.pubkey}:x`, quantity: 1 }],
          total: { amount: '2', currency: 'USD' },
        }),
        buyer,
        store,
      ),
    );
    events.push(listingOf(D, '3', T0 + 10));
    byId('refresh').click();
    await vi.waitFor(() => expect(byId('orders').querySelectorAll('tr')).toHaveLength(2));
    expect(byId('products').textContent).toContain('x: x, 2 USD, on sale');
    expect(byId('products').textContent).toContain(`${D}: ${D}, 3 USD, on sale`);
  });

  it('shows one count line for orders naming unknown products, and keeps a listing a later read misses', async () => {
    const store = key();
    const owner = key();
    let events = storeEvents(store, owner);
    const wraps = [
      wrapOf(orderBody(store, 'b3a7c2d4-0000-4000-8000-00000000f000'), key(), store),
      ...Array.from({ length: 50 }, (_, index) =>
        wrapOf(
          orderBody(store, `b3a7c2d4-0000-4000-8000-0000000f${String(index).padStart(4, '0')}`, {
            items: [{ product: `30402:${store.pubkey}:spam-${index}`, quantity: 1 }],
          }),
          key(),
          store,
        ),
      ),
    ];
    startAdmin(document, {
      client: {
        ...relayLike([]),
        query: (relays, filters) => relayLike(events).query(relays, filters),
      },
      pool: fakePool(wraps),
      now: () => Math.floor(Date.now() / 1000),
      forget: () => undefined,
    });
    keyInput().value = nip19.nsecEncode(store.secretKey);
    byId('open').click();
    await vi.waitFor(() => expect(byId('orders').querySelectorAll('tr')).toHaveLength(1));
    const lines = [...byId('warnings').querySelectorAll('li')].map((item) => item.textContent);
    expect(lines.filter((line) => line?.includes('no listing found'))).toEqual([
      '50 orders name products with no listing found (an unknown product, or the relays did not answer): they are hidden.',
    ]);
    // A later read that finds nothing never drops a listing already read.
    events = [];
    byId('refresh').click();
    await vi.waitFor(() =>
      expect(byId('warnings').textContent).toMatch(/did not answer for the store/),
    );
    expect(byId('orders').querySelectorAll('tr')).toHaveLength(1);
  });
});
