import type { LoadOfferOptions } from '@elisym/commerce/buyer';
import { OrderStore } from '@elisym/commerce/buyer';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRelays, NOW, inboxList, makeShop } from '../../commerce/tests/buyer/fixtures';
import { SLOW_START_MS, screenForPage, startWithHint } from '../src/app/controller';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';

const PAGE = 'https://merchant.example';

let store: OrderStore;

beforeEach(async () => {
  store = new OrderStore(new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory())));
});

describe('the screen for a page', () => {
  it('shows the offer verified for the page origin, on the rails the widget pays', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, ['wss://a.example'])]);
    const seen: LoadOfferOptions[] = [];
    const deps = {
      client: relays,
      store,
      loadOffer: async (naddr: string, options: LoadOfferOptions) => {
        seen.push(options);
        const { loadOffer } = await import('@elisym/commerce/buyer');
        return loadOffer(naddr, { ...options, now: NOW });
      },
    };
    const params = {
      naddr: shop.naddr,
      network: 'devnet' as const,
      theme: 'auto' as const,
      collectEmail: false,
      display: 'inline' as const,
    };
    const screen = await screenForPage({ ...params, strictOrigin: false }, PAGE, deps);
    expect(screen).toMatchObject({ kind: 'offer' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      pageOrigin: PAGE,
      families: ['solana', 'evm'],
      network: 'devnet',
    });
    expect(seen[0]?.strictOrigin).toBeUndefined();
    expect(seen[0]?.pins).toBeUndefined();
    // The page's strict-origin attribute tightens: a level C store is refused.
    expect(await screenForPage({ ...params, strictOrigin: true }, PAGE, deps)).toMatchObject({
      kind: 'refused',
      reason: 'offer_refused',
    });
    expect(seen[1]?.strictOrigin).toBe(true);
  });

  it('passes the pins of earlier purchases from this store', async () => {
    const shop = makeShop();
    await store.rememberDelivery(shop.store.pubkey, shop.owner.pubkey, [
      { caip19: 'solana:x/token:y', address: shop.payout },
    ]);
    let pins: LoadOfferOptions['pins'];
    let skipUnreachable: boolean | undefined;
    await screenForPage(
      {
        naddr: shop.naddr,
        strictOrigin: false,
        theme: 'auto',
        collectEmail: false,
        display: 'inline',
      },
      PAGE,
      {
        client: new MemoryRelays(shop.events),
        store,
        loadOffer: async (_naddr, options) => {
          pins = options.pins;
          skipUnreachable = options.skipUnreachable;
          return { ok: false, refusal: 'no_payable_payout', message: 'none' } as const;
        },
      },
    );
    expect(pins).toMatchObject({ pinnedOwnerPubkey: shop.owner.pubkey });
    // The load that opens the page may pass by relays just found dead.
    expect(skipUnreachable).toBe(true);
  });

  it('re-verifies with the pins too, read fresh each time', async () => {
    const shop = makeShop();
    const { loadWithPins } = await import('../src/app/controller');
    const seen: LoadOfferOptions[] = [];
    const deps = {
      client: new MemoryRelays(shop.events),
      store,
      loadOffer: async (_naddr: string, options: LoadOfferOptions) => {
        seen.push(options);
        return { ok: false, refusal: 'no_payable_payout', message: 'none' } as const;
      },
    };
    const params = {
      naddr: shop.naddr,
      strictOrigin: false,
      theme: 'auto' as const,
      collectEmail: false,
      display: 'inline' as const,
    };
    await loadWithPins(params, PAGE, deps);
    expect(seen[0]?.pins).toBeUndefined();
    // A re-verification before paying tries every relay.
    expect(seen[0]?.skipUnreachable).toBeUndefined();
    // A delivery since the page opened pinned the owner: the next re-verification uses it.
    await store.rememberDelivery(shop.store.pubkey, shop.owner.pubkey, []);
    await loadWithPins(params, PAGE, deps);
    expect(seen[1]?.pins).toMatchObject({ pinnedOwnerPubkey: shop.owner.pubkey });
  });

  it('refuses without storage, without a product, and on a refused offer', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays(shop.events);
    const params = {
      naddr: shop.naddr,
      strictOrigin: false,
      theme: 'auto' as const,
      collectEmail: false,
      display: 'inline' as const,
    };
    expect(await screenForPage(params, PAGE, { client: relays, store: undefined })).toEqual({
      kind: 'refused',
      reason: 'no_storage',
    });
    expect(
      await screenForPage({ ...params, naddr: 'naddr1broken' }, PAGE, { client: relays, store }),
    ).toEqual({ kind: 'refused', reason: 'no_product' });
    expect(
      await screenForPage(params, PAGE, {
        client: relays,
        store,
        loadOffer: async () => ({ ok: false, refusal: 'origin_mismatch', message: 'not here' }),
      }),
    ).toEqual({ kind: 'refused', reason: 'offer_refused', message: 'not here' });
  });
});

describe('a slow start', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('only says it is slow: never a refusal, and the start keeps running', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    let settled = false;
    const running = startWithHint(
      () => new Promise<void>(() => undefined),
      () => said.push('slow'),
    ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SLOW_START_MS - 1);
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(said).toEqual(['slow']);
    await vi.advanceTimersByTimeAsync(10 * SLOW_START_MS);
    // Once, and nothing else: no refusal, nothing ended.
    expect(said).toEqual(['slow']);
    expect(settled).toBe(false);
    void running;
  });

  it('says nothing for a start that ends in time, and ends when the start does', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    let finish: () => void = () => undefined;
    const running = startWithHint(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      () => said.push('slow'),
    );
    await vi.advanceTimersByTimeAsync(SLOW_START_MS - 1000);
    finish();
    await running;
    await vi.advanceTimersByTimeAsync(SLOW_START_MS);
    expect(said).toEqual([]);
  });

  it('lets a late start finish after the hint, and passes its failure on', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    let fail: (error: Error) => void = () => undefined;
    const running = startWithHint(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
      () => said.push('slow'),
    );
    await vi.advanceTimersByTimeAsync(SLOW_START_MS);
    expect(said).toEqual(['slow']);
    fail(new Error('relay down'));
    await expect(running).rejects.toThrow('relay down');
  });
});
