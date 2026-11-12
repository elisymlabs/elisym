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
});
