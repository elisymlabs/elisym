import type { LoadedOffer, LoadOfferOptions } from '@elisym/commerce/buyer';
import { OrderStore, loadOffer } from '@elisym/commerce/buyer';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRelays, NOW, inboxList, makeShop } from '../../commerce/tests/buyer/fixtures';
import { type LoadDeps, loadWithPins, refRefusal, screenForPage } from '../src/app/controller';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';
import {
  type CheckoutParams,
  decodeCheckoutParams,
  encodeCheckoutParams,
} from '../src/embed/protocol';
import { encodeCheckoutParams as encodeV1 } from '../src/embed/v1/protocol';
import { encodeCheckoutParams as encodeV2 } from '../src/embed/v2/protocol';
import { encodeCheckoutParams as encodeV3 } from '../src/embed/v3/protocol';

const PAGE = 'https://merchant.example';
const INBOX = ['wss://inbox-a.example.com'];

let store: OrderStore;

beforeEach(async () => {
  store = new OrderStore(new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory())));
});

function paramsFor(naddr: string, extra: Partial<CheckoutParams> = {}): CheckoutParams {
  return {
    naddr,
    network: 'devnet',
    strictOrigin: false,
    theme: 'auto',
    collectEmail: false,
    display: 'modal',
    ...extra,
  };
}

/** A shop, its offer as the page would load it, and stand-in loads around it. */
async function shopWithOffer() {
  const shop = makeShop();
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const seen: LoadOfferOptions[] = [];
  const real = async (naddr: string, options: LoadOfferOptions) => {
    seen.push(options);
    return loadOffer(naddr, { ...options, now: NOW });
  };
  return { shop, relays, seen, real };
}

/** The real offer, re-labelled level A on the page's domain (the fixture store is level C). */
function asLevelA(loaded: LoadedOffer): LoadedOffer {
  return loaded.ok
    ? { ...loaded, offer: { ...loaded.offer, level: 'A', domain: 'merchant.example' } }
    : loaded;
}

describe('the customer reference in the fragment', () => {
  it('keeps a valid reference and refuses the page for an invalid one', () => {
    const naddr = 'naddr1qqtest';
    expect(decodeCheckoutParams(`#naddr=${naddr}&ref=user_42`)?.customerRef).toBe('user_42');
    expect(decodeCheckoutParams(`#naddr=${naddr}&ref=user_42`)?.badCustomerRef).toBeUndefined();
    for (const bad of ['', 'user%2042', 'x'.repeat(129), '%3Cscript%3E', 'us%C3%A9r']) {
      const decoded = decodeCheckoutParams(`#naddr=${naddr}&ref=${bad}`);
      expect(decoded?.customerRef).toBeUndefined();
      expect(decoded?.badCustomerRef).toBe(true);
    }
  });

  it('v1 and v2 hashes decode without a reference, exactly as before', () => {
    const base = { naddr: 'naddr1qqtest', strictOrigin: true, theme: 'dark', collectEmail: true };
    const fromV1 = decodeCheckoutParams(encodeV1({ ...base, theme: 'dark' }));
    const fromV2 = decodeCheckoutParams(encodeV2({ ...base, theme: 'dark', display: 'modal' }));
    for (const decoded of [fromV1, fromV2]) {
      expect(decoded).not.toHaveProperty('customerRef');
      expect(decoded).not.toHaveProperty('badCustomerRef');
    }
  });

  it('the v3 loader and the checkout agree on the encoding', () => {
    const params = paramsFor('naddr1qqtest', { strictOrigin: true, customerRef: 'a.b:c@d-e_f' });
    expect(decodeCheckoutParams(encodeV3(params))).toEqual(params);
    expect(encodeCheckoutParams(params)).toBe(encodeV3(params));
  });
});

describe('a reference before anything is loaded', () => {
  const top = {};
  it('refuses an invalid reference, and one outside the top window', () => {
    const naddr = 'naddr1qqtest';
    expect(refRefusal(paramsFor(naddr, { badCustomerRef: true }), { parent: top, top })).toBe(
      'bad_customer_ref',
    );
    expect(refRefusal(paramsFor(naddr, { customerRef: 'user_42' }), { parent: {}, top })).toBe(
      'ref_needs_verified_store',
    );
    expect(refRefusal(paramsFor(naddr, { customerRef: 'user_42' }), { parent: top, top })).toBe(
      undefined,
    );
    // No reference: a nested store page is today's behaviour, untouched.
    expect(refRefusal(paramsFor(naddr), { parent: {}, top })).toBe(undefined);
  });
});

describe('a reference and the store', () => {
  it('forces strict origin, even from a fragment without strict=1', async () => {
    const { shop, relays, seen, real } = await shopWithOffer();
    const fragment = decodeCheckoutParams(`#naddr=${shop.naddr}&ref=user_42&display=modal`);
    if (fragment === undefined) {
      throw new Error('no params');
    }
    expect(fragment.strictOrigin).toBe(false);
    await loadWithPins(fragment, PAGE, { client: relays, store, loadOffer: real });
    expect(seen[0]?.strictOrigin).toBe(true);
    await loadWithPins(paramsFor(shop.naddr), PAGE, { client: relays, store, loadOffer: real });
    expect(seen[1]?.strictOrigin).toBeUndefined();
  });

  it('a store that is not level A on this page is refused as such, terminally', async () => {
    const { shop, relays, real } = await shopWithOffer();
    const deps: LoadDeps = { client: relays, store, loadOffer: real };
    // The fixture store is level C: strict origin refuses it.
    const params = paramsFor(shop.naddr, { customerRef: 'user_42' });
    expect(await screenForPage(params, PAGE, deps)).toEqual({
      kind: 'refused',
      reason: 'ref_needs_verified_store',
    });
    // Even a loader that let a level-C offer through (it never should) is refused.
    const lenient: LoadDeps = {
      client: relays,
      store,
      loadOffer: (naddr, options) => real(naddr, { ...options, strictOrigin: false }),
    };
    expect(await screenForPage(params, PAGE, lenient)).toEqual({
      kind: 'refused',
      reason: 'ref_needs_verified_store',
    });
    // Without a reference the same store is offered (level C, as today).
    expect(await screenForPage(paramsFor(shop.naddr), PAGE, deps)).toMatchObject({ kind: 'offer' });
  });

  it('a level-A store on the page is offered with the reference', async () => {
    const { shop, relays, real } = await shopWithOffer();
    const deps: LoadDeps = {
      client: relays,
      store,
      loadOffer: async (naddr, options) =>
        asLevelA(await real(naddr, { ...options, strictOrigin: false })),
    };
    const params = paramsFor(shop.naddr, { customerRef: 'user_42' });
    expect(await screenForPage(params, PAGE, deps)).toMatchObject({ kind: 'offer' });
  });
});
