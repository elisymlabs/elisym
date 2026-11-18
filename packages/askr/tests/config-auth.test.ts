import { buildStoreAuthEvent, buildStoreRevocationEvent } from '@elisym/commerce';
import { nip44 } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  buildCatalogAuth,
  buildCatalogRevocation,
  isCatalogKey,
  readCatalogAuthority,
  resolveStoreKeys,
} from '../src/events/catalog-auth';
import {
  assistantDisplayName,
  buildConfigEvent,
  buildConfigEventWith,
  decryptPrivateConfig,
  decryptPrivateConfigWith,
  normalizeShopUrl,
  parseConfig,
} from '../src/events/config';
import { buildPolicyEvent, parsePolicy } from '../src/events/policy';
import { PRODUCT_SOURCES, StoreConfigInputSchema } from '../src/index';
import { NOW, sign, testKey } from './fixtures';

const owner = testKey();
const assistant = testKey();
const catalog = testKey();

function config(overrides: Record<string, unknown> = {}) {
  return sign(
    buildConfigEvent(
      {
        assistant: assistant.pubkey,
        origins: ['https://shop.example.com'],
        name: 'Example Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'catalog' },
        catalogKey: catalog.pubkey,
        private: { voice: 'friendly', instructions: 'never push', notes: 'margin is thin' },
        createdAt: NOW - 100,
        ...overrides,
      },
      owner.secretKey,
    ),
    owner,
  );
}

