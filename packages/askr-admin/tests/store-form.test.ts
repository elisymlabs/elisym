import {
  buildConfigEvent,
  CONFIG_D_TAG,
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  decryptPrivateConfig,
  decryptPrivateConfigWith,
  parseConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { npubOf, secretKeySigner } from '../src/lib/signer';
import {
  EMPTY_FORM,
  FormError,
  type StoreForm,
  formOfConfig,
  signStoreEvents,
} from '../src/lib/store-form';

const ownerKey = generateSecretKey();
const owner = getPublicKey(ownerKey);
const signer = secretKeySigner(ownerKey);
const assistantKey = generateSecretKey();
const assistant = getPublicKey(assistantKey);
const serverKey = getPublicKey(generateSecretKey());
const merchantKey = getPublicKey(generateSecretKey());
const paycoreKey = getPublicKey(generateSecretKey());
const NOW = 1_800_000_000;

const BASE_FORM: StoreForm = {
  ...EMPTY_FORM,
  name: 'Tea Shop',
  language: 'en',
  currency: 'eur',
  origins: 'https://tea.example/\nhttps://www.tea.example',
  linkOrigins: '',
  greeting: 'Hi! Ask me about tea.',
  voice: 'warm',
  instructions: 'Recommend green tea first.',
  notes: 'Ships from Berlin.',
};

function tag(event: NostrEvent, name: string): string[] | undefined {
  return event.tags.find((entry) => entry[0] === name);
}

async function sign(
  form: StoreForm,
  extra: { previousCreatedAt?: number; authorized?: Set<string>; authCreatedAt?: number } = {},
) {
  return signStoreEvents({ form, keys: { assistant, serverKey }, signer, now: NOW, ...extra });
}

describe('the onboarding events', () => {
  it('admin source: the config names the server K for products and policies, and K is authorized hosted', async () => {
    const [config, auth, ...rest] = await sign({ ...BASE_FORM, source: 'admin' });
    expect(rest).toEqual([]);
    if (config === undefined || auth === undefined) {
      throw new Error('two events expected');
    }
    expect(config.kind).toBe(KIND_CONFIG);
    expect(config.pubkey).toBe(owner);
    expect(verifyEvent(config)).toBe(true);
    expect(tag(config, 'd')).toEqual(['d', CONFIG_D_TAG]);
    expect(tag(config, 'assistant')).toEqual(['assistant', assistant]);
    expect(tag(config, 'source')).toEqual(['source', 'admin']);
    expect(tag(config, 'catalog-key')).toEqual(['catalog-key', serverKey]);
    expect(tag(config, 'policy-key')).toEqual(['policy-key', serverKey]);
    expect(tag(config, 'currency')).toEqual(['currency', 'EUR']);
    expect(config.tags.filter((entry) => entry[0] === 'origin')).toEqual([
      ['origin', 'https://tea.example'],
      ['origin', 'https://www.tea.example'],
    ]);
    expect(config.created_at).toBe(NOW);

    expect(auth.kind).toBe(KIND_CATALOG_AUTH);
    expect(auth.pubkey).toBe(owner);
    expect(verifyEvent(auth)).toBe(true);
    expect(tag(auth, 'd')).toEqual(['d', serverKey]);
    expect(tag(auth, 'mode')).toEqual(['mode', 'hosted']);
  });

  it('seals the private part to the assistant, readable by A and by O', async () => {
    const [config] = await sign(BASE_FORM);
    const parsed = config === undefined ? undefined : parseConfig(config);
    if (parsed === undefined) {
      throw new Error('config does not parse');
    }
    const expected = {
      voice: 'warm',
      instructions: 'Recommend green tea first.',
      notes: 'Ships from Berlin.',
    };
    expect(decryptPrivateConfig(parsed, assistantKey)).toEqual(expected);
    expect(await decryptPrivateConfigWith(parsed, signer.decrypt)).toEqual(expected);
  });

  it('catalog source: the merchant K holds products and policies and is authorized self-host', async () => {
    const [config, auth] = await sign({
      ...BASE_FORM,
      source: 'catalog',
      merchantKey: npubOf(merchantKey),
    });
    if (config === undefined || auth === undefined) {
      throw new Error('two events expected');
    }
    expect(tag(config, 'source')).toEqual(['source', 'catalog']);
    expect(tag(config, 'catalog-key')).toEqual(['catalog-key', merchantKey]);
    expect(tag(config, 'policy-key')).toEqual(['policy-key', merchantKey]);
    expect(tag(auth, 'd')).toEqual(['d', merchantKey]);
    expect(tag(auth, 'mode')).toEqual(['mode', 'self-host']);
  });

  it('paycore source: S holds products, the server K policies, and only K is authorized here', async () => {
    const [config, auth] = await sign({ ...BASE_FORM, source: 'paycore', paycoreKey });
    if (config === undefined || auth === undefined) {
      throw new Error('two events expected');
    }
    expect(tag(config, 'source')).toEqual(['source', 'paycore']);
    expect(tag(config, 'catalog-key')).toEqual(['catalog-key', paycoreKey]);
    expect(tag(config, 'policy-key')).toEqual(['policy-key', serverKey]);
    expect(tag(auth, 'd')).toEqual(['d', serverKey]);
    expect(tag(auth, 'mode')).toEqual(['mode', 'hosted']);
  });

  it('connector source: the shop URL rides on the source tag, normalized, and the server K is hosted', async () => {
    const [config, auth] = await sign({
      ...BASE_FORM,
      source: 'connector',
      platform: 'woocommerce',
      shopUrl: 'https://tea.example/shop/',
    });
    if (config === undefined || auth === undefined) {
      throw new Error('two events expected');
    }
    expect(tag(config, 'source')).toEqual([
      'source',
      'connector',
      'woocommerce',
      'https://tea.example/shop',
    ]);
    expect(tag(config, 'catalog-key')).toEqual(['catalog-key', serverKey]);
    expect(parseConfig(config)?.source).toEqual({
      kind: 'connector',
      platform: 'woocommerce',
      shopUrl: 'https://tea.example/shop',
    });
    expect(tag(auth, 'mode')).toEqual(['mode', 'hosted']);
  });

  it('connector source: a shop off the allowed origins, or none, is refused before signing', async () => {
    await expect(
      sign({
        ...BASE_FORM,
        source: 'connector',
        platform: 'shopify',
        shopUrl: 'https://other.example',
      }),
    ).rejects.toThrow('add https://other.example to the allowed origins');
    await expect(
      sign({ ...BASE_FORM, source: 'connector', platform: 'shopify', shopUrl: '' }),
    ).rejects.toBeInstanceOf(FormError);
  });

  it('a Google feed names no shop URL', async () => {
    const [config] = await sign({
      ...BASE_FORM,
      source: 'connector',
      platform: 'google',
      shopUrl: 'https://tea.example',
    });
    expect(config === undefined ? undefined : tag(config, 'source')).toEqual([
      'source',
      'connector',
      'google',
    ]);
  });

  it('refuses a form without origins or with a bad key in plain words', async () => {
    await expect(sign({ ...BASE_FORM, origins: '' })).rejects.toThrow('Allowed origins');
    await expect(sign({ ...BASE_FORM, origins: 'http://tea.example' })).rejects.toThrow(
      'must start with https://',
    );
    await expect(sign({ ...BASE_FORM, source: 'catalog', merchantKey: 'nope' })).rejects.toThrow(
      'Merchant catalog key',
    );
    await expect(sign({ ...BASE_FORM, name: '' })).rejects.toThrow('Store name');
  });

  it('a later save is dated after the stored config and skips an authorization already in force', async () => {
    const events = await sign(BASE_FORM, {
      previousCreatedAt: NOW + 30,
      authorized: new Set([serverKey]),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.created_at).toBe(NOW + 31);
  });

  it('reads a published config back into the same form', async () => {
    const form: StoreForm = {
      ...BASE_FORM,
      currency: 'EUR',
      origins: 'https://tea.example\nhttps://www.tea.example',
      displayName: 'Tea helper',
      avatar: 'https://tea.example/a.png',
      contact: 'https://tea.example/contact',
      source: 'catalog',
      merchantKey: npubOf(merchantKey),
    };
    const [config] = await sign(form);
    const parsed = config === undefined ? undefined : parseConfig(config);
    if (parsed === undefined) {
      throw new Error('config does not parse');
    }
    const privatePart = await decryptPrivateConfigWith(parsed, signer.decrypt);
    expect(formOfConfig(parsed, privatePart)).toEqual({
      ...form,
      keptPolicy: { source: 'catalog', catalogKey: merchantKey, policyKey: merchantKey },
    });
  });

  it('keeps a non-default policy key through a read and a save, while the source stays', async () => {
    // A Pay Core store reading its policies from a merchant K, not the server K default.
    const event = finalizeEvent(
      buildConfigEvent(
        {
          assistant,
          origins: ['https://tea.example'],
          name: 'Tea Shop',
          language: 'en',
          currency: 'EUR',
          source: { kind: 'paycore' },
          catalogKey: paycoreKey,
          policyKey: merchantKey,
        },
        ownerKey,
      ),
      ownerKey,
    );
    const parsed = parseConfig(event);
    if (parsed === undefined) {
      throw new Error('config does not parse');
    }
    const form = formOfConfig(parsed, { voice: '', instructions: '', notes: '' });
    const [saved] = await sign({ ...form, greeting: 'Hello' });
    expect(saved === undefined ? undefined : tag(saved, 'policy-key')).toEqual([
      'policy-key',
      merchantKey,
    ]);
    const [moved] = await sign({ ...form, source: 'admin' });
    expect(moved === undefined ? undefined : tag(moved, 'policy-key')).toEqual([
      'policy-key',
      serverKey,
    ]);
  });

  it('moves policies to the default key when the source changes, even onto the same key', async () => {
    // An admin store reading policies from a merchant K; admin and connector both use the server K.
    const event = finalizeEvent(
      buildConfigEvent(
        {
          assistant,
          origins: ['https://tea.example'],
          name: 'Tea Shop',
          language: 'en',
          currency: 'EUR',
          source: { kind: 'admin' },
          catalogKey: serverKey,
          policyKey: merchantKey,
        },
        ownerKey,
      ),
      ownerKey,
    );
    const parsed = parseConfig(event);
    if (parsed === undefined) {
      throw new Error('config does not parse');
    }
    const form = formOfConfig(parsed, { voice: '', instructions: '', notes: '' });
    const [kept] = await sign(form);
    expect(kept === undefined ? undefined : tag(kept, 'policy-key')).toEqual([
      'policy-key',
      merchantKey,
    ]);
    const [moved] = await sign({ ...form, source: 'connector', platform: 'google' });
    expect(moved === undefined ? undefined : tag(moved, 'policy-key')).toEqual([
      'policy-key',
      serverKey,
    ]);
  });

  it('dates the authorization it signs with the date it is given', async () => {
    const [, auth] = await sign(BASE_FORM, { authCreatedAt: NOW + 77 });
    expect(auth?.created_at).toBe(NOW + 77);
  });
});
