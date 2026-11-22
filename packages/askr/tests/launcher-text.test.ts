import type { NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { buildConfigEvent, parseConfig } from '../src/events/config';
import { LIMITS, StoreConfigInputSchema } from '../src/index';
import { NOW, sign, testKey } from './fixtures';

const owner = testKey();
const assistant = testKey();
const catalog = testKey();

const BASE_INPUT = {
  assistant: assistant.pubkey,
  origins: ['https://shop.example.com'],
  name: 'Example Shop',
  greeting: 'Hi there',
  language: 'en',
  currency: 'USD',
  source: { kind: 'catalog' as const },
  catalogKey: catalog.pubkey,
  createdAt: NOW - 100,
};

function template(launcherText?: string) {
  return buildConfigEvent(
    launcherText === undefined ? BASE_INPUT : { ...BASE_INPUT, launcherText },
    owner.secretKey,
  );
}

function signedWithTags(tags: NostrEvent['tags']): NostrEvent {
  const base = template();
  return sign({ ...base, tags: [...base.tags, ...tags] }, owner);
}

describe('store config launcher text', () => {
  it('pushes exactly one launcher-text tag only when set', () => {
    const withText = template('Ask our stylist');
    const tags = withText.tags.filter((tag) => tag[0] === 'launcher-text');
    expect(tags).toEqual([['launcher-text', 'Ask our stylist']]);
    const without = template();
    expect(without.tags.some((tag) => tag[0] === 'launcher-text')).toBe(false);
  });

  it('accepts up to the limit and refuses longer, empty, blank and malformed text', () => {
    function accepts(value: string): boolean {
      return StoreConfigInputSchema.safeParse({ ...BASE_INPUT, launcherText: value }).success;
    }
    expect(LIMITS.LAUNCHER_TEXT_CHARS).toBe(24);
    expect(accepts('a'.repeat(24))).toBe(true);
    expect(accepts('a'.repeat(25))).toBe(false);
    expect(accepts('')).toBe(false);
    expect(accepts('   ')).toBe(false);
    expect(accepts('a\uD800')).toBe(false);
  });

  it('parses a valid tag and ignores a bad one while keeping the rest of the config', () => {
    const valid = parseConfig(signedWithTags([['launcher-text', 'Ask us']]));
    expect(valid?.launcherText).toBe('Ask us');
    const ignored: NostrEvent['tags'][] = [
      [['launcher-text', 'a'.repeat(25)]],
      [['launcher-text', '   ']],
      [['launcher-text', 'Ask\uD800']],
      [
        ['launcher-text', 'Ask us'],
        ['launcher-text', 'Ask them'],
      ],
    ];
    for (const tags of ignored) {
      const parsed = parseConfig(signedWithTags(tags));
      expect(parsed).toBeDefined();
      expect(parsed?.launcherText).toBeUndefined();
      expect(parsed?.name).toBe('Example Shop');
      expect(parsed?.greeting).toBe('Hi there');
    }
  });

  it('round-trips the text byte for byte, with no trim or normalisation', () => {
    for (const text of ['Спросите нас', '問い合わせ', 'Ask us ', 'Café', 'Ask 🛍']) {
      const parsed = parseConfig(sign(template(text), owner));
      expect(parsed?.launcherText).toBe(text);
    }
  });
});
