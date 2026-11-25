import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  type StoreConfig,
  buildCatalogAuth,
  buildConfigEvent,
  parseConfig,
} from '@elisym/askr';
import {
  KIND_DELETION,
  KIND_STORE_AUTH,
  buildProductEvent,
  buildStoreAuthEvent,
  buildStoreProfileEvent,
  buildStoreRevocationEvent,
} from '@elisym/commerce';
import type { EventTemplate, Filter, NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogKeys } from '../src/components/CatalogKeys';
import { EmbedSection } from '../src/components/EmbedSection';
import { Onboarding } from '../src/components/Onboarding';
import { RotateAssistant } from '../src/components/RotateAssistant';
import { SettingsSection } from '../src/components/SettingsSection';
import { Shell } from '../src/components/Shell';
import { StoreFields } from '../src/components/StoreFields';
import type { SessionDeps } from '../src/lib/deps';
import { cspSources } from '../src/lib/embed';
import {
  CHECKOUT_V4_INTEGRITY,
  CHECKOUT_V4_SNIPPET,
  CHECKOUT_V4_SRC,
  PAYCORE_ONBOARDING_URL,
  detectPayCore,
  discoveredStore,
  hasPayCoreLayout,
  payCoreStoresOf,
  readPayCoreStores,
} from '../src/lib/paycore';
import type { RelayReader } from '../src/lib/relay';
import { npubOf, secretKeySigner } from '../src/lib/signer';
import { countListed } from '../src/lib/store-data';
import {
  EMPTY_FORM,
  FormError,
  type PayCoreLink,
  type StoreForm,
  authorizationsOf,
  configInputOf,
  formOfConfig,
  signStoreEvents,
  withPayCore,
} from '../src/lib/store-form';
import { type PayCoreChoices, usePayCoreChoices } from '../src/lib/use-paycore-choices';
import {
  ASSISTANT,
  NOW,
  OWNER,
  OWNER_KEY,
  SERVER_KEY,
  fakeApi,
  fakeReader,
  sessionDeps,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, byId, chooseOption, click, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const STORE_KEY = generateSecretKey();
const STORE = getPublicKey(STORE_KEY);
const OTHER_STORE_KEY = generateSecretKey();
const OTHER_STORE = getPublicKey(OTHER_STORE_KEY);
const STRANGER_KEY = generateSecretKey();
const PRIVATE_PART = { voice: 'calm', instructions: 'Sell courses.', notes: '' };
const DEVNET_USDC =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

function owned(template: Omit<EventTemplate, 'created_at'>, createdAt: number): NostrEvent {
  return finalizeEvent({ ...template, created_at: createdAt }, OWNER_KEY);
}

function hosted(store = STORE, createdAt = NOW - 100, expiresAt?: number): NostrEvent {
  return owned(
    buildStoreAuthEvent({
      storePubkey: store,
      mode: 'hosted',
      operator: 'elisym.network',
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }),
    createdAt,
  );
}

function selfHost(store = STORE, createdAt = NOW - 100): NostrEvent {
  return owned(buildStoreAuthEvent({ storePubkey: store, mode: 'self-host' }), createdAt);
}

function revoked(store = STORE, createdAt = NOW - 50): NostrEvent {
  return owned(buildStoreRevocationEvent(store), createdAt);
}

function profile(key: Uint8Array, name: string): NostrEvent {
  return finalizeEvent(
    { ...buildStoreProfileEvent({ name, ownerPubkey: OWNER }), created_at: NOW - 200 },
    key,
  );
}

/** Both 30497s a PayCore store's config needs: S mirroring its 30490, and the server K. */
function bothCatalogAuths(): NostrEvent[] {
  return [
    owned(buildCatalogAuth({ key: STORE, mode: 'hosted', operator: 'elisym.network' }), NOW - 90),
    owned(buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }), NOW - 90),
  ];
}

function payCoreConfigEvent(currency = 'USD'): NostrEvent {
  return finalizeEvent(
    {
      ...buildConfigEvent(
        {
          assistant: ASSISTANT,
          origins: ['https://course.example'],
          name: 'Course Shop',
          language: 'en',
          currency,
          source: { kind: 'catalog' },
          catalogKey: STORE,
          policyKey: SERVER_KEY,
          private: PRIVATE_PART,
        },
        OWNER_KEY,
      ),
      created_at: NOW - 80,
    },
    OWNER_KEY,
  );
}

function configOf(event: NostrEvent): StoreConfig {
  const config = parseConfig(event);
  if (config === undefined) {
    throw new Error('config does not parse');
  }
  return config;
}

function modeOf(event: NostrEvent): string[] | undefined {
  return event.tags.find((tag) => tag[0] === 'mode');
}

function dOf(event: NostrEvent): string | undefined {
  return event.tags.find((tag) => tag[0] === 'd')?.[1];
}

const KEYS = { assistant: ASSISTANT, serverKey: SERVER_KEY };

/** A kind 0 with the name exactly as given (the builder may tidy it). */
function rawProfile(key: Uint8Array, name: string): NostrEvent {
  return finalizeEvent(
    { kind: 0, created_at: NOW - 200, tags: [], content: JSON.stringify({ name }) },
    key,
  );
}

/** A 30490 with the tags exactly as given. */
function rawStoreAuth(tags: string[][], createdAt: number): NostrEvent {
  return owned({ kind: KIND_STORE_AUTH, content: '', tags }, createdAt);
}

function deletionOf(store: string, createdAt: number): NostrEvent {
  return owned(
    { kind: KIND_DELETION, content: '', tags: [['a', `${KIND_STORE_AUTH}:${OWNER}:${store}`]] },
    createdAt,
  );
}

