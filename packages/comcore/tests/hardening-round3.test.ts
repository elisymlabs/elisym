import { describe, expect, it } from 'vitest';
import { newAskId } from '../src/chat/messages';
import { unwrapChatMessage } from '../src/chat/wrap';
import { buildCatalogAuth } from '../src/events/catalog-auth';
import { buildCatalogItemEvent } from '../src/events/catalog-item';
import { buildConfigEvent, parseConfig } from '../src/events/config';
import { syncCatalog } from '../src/sync';
import { craftWrap } from './craft';
import { MemoryRelay, NOW, PurgingRelay, sign, testKey } from './fixtures';

const owner = testKey();
const catalog = testKey();
const noSleep = async () => {};
const item = (d: string) => ({ d, title: d, price: { amount: '1', currency: 'USD' } });

function grantOn<Relay extends MemoryRelay>(relay: Relay): Relay {
  relay.events.push(
    sign(buildCatalogAuth({ key: catalog.pubkey, mode: 'hosted', createdAt: NOW - 100 }), owner),
  );
  return relay;
}

function sync(relay: MemoryRelay, items: ReturnType<typeof item>[], now: number) {
  return syncCatalog({
    signer: catalog.secretKey,
    store: owner.pubkey,
    items,
    client: relay,
    now,
    sleep: noSleep,
  });
}

describe('sync against a purging relay', () => {
  it('re-adds an item dated after a deletion that is all that is left', async () => {
    const relay = grantOn(new PurgingRelay());
    await sync(relay, [item('a')], NOW);
    await sync(relay, [], NOW);
    // Only the grant and the deletion survive.
    expect(relay.events.filter((event) => event.kind === 30402)).toHaveLength(0);
    const before = relay.published.length;
    const diff = await sync(relay, [item('a')], NOW);
    expect(diff.created).toEqual(['a']);
    // Hidden and deleted at NOW + 1 (after the NOW listing), so re-added at NOW + 2.
    expect(relay.published[before]?.created_at).toBe(NOW + 2);
  });

  it('dates past a listing more than the skew window ahead', async () => {
    const relay = grantOn(new MemoryRelay());
    await sync(relay, [item('a')], NOW + 3_600);
    const before = relay.published.length;
    await sync(relay, [], NOW);
    expect(relay.published.slice(before).map((event) => event.created_at)).toEqual([
      NOW + 3_601,
      NOW + 3_601,
    ]);
  });
});

describe('remaining untested paths', () => {
  const assistant = testKey();
  const visitor = testKey();

  it('refuses a rumor with two p tags', () => {
    const wrap = craftWrap({
      content: JSON.stringify({ type: 'status', ask_id: newAskId(), text: 'x' }),
      sender: visitor.secretKey,
      recipient: assistant.pubkey,
      now: NOW,
      rumorExtraTags: [['p', testKey().pubkey]],
    });
    expect(unwrapChatMessage(wrap, assistant.secretKey)).toBeUndefined();
  });

  it('validates pace even on a dry run', async () => {
    for (const pace of [0, Number.NaN]) {
      await expect(
        syncCatalog({
          signer: catalog.secretKey,
          store: owner.pubkey,
          items: [item('a')],
          client: grantOn(new MemoryRelay()),
          dryRun: true,
          pace,
          now: NOW,
          sleep: noSleep,
        }),
      ).rejects.toThrow(/pace must be positive/);
    }
  });

  it('caps language, avatar and contact on read', () => {
    const event = sign(
      buildConfigEvent(
        {
          assistant: assistant.pubkey,
          origins: ['https://shop.example.com'],
          name: 'Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'catalog' },
          catalogKey: catalog.pubkey,
          createdAt: NOW,
        },
        owner.secretKey,
      ),
      owner,
    );
    const longLanguage = 'en' + '-abcdefgh'.repeat(4);
    expect(longLanguage.length).toBeGreaterThan(35);
    const withLanguage = {
      ...event,
      tags: event.tags.map((tag) => (tag[0] === 'language' ? ['language', longLanguage] : tag)),
    };
    expect(parseConfig(withLanguage)).toBeUndefined();
    const longUrl = 'https://x.example.com/' + 'a'.repeat(1_100);
    const withLinks = {
      ...event,
      tags: [...event.tags, ['avatar', longUrl], ['contact', longUrl]],
    };
    const parsed = parseConfig(withLinks);
    expect(parsed?.avatar).toBeUndefined();
    expect(parsed?.contact).toBeUndefined();
  });

  const options = [{ name: 'size', values: ['S'] }];
  const unavailable = [{ id: 'a', price: '1', available: false, values: ['S'] }];
  const base = { d: 'x', title: 'X', price: { amount: '1', currency: 'USD' }, options };

  it('allows pre-order and refuses on-sale with nothing available', () => {
    expect(() =>
      buildCatalogItemEvent({ ...base, variants: unavailable, visibility: 'pre-order' }),
    ).not.toThrow();
    expect(() =>
      buildCatalogItemEvent({ ...base, variants: unavailable, visibility: 'on-sale' }),
    ).toThrow(/not|sold-out|available/);
  });
});