describe('config, zod 4 parity', () => {
  function unsignedConfig(overrides: Record<string, unknown> = {}) {
    return buildConfigEvent(
      {
        assistant: assistant.pubkey,
        origins: ['https://shop.example.com'],
        name: 'Example Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'catalog' },
        catalogKey: catalog.pubkey,
        createdAt: NOW - 100,
        ...overrides,
      },
      owner.secretKey,
    );
  }

  it('refuses an origin tag with a stray space, tab or newline (fail closed)', () => {
    for (const origin of [
      'https://shop.example.com\n',
      ' https://shop.example.com',
      'https://shop.example.com ',
      'https://sh\top.example.com',
    ]) {
      for (const tagName of ['origin', 'link-origin']) {
        const template = unsignedConfig();
        template.tags = [...template.tags, [tagName, origin]];
        expect(parseConfig(sign(template, owner))).toBeUndefined();
      }
      const input = {
        assistant: assistant.pubkey,
        origins: [origin],
        name: 'Example Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'catalog' },
        catalogKey: catalog.pubkey,
      };
      expect(StoreConfigInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it('a config built without a private block decrypts to its empty fields', () => {
    const parsed = parseConfig(sign(unsignedConfig(), owner));
    expect(parsed && decryptPrivateConfig(parsed, assistant.secretKey)).toEqual({
      voice: '',
      instructions: '',
      notes: '',
    });
  });

  it('refuses a contact with a leading space instead of trimming it', () => {
    for (const field of ['contact']) {
      expect(() => unsignedConfig({ [field]: ' https://shop.example.com/a.png' })).toThrow();
      expect(() => unsignedConfig({ [field]: 'https://shop.example.com/a.png' })).not.toThrow();
    }
  });
});

describe('config', () => {
  it('reads the public part and decrypts the private part only with A', () => {
    const event = config();
    const parsed = parseConfig(event);
    expect(parsed).toMatchObject({
      owner: owner.pubkey,
      assistant: assistant.pubkey,
      origins: ['https://shop.example.com'],
      name: 'Example Shop',
      currency: 'USD',
      source: { kind: 'catalog' },
      catalogKey: catalog.pubkey,
      policyKey: catalog.pubkey,
    });
    expect(event.content).not.toContain('friendly');
    expect(parsed && decryptPrivateConfig(parsed, assistant.secretKey)).toEqual({
      voice: 'friendly',
      instructions: 'never push',
      notes: 'margin is thin',
    });
    expect(parsed && decryptPrivateConfig(parsed, testKey().secretKey)).toBeUndefined();
    expect(parsed && assistantDisplayName(parsed)).toBe('Example Shop assistant');
  });

  it('builds through an outside encrypt (NIP-07) the same config, and the owner reads it back', async () => {
    const ownerEncrypt = async (plaintext: string, peer: string) =>
      nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(owner.secretKey, peer));
    const ownerDecrypt = async (ciphertext: string, peer: string) =>
      nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(owner.secretKey, peer));
    const input = {
      assistant: assistant.pubkey,
      origins: ['https://shop.example.com'],
      name: 'Example Shop',
      language: 'en',
      currency: 'USD',
      source: { kind: 'catalog' as const },
      catalogKey: catalog.pubkey,
      private: { voice: 'calm', instructions: '', notes: '' },
      createdAt: NOW - 100,
    };
    const peers: string[] = [];
    const viaSigner = sign(
      await buildConfigEventWith(input, async (plaintext, peer) => {
        peers.push(peer);
        return ownerEncrypt(plaintext, peer);
      }),
      owner,
    );
    expect(peers).toEqual([assistant.pubkey]);
    const direct = sign(buildConfigEvent(input, owner.secretKey), owner);
    expect(viaSigner.tags).toEqual(direct.tags);
    const parsed = parseConfig(viaSigner);
    expect(parsed && decryptPrivateConfig(parsed, assistant.secretKey)).toEqual(input.private);
    expect(parsed && (await decryptPrivateConfigWith(parsed, ownerDecrypt))).toEqual(input.private);
    const stranger = testKey();
    const strangerDecrypt = async (ciphertext: string, peer: string) =>
      nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(stranger.secretKey, peer));
    expect(parsed && (await decryptPrivateConfigWith(parsed, strangerDecrypt))).toBeUndefined();
    // A part that decrypts but is not a private config (wrong types) is refused too.
    expect(
      parsed && (await decryptPrivateConfigWith(parsed, async () => '{"voice":42}')),
    ).toBeUndefined();
    expect(
      parsed && (await decryptPrivateConfigWith(parsed, async () => 'not json')),
    ).toBeUndefined();
    // The same checks as the direct builder: a bad input never reaches the encrypt.
    await expect(
      buildConfigEventWith({ ...input, origins: ['http://shop.example.com'] }, ownerEncrypt),
    ).rejects.toThrow();
  });

  it('fails closed on a duplicated required tag', () => {
    const event = config();
    const tampered = { ...event, tags: [...event.tags, ['assistant', testKey().pubkey]] };
    expect(parseConfig(tampered)).toBeUndefined();
  });

  it('refuses an origin with a path', () => {
    expect(() => config({ origins: ['https://shop.example.com/path'] })).toThrow();
  });

  it('ties a connector source to its platform', () => {
    expect(() => config({ source: { kind: 'connector' } })).toThrow();
    const parsed = parseConfig(config({ source: { kind: 'connector', platform: 'shopify' } }));
    expect(parsed?.source).toEqual({ kind: 'connector', platform: 'shopify' });
  });

  it('carries the connected shop URL as a third source value, in canonical form', () => {
    const event = config({
      source: {
        kind: 'connector',
        platform: 'woocommerce',
        shopUrl: 'https://Shop.Example.com/shop/',
      },
    });
    expect(event.tags).toContainEqual([
      'source',
      'connector',
      'woocommerce',
      'https://shop.example.com/shop',
    ]);
    expect(parseConfig(event)?.source).toEqual({
      kind: 'connector',
      platform: 'woocommerce',
      shopUrl: 'https://shop.example.com/shop',
    });
    const root = parseConfig(
      config({
        source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://shop.example.com' },
      }),
    );
    expect(root?.source.shopUrl).toBe('https://shop.example.com');
  });

  it('refuses to build a shop URL off the origins, malformed, or on a non-connector source', () => {
    for (const shopUrl of [
      'https://other.example.com/shop',
      'http://shop.example.com',
      'https://user:pw@shop.example.com',
      'https://shop.example.com/?a=1',
      'https://shop.example.com/#x',
      'not a url',
    ]) {
      expect(() =>
        config({ source: { kind: 'connector', platform: 'shopify', shopUrl } }),
      ).toThrow();
    }
    expect(() =>
      config({ source: { kind: 'catalog', shopUrl: 'https://shop.example.com' } }),
    ).toThrow();
  });

  it('fails closed on a malformed or foreign shop URL in the source tag', () => {
    const event = config({ source: { kind: 'connector', platform: 'shopify' } });
    const withShop = (value: string[]) => ({
      ...event,
      tags: event.tags.map((tag) => (tag[0] === 'source' ? value : tag)),
    });
    for (const shopUrl of [
      'https://other.example.com',
      'http://shop.example.com',
      'https://shop.example.com/',
      'https://SHOP.example.com',
      'https://shop.example.com/a?b=1',
      'https://shop.example.com#a',
      'https://u@shop.example.com',
      'garbage',
      '',
    ]) {
      expect(parseConfig(withShop(['source', 'connector', 'shopify', shopUrl]))).toBeUndefined();
    }
    expect(
      parseConfig(
        withShop(['source', 'connector', 'shopify', 'https://shop.example.com', 'extra']),
      ),
    ).toBeUndefined();
    expect(
      parseConfig(withShop(['source', 'connector', 'shopify', 'https://shop.example.com/a']))
        ?.source.shopUrl,
    ).toBe('https://shop.example.com/a');
  });

  it('a google feed source names no shop URL: refused on build, voids the config on read', () => {
    expect(() =>
      config({
        source: { kind: 'connector', platform: 'google', shopUrl: 'https://shop.example.com' },
      }),
    ).toThrow('A google feed source names no shop URL');
    const event = config({ source: { kind: 'connector', platform: 'google' } });
    expect(parseConfig(event)?.source).toEqual({ kind: 'connector', platform: 'google' });
    const tampered = {
      ...event,
      tags: event.tags.map((tag) =>
        tag[0] === 'source' ? ['source', 'connector', 'google', 'https://shop.example.com'] : tag,
      ),
    };
    expect(parseConfig(tampered)).toBeUndefined();
  });

  it('normalizeShopUrl gives the canonical form or nothing', () => {
    expect(normalizeShopUrl('https://shop.example.com//')).toBe('https://shop.example.com');
    expect(normalizeShopUrl('https://shop.example.com:443/a/b/')).toBe(
      'https://shop.example.com/a/b',
    );
    expect(normalizeShopUrl('https://shop.example.com?')).toBeUndefined();
    for (const value of [
      'http://shop.example.com',
      'https://user:pw@shop.example.com',
      'https://user@shop.example.com',
      'https://shop.example.com/a?b=1',
      'https://shop.example.com/a#b',
      'not a url',
    ]) {
      expect(normalizeShopUrl(value)).toBeUndefined();
    }
    expect(normalizeShopUrl(`https://shop.example.com/${'a'.repeat(1100)}`)).toBeUndefined();
  });
});

describe('policies', () => {
  it('round-trips', () => {
    const policy = parsePolicy(
      sign(buildPolicyEvent({ slug: 'returns', title: 'Returns', body: '30 days.' }), catalog),
    );
    expect(policy).toMatchObject({ author: catalog.pubkey, slug: 'returns', body: '30 days.' });
  });

  it('refuses a bad slug', () => {
    expect(() => buildPolicyEvent({ slug: 'Bad Slug', title: 'X', body: 'y' })).toThrow();
  });
});

describe('catalog key authority', () => {
  it('grants a 30497 key; a key the owner authorized only with a 30490 holds nothing', () => {
    const catalogAuth = sign(
      buildCatalogAuth({ key: catalog.pubkey, mode: 'self-host', createdAt: NOW - 10 }),
      owner,
    );
    const store = testKey();
    const storeAuth = sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'self-host', createdAt: NOW - 10 }),
      owner,
    );
    const events = [catalogAuth, storeAuth];
    expect(isCatalogKey(events, owner.pubkey, catalog.pubkey, NOW)).toBe(true);
    expect(isCatalogKey(events, owner.pubkey, store.pubkey, NOW)).toBe(false);
    expect(readCatalogAuthority(events, owner.pubkey, NOW)).toEqual(new Set([catalog.pubkey]));
    expect(readCatalogAuthority([storeAuth], owner.pubkey, NOW).size).toBe(0);
    expect(isCatalogKey(events, testKey().pubkey, catalog.pubkey, NOW)).toBe(false);
  });

  it('ignores a 30497 signed by someone other than the owner', () => {
    const forged = sign(
      buildCatalogAuth({ key: catalog.pubkey, mode: 'self-host', createdAt: NOW - 10 }),
      catalog,
    );
    expect(isCatalogKey([forged], owner.pubkey, catalog.pubkey, NOW)).toBe(false);
    expect(readCatalogAuthority([forged], owner.pubkey, NOW).size).toBe(0);
  });

  it('a 30490 revocation does not revoke a catalog key, a catalog revocation does', () => {
    const grant = sign(
      buildCatalogAuth({ key: catalog.pubkey, mode: 'hosted', createdAt: NOW - 10 }),
      owner,
    );
    const storeRevoke = sign(buildStoreRevocationEvent(catalog.pubkey, NOW - 5), owner);
    expect(isCatalogKey([grant, storeRevoke], owner.pubkey, catalog.pubkey, NOW)).toBe(true);
    expect(readCatalogAuthority([grant, storeRevoke], owner.pubkey, NOW)).toEqual(
      new Set([catalog.pubkey]),
    );
    const revoke = sign(buildCatalogRevocation(catalog.pubkey, NOW - 5), owner);
    expect(isCatalogKey([grant, revoke], owner.pubkey, catalog.pubkey, NOW)).toBe(false);
    expect(readCatalogAuthority([grant, revoke], owner.pubkey, NOW).size).toBe(0);
  });

  it('resolves product and policy keys only while each is an authorized catalog key', () => {
    const parsed = parseConfig(config());
    const grant = sign(
      buildCatalogAuth({ key: catalog.pubkey, mode: 'self-host', createdAt: NOW - 10 }),
      owner,
    );
    expect(parsed && resolveStoreKeys(parsed, [grant], NOW)).toEqual({
      productKey: catalog.pubkey,
      policyKey: catalog.pubkey,
    });
    expect(parsed && resolveStoreKeys(parsed, [], NOW)).toEqual({});
    const policyOnly = testKey();
    const split = parseConfig(config({ catalogKey: policyOnly.pubkey, policyKey: catalog.pubkey }));
    expect(split && resolveStoreKeys(split, [grant], NOW)).toEqual({ policyKey: catalog.pubkey });
  });

  it('a key authorized only with a 30490 is never a product or policy key', () => {
    const store = testKey();
    const parsed = parseConfig(config({ catalogKey: store.pubkey, policyKey: store.pubkey }));
    const storeAuth = sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'hosted', createdAt: NOW - 10 }),
      owner,
    );
    expect(parsed && resolveStoreKeys(parsed, [storeAuth], NOW)).toEqual({});
  });
});