/**
 * A relay whose reads matching `gated` pass, fail or wait, as set; every
 * other read answers from `events` at once.
 */
function scriptedReader(events: readonly NostrEvent[], gated: (filter: Filter) => boolean) {
  const base = fakeReader(events);
  let mode: 'pass' | 'fail' | 'hold' = 'pass';
  const waiting: (() => void)[] = [];
  const reader: RelayReader = {
    query: async (filter) => {
      if (gated(filter)) {
        if (mode === 'fail') {
          throw new Error('The relay did not answer the whole read');
        }
        if (mode === 'hold') {
          // Set again while the read waited (`failHeld`).
          const after: string = await new Promise<string>((resolve) =>
            waiting.push(() => resolve(mode)),
          );
          if (after === 'fail') {
            throw new Error('The relay did not answer the whole read');
          }
        }
      }
      return base.query(filter);
    },
  };
  return {
    reader,
    set: (next: 'pass' | 'fail' | 'hold') => {
      mode = next;
    },
    release: () => {
      mode = 'pass';
      for (const resume of waiting.splice(0)) {
        resume();
      }
    },
    /** End the held reads with a failure. */
    failHeld: () => {
      mode = 'fail';
      for (const resume of waiting.splice(0)) {
        resume();
      }
    },
  };
}

/** The authority read (30497s, 30490s and kind 5s), not the PayCore choices read. */
function isAuthorityRead(filter: Filter): boolean {
  return filter.kinds?.includes(KIND_CATALOG_AUTH) === true;
}

/** The PayCore choices read (30490s and kind 5s only). */
function isChoicesRead(filter: Filter): boolean {
  return (
    filter.kinds?.includes(KIND_STORE_AUTH) === true &&
    filter.kinds.includes(KIND_CATALOG_AUTH) !== true
  );
}

const PAYCORE_FORM: StoreForm = {
  ...EMPTY_FORM,
  name: 'Course Shop',
  language: 'en',
  currency: 'USD',
  origins: 'https://course.example',
  source: 'paycore',
  payCore: { key: STORE, active: true, mode: 'hosted', operator: 'elisym.network' },
};

describe('payCoreStoresOf', () => {
  it('lists every store key the owner signed a 30490 for, newest first, with its mode', () => {
    const stores = payCoreStoresOf(
      [hosted(STORE, NOW - 100), selfHost(OTHER_STORE, NOW - 10)],
      OWNER,
      NOW,
    );
    expect(stores).toEqual([
      { key: OTHER_STORE, active: true, mode: 'self-host', newestAt: NOW - 10 },
      { key: STORE, active: true, mode: 'hosted', operator: 'elisym.network', newestAt: NOW - 100 },
    ]);
  });

  it('a revoked, expired or deleted one is inactive and keeps the mode it was granted with', () => {
    const [revokedStore] = payCoreStoresOf([hosted(), revoked()], OWNER, NOW);
    expect(revokedStore).toEqual({
      key: STORE,
      active: false,
      mode: 'hosted',
      operator: 'elisym.network',
      newestAt: NOW - 50,
    });
    const [expired] = payCoreStoresOf([hosted(STORE, NOW - 100, NOW - 1)], OWNER, NOW);
    expect(expired?.active).toBe(false);
    expect(expired?.mode).toBe('hosted');
    const deletion = owned(
      { kind: KIND_DELETION, content: '', tags: [['a', `${KIND_STORE_AUTH}:${OWNER}:${STORE}`]] },
      NOW - 40,
    );
    const [deleted] = payCoreStoresOf([selfHost(), deletion], OWNER, NOW);
    expect(deleted?.active).toBe(false);
    expect(deleted?.mode).toBe('self-host');
  });

  it('a store with only revocations has no mode; a re-authorization is active again', () => {
    const [onlyRevoked] = payCoreStoresOf([revoked()], OWNER, NOW);
    expect(onlyRevoked).toEqual({ key: STORE, active: false, newestAt: NOW - 50 });
    const [again] = payCoreStoresOf([hosted(), revoked(), selfHost(STORE, NOW - 10)], OWNER, NOW);
    expect(again).toEqual({ key: STORE, active: true, mode: 'self-host', newestAt: NOW - 10 });
  });

  it("ignores another author's 30490, a forged one, and other kinds", () => {
    const foreign = finalizeEvent(
      { ...buildStoreAuthEvent({ storePubkey: STORE, mode: 'hosted' }), created_at: NOW - 10 },
      STRANGER_KEY,
    );
    const real = hosted(OTHER_STORE);
    const forged = { ...real, tags: real.tags.map((tag) => (tag[0] === 'd' ? ['d', STORE] : tag)) };
    const catalogAuth = owned(buildCatalogAuth({ key: STORE, mode: 'self-host' }), NOW - 10);
    expect(payCoreStoresOf([foreign, forged, catalogAuth], OWNER, NOW)).toEqual([]);
  });
});

