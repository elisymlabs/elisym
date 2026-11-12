import { describe, expect, it } from 'vitest';
import { type Answer, newAskId } from '../src/chat/messages';
import { fitAnswer, rumorBytes, unwrapChatMessage, wrapChatMessage } from '../src/chat/wrap';
import { LIMITS } from '../src/constants';
import {
  buildCatalogItemEvent,
  parseCatalogItem,
  productPageUrl,
} from '../src/events/catalog-item';
import { buildConfigEvent, parseConfig } from '../src/events/config';
import { craftWrap } from './craft';
import { NOW, sign, testKey } from './fixtures';

const visitor = testKey();
const assistant = testKey();
const status = () => JSON.stringify({ type: 'status', ask_id: newAskId(), text: 'x' });

describe('unwrap gaps', () => {
  it('refuses own p first and a foreign p second', () => {
    const wrap = craftWrap({
      content: status(),
      sender: visitor.secretKey,
      recipient: assistant.pubkey,
      now: NOW,
      wrapRecipients: [assistant.pubkey, testKey().pubkey],
    });
    expect(unwrapChatMessage(wrap, assistant.secretKey)).toBeUndefined();
  });

  it('refuses a kind 14 rumor', () => {
    const wrap = craftWrap({
      content: status(),
      sender: visitor.secretKey,
      recipient: assistant.pubkey,
      now: NOW,
      rumorKind: 14,
    });
    expect(unwrapChatMessage(wrap, assistant.secretKey)).toBeUndefined();
  });

  it('refuses an over-bound wrap whose content would otherwise open', () => {
    const options = {
      content: status(),
      sender: visitor.secretKey,
      recipient: assistant.pubkey,
      now: NOW,
    };
    // Control: the same padded seal under the bound opens.
    expect(
      unwrapChatMessage(craftWrap({ ...options, padSealTo: 20_000 }), assistant.secretKey),
    ).toBeDefined();
    const big = craftWrap({ ...options, padSealTo: 60_000 });
    expect(big.content.length).toBeGreaterThan(LIMITS.WRAP_CONTENT_MAX_CHARS);
    expect(unwrapChatMessage(big, assistant.secretKey)).toBeUndefined();
  });
});

describe('catalog item gaps', () => {
  const key = testKey();
  const base = () =>
    buildCatalogItemEvent({
      d: 'x',
      title: 'X',
      price: { amount: '1', currency: 'USD' },
      url: 'https://shop.example.com/p',
      options: [{ name: 'size', values: ['S'] }],
      variants: [{ id: 'v', price: '1', available: true, values: ['S'] }],
    });
  const read = (template: ReturnType<typeof base>) =>
    parseCatalogItem(sign(template, key), { now: NOW, role: 'catalog' });

  it('rejects look-alike product page origins', () => {
    for (const link of [
      'https://shop.example.com.evil.com/p',
      'https://shop.example.com@evil.com/p',
    ]) {
      const template = base();
      template.tags = template.tags.map((tag) => (tag[0] === 'r' ? ['r', link] : tag));
      const item = read(template);
      expect(item && productPageUrl(item, ['https://shop.example.com'])).toBeUndefined();
    }
  });

  it('treats a malformed expiration as absent', () => {
    for (const value of ['soon', '1800000000000']) {
      const template = base();
      template.tags.push(['expiration', value]);
      expect(read(template)).toBeUndefined();
    }
  });

  it('drops variants with extra values or a bad availability flag', () => {
    for (const bad of [
      ['variant', 'extra', '1', '1', 'S', 'S'],
      ['variant', 'flag', '1', 'yes', 'S'],
    ]) {
      const template = base();
      template.tags.push(bad);
      expect(read(template)?.variants.map((variant) => variant.id)).toEqual(['v']);
    }
  });
});

describe('config gaps', () => {
  it('refuses an unknown connector platform', () => {
    const owner = testKey();
    const event = sign(
      buildConfigEvent(
        {
          assistant: assistant.pubkey,
          origins: ['https://shop.example.com'],
          name: 'Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'connector', platform: 'shopify' },
          catalogKey: testKey().pubkey,
          createdAt: NOW,
        },
        owner.secretKey,
      ),
      owner,
    );
    const tampered = {
      ...event,
      tags: event.tags.map((tag) => (tag[0] === 'source' ? ['source', 'connector', 'tilda'] : tag)),
    };
    expect(parseConfig(tampered)).toBeUndefined();
  });
});

describe('fitAnswer (4.2 overflow)', () => {
  const plan = {
    type: 'plan' as const,
    title: 't',
    steps: Array.from({ length: 6 }, () => ({
      label: 'l',
      detail: '"'.repeat(LIMITS.PLAN_DETAIL_CHARS),
      addresses: [],
    })),
  };

  it('leaves a small answer alone', () => {
    const answer: Answer = {
      type: 'answer',
      ask_id: newAskId(),
      session_end: NOW + 100,
      text: 'hi',
      components: [plan],
      chips: [],
    };
    expect(fitAnswer(answer, NOW)).toEqual(answer);
  });

  // Within the schema caps text alone always fits (4 000 UTF-16 units, at most 7
  // bytes each after double escaping: 28 000 + chips + overhead < 32 000), so the
  // truncation step is the spec's last resort and not reachable here.
  const titled = (index: number) => ({ ...plan, title: `c${index}` });
  const titles = (answer: Answer) =>
    answer.components.map((component) => ('title' in component ? component.title : undefined));

  it('drops exactly the last component when one drop is enough', () => {
    const answer: Answer = {
      type: 'answer',
      ask_id: newAskId(),
      session_end: NOW + 100,
      text: 'ж"'.repeat(2_000),
      components: [titled(0), titled(1), titled(2), titled(3)],
      chips: [],
    };
    expect(rumorBytes(answer, NOW)).toBeGreaterThan(LIMITS.RUMOR_WORKING_BYTES);
    const fitted = fitAnswer(answer, NOW);
    expect(titles(fitted)).toEqual(['c0', 'c1', 'c2']);
    expect(fitted.text).toBe(answer.text);
    expect(() =>
      wrapChatMessage({
        message: fitted,
        senderSecretKey: assistant.secretKey,
        recipientPubkey: visitor.pubkey,
        expiresAt: NOW + 60,
        now: NOW,
      }),
    ).not.toThrow();
  });

  it('stops dropping as soon as the answer fits', () => {
    const answer: Answer = {
      type: 'answer',
      ask_id: newAskId(),
      session_end: NOW + 100,
      text: '"'.repeat(4_000),
      components: [titled(0), titled(1), titled(2), titled(3)],
      chips: [],
    };
    const fitted = fitAnswer(answer, NOW);
    expect(rumorBytes(fitted, NOW)).toBeLessThanOrEqual(LIMITS.RUMOR_WORKING_BYTES);
    const kept = fitted.components.length;
    expect(kept).toBeGreaterThan(0);
    expect(titles(fitted)).toEqual(['c0', 'c1', 'c2', 'c3'].slice(0, kept));
    // One more component would not have fit.
    expect(
      rumorBytes({ ...answer, components: answer.components.slice(0, kept + 1) }, NOW),
    ).toBeGreaterThan(LIMITS.RUMOR_WORKING_BYTES);
  });
});
