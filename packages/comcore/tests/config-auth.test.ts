import { buildStoreAuthEvent, buildStoreRevocationEvent } from '@elisym/commerce';
import { describe, expect, it } from 'vitest';
import {
  buildCatalogAuth,
  buildCatalogRevocation,
  catalogKeyRole,
  resolveStoreKeys,
} from '../src/events/catalog-auth';
import {
  assistantDisplayName,
  buildConfigEvent,
  decryptPrivateConfig,
  parseConfig,
} from '../src/events/config';
import { buildPolicyEvent, parsePolicy } from '../src/events/policy';
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
  it('grants catalog to a 30497 key and paycore to a 30490 key, never mixed', () => {
    const catalogAuth = sign(
      buildCatalogAuth({ key: catalog.pubkey, mode: 'self-host', createdAt: NOW - 10 }),
      owner,
    );
    const store = testKey();
    const payCoreAuth = sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'self-host', createdAt: NOW - 10 }),
      owner,
    );
    const events = [catalogAuth, payCoreAuth];
    expect(catalogKeyRole(events, owner.pubkey, catalog.pubkey, NOW)).toBe('catalog');
    expect(catalogKeyRole(events, owner.pubkey, store.pubkey, NOW)).toBe('paycore');
    expect(catalogKeyRole(events, testKey().pubkey, catalog.pubkey, NOW)).toBeUndefined();
  });

  it('ignores a 30497 signed by someone other than the owner', () => {
    const forged = sign(
      buildCatalogAuth({ key: catalog.pubkey, mode: 'self-host', createdAt: NOW - 10 }),
      catalog,
    );
    expect(catalogKeyRole([forged], owner.pubkey, catalog.pubkey, NOW)).toBeUndefined();
  });

  it('a Pay Core revocation does not revoke a catalog key, a catalog revocation does', () => {
    const grant = sign(
      buildCatalogAuth({ key: catalog.pubkey, mode: 'hosted', createdAt: NOW - 10 }),
      owner,
    );
    const payCoreRevoke = sign(buildStoreRevocationEvent(catalog.pubkey, NOW - 5), owner);
    expect(catalogKeyRole([grant, payCoreRevoke], owner.pubkey, catalog.pubkey, NOW)).toBe(
      'catalog',
    );
    const revoke = sign(buildCatalogRevocation(catalog.pubkey, NOW - 5), owner);
    expect(catalogKeyRole([grant, revoke], owner.pubkey, catalog.pubkey, NOW)).toBeUndefined();
  });

  it('resolves product and policy keys by the role the source needs', () => {
    const parsed = parseConfig(config());
    const grant = sign(
      buildCatalogAuth({ key: catalog.pubkey, mode: 'self-host', createdAt: NOW - 10 }),
      owner,
    );
    expect(parsed && resolveStoreKeys(parsed, [grant], NOW)).toEqual({
      productKey: catalog.pubkey,
      productRole: 'catalog',
      policyKey: catalog.pubkey,
    });
    expect(parsed && resolveStoreKeys(parsed, [], NOW)).toEqual({});
  });

  it('takes a paycore source only from a 30490 key', () => {
    const store = testKey();
    const parsed = parseConfig(
      config({ source: { kind: 'paycore' }, catalogKey: store.pubkey, policyKey: catalog.pubkey }),
    );
    const payCoreAuth = sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'hosted', createdAt: NOW - 10 }),
      owner,
    );
    const catalogGrant = sign(
      buildCatalogAuth({ key: catalog.pubkey, mode: 'hosted', createdAt: NOW - 10 }),
      owner,
    );
    expect(parsed && resolveStoreKeys(parsed, [payCoreAuth, catalogGrant], NOW)).toEqual({
      productKey: store.pubkey,
      productRole: 'paycore',
      policyKey: catalog.pubkey,
    });
  });
});