describe('discovery and detection', () => {
  it('discovers the newest store whose authorization is active', () => {
    const stores = payCoreStoresOf(
      [hosted(STORE, NOW - 100), hosted(OTHER_STORE, NOW - 30), revoked(OTHER_STORE, NOW - 20)],
      OWNER,
      NOW,
    );
    expect(discoveredStore(stores)?.key).toBe(STORE);
    expect(discoveredStore([])).toBeUndefined();
  });

  it('a catalog of another key with the policies on the server key is a PayCore store only with a 30490 for that key', () => {
    const config = configOf(payCoreConfigEvent());
    expect(hasPayCoreLayout(config, SERVER_KEY)).toBe(true);
    const stores = payCoreStoresOf([hosted()], OWNER, NOW);
    expect(detectPayCore(config, SERVER_KEY, stores)?.key).toBe(STORE);
    expect(detectPayCore(config, SERVER_KEY, [])).toBeUndefined();
    expect(
      detectPayCore(config, SERVER_KEY, payCoreStoresOf([hosted(OTHER_STORE)], OWNER, NOW)),
    ).toBeUndefined();
    expect(detectPayCore({ ...config, policyKey: STORE }, SERVER_KEY, stores)).toBeUndefined();
    expect(
      detectPayCore({ ...config, source: { kind: 'admin' } }, SERVER_KEY, stores),
    ).toBeUndefined();
    expect(
      detectPayCore({ ...config, catalogKey: SERVER_KEY }, SERVER_KEY, [
        ...stores,
        { key: SERVER_KEY, active: true, newestAt: NOW },
      ]),
    ).toBeUndefined();
  });

  it("reads the stores with their names, from each store key's kind 0; a failed name read leaves them out", async () => {
    const events = [hosted(), profile(STORE_KEY, 'Course Shop'), profile(STRANGER_KEY, 'Fake')];
    const stores = await readPayCoreStores(fakeReader(events), OWNER, NOW);
    expect(stores.map((store) => [store.key, store.name])).toEqual([[STORE, 'Course Shop']]);
    const reader = fakeReader([hosted()]);
    const noNames = await readPayCoreStores(
      {
        query: async (filter) => {
          if (filter.kinds?.includes(0) === true) {
            throw new Error('down');
          }
          return reader.query(filter);
        },
      },
      OWNER,
      NOW,
    );
    expect(noNames).toEqual([
      { key: STORE, active: true, mode: 'hosted', operator: 'elisym.network', newestAt: NOW - 100 },
    ]);
  });
});

describe('a PayCore form', () => {
  const signer = secretKeySigner(OWNER_KEY);
  const sign = (form: StoreForm, authorized?: Set<string>) =>
    signStoreEvents({
      form,
      keys: KEYS,
      signer,
      now: NOW,
      ...(authorized === undefined ? {} : { authorized }),
    });

  it('saves as a catalog of the store key with the policies on the server key, and authorizes both', async () => {
    const [config, storeAuth, serverAuth, ...rest] = await sign(PAYCORE_FORM);
    expect(rest).toEqual([]);
    if (config === undefined || storeAuth === undefined || serverAuth === undefined) {
      throw new Error('three events expected');
    }
    const parsed = configOf(config);
    expect(parsed.source).toEqual({ kind: 'catalog' });
    expect(parsed.catalogKey).toBe(STORE);
    expect(parsed.policyKey).toBe(SERVER_KEY);
    expect(storeAuth.kind).toBe(KIND_CATALOG_AUTH);
    expect(dOf(storeAuth)).toBe(STORE);
    expect(modeOf(storeAuth)).toEqual(['mode', 'hosted', 'elisym.network']);
    expect(dOf(serverAuth)).toBe(SERVER_KEY);
    expect(modeOf(serverAuth)).toEqual(['mode', 'hosted']);
  });

  it("mirrors the store's 30490: a self-host store's 30497 carries no operator", async () => {
    const link: PayCoreLink = { key: STORE, active: true, mode: 'self-host' };
    const [, storeAuth] = await sign({ ...PAYCORE_FORM, payCore: link });
    expect(storeAuth === undefined ? undefined : modeOf(storeAuth)).toEqual(['mode', 'self-host']);
    // An operator on a self-host link is never written.
    expect(
      authorizationsOf(
        { ...PAYCORE_FORM, payCore: { ...link, operator: 'x.example' } },
        SERVER_KEY,
      ),
    ).toEqual([
      { key: STORE, mode: 'self-host' },
      { key: SERVER_KEY, mode: 'hosted' },
    ]);
  });

  it('signs no 30497 a key already has: a save of an authorized PayCore store signs the config only', async () => {
    expect(await sign(PAYCORE_FORM, new Set([STORE, SERVER_KEY]))).toHaveLength(1);
    const [, only] = await sign(PAYCORE_FORM, new Set([STORE]));
    expect(only === undefined ? undefined : dOf(only)).toBe(SERVER_KEY);
  });

  it('locks the currency to USD', () => {
    expect(() => configInputOf({ ...PAYCORE_FORM, currency: 'eur' }, KEYS, NOW)).toThrow(
      /^Currency: a PayCore store's prices are in USD/u,
    );
    expect(configInputOf({ ...PAYCORE_FORM, currency: ' usd ' }, KEYS, NOW).currency).toBe('USD');
    // Another source keeps any currency.
    expect(
      configInputOf({ ...PAYCORE_FORM, source: 'admin', currency: 'EUR' }, KEYS, NOW).currency,
    ).toBe('EUR');
  });

  it('refuses without a store, and refuses to link a store none of whose 30490s grants', async () => {
    const { payCore: _payCore, ...unlinked } = PAYCORE_FORM;
    await expect(sign(unlinked)).rejects.toThrow(FormError);
    await expect(sign(unlinked)).rejects.toThrow(/^PayCore store: none is found/u);
    const noGrant: StoreForm = { ...PAYCORE_FORM, payCore: { key: STORE, active: false } };
    await expect(sign(noGrant)).rejects.toThrow(/^PayCore store: its authorization is not active/u);
    // Already authorized: the settings save, nothing new is linked.
    expect(await sign(noGrant, new Set([STORE, SERVER_KEY]))).toHaveLength(1);
  });

  it('reads back as a PayCore store with its link, or stays as it was without one', () => {
    const config = configOf(payCoreConfigEvent());
    const read = formOfConfig(config, PRIVATE_PART);
    expect(read.source).toBe('catalog');
    const [store] = payCoreStoresOf([hosted(), revoked()], OWNER, NOW);
    const linked = withPayCore(read, store);
    expect(linked.source).toBe('paycore');
    expect(linked.merchantKey).toBe('');
    expect(linked.payCore).toEqual({
      key: STORE,
      active: false,
      mode: 'hosted',
      operator: 'elisym.network',
    });
    expect(linked.keptPolicy?.source).toBe('paycore');
    expect(withPayCore(read, undefined)).toBe(read);
    const admin = { ...read, source: 'admin' as const };
    expect(withPayCore(admin, store)).toBe(admin);
  });

  it("a catalog read back without a 30490 keeps the server key's 30497 beside its own", () => {
    const read = formOfConfig(configOf(payCoreConfigEvent()), PRIVATE_PART);
    expect(authorizationsOf(read, SERVER_KEY)).toEqual([
      { key: STORE, mode: 'self-host' },
      { key: SERVER_KEY, mode: 'hosted' },
    ]);
    expect(authorizationsOf({ ...read, keptPolicy: undefined }, SERVER_KEY)).toEqual([
      { key: STORE, mode: 'self-host' },
    ]);
    expect(authorizationsOf({ ...EMPTY_FORM, source: 'admin' }, SERVER_KEY)).toEqual([
      { key: SERVER_KEY, mode: 'hosted' },
    ]);
  });
});

