import { createHmac } from 'node:crypto';
import {
  KIND_CONFIG,
  LIMITS,
  buildConfigDelegation,
  buildConfigDelegationRevocation,
  buildConfigEvent,
  parseConfig,
} from '@elisym/askr';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { shopifyFromEnv } from '../src/config';
import { mapShopifyProduct, parseShopifyPage } from '../src/connectors/shopify';
import { KeyVault } from '../src/db/keys';
import { productsFromBulk } from '../src/shopify/admin-catalog';
import { SESSION_TOKEN_SKEW_SECS, checkSessionToken, webhookSigned } from '../src/shopify/auth';
import {
  configLanguage,
  configName,
  delegateConfigTime,
  delegateInCharge,
  newestConfigAt,
  signDelegateConfig,
} from '../src/shopify/delegate-config';
import { MASTER_KEY, NOW } from './fixtures';
import { API_KEY, API_SECRET, SHOP, sessionToken } from './shopify-fixtures';

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: API_KEY,
    sub: '42',
    exp: NOW + 60,
    nbf: NOW - 1,
    iat: NOW - 1,
    jti: 'id',
    ...overrides,
  };
}

function check(token: string, now = NOW) {
  return checkSessionToken({
    header: `Bearer ${token}`,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    now,
  });
}

