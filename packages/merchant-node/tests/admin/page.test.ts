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
    expect(text).toContain('delivered');
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
    expect(byId('warnings').textContent).toMatch(/No listing found/);

    events.push(...storeEvents(store, owner));
    byId('refresh').click();
    await vi.waitFor(() => expect(byId('orders').querySelectorAll('tr')).toHaveLength(1));
    expect(byId('warnings').textContent).not.toMatch(/No listing found|No inbox list/);
    expect(byId('store-name').textContent).toBe(HOSTILE_NAME);
  });
});