async function mountSettings(relay: NostrEvent[], config: StoreConfig) {
  const deps = sessionDeps(fakeApi(), fakeReader(relay));
  mounted = await mount(
    <SettingsSection
      deps={deps}
      view={storeView()}
      config={config}
      configError=""
      onRetry={async () => undefined}
      onSaved={async () => undefined}
    />,
  );
  const { container } = mounted;
  await settle(() => container.querySelector('#store-name') !== null);
  return { container, deps };
}

function sourceOf(container: HTMLElement): string {
  const field = byId(container, 'store-source');
  return field instanceof HTMLSelectElement ? field.value : '';
}

describe('the settings of a PayCore store', () => {
  it('reload: an active 30490 reads as the PayCore store, named; saving signs the config only', async () => {
    const event = payCoreConfigEvent();
    const { container, deps } = await mountSettings(
      [event, hosted(), profile(STORE_KEY, 'Course Shop'), ...bothCatalogAuths()],
      configOf(event),
    );
    await settle(() => sourceOf(container) === 'paycore');
    await settle(() => (container.textContent ?? '').includes('Course Shop'));
    expect(container.textContent).toContain(npubOf(STORE));
    expect(container.textContent).not.toContain('authorization inactive');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.storeEvents).mock.calls.length === 1);
    const signed = vi.mocked(deps.api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(signed.map((entry) => entry.kind)).toEqual([KIND_CONFIG]);
    expect(configOf(signed[0] ?? event).catalogKey).toBe(STORE);
  });

  it('reload: a revoked 30490 reads as inactive, with a re-authorize link and the other active store to use', async () => {
    const event = payCoreConfigEvent();
    const { container } = await mountSettings(
      [
        event,
        hosted(),
        revoked(),
        hosted(OTHER_STORE, NOW - 300),
        profile(OTHER_STORE_KEY, 'Second Shop'),
        ...bothCatalogAuths(),
      ],
      configOf(event),
    );
    await settle(() =>
      (container.textContent ?? '').includes('PayCore store - authorization inactive'),
    );
    expect(sourceOf(container)).toBe('paycore');
    const relink = [...container.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Re-authorize it in PayCore',
    );
    expect(relink?.getAttribute('href')).toBe(PAYCORE_ONBOARDING_URL);
    await settle(() => (container.textContent ?? '').includes('Use Second Shop instead'));
    await click(buttonNamed(container, 'Use Second Shop instead'));
    expect(container.textContent).not.toContain('authorization inactive');
    expect(container.textContent).toContain(npubOf(OTHER_STORE));
  });

  it('reload: with no 30490 for the key at all, it falls back to a merchant catalog', async () => {
    const event = payCoreConfigEvent();
    const { container } = await mountSettings([event, ...bothCatalogAuths()], configOf(event));
    const merchant = byId(container, 'store-merchant-key');
    expect(sourceOf(container)).toBe('catalog');
    expect(merchant instanceof HTMLInputElement ? merchant.value : '').toBe(npubOf(STORE));
  });
});

function renderFields(form: StoreForm, choices: PayCoreChoices | undefined) {
  const changes: StoreForm[] = [];
  return {
    changes,
    element: (
      <StoreFields
        form={form}
        onChange={(next) => changes.push(next)}
        {...(choices === undefined ? {} : { payCore: choices })}
      />
    ),
  };
}