describe('Shopify session tokens (askr-shopify 3.2)', () => {
  it('accepts a valid token and names its shop', () => {
    expect(check(sessionToken(claims()))).toEqual({ ok: true, shop: SHOP, sub: '42' });
  });

  it('refuses a missing, malformed or wrongly signed token', () => {
    expect(
      checkSessionToken({ header: null, apiKey: API_KEY, apiSecret: API_SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: 'missing' });
    expect(
      checkSessionToken({ header: 'Bearer x.y', apiKey: API_KEY, apiSecret: API_SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(check(sessionToken(claims(), 'other-secret')).ok).toBe(false);
    expect(check(sessionToken(claims(), API_SECRET, { alg: 'none' }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('checks the audience', () => {
    expect(check(sessionToken(claims({ aud: 'other' })))).toEqual({
      ok: false,
      reason: 'audience',
    });
    expect(check(sessionToken(claims({ aud: [API_KEY] }))).ok).toBe(true);
  });

  it('allows exactly the skew on exp and nbf', () => {
    const token = sessionToken(claims({ exp: NOW, nbf: NOW }));
    expect(check(token, NOW + SESSION_TOKEN_SKEW_SECS).ok).toBe(true);
    expect(check(token, NOW + SESSION_TOKEN_SKEW_SECS + 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(check(token, NOW - SESSION_TOKEN_SKEW_SECS).ok).toBe(true);
    expect(check(token, NOW - SESSION_TOKEN_SKEW_SECS - 1)).toEqual({ ok: false, reason: 'early' });
    expect(check(sessionToken(claims({ exp: 'soon' })))).toEqual({ ok: false, reason: 'expired' });
  });

  it('needs iss and dest on one myshopify host', () => {
    expect(check(sessionToken(claims({ iss: 'https://other.myshopify.com/admin' })))).toEqual({
      ok: false,
      reason: 'shop',
    });
    expect(
      check(
        sessionToken(
          claims({ iss: 'https://shop.example.com/admin', dest: 'https://shop.example.com' }),
        ),
      ),
    ).toEqual({ ok: false, reason: 'shop' });
    expect(
      check(sessionToken(claims({ iss: `http://${SHOP}/admin`, dest: `http://${SHOP}` }))),
    ).toEqual({ ok: false, reason: 'shop' });
  });
});

describe('Shopify webhook signatures (askr-shopify 3.2)', () => {
  it('accepts the base64 HMAC of the raw body and nothing else', () => {
    const body = Buffer.from('{"id":1}');
    const good = createHmac('sha256', API_SECRET).update(body).digest('base64');
    expect(webhookSigned(body, good, API_SECRET)).toBe(true);
    expect(webhookSigned(Buffer.from('{"id":2}'), good, API_SECRET)).toBe(false);
    expect(webhookSigned(body, good, 'other')).toBe(false);
    expect(webhookSigned(body, null, API_SECRET)).toBe(false);
    expect(webhookSigned(body, 'x'.repeat(200), API_SECRET)).toBe(false);
  });
});

describe('Shopify settings from the environment (askr-shopify 3)', () => {
  const files: Record<string, string> = { '/secret': 'shh\n', '/partner': 'ptok', '/empty': '' };
  const read = (path: string) => files[path] ?? '';

  it('is off with none set and on with all three', () => {
    expect(shopifyFromEnv({}, read)).toBeUndefined();
    expect(
      shopifyFromEnv(
        {
          ASKR_SHOPIFY_API_KEY: 'key',
          ASKR_SHOPIFY_API_SECRET_FILE: '/secret',
          ASKR_SHOPIFY_PARTNER_TOKEN_FILE: '/partner',
        },
        read,
      ),
    ).toEqual({ apiKey: 'key', apiSecret: 'shh', partnerToken: 'ptok' });
  });

  it('refuses to start on a partial setting or an empty file', () => {
    expect(() => shopifyFromEnv({ ASKR_SHOPIFY_API_KEY: 'key' }, read)).toThrow(/needs all/);
    expect(() =>
      shopifyFromEnv(
        {
          ASKR_SHOPIFY_API_KEY: 'key',
          ASKR_SHOPIFY_API_SECRET_FILE: '/empty',
          ASKR_SHOPIFY_PARTNER_TOKEN_FILE: '/partner',
        },
        read,
      ),
    ).toThrow(/empty/);
    expect(() =>
      shopifyFromEnv(
        {
          ASKR_SHOPIFY_API_KEY: 'key',
          ASKR_SHOPIFY_API_SECRET_FILE: '/secret',
          ASKR_SHOPIFY_PARTNER_TOKEN_FILE: '/empty',
        },
        read,
      ),
    ).toThrow(/empty/);
  });
});

describe('sealed texts (askr-shopify 3.1)', () => {
  it('opens only with the same context and purpose', () => {
    const vault = new KeyVault(MASTER_KEY);
    const sealed = vault.sealText('shpat_123', SHOP, 'shopify-access');
    expect(vault.openText(sealed, SHOP, 'shopify-access')).toBe('shpat_123');
    expect(() => vault.openText(sealed, 'other.myshopify.com', 'shopify-access')).toThrow();
    expect(() => vault.openText(sealed, SHOP, 'shopify-refresh')).toThrow();
    expect(() => vault.sealText('', SHOP, 'shopify-access')).toThrow();
  });
});

describe('the first delegate config (askr-shopify 3.3)', () => {
  it('cuts a long shop name by whole code points within the title limit', () => {
    const astral = '\u{1F375}';
    const name = `${'a'.repeat(LIMITS.TITLE_CHARS - 1)}${astral}tail`;
    const cut = configName(name);
    expect(cut).toBe('a'.repeat(LIMITS.TITLE_CHARS - 1));
    expect(cut.length).toBeLessThanOrEqual(LIMITS.TITLE_CHARS);
    expect(configName('   ')).toBe('Shop');
    expect(configName(`${astral} Tea`)).toBe(`${astral} Tea`);
  });

  it('maps a locale to a config language, falling back to en', () => {
    expect(configLanguage('pt-BR')).toBe('pt-BR');
    expect(configLanguage('zh_CN')).toBe('zh');
    expect(configLanguage('x')).toBe('en');
    expect(configLanguage(undefined)).toBe('en');
    expect(configLanguage(`en-${'abcdefgh-'.repeat(5)}x`)).toBe('en');
  });

  it('signs a config every reader parses, with an unusual locale and a long name', () => {
    const delegateSecret = generateSecretKey();
    const assistant = getPublicKey(generateSecretKey());
    const catalogKey = getPublicKey(generateSecretKey());
    const event = signDelegateConfig({
      settings: {
        origins: ['https://tea.example', `https://${SHOP}`],
        linkOrigins: [],
        name: configName(`${'b'.repeat(79)}\u{1F375}`),
        language: configLanguage('sr-Latn-RS'),
        currency: 'EUR',
      },
      keys: { assistant, catalogKey },
      shopUrl: 'https://tea.example',
      createdAt: NOW,
      delegateSecret,
    });
    const owner = getPublicKey(generateSecretKey());
    const config = parseConfig(event, { owner });
    expect(config?.signer).toBe(getPublicKey(delegateSecret));
    expect(config?.source).toEqual({
      kind: 'connector',
      platform: 'shopify',
      shopUrl: 'https://tea.example',
    });
    expect(config?.assistant).toBe(assistant);
    expect(config?.catalogKey).toBe(catalogKey);
    expect(config?.language).toBe('sr-Latn-RS');
  });
});

describe('delegate timing and standing (askr-shopify 3.4)', () => {
  const ownerSecret = generateSecretKey();
  const owner = getPublicKey(ownerSecret);
  const delegate = getPublicKey(generateSecretKey());
  const ownerConfig = (createdAt: number) =>
    finalizeEvent(
      buildConfigEvent(
        {
          assistant: getPublicKey(generateSecretKey()),
          origins: ['https://tea.example'],
          name: 'Tea',
          language: 'en',
          currency: 'USD',
          source: { kind: 'catalog' },
          catalogKey: getPublicKey(generateSecretKey()),
          createdAt,
        },
        ownerSecret,
      ),
      ownerSecret,
    );
  const grant = (createdAt: number) =>
    finalizeEvent(buildConfigDelegation({ key: delegate, createdAt }), ownerSecret);

  it('dates a new config after every stored one, within 60 s of now', () => {
    expect(delegateConfigTime([], NOW)).toBe(NOW);
    expect(delegateConfigTime([ownerConfig(NOW - 5)], NOW)).toBe(NOW);
    expect(delegateConfigTime([ownerConfig(NOW)], NOW)).toBe(NOW + 1);
    expect(delegateConfigTime([ownerConfig(NOW + 59)], NOW)).toBe(NOW + 60);
    expect(delegateConfigTime([ownerConfig(NOW + 60)], NOW)).toBeUndefined();
    expect(newestConfigAt([grant(NOW + 100)])).toBeUndefined();
  });

  it('puts D in charge only while active and granted after the owner newest config', () => {
    expect(delegateInCharge([grant(NOW - 10)], owner, delegate, true, NOW)).toBe(true);
    expect(delegateInCharge([grant(NOW - 10)], owner, delegate, false, NOW)).toBe(false);
    expect(
      delegateInCharge([grant(NOW - 10), ownerConfig(NOW - 10)], owner, delegate, true, NOW),
    ).toBe(false);
    expect(
      delegateInCharge([grant(NOW - 10), ownerConfig(NOW - 11)], owner, delegate, true, NOW),
    ).toBe(true);
    const revoked = finalizeEvent(buildConfigDelegationRevocation(delegate, NOW - 5), ownerSecret);
    expect(delegateInCharge([grant(NOW - 10), revoked], owner, delegate, true, NOW)).toBe(false);
    expect(delegateInCharge([], owner, delegate, true, NOW)).toBe(false);
    expect(KIND_CONFIG).toBe(30496);
  });
});

describe('the Admin API bulk catalog (askr-shopify 3.5)', () => {
  const lines = [
    {
      id: 'gid://shopify/Product/11',
      legacyResourceId: '11',
      title: 'Green tea',
      handle: 'green-tea',
      descriptionHtml: '<p>Fresh</p>',
      vendor: 'Leaf',
      productType: 'Tea',
      tags: ['green', 'Discount Codes: Allow'],
      onlineStoreUrl: 'https://tea.example/products/green-tea',
      options: [{ name: 'Size', optionValues: [{ name: '50g' }, { name: '100g' }] }],
    },
    {
      id: 'gid://shopify/MediaImage/1',
      image: { url: 'https://cdn.example/1.jpg' },
      __parentId: 'gid://shopify/Product/11',
    },
    {
      id: 'gid://shopify/ProductVariant/21',
      legacyResourceId: '21',
      sku: 'G50',
      price: '5.00',
      availableForSale: true,
      selectedOptions: [{ name: 'Size', value: '50g' }],
      __parentId: 'gid://shopify/Product/11',
    },
    {
      id: 'gid://shopify/ProductVariant/22',
      legacyResourceId: '22',
      sku: null,
      price: '9.50',
      availableForSale: false,
      selectedOptions: [{ name: 'Size', value: '100g' }],
      __parentId: 'gid://shopify/Product/11',
    },
    {
      id: 'gid://shopify/Product/12',
      legacyResourceId: '12',
      title: 'Draft only',
      handle: 'draft',
      onlineStoreUrl: null,
      options: [],
    },
    { something: 'else' },
  ];
  const jsonl = lines.map((line) => JSON.stringify(line)).join('\n');

  it('keeps Online Store products and maps them as the public reader does', () => {
    const { products, malformed } = productsFromBulk(jsonl);
    expect(malformed).toBe(1);
    expect(products.map((product) => product.id)).toEqual(['11']);
    const publicPage = parseShopifyPage({
      products: [
        {
          id: 11,
          title: 'Green tea',
          handle: 'green-tea',
          body_html: '<p>Fresh</p>',
          vendor: 'Leaf',
          product_type: 'Tea',
          tags: ['green', 'Discount Codes: Allow'],
          variants: [
            {
              id: 21,
              option1: '50g',
              option2: null,
              option3: null,
              sku: 'G50',
              available: true,
              price: '5.00',
            },
            {
              id: 22,
              option1: '100g',
              option2: null,
              option3: null,
              sku: null,
              available: false,
              price: '9.50',
            },
          ],
          images: [{ src: 'https://cdn.example/1.jpg' }],
          options: [{ name: 'Size', values: ['50g', '100g'] }],
        },
      ],
    });
    const shop = { origin: 'https://tea.example', currency: 'EUR' };
    const [fromAdmin] = products;
    const [fromPublic] = publicPage?.products ?? [];
    if (fromAdmin === undefined || fromPublic === undefined) {
      throw new Error('missing product');
    }
    expect(mapShopifyProduct(fromAdmin, shop)).toEqual(mapShopifyProduct(fromPublic, shop));
  });

  it('counts an orphan variant as malformed and throws on a line that is no JSON', () => {
    const orphan = JSON.stringify({
      id: 'gid://shopify/ProductVariant/9',
      legacyResourceId: '9',
      price: '1',
      availableForSale: true,
      selectedOptions: [],
      __parentId: 'gid://shopify/Product/404',
    });
    expect(productsFromBulk(orphan).malformed).toBe(1);
    expect(() => productsFromBulk('{not json')).toThrow();
  });
});
