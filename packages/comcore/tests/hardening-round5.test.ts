import type { NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { KIND_POLICY } from '../src/constants';
import { buildCatalogAuth, readCatalogAuthority } from '../src/events/catalog-auth';
import { parsePolicy } from '../src/events/policy';
import { removePolicy, setPolicy, syncCatalog } from '../src/sync';
import { MemoryRelay, NOW, PurgingRelay, sign, testKey } from './fixtures';

const owner = testKey();
const catalog = testKey();
const noSleep = async () => {};
const item = (d: string) => ({ d, title: d, price: { amount: '1', currency: 'USD' } });

function grant() {
  return sign(
    buildCatalogAuth({ key: catalog.pubkey, mode: 'hosted', createdAt: NOW - 100 }),
    owner,
  );
}

/** A relay that ignores `authors`, returning everyone's events of the kinds asked. */
class LooseRelay extends MemoryRelay {
  override async query(
    _relays: readonly string[],
    filter: Parameters<MemoryRelay['query']>[1],
  ): Promise<NostrEvent[]> {
    return this.events.filter((event) => !filter.kinds || filter.kinds.includes(event.kind));
  }
}

describe('foreign events from a loose relay', () => {
  it('a genuine deletion by another key does not stop a hide', async () => {
    const relay = new LooseRelay();
    relay.events.push(grant());
    await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a')],
      client: relay,
      now: NOW,
      sleep: noSleep,
    });
    const stranger = testKey();
    relay.events.push(
      sign(
        { kind: 5, created_at: NOW + 5, tags: [['a', `30402:${catalog.pubkey}:a`]], content: '' },
        stranger,
      ),
    );
    const diff = await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [],
      client: relay,
      now: NOW + 10,
      sleep: noSleep,
    });
    expect(diff.hidden).toEqual(['a']);
  });

  it('a far-future listing by another key does not move the dating floor', async () => {
    const relay = new LooseRelay();
    relay.events.push(grant());
    relay.events.push(
      sign(
        {
          kind: 30402,
          created_at: NOW + 3_600,
          tags: [
            ['d', 'a'],
            ['title', 'a'],
            ['price', '1', 'USD'],
          ],
          content: '',
        },
        testKey(),
      ),
    );
    const before = relay.published.length;
    await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a')],
      client: relay,
      now: NOW,
      sleep: noSleep,
    });
    expect(relay.published[before]?.created_at).toBe(NOW);
  });
});

describe('readCatalogAuthority tolerates malformed entries', () => {
  it('skips null and broken tags next to a valid grant', () => {
    const malformed: unknown[] = [
      null,
      { pubkey: owner.pubkey, kind: 30497, tags: null },
      { pubkey: owner.pubkey, kind: 30497, tags: [null] },
    ];
    const events = [grant(), ...malformed] as Parameters<typeof readCatalogAuthority>[0];
    expect(readCatalogAuthority(events, owner.pubkey, NOW)).toEqual(
      new Map([[catalog.pubkey, new Set(['catalog'])]]),
    );
  });
});

describe('setPolicy and removePolicy', () => {
  it('refuses an unauthorized key', async () => {
    await expect(
      setPolicy({
        signer: catalog.secretKey,
        store: owner.pubkey,
        client: new MemoryRelay(),
        policy: { slug: 'returns', title: 'Returns', body: '30 days' },
        now: NOW,
      }),
    ).rejects.toThrow(/not authorized/);
  });

  it('publishes, replaces after the previous version, deletes, and re-adds after the deletion', async () => {
    const relay = new PurgingRelay();
    relay.events.push(grant());
    const first = await setPolicy({
      signer: catalog.secretKey,
      store: owner.pubkey,
      client: relay,
      policy: { slug: 'returns', title: 'Returns', body: '30 days' },
      now: NOW,
    });
    expect(parsePolicy(first)?.body).toBe('30 days');
    const second = await setPolicy({
      signer: catalog.secretKey,
      store: owner.pubkey,
      client: relay,
      policy: { slug: 'returns', title: 'Returns', body: '14 days' },
      now: NOW,
    });
    expect(second.created_at).toBe(NOW + 1);
    const deletion = await removePolicy({
      signer: catalog.secretKey,
      store: owner.pubkey,
      client: relay,
      slug: 'returns',
      now: NOW,
    });
    expect(deletion.kind).toBe(5);
    expect(deletion.created_at).toBe(NOW + 2);
    expect(deletion.tags).toContainEqual(['a', `${KIND_POLICY}:${catalog.pubkey}:returns`]);
    expect(relay.events.some((event) => event.kind === KIND_POLICY)).toBe(false);
    const again = await setPolicy({
      signer: catalog.secretKey,
      store: owner.pubkey,
      client: relay,
      policy: { slug: 'returns', title: 'Returns', body: 'final' },
      now: NOW,
    });
    expect(again.created_at).toBe(NOW + 3);
  });
});

describe('round 6 gaps', () => {
  it('removePolicy refuses an unauthorized key', async () => {
    await expect(
      removePolicy({
        signer: catalog.secretKey,
        store: owner.pubkey,
        client: new MemoryRelay(),
        slug: 'returns',
        now: NOW,
      }),
    ).rejects.toThrow(/not authorized/);
  });

  it('a policy deletion does not touch a product with the same d', async () => {
    const relay = new MemoryRelay();
    relay.events.push(grant());
    const run = (items: ReturnType<typeof item>[], now: number) =>
      syncCatalog({
        signer: catalog.secretKey,
        store: owner.pubkey,
        items,
        client: relay,
        now,
        sleep: noSleep,
      });
    await run([item('a')], NOW);
    await setPolicy({
      signer: catalog.secretKey,
      store: owner.pubkey,
      client: relay,
      policy: { slug: 'a', title: 'A', body: 'policy a' },
      now: NOW + 1,
    });
    await removePolicy({
      signer: catalog.secretKey,
      store: owner.pubkey,
      client: relay,
      slug: 'a',
      now: NOW + 2,
    });
    expect((await run([item('a')], NOW + 3)).unchanged).toEqual(['a']);
  });
});