describe('a paycore product source is refused', () => {
  it('is not a product source', () => {
    expect(PRODUCT_SOURCES).toEqual(['catalog', 'admin', 'connector']);
    expect(PRODUCT_SOURCES.some((kind) => kind === 'paycore')).toBe(false);
  });

  it('a config naming it is not built', () => {
    expect(() => config({ source: { kind: 'paycore' }, policyKey: catalog.pubkey })).toThrow();
    expect(() => config({ source: { kind: 'paycore' } })).toThrow();
  });

  it('a signed config naming it reads as no config at all, without throwing', () => {
    const valid = config();
    expect(parseConfig(valid)).toBeDefined();
    for (const sourceTag of [
      ['source', 'paycore'],
      ['source', 'paycore', 'shopify'],
      ['source', 'PayCore'],
    ]) {
      const tags = valid.tags.map((tag) => (tag[0] === 'source' ? sourceTag : tag));
      const signed = sign({ ...valid, tags }, owner);
      expect(() => parseConfig(signed)).not.toThrow();
      expect(parseConfig(signed)).toBeUndefined();
    }
  });

  it('the schema refuses it', () => {
    const parsed = StoreConfigInputSchema.safeParse({
      assistant: assistant.pubkey,
      origins: ['https://shop.example.com'],
      name: 'Example Shop',
      language: 'en',
      currency: 'USD',
      source: { kind: 'paycore' },
      catalogKey: catalog.pubkey,
      policyKey: catalog.pubkey,
    });
    expect(parsed.success).toBe(false);
  });
});
