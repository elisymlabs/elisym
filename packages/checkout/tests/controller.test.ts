import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { screenForPage } from '../src/app/controller';
import type { LoadOfferOptions } from '../src/core/offer';
import { OrderStore, openOrderDatabase } from '../src/core/order-store';
import { MemoryRelays, NOW, inboxList, makeShop } from './fixtures';

const PAGE = 'https://merchant.example';

let store: OrderStore;

beforeEach(async () => {
  store = new OrderStore(await openOrderDatabase(new IDBFactory()));
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
        const { loadOffer } = await import('../src/core/offer');
        return loadOffer(naddr, { ...options, now: NOW });
      },
    };
    const params = { naddr: shop.naddr, network: 'devnet' as const, theme: 'auto' as const };
    const screen = await screenForPage({ ...params, strictOrigin: false }, PAGE, deps);
    expect(screen).toMatchObject({ kind: 'offer' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pageOrigin: PAGE, families: ['solana'], network: 'devnet' });
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
    await screenForPage({ naddr: shop.naddr, strictOrigin: false, theme: 'auto' }, PAGE, {
      client: new MemoryRelays(shop.events),
      store,
      loadOffer: async (_naddr, options) => {
        pins = options.pins;
        return { ok: false, refusal: 'no_payable_payout', message: 'none' } as const;
      },
    });
    expect(pins).toMatchObject({ pinnedOwnerPubkey: shop.owner.pubkey });
  });

  it('refuses without storage, without a product, and on a refused offer', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays(shop.events);
    const params = { naddr: shop.naddr, strictOrigin: false, theme: 'auto' as const };
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
