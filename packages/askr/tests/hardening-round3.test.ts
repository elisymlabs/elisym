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

describe('forged and malformed relay entries', () => {
  function broken<Event extends { sig: string }>(event: Event): Event {
    const last = event.sig.slice(-1) === '0' ? '1' : '0';
    return { ...event, sig: event.sig.slice(0, -1) + last };
  }

  it('ignores a deletion by K with a broken signature', async () => {
    const relay = grantOn(new MemoryRelay());
    await sync(relay, [item('a')], NOW);
    relay.events.push(
      broken(
        sign(
          {
            kind: 5,
            created_at: NOW + 5,
            tags: [['a', `30402:${catalog.pubkey}:a`]],
            content: '',
          },
          catalog,
        ),
      ),
    );
    expect((await sync(relay, [item('a')], NOW + 10)).unchanged).toEqual(['a']);
    expect((await sync(relay, [], NOW + 20)).hidden).toEqual(['a']);
  });

  it('ignores a far-future listing by K with a broken signature', async () => {
    const relay = grantOn(new MemoryRelay());
    await sync(relay, [item('a')], NOW);
    const forged = broken(
      sign(
        {
          kind: 30402,
          created_at: NOW + 100_000_000,
          tags: [
            ['d', 'a'],
            ['title', 'a'],
            ['price', '1', 'USD'],
          ],
          content: '',
        },
        catalog,
      ),
    );
    relay.events.push(forged);
    const before = relay.published.length;
    await sync(relay, [{ ...item('a'), title: 'renamed' }], NOW + 10);
    expect(relay.published[before]?.created_at).toBe(NOW + 10);
  });

  it('skips malformed entries instead of crashing', async () => {
    const relay = grantOn(new MemoryRelay());
    const malformed = [null, { kind: 30402, tags: null }, { kind: 5, tags: [null] }];
    const client = {
      query: async (relays: readonly string[], filter: Parameters<MemoryRelay['query']>[1]) =>
        [...(await relay.query(relays, filter)), ...malformed] as never[],
      publish: relay.publish.bind(relay),
    };
    const diff = await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a')],
      client,
      now: NOW,
      sleep: noSleep,
    });
    expect(diff.created).toEqual(['a']);
  });
});
