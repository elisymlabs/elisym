import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAYS } from '../src/core/constants';
import { isPageOrigin, isSnapshotStale, loadOffer } from '../src/core/offer';
import { MemoryRelays, NOW, USDC_DEVNET_CAIP19, makeShop } from './fixtures';

const PAGE = 'https://merchant.example';

describe('loadOffer', () => {
  it('prices the payouts it can pay and says what to confirm and what to show', async () => {
    const shop = makeShop();
    const client = new MemoryRelays(shop.events);
    const loaded = await loadOffer(shop.naddr, {
      client,
      pageOrigin: PAGE,
      families: ['solana'],
      now: NOW,
    });
    if (!loaded.ok) {
      throw new Error(loaded.message);
    }
    expect(loaded.productAddress).toBe(`30402:${shop.store.pubkey}:course-101`);
    expect(loaded.payouts).toHaveLength(1);
    expect(loaded.payouts[0]?.amount).toBe(49_000_000n);
    expect(loaded.payouts[0]?.target.address).toBe(shop.payout);
    expect(loaded.confirm).toEqual([]);
    expect(loaded.notices).toEqual(
      expect.arrayContaining(['owner_unpinned', 'origin_unverifiable', 'payout_unsigned']),
    );
    expect(loaded.snapshotAt).toBe(NOW);
  });

  it('reads from the default relays plus the usable naddr hints', async () => {
    const shop = makeShop({ hints: ['wss://hint.example.com', 'ws://plain.example.com'] });
    const client = new MemoryRelays(shop.events);
    const loaded = await loadOffer(shop.naddr, {
      client,
      pageOrigin: PAGE,
      families: ['solana'],
      now: NOW,
    });
    expect(loaded.ok).toBe(true);
    const expected = [...DEFAULT_RELAYS, 'wss://hint.example.com'];
    expect(client.queried.length).toBeGreaterThan(0);
    expect(
      client.queried.every((relays) => JSON.stringify(relays) === JSON.stringify(expected)),
    ).toBe(true);
  });

  it('refuses a page without a usable origin before reading anything', async () => {
    const shop = makeShop();
    for (const pageOrigin of [
      'null',
      'https://merchant.example/',
      'file:///x',
      'merchant.example',
    ]) {
      const client = new MemoryRelays(shop.events);
      expect(
        await loadOffer(shop.naddr, { client, pageOrigin, families: ['solana'], now: NOW }),
      ).toMatchObject({
        ok: false,
        refusal: 'bad_page_origin',
      });
      expect(client.queried).toEqual([]);
    }
  });

  it('refuses a level A store on a page off its domain, and accepts it on the domain', async () => {
    const shop = makeShop({ nip05: '_@shop.example' });
    const resolveDomain = async () => ({
      domain: 'shop.example',
      name: '_',
      storePubkey: shop.store.pubkey,
      ownerPubkey: shop.owner.pubkey,
      source: 'nostr.json' as const,
    });
    const client = new MemoryRelays(shop.events);
    expect(
      await loadOffer(shop.naddr, {
        client,
        pageOrigin: PAGE,
        families: ['solana'],
        now: NOW,
        resolveDomain,
      }),
    ).toMatchObject({ ok: false, refusal: 'origin_mismatch' });
    const onDomain = await loadOffer(shop.naddr, {
      client,
      pageOrigin: 'https://shop.example',
      families: ['solana'],
      now: NOW,
      resolveDomain,
    });
    expect(onDomain).toMatchObject({ ok: true, offer: { level: 'A' } });
  });

  it('offers only the rails and network the widget pays on', async () => {
    const shop = makeShop();
    const client = new MemoryRelays(shop.events);
    const base = { client, pageOrigin: PAGE, families: ['solana' as const], now: NOW };
    expect(await loadOffer(shop.naddr, { ...base, families: ['evm'] })).toMatchObject({
      ok: false,
      refusal: 'no_payable_payout',
    });
    expect(await loadOffer(shop.naddr, { ...base, network: 'mainnet' })).toMatchObject({
      ok: false,
      refusal: 'no_payable_payout',
    });
    expect(
      await loadOffer(shop.naddr, { ...base, families: ['solana'], network: 'devnet' }),
    ).toMatchObject({ ok: true });
  });

  it('asks for a confirmation on a fresh payout list or an unknown payout', async () => {
    const recent = makeShop({ paytoCreatedAt: NOW - 3600 });
    const loaded = await loadOffer(recent.naddr, {
      client: new MemoryRelays(recent.events),
      pageOrigin: PAGE,
      families: ['solana'],
      now: NOW,
    });
    expect(loaded).toMatchObject({ ok: true, confirm: ['payout_recently_changed'] });

    const shop = makeShop();
    const pinned = await loadOffer(shop.naddr, {
      client: new MemoryRelays(shop.events),
      pageOrigin: PAGE,
      families: ['solana'],
      now: NOW,
      pins: {
        pinnedOwnerPubkey: shop.owner.pubkey,
        knownPayouts: [
          { caip19: USDC_DEVNET_CAIP19, address: 'SomeOtherAddress1111111111111111111111111' },
        ],
      },
    });
    expect(pinned).toMatchObject({ ok: true, confirm: ['payout_changed'] });
  });

  it('tightens the origin rule on request, and holds a store to its pinned owner', async () => {
    const shop = makeShop();
    const client = new MemoryRelays(shop.events);
    expect(
      await loadOffer(shop.naddr, {
        client,
        pageOrigin: PAGE,
        families: ['solana'],
        now: NOW,
        strictOrigin: true,
      }),
    ).toMatchObject({ ok: false, refusal: 'origin_mismatch' });
    expect(
      await loadOffer(shop.naddr, {
        client,
        pageOrigin: PAGE,
        families: ['solana'],
        now: NOW,
        pins: { pinnedOwnerPubkey: 'f'.repeat(64) },
      }),
    ).toMatchObject({ ok: false, refusal: 'owner_pin_mismatch' });
  });

  it('offers nothing for a free product (no amount to pay)', async () => {
    const shop = makeShop({ price: '0' });
    const client = new MemoryRelays(shop.events);
    expect(
      await loadOffer(shop.naddr, { client, pageOrigin: PAGE, families: ['solana'], now: NOW }),
    ).toMatchObject({
      ok: false,
      refusal: 'no_payable_payout',
    });
  });

  it('passes the refusals of the offer check through', async () => {
    const shop = makeShop();
    const client = new MemoryRelays(shop.events.slice(1));
    expect(
      await loadOffer(shop.naddr, { client, pageOrigin: PAGE, families: ['solana'], now: NOW }),
    ).toMatchObject({
      ok: false,
      refusal: 'product_missing',
    });
    expect(
      await loadOffer('naddr1bogus', { client, pageOrigin: PAGE, families: ['solana'], now: NOW }),
    ).toMatchObject({
      ok: false,
      refusal: 'bad_pointer',
    });
  });
});

describe('page origin and snapshot age', () => {
  it('accepts only a canonical http(s) origin', () => {
    expect(isPageOrigin('https://merchant.example')).toBe(true);
    expect(isPageOrigin('http://localhost:5173')).toBe(true);
    expect(isPageOrigin('null')).toBe(false);
    expect(isPageOrigin('ftp://merchant.example')).toBe(false);
    expect(isPageOrigin('wss://merchant.example')).toBe(false);
    expect(isPageOrigin('HTTPS://merchant.example')).toBe(false);
    expect(isPageOrigin(undefined)).toBe(false);
  });

  it('treats a snapshot older than two minutes as stale', () => {
    expect(isSnapshotStale(NOW - 120, NOW)).toBe(false);
    expect(isSnapshotStale(NOW - 121, NOW)).toBe(true);
  });
});
