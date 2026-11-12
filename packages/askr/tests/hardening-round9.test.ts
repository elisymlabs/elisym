import { describe, expect, it } from 'vitest';
import { AskSchema, newAskId } from '../src/chat/messages';
import { unwrapChatMessage } from '../src/chat/wrap';
import { KIND_POLICY, LIMITS } from '../src/constants';
import {
  buildCatalogItemEvent,
  determinedVariant,
  parseCatalogItem,
} from '../src/events/catalog-item';
import { buildConfigEvent, parseConfig } from '../src/events/config';
import { parsePolicy } from '../src/events/policy';
import { buildTicket } from '../src/ticket';
import { craftWrap } from './craft';
import { NOW, sign, testKey } from './fixtures';

const key = testKey();

describe('determinedVariant with a single variant', () => {
  const read = (values: string[]) =>
    parseCatalogItem(
      sign(
        buildCatalogItemEvent({
          d: 'x',
          title: 'X',
          price: { amount: '1', currency: 'USD' },
          options: [{ name: 'size', values: ['M', 'L'] }],
          variants: [{ id: 'only', price: '1', available: true, values }],
        }),
        key,
      ),
      { now: NOW, role: 'catalog' },
    );

  it('is determined without a pick or by a matching one, never by a contradicting one', () => {
    const item = read(['M']);
    expect(item && determinedVariant(item, {})?.id).toBe('only');
    expect(item && determinedVariant(item, { size: 'M' })?.id).toBe('only');
    expect(item && determinedVariant(item, { size: 'L' })).toBeUndefined();
  });

  it('is never determined when it carries *', () => {
    const item = read(['*']);
    expect(item && determinedVariant(item, { size: 'M' })).toBeUndefined();
  });
});

describe('reader edge cases', () => {
  it('refuses a policy with a bad or over-long slug', () => {
    for (const slug of ['Bad Slug', 'a'.repeat(65)]) {
      expect(
        parsePolicy(
          sign(
            {
              kind: KIND_POLICY,
              created_at: NOW,
              tags: [
                ['d', slug],
                ['title', 'T'],
              ],
              content: 'body',
            },
            key,
          ),
        ),
      ).toBeUndefined();
    }
  });

  const owner = testKey();
  const config = () =>
    sign(
      buildConfigEvent(
        {
          assistant: testKey().pubkey,
          origins: ['https://shop.example.com'],
          name: 'Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'catalog' },
          catalogKey: testKey().pubkey,
          createdAt: NOW,
        },
        owner.secretKey,
      ),
      owner,
    );

  it('refuses an over-long private content', () => {
    const event = config();
    expect(
      parseConfig({ ...event, content: 'A'.repeat(LIMITS.CONFIG_CONTENT_MAX_CHARS + 1) }),
    ).toBeUndefined();
  });

  it('refuses a platform on a non-connector source', () => {
    const event = config();
    const tampered = {
      ...event,
      tags: event.tags.map((tag) => (tag[0] === 'source' ? ['source', 'catalog', 'shopify'] : tag)),
    };
    expect(parseConfig(tampered)).toBeUndefined();
  });

  it('refuses a non-http page URL and one over the byte cap', () => {
    const gateway = testKey();
    const visitor = testKey();
    const ticket = sign(
      buildTicket({ visitor: visitor.pubkey, store: owner.pubkey, now: NOW }),
      gateway,
    );
    const ask = (url: string) =>
      AskSchema.safeParse({ type: 'ask', ask_id: newAskId(), text: 'hi', ticket, page: { url } });
    expect(ask('https://shop.example.com/p').success).toBe(true);
    expect(ask('javascript:alert(1)').success).toBe(false);
    expect(ask(`https://shop.example.com/${'€'.repeat(1_000)}`).success).toBe(false);
  });

  it('reads a malformed wrap expiration as none', () => {
    const assistant = testKey();
    const visitor = testKey();
    const opened = unwrapChatMessage(
      craftWrap({
        content: JSON.stringify({ type: 'status', ask_id: newAskId(), text: 'x' }),
        sender: visitor.secretKey,
        recipient: assistant.pubkey,
        now: NOW,
        wrapExpiration: 'abc',
      }),
      assistant.secretKey,
    );
    expect(opened).toBeDefined();
    expect(opened?.expiresAt).toBeUndefined();
  });
});
