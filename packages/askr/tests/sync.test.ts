import { describe, expect, it } from 'vitest';
import { buildCatalogAuth } from '../src/events/catalog-auth';
import { parseCatalogItem } from '../src/events/catalog-item';
import { syncCatalog } from '../src/sync';
import { MemoryRelay, NOW, sign, testKey } from './fixtures';

const owner = testKey();
const catalog = testKey();

function item(d: string, amount = '10') {
  return { d, title: `Item ${d}`, price: { amount, currency: 'USD' } };
}

function relayWithGrant(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.events.push(
    sign(buildCatalogAuth({ key: catalog.pubkey, mode: 'self-host', createdAt: NOW - 100 }), owner),
  );
  return relay;
}

const noSleep = async () => {};

describe('syncCatalog', () => {
  it('refuses a key the owner has not authorized', async () => {
    await expect(
      syncCatalog({
        signer: catalog.secretKey,
        store: owner.pubkey,
        items: [item('a')],
        client: new MemoryRelay(),
        now: NOW,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/not authorized/);
  });

  it('creates, then leaves unchanged, then updates and hides', async () => {
    const relay = relayWithGrant();
    const first = await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a'), item('b')],
      client: relay,
      now: NOW,
      sleep: noSleep,
    });
    expect(first).toEqual({ created: ['a', 'b'], updated: [], hidden: [], unchanged: [] });

    const second = await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a'), item('b')],
      client: relay,
      now: NOW + 10,
      sleep: noSleep,
    });
    expect(second).toEqual({ created: [], updated: [], hidden: [], unchanged: ['a', 'b'] });

    const publishedBefore = relay.published.length;
    const third = await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a', '12')],
      client: relay,
      now: NOW + 20,
      sleep: noSleep,
    });
    expect(third).toEqual({ created: [], updated: ['a'], hidden: ['b'], unchanged: [] });
    const newEvents = relay.published.slice(publishedBefore);
    // a updated, b hidden, b deleted.
    expect(newEvents.map((event) => event.kind)).toEqual([30402, 30402, 5]);
    const hiddenB = newEvents[1];
    expect(
      hiddenB && parseCatalogItem(hiddenB, { now: NOW + 20, role: 'catalog' }),
    ).toBeUndefined();
  });

  it('upsert touches only its items and the listings it hides', async () => {
    const relay = relayWithGrant();
    const base = { signer: catalog.secretKey, store: owner.pubkey, client: relay, sleep: noSleep };
    await syncCatalog({ ...base, items: [item('a'), item('b'), item('c')], now: NOW });
    const upserted = await syncCatalog({
      ...base,
      mode: 'upsert',
      items: [item('a', '12'), item('d')],
      now: NOW + 10,
    });
    expect(upserted).toEqual({ created: ['d'], updated: ['a'], hidden: [], unchanged: [] });
    const before = relay.published.length;
    const hidden = await syncCatalog({
      ...base,
      mode: 'upsert',
      items: [],
      hide: ['b', 'missing'],
      now: NOW + 20,
    });
    expect(hidden).toEqual({ created: [], updated: [], hidden: ['b'], unchanged: [] });
    expect(relay.published.slice(before).map((event) => event.kind)).toEqual([30402, 5]);
    // A replace afterwards still sees c and d, untouched by either upsert.
    const replaced = await syncCatalog({
      ...base,
      items: [item('a', '12'), item('c'), item('d')],
      dryRun: true,
      now: NOW + 30,
    });
    expect(replaced).toEqual({ created: [], updated: [], hidden: [], unchanged: ['a', 'c', 'd'] });
  });

  it('refuses hide outside upsert, and an item both published and hidden', async () => {
    const relay = relayWithGrant();
    const base = { signer: catalog.secretKey, store: owner.pubkey, client: relay, now: NOW };
    await expect(syncCatalog({ ...base, items: [], hide: ['a'] })).rejects.toThrow(/upsert/);
    await expect(
      syncCatalog({ ...base, mode: 'upsert', items: [item('a')], hide: ['a'] }),
    ).rejects.toThrow(/also be hidden/);
    expect(relay.published).toEqual([]);
  });

  it('never touches another author', async () => {
    const relay = relayWithGrant();
    const stranger = testKey();
    relay.events.push(
      sign(
        {
          kind: 30402,
          created_at: NOW - 5,
          tags: [
            ['d', 'x'],
            ['title', 'X'],
            ['price', '1', 'USD'],
          ],
          content: '',
        },
        stranger,
      ),
    );
    const diff = await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [],
      client: relay,
      now: NOW,
      sleep: noSleep,
    });
    expect(diff.hidden).toEqual([]);
    expect(relay.published).toEqual([]);
  });

  it('publishes nothing on a dry run', async () => {
    const relay = relayWithGrant();
    const diff = await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a')],
      client: relay,
      dryRun: true,
      now: NOW,
      sleep: noSleep,
    });
    expect(diff.created).toEqual(['a']);
    expect(relay.published).toEqual([]);
  });

  it('paces publishing', async () => {
    const relay = relayWithGrant();
    const waits: number[] = [];
    await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a'), item('b'), item('c')],
      client: relay,
      pace: 4,
      now: NOW,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([250, 250]);
  });

  it('refuses duplicate d values', async () => {
    await expect(
      syncCatalog({
        signer: catalog.secretKey,
        store: owner.pubkey,
        items: [item('a'), item('a')],
        client: relayWithGrant(),
        now: NOW,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/Duplicate/);
  });

  it("one product's future date never moves another's", async () => {
    const relay = relayWithGrant();
    const base = { signer: catalog.secretKey, store: owner.pubkey, client: relay, sleep: noSleep };
    // `a` was last signed by a clock two hours fast.
    await syncCatalog({ ...base, items: [item('a')], now: NOW + 7_200 });
    const before = relay.published.length;
    await syncCatalog({
      ...base,
      mode: 'upsert',
      items: [item('a', '11'), item('b'), item('c')],
      now: NOW,
    });
    const dates = relay.published.slice(before).map((event) => event.created_at - NOW);
    expect(dates).toEqual([7_201, 0, 0]);
  });

  it('dates each event by the clock as it is published, and a given past now as is', async () => {
    const relay = relayWithGrant();
    const base = { signer: catalog.secretKey, store: owner.pubkey, client: relay, sleep: noSleep };
    let tick = NOW;
    await syncCatalog({
      ...base,
      items: [item('a'), item('b'), item('c')],
      now: NOW,
      clock: () => tick++,
    });
    expect(relay.published.map((event) => event.created_at - NOW)).toEqual([0, 1, 2]);
    // Before real time: a given `now` dates the events, not the wall clock.
    const past = 1_600_000_000;
    const old = new MemoryRelay();
    old.events.push(
      sign(
        buildCatalogAuth({ key: catalog.pubkey, mode: 'self-host', createdAt: past - 100 }),
        owner,
      ),
    );
    await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      client: old,
      sleep: noSleep,
      items: [item('a')],
      now: past,
    });
    expect(old.published.at(-1)?.created_at).toBe(past);
  });

  it('a deletion is never dated before the hidden version it follows, even when the clock steps back', async () => {
    const relay = relayWithGrant();
    const base = { signer: catalog.secretKey, store: owner.pubkey, client: relay, sleep: noSleep };
    await syncCatalog({ ...base, items: [item('a')], now: NOW });
    const before = relay.published.length;
    const ticks = [NOW + 50, NOW + 10];
    await syncCatalog({ ...base, items: [], now: NOW, clock: () => ticks.shift() ?? NOW });
    const [hidden, deletion] = relay.published.slice(before);
    expect(hidden?.kind).toBe(30402);
    expect(deletion?.kind).toBe(5);
    expect(deletion?.created_at).toBeGreaterThanOrEqual(hidden?.created_at ?? Infinity);
  });
});
