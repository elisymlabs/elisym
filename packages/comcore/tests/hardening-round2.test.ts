import { buildStoreAuthEvent } from '@elisym/commerce';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { ComparisonComponentSchema, newAskId } from '../src/chat/messages';
import { unwrapChatMessage } from '../src/chat/wrap';
import { KIND_CATALOG_AUTH } from '../src/constants';
import { buildCatalogAuth, readCatalogAuthority } from '../src/events/catalog-auth';
import { buildCatalogItemEvent } from '../src/events/catalog-item';
import { syncCatalog } from '../src/sync';
import { craftWrap } from './craft';
import { MemoryRelay, NOW, sign, testKey } from './fixtures';

const visitor = testKey();
const assistant = testKey();
const owner = testKey();
const catalog = testKey();
const noSleep = async () => {};

const item = (d: string, amount = '1') => ({ d, title: d, price: { amount, currency: 'USD' } });

function grant() {
  return sign(
    buildCatalogAuth({ key: catalog.pubkey, mode: 'hosted', createdAt: NOW - 100 }),
    owner,
  );
}

function sync(memory: MemoryRelay, items: ReturnType<typeof item>[], now: number) {
  return syncCatalog({
    signer: catalog.secretKey,
    store: owner.pubkey,
    items,
    client: memory,
    now,
    sleep: noSleep,
  });
}

describe('wrap recipient binding', () => {
  const good = craftWrap({
    content: JSON.stringify({ type: 'status', ask_id: newAskId(), text: 'x' }),
    sender: visitor.secretKey,
    recipient: assistant.pubkey,
    now: NOW,
  });

  it('refuses a wrap with a second p tag', () => {
    const twoP = finalizeEvent(
      {
        kind: 1059,
        created_at: good.created_at,
        tags: [['p', testKey().pubkey], ...good.tags],
        content: good.content,
      },
      generateSecretKey(),
    );
    expect(unwrapChatMessage(twoP, assistant.secretKey)).toBeUndefined();
  });

  it('refuses a wrap addressed to another key', () => {
    const other = finalizeEvent(
      {
        kind: 1059,
        created_at: good.created_at,
        tags: [['p', testKey().pubkey]],
        content: good.content,
      },
      generateSecretKey(),
    );
    expect(unwrapChatMessage(other, assistant.secretKey)).toBeUndefined();
  });
});

describe('sync dating', () => {
  it('dates an update after the listing it replaces, same second or fast clock', async () => {
    for (const listedAt of [NOW, NOW + 30]) {
      const memory = new MemoryRelay();
      memory.events.push(grant());
      await sync(memory, [item('a')], listedAt);
      const before = memory.published.length;
      await sync(memory, [item('a', '2')], NOW);
      expect(memory.published[before]?.created_at).toBe(listedAt + 1);
    }
  });

  it('dates the hidden version and its deletion after a fast-clock listing', async () => {
    const memory = new MemoryRelay();
    memory.events.push(grant());
    await sync(memory, [item('a')], NOW + 30);
    const before = memory.published.length;
    await sync(memory, [], NOW);
    expect(memory.published.slice(before).map((event) => event.created_at)).toEqual([
      NOW + 31,
      NOW + 31,
    ]);
  });

  it('stops syncing once the owner deletes the catalog-key grant', async () => {
    const memory = new MemoryRelay();
    memory.events.push(grant());
    memory.events.push(
      sign(
        {
          kind: 5,
          created_at: NOW - 50,
          tags: [['a', `${KIND_CATALOG_AUTH}:${owner.pubkey}:${catalog.pubkey}`]],
          content: '',
        },
        owner,
      ),
    );
    await expect(sync(memory, [item('a')], NOW)).rejects.toThrow(/not authorized/);
  });
});

describe('authority and builder rules', () => {
  it('enumerates authority with deletions and dual roles', () => {
    const both = testKey();
    const events = [
      grant(),
      sign(buildCatalogAuth({ key: both.pubkey, mode: 'hosted', createdAt: NOW - 90 }), owner),
      sign(
        buildStoreAuthEvent({ storePubkey: both.pubkey, mode: 'hosted', createdAt: NOW - 90 }),
        owner,
      ),
      sign(
        {
          kind: 5,
          created_at: NOW - 10,
          tags: [['a', `${KIND_CATALOG_AUTH}:${owner.pubkey}:${catalog.pubkey}`]],
          content: '',
        },
        owner,
      ),
    ];
    expect(readCatalogAuthority(events, owner.pubkey, NOW)).toEqual(
      new Map([[both.pubkey, new Set(['catalog', 'paycore'])]]),
    );
  });

  const options = [{ name: 'size', values: ['S', 'M'] }];

  it('derives price-from from the variants', () => {
    const differ = buildCatalogItemEvent({
      d: 'x',
      title: 'X',
      price: { amount: '1', currency: 'USD' },
      options,
      variants: [
        { id: 'a', price: '1', available: true, values: ['S'] },
        { id: 'b', price: '2', available: true, values: ['M'] },
      ],
    });
    expect(differ.tags).toContainEqual(['price-from', '1']);
    const same = buildCatalogItemEvent({
      d: 'x',
      title: 'X',
      price: { amount: '1', currency: 'USD' },
      options,
      variants: [
        { id: 'a', price: '1.00', available: true, values: ['S'] },
        { id: 'b', price: '1', available: true, values: ['M'] },
      ],
    });
    expect(same.tags.some((tag) => tag[0] === 'price-from')).toBe(false);
  });

  it('lets a fully sold-out product be hidden', () => {
    expect(() =>
      buildCatalogItemEvent({
        d: 'x',
        title: 'X',
        price: { amount: '1', currency: 'USD' },
        options: [{ name: 'size', values: ['S'] }],
        variants: [{ id: 'a', price: '1', available: false, values: ['S'] }],
        visibility: 'hidden',
      }),
    ).not.toThrow();
  });

  it('requires the recommended product to be compared', () => {
    const owned = testKey();
    expect(
      ComparisonComponentSchema.safeParse({
        type: 'comparison',
        addresses: [`30402:${owned.pubkey}:a`, `30402:${owned.pubkey}:b`],
        rows: [],
        recommended: `30402:${owned.pubkey}:c`,
      }).success,
    ).toBe(false);
  });
});