describe('choosing the PayCore source', () => {
  const ADMIN_FORM: StoreForm = { ...EMPTY_FORM, currency: 'EUR' };

  it('links the newest active store discovery found and sets the currency to USD', async () => {
    const stores = payCoreStoresOf([hosted()], OWNER, NOW);
    const { changes, element } = renderFields(ADMIN_FORM, { state: 'read', stores });
    mounted = await mount(element);
    await chooseOption(byId(mounted.container, 'store-source'), 'paycore');
    expect(changes.at(-1)?.source).toBe('paycore');
    expect(changes.at(-1)?.currency).toBe('USD');
    expect(changes.at(-1)?.payCore).toEqual({
      key: STORE,
      active: true,
      mode: 'hosted',
      operator: 'elisym.network',
    });
  });

  it('with no PayCore store for the key, links to PayCore onboarding (not an error)', async () => {
    const { element } = renderFields(
      { ...ADMIN_FORM, source: 'paycore' },
      { state: 'read', stores: payCoreStoresOf([hosted(), revoked()], OWNER, NOW) },
    );
    mounted = await mount(element);
    const { container } = mounted;
    expect(container.textContent).toContain('No PayCore store is set up for this Store ID yet');
    const onboarding = [...container.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Set one up in PayCore',
    );
    expect(onboarding?.getAttribute('href')).toBe(PAYCORE_ONBOARDING_URL);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('offers a store found after the source was chosen, and says when the read failed', async () => {
    const stores = payCoreStoresOf([selfHost()], OWNER, NOW);
    const found = renderFields({ ...ADMIN_FORM, source: 'paycore' }, { state: 'read', stores });
    mounted = await mount(found.element);
    await click(buttonNamed(mounted.container, 'Sell from this store'));
    expect(found.changes.at(-1)?.payCore).toEqual({ key: STORE, active: true, mode: 'self-host' });
    expect(found.changes.at(-1)?.currency).toBe('USD');
    await mounted.unmount();
    const retry = vi.fn();
    const failed = renderFields({ ...ADMIN_FORM, source: 'paycore' }, { state: 'failed', retry });
    mounted = await mount(failed.element);
    expect(mounted.container.textContent).toContain('Your PayCore stores could not be read');
    await click(buttonNamed(mounted.container, 'Retry'));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe('rotation of a PayCore store', () => {
  it('signs the config only: both 30497s stay as they are', async () => {
    const nextAssistant = getPublicKey(generateSecretKey());
    const api = fakeApi({ rotateAssistant: vi.fn(async () => ({ nextAssistant })) });
    const deps: SessionDeps = sessionDeps(api, fakeReader([]));
    const event = payCoreConfigEvent();
    mounted = await mount(
      <RotateAssistant
        deps={deps}
        view={storeView()}
        config={configOf(event)}
        configError=""
        onRetry={async () => undefined}
        onChanged={async () => undefined}
      />,
    );
    await click(buttonNamed(mounted.container, 'Rotate assistant key'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const signed = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(signed).toHaveLength(1);
    const rotated = configOf(signed[0] ?? event);
    expect(rotated.assistant).toBe(nextAssistant);
    expect(rotated.catalogKey).toBe(STORE);
    expect(rotated.policyKey).toBe(SERVER_KEY);
  });
});

describe('the plan count of a PayCore store', () => {
  it('counts its listings, accept tags and all, in USD', async () => {
    const listings = ['a', 'b', 'c'].map((d) =>
      finalizeEvent(
        buildProductEvent({
          d,
          title: `Course ${d}`,
          description: 'A course.',
          price: { amount: '25', currency: 'USD' },
          accept: [DEVNET_USDC],
          createdAt: NOW - 10,
        }),
        STORE_KEY,
      ),
    );
    expect(await countListed(fakeReader(listings), STORE, 'USD', NOW)).toBe(3);
    expect(await countListed(fakeReader(listings), STORE, 'EUR', NOW)).toBe(0);
  });
});

describe('the embed code of a PayCore store', () => {
  const PACKAGES = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  it('pins the released checkout v4 loader', () => {
    const sri = readFileSync(join(PACKAGES, 'checkout', 'src', 'embed', 'v4.sri'), 'utf8').trim();
    expect(CHECKOUT_V4_INTEGRITY).toBe(sri);
    expect(CHECKOUT_V4_SRC).toBe('https://pay.elisym.network/v4/embed.js');
    expect(CHECKOUT_V4_SNIPPET).toContain(`src="${CHECKOUT_V4_SRC}"`);
    expect(CHECKOUT_V4_SNIPPET).toContain(`integrity="${sri}"`);
    expect(CHECKOUT_V4_SNIPPET).toContain('crossorigin="anonymous"');
  });

  it('adds the checkout to script-src and frame-src only for a PayCore store', () => {
    const plain = cspSources();
    expect(plain.map((source) => source.directive)).not.toContain('frame-src');
    expect(plain.find((source) => source.directive === 'script-src')?.sources).not.toContain(
      'https://pay.elisym.network',
    );
    const payCore = cspSources(true);
    expect(payCore.find((source) => source.directive === 'frame-src')?.sources).toEqual([
      'https://pay.elisym.network',
    ]);
    expect(payCore.find((source) => source.directive === 'script-src')?.sources).toContain(
      'https://pay.elisym.network',
    );
  });

  async function mountEmbed(relay: NostrEvent[], config: StoreConfig) {
    mounted = await mount(
      <EmbedSection
        api={fakeApi()}
        view={storeView()}
        config={config}
        reader={fakeReader(relay)}
        now={() => NOW}
      />,
    );
    return mounted.container;
  }

  it('shows the checkout script for a PayCore store, an inactive one included', async () => {
    const config = configOf(payCoreConfigEvent());
    const active = await mountEmbed([hosted()], config);
    await settle(() => (active.textContent ?? '').includes('PayCore checkout script'));
    expect(active.textContent).toContain(CHECKOUT_V4_INTEGRITY);
    expect(active.textContent).toContain('frame-src');
    await mounted?.unmount();
    const inactive = await mountEmbed([hosted(), revoked()], config);
    await settle(() => (inactive.textContent ?? '').includes('PayCore checkout script'));
  });

  it('shows none for a merchant catalog without a 30490, or another source', async () => {
    const container = await mountEmbed([], configOf(payCoreConfigEvent()));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.textContent).not.toContain('PayCore checkout script');
    expect(container.textContent).not.toContain('frame-src');
  });
});

describe('the catalog keys list', () => {
  it('names a store key with a 30490 as the PayCore store, inactive or not', async () => {
    const config = configOf(payCoreConfigEvent());
    mounted = await mount(
      <CatalogKeys
        deps={sessionDeps(fakeApi(), fakeReader([hosted(), ...bothCatalogAuths()]))}
        view={storeView()}
        config={config}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('your PayCore store'));
    expect(container.textContent).not.toContain('authorization inactive');
    await mounted.unmount();
    mounted = await mount(
      <CatalogKeys
        deps={sessionDeps(fakeApi(), fakeReader([hosted(), revoked(), ...bothCatalogAuths()]))}
        view={storeView()}
        config={config}
      />,
    );
    const inactive = mounted.container;
    await settle(() =>
      (inactive.textContent ?? '').includes('your PayCore store (authorization inactive)'),
    );
  });
});

describe('payCoreStoresOf, the edges', () => {
  it('reads the mode only from a 30490 with exactly one mode tag', () => {
    const twoModes = rawStoreAuth(
      [
        ['d', STORE],
        ['p', STORE],
        ['mode', 'hosted', 'x.example'],
        ['mode', 'self-host'],
      ],
      NOW - 80,
    );
    const [store] = payCoreStoresOf([selfHost(STORE, NOW - 100), twoModes, revoked()], OWNER, NOW);
    expect(store).toEqual({ key: STORE, active: false, mode: 'self-host', newestAt: NOW - 50 });
  });

  it('lists no 30490 whose d is not a store key', () => {
    const notHex = rawStoreAuth(
      [
        ['d', 'not-a-key'],
        ['p', 'not-a-key'],
        ['mode', 'hosted'],
      ],
      NOW - 10,
    );
    expect(payCoreStoresOf([notHex], OWNER, NOW)).toEqual([]);
  });

  it("an active store's mode is its current word, not a 30490 dated too far ahead", () => {
    const ahead = hosted(STORE, NOW + 100_000);
    const [store] = payCoreStoresOf([selfHost(STORE, NOW - 100), ahead], OWNER, NOW);
    expect(store).toEqual({ key: STORE, active: true, mode: 'self-host', newestAt: NOW + 100_000 });
  });

  it("an inactive store keeps the newest grant's mode", () => {
    const [store] = payCoreStoresOf(
      [hosted(STORE, NOW - 100), selfHost(STORE, NOW - 80), revoked()],
      OWNER,
      NOW,
    );
    expect(store?.mode).toBe('self-host');
    expect(store?.operator).toBeUndefined();
  });

  it('orders stores signed at the same second by key', () => {
    const stores = payCoreStoresOf(
      [hosted(STORE, NOW - 100), hosted(OTHER_STORE, NOW - 100)],
      OWNER,
      NOW,
    );
    expect(stores.map((store) => store.key)).toEqual([STORE, OTHER_STORE].sort());
  });
});

describe('readPayCoreStores, the edges', () => {
  it('trims a name and leaves out a blank one', async () => {
    const padded = await readPayCoreStores(
      fakeReader([hosted(), rawProfile(STORE_KEY, '  Course Shop  ')]),
      OWNER,
      NOW,
    );
    expect(padded[0]?.name).toBe('Course Shop');
    const blank = await readPayCoreStores(
      fakeReader([hosted(), rawProfile(STORE_KEY, '   ')]),
      OWNER,
      NOW,
    );
    expect(blank[0]).not.toHaveProperty('name');
  });

  it('reads the deletions too: a deleted 30490 is never discovered', async () => {
    const stores = await readPayCoreStores(
      fakeReader([selfHost(), deletionOf(STORE, NOW - 40)]),
      OWNER,
      NOW,
    );
    expect(stores.map((store) => store.active)).toEqual([false]);
    expect(discoveredStore(stores)).toBeUndefined();
  });
});

describe('linking and leaving a PayCore store', () => {
  const signer = secretKeySigner(OWNER_KEY);

  it('refuses to link an expired or a revoked store: a new 30497 needs an active 30490', async () => {
    const [expired] = payCoreStoresOf([hosted(STORE, NOW - 100, NOW - 1)], OWNER, NOW);
    const [revokedStore] = payCoreStoresOf([hosted(), revoked()], OWNER, NOW);
    for (const store of [expired, revokedStore]) {
      if (store === undefined) {
        throw new Error('a store expected');
      }
      expect(store.mode).toBe('hosted');
      const form = { ...PAYCORE_FORM, payCore: { ...store } };
      await expect(signStoreEvents({ form, keys: KEYS, signer, now: NOW })).rejects.toThrow(
        /^PayCore store: its authorization is not active/u,
      );
      // With its 30497 in force, the settings still save.
      const saved = await signStoreEvents({
        form,
        keys: KEYS,
        signer,
        now: NOW,
        authorized: new Set([STORE, SERVER_KEY]),
      });
      expect(saved).toHaveLength(1);
    }
  });

  it('leaving PayCore for a merchant catalog signs that key as a plain merchant key', async () => {
    const merchant = getPublicKey(generateSecretKey());
    const form: StoreForm = {
      ...PAYCORE_FORM,
      source: 'catalog',
      merchantKey: npubOf(merchant),
    };
    expect(authorizationsOf(form, SERVER_KEY)).toEqual([{ key: merchant, mode: 'self-host' }]);
    const [, auth, ...rest] = await signStoreEvents({ form, keys: KEYS, signer, now: NOW });
    expect(rest).toEqual([]);
    expect(auth === undefined ? undefined : modeOf(auth)).toEqual(['mode', 'self-host']);
    expect(auth === undefined ? undefined : dOf(auth)).toBe(merchant);
  });

  it('dates each 30497 for its own key', async () => {
    const [, storeAuth, serverAuth] = await signStoreEvents({
      form: PAYCORE_FORM,
      keys: KEYS,
      signer,
      now: NOW,
      authCreatedAt: (key) => (key === STORE ? NOW + 5 : NOW + 9),
    });
    expect(storeAuth?.created_at).toBe(NOW + 5);
    expect(serverAuth?.created_at).toBe(NOW + 9);
  });
});

describe('the PayCore source in the form, more', () => {
  it('choosing PayCore again keeps the store already linked', async () => {
    const other: PayCoreLink = { key: OTHER_STORE, active: true, mode: 'self-host' };
    const { changes, element } = renderFields(
      { ...EMPTY_FORM, source: 'admin', payCore: other },
      { state: 'read', stores: payCoreStoresOf([hosted()], OWNER, NOW) },
    );
    mounted = await mount(element);
    await chooseOption(byId(mounted.container, 'store-source'), 'paycore');
    expect(changes.at(-1)?.payCore).toEqual(other);
  });

  it('an inactive hosted store is named, with the hosted re-authorize link', async () => {
    const stores = await readPayCoreStores(
      fakeReader([hosted(), revoked(), profile(STORE_KEY, 'Course Shop')]),
      OWNER,
      NOW,
    );
    const { element } = renderFields(
      { ...PAYCORE_FORM, payCore: { key: STORE, active: false, mode: 'hosted' } },
      { state: 'read', stores },
    );
    mounted = await mount(element);
    const { container } = mounted;
    expect(container.textContent).toContain('PayCore store - authorization inactive');
    expect(container.textContent).toContain('Course Shop');
    const relink = [...container.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Re-authorize it in PayCore',
    );
    expect(relink?.getAttribute('href')).toBe(PAYCORE_ONBOARDING_URL);
  });

  it('an inactive self-host store is re-authorized on its own node: no hosted link', async () => {
    const { element } = renderFields(
      { ...PAYCORE_FORM, payCore: { key: STORE, active: false, mode: 'self-host' } },
      { state: 'read', stores: payCoreStoresOf([selfHost(), revoked()], OWNER, NOW) },
    );
    mounted = await mount(element);
    const { container } = mounted;
    expect(container.textContent).toContain('runs on your own PayCore node');
    expect(container.querySelector(`a[href="${PAYCORE_ONBOARDING_URL}"]`)).toBeNull();
  });
});

describe('the settings of a PayCore store, while its 30490s are read', () => {
  it('holds the form until the read is in', async () => {
    const event = payCoreConfigEvent();
    const relay = scriptedReader([event, hosted(), ...bothCatalogAuths()], isAuthorityRead);
    relay.set('hold');
    mounted = await mount(
      <SettingsSection
        deps={sessionDeps(fakeApi(), relay.reader)}
        view={storeView()}
        config={configOf(event)}
        configError=""
        onRetry={async () => undefined}
        onSaved={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Checking your PayCore store...'));
    expect(container.querySelector('#store-source')).toBeNull();
    relay.release();
    await settle(() => container.querySelector('#store-source') !== null);
    expect(sourceOf(container)).toBe('paycore');
  });

  it('a failed read keeps the form held, and a retry opens it', async () => {
    const event = payCoreConfigEvent();
    const relay = scriptedReader([event, hosted(), ...bothCatalogAuths()], isAuthorityRead);
    relay.set('fail');
    mounted = await mount(
      <SettingsSection
        deps={sessionDeps(fakeApi(), relay.reader)}
        view={storeView()}
        config={configOf(event)}
        configError=""
        onRetry={async () => undefined}
        onSaved={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('could not be checked yet'));
    expect(container.querySelector('#store-source')).toBeNull();
    relay.set('pass');
    await click(buttonNamed(container, 'Retry'));
    await settle(() => container.querySelector('#store-source') !== null);
    expect(sourceOf(container)).toBe('paycore');
  });

  it('a config of another layout is not held', async () => {
    const relay = scriptedReader([], isAuthorityRead);
    relay.set('hold');
    mounted = await mount(
      <SettingsSection
        deps={sessionDeps(fakeApi(), relay.reader)}
        // The config's products come from the server key itself: no PayCore layout.
        view={storeView({ catalogKey: STORE })}
        config={configOf(payCoreConfigEvent())}
        configError=""
        onRetry={async () => undefined}
        onSaved={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => container.querySelector('#store-source') !== null);
    relay.release();
  });
});

function ChoicesProbe({ deps }: { deps: SessionDeps }) {
  const choices = usePayCoreChoices(deps);
  return (
    <div>
      <span id="choices-state">{choices.state}</span>
      {choices.state === 'read' ? (
        <span id="choices-keys">{choices.stores.map((store) => store.key).join(',')}</span>
      ) : null}
      {choices.state === 'failed' ? (
        <button type="button" onClick={choices.retry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

function probeText(container: HTMLElement, id: string): string {
  return container.querySelector(`#${id}`)?.textContent ?? '';
}

describe('usePayCoreChoices', () => {
  it('says when the read failed, reads again from reading on a retry', async () => {
    const relay = scriptedReader([hosted()], isChoicesRead);
    relay.set('fail');
    mounted = await mount(<ChoicesProbe deps={sessionDeps(fakeApi(), relay.reader)} />);
    const { container } = mounted;
    await settle(() => probeText(container, 'choices-state') === 'failed');
    relay.set('hold');
    await click(buttonNamed(container, 'Retry'));
    await settle(() => probeText(container, 'choices-state') === 'reading');
    relay.release();
    await settle(() => probeText(container, 'choices-state') === 'read');
    expect(probeText(container, 'choices-keys')).toBe(STORE);
  });

  it('an older read finishing late never replaces a newer one', async () => {
    const first = scriptedReader([hosted()], isChoicesRead);
    first.set('hold');
    mounted = await mount(<ChoicesProbe deps={sessionDeps(fakeApi(), first.reader)} />);
    const { container } = mounted;
    await mounted.rerender(
      <ChoicesProbe deps={sessionDeps(fakeApi(), fakeReader([hosted(OTHER_STORE)]))} />,
    );
    await settle(() => probeText(container, 'choices-keys') === OTHER_STORE);
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probeText(container, 'choices-keys')).toBe(OTHER_STORE);
  });

  it('an older read failing late never replaces a newer one', async () => {
    const first = scriptedReader([hosted()], isChoicesRead);
    first.set('hold');
    mounted = await mount(<ChoicesProbe deps={sessionDeps(fakeApi(), first.reader)} />);
    const { container } = mounted;
    await mounted.rerender(
      <ChoicesProbe deps={sessionDeps(fakeApi(), fakeReader([hosted(OTHER_STORE)]))} />,
    );
    await settle(() => probeText(container, 'choices-keys') === OTHER_STORE);
    first.failHeld();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probeText(container, 'choices-state')).toBe('read');
    expect(probeText(container, 'choices-keys')).toBe(OTHER_STORE);
  });
});

describe('the embed code of a PayCore store, more', () => {
  function embed(config: StoreConfig, reader: RelayReader) {
    return (
      <EmbedSection
        api={fakeApi()}
        view={storeView()}
        config={config}
        reader={reader}
        now={() => NOW}
      />
    );
  }

  it('says when the 30490 read failed, and a retry shows the script', async () => {
    const relay = scriptedReader([hosted()], isAuthorityRead);
    relay.set('fail');
    mounted = await mount(embed(configOf(payCoreConfigEvent()), relay.reader));
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('could not be checked'));
    expect(container.textContent).not.toContain('PayCore checkout script');
    relay.set('pass');
    await click(buttonNamed(container, 'Retry'));
    await settle(() => (container.textContent ?? '').includes('PayCore checkout script'));
    expect(container.textContent).not.toContain('could not be checked');
  });

  it('drops the script when the settings change to another source', async () => {
    const reader = fakeReader([hosted()]);
    mounted = await mount(embed(configOf(payCoreConfigEvent()), reader));
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('PayCore checkout script'));
    const admin = { ...configOf(payCoreConfigEvent()), catalogKey: SERVER_KEY };
    await mounted.rerender(embed(admin, reader));
    await settle(() => !(container.textContent ?? '').includes('PayCore checkout script'));
  });

  it('a read for settings since replaced never shows the script', async () => {
    const relay = scriptedReader([hosted()], isAuthorityRead);
    relay.set('hold');
    mounted = await mount(embed(configOf(payCoreConfigEvent()), relay.reader));
    const { container } = mounted;
    const admin = { ...configOf(payCoreConfigEvent()), catalogKey: SERVER_KEY };
    await mounted.rerender(embed(admin, relay.reader));
    relay.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.textContent).not.toContain('PayCore checkout script');
  });

  it('a read for settings since replaced, failing late, never shows the failure', async () => {
    const relay = scriptedReader([hosted()], isAuthorityRead);
    relay.set('hold');
    mounted = await mount(embed(configOf(payCoreConfigEvent()), relay.reader));
    const { container } = mounted;
    const admin = { ...configOf(payCoreConfigEvent()), catalogKey: SERVER_KEY };
    await mounted.rerender(embed(admin, relay.reader));
    relay.failHeld();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.textContent).not.toContain('could not be checked');
  });

  it('says why each checkout source is needed', () => {
    const payCore = cspSources(true);
    expect(payCore.find((source) => source.directive === 'script-src')?.why).toBe(
      'loads widget.js and the PayCore checkout script',
    );
    expect(payCore.find((source) => source.directive === 'frame-src')?.why).toBe(
      'the PayCore checkout behind the Buy button',
    );
    expect(cspSources().find((source) => source.directive === 'script-src')?.why).toBe(
      'loads widget.js',
    );
  });

  it('the Embed tab reads the 30490s through the session', async () => {
    const event = payCoreConfigEvent();
    mounted = await mount(
      <Shell
        deps={sessionDeps(fakeApi(), fakeReader([hosted()]))}
        view={storeView()}
        config={configOf(event)}
        configFromServer={false}
        storedTruncated={false}
        configError=""
        configUnreadableAt={undefined}
        reloadWarning=""
        reload={async () => true}
        reloadConfig={async () => true}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    const { container } = mounted;
    await click(buttonNamed(container, 'Embed'));
    await settle(() => (container.textContent ?? '').includes('PayCore checkout script'));
  });
});

describe('onboarding with a PayCore store', () => {
  it('offers the store the new owner already has', async () => {
    mounted = await mount(
      <Onboarding
        deps={sessionDeps(fakeApi(), fakeReader([hosted(), profile(STORE_KEY, 'Course Shop')]))}
        view={storeView({ status: 'pending', tier: null })}
        onCreated={() => undefined}
        onDone={async () => undefined}
        onSignOut={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => container.querySelector('#store-source') !== null);
    // The choices are read before the source is chosen, so it is linked at once.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await chooseOption(byId(container, 'store-source'), 'paycore');
    await settle(() => (container.textContent ?? '').includes('Course Shop'));
    expect(container.textContent).not.toContain('Sell from this store');
  });
});
