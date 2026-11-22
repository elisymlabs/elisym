import {
  type StoreConfig,
  buildCatalogAuth,
  buildCatalogRevocation,
  buildConfigEvent,
  decryptPrivateConfigWith,
  parseConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsSection } from '../src/components/SettingsSection';
import type { SessionDeps } from '../src/lib/deps';
import { type Signer, secretKeySigner } from '../src/lib/signer';
import { EMPTY_FORM, withConnector } from '../src/lib/store-form';
import type { StoreView } from '../src/lib/types';
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
import {
  type Mounted,
  buttonNamed,
  byId,
  chooseOption,
  click,
  mount,
  settle,
  typeInto,
} from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const PRIVATE_PART = { voice: 'calm', instructions: 'Recommend oolong.', notes: 'Berlin' };

function publishedConfig(createdAt: number): NostrEvent {
  return finalizeEvent(
    {
      ...buildConfigEvent(
        {
          assistant: ASSISTANT,
          origins: ['https://tea.example'],
          name: 'Relay Tea',
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: SERVER_KEY,
          private: PRIVATE_PART,
        },
        OWNER_KEY,
      ),
      created_at: createdAt,
    },
    OWNER_KEY,
  );
}

function ownerSigned(template: Parameters<typeof finalizeEvent>[0]): NostrEvent {
  return finalizeEvent(template, OWNER_KEY);
}

function configOf(event: NostrEvent): StoreConfig {
  const config = parseConfig(event);
  if (config === undefined) {
    throw new Error('config does not parse');
  }
  return config;
}

function instructionsOf(container: HTMLElement): string {
  const field = byId(container, 'store-instructions');
  return field instanceof HTMLTextAreaElement ? field.value : '';
}

function tagOf(event: NostrEvent | undefined, name: string): string | undefined {
  return event?.tags.find((tag) => tag[0] === name)?.[1];
}

async function mountSettings(options: {
  deps: SessionDeps;
  config: StoreConfig | undefined;
  view?: StoreView;
}) {
  const render = (config: StoreConfig | undefined) => (
    <SettingsSection
      deps={options.deps}
      view={options.view ?? storeView()}
      config={config}
      configError=""
      onRetry={async () => undefined}
      onSaved={async () => undefined}
    />
  );
  mounted = await mount(render(options.config));
  const { container } = mounted;
  await settle(() => container.querySelector('#store-name') !== null);
  return { container, render };
}

function storedEvents(deps: SessionDeps, call: number): NostrEvent[] {
  return vi.mocked(deps.api.storeEvents).mock.calls[call]?.[0] ?? [];
}

const CONNECTOR_FAILURE = 'Your settings are saved, but the connector could not be updated';

/** The connector failure shows in the error notice, never in the success one. */
function expectConnectorErrorOnlyInAlert(container: HTMLElement): void {
  const alerts = [...container.querySelectorAll('[role="alert"]')].map(
    (alert) => alert.textContent ?? '',
  );
  const statuses = [...container.querySelectorAll('[role="status"]')].map(
    (status) => status.textContent ?? '',
  );
  expect(alerts.some((alert) => alert.includes(CONNECTOR_FAILURE))).toBe(true);
  expect(statuses.some((status) => status.includes(CONNECTOR_FAILURE))).toBe(false);
  expect(statuses.some((status) => status.startsWith('Saved.'))).toBe(true);
}

describe('the settings save', () => {
  it.each([
    ['active', storeView(), 'are published in a moment'],
    [
      'pending',
      storeView({ status: 'pending', tier: null }),
      'Saved. Choose a plan in Billing to go live.',
    ],
    [
      'operator-managed pending',
      storeView({ status: 'pending' }),
      "Saved. We manage your store's plan. Message us with your Store ID to make it live.",
    ],
    ['suspended', storeView({ status: 'suspended' }), 'published once your store is reactivated'],
  ] as const)('says it saved, for a %s store', async (_status, view, copy) => {
    const event = publishedConfig(NOW - 100);
    const deps = sessionDeps(fakeApi(), fakeReader([event]));
    const { container } = await mountSettings({ deps, config: configOf(event), view });
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => (container.textContent ?? '').includes(copy));
    // The section reads the config this save signed; the message stays.
    await settle(() => vi.mocked(deps.api.storeEvents).mock.calls.length === 1);
    expect(container.textContent).toContain(copy);
  });

  it('the chat button text sits in the Assistant group and reaches the saved config', async () => {
    const event = publishedConfig(NOW - 100);
    const deps = sessionDeps(fakeApi(), fakeReader([event]));
    const { container } = await mountSettings({ deps, config: configOf(event) });
    const field = byId(container, 'store-launcher-text');
    expect(field.closest('fieldset')?.getAttribute('aria-labelledby')).toBe(
      'group-assistant-title',
    );
    await typeInto(field, 'Ask our tea expert');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.storeEvents).mock.calls.length === 1);
    expect(tagOf(storedEvents(deps, 0)[0], 'launcher-text')).toBe('Ask our tea expert');
  });

  it('dates a second save after the first, even before the relay shows the first', async () => {
    const event = publishedConfig(NOW - 100);
    const deps = sessionDeps(fakeApi(), fakeReader([event]));
    const { container } = await mountSettings({ deps, config: configOf(event) });
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.storeEvents).mock.calls.length === 1);
    await typeInto(byId(container, 'store-greeting'), 'Hi again');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.storeEvents).mock.calls.length === 2);
    expect(storedEvents(deps, 0)[0]?.created_at).toBe(NOW);
    expect(storedEvents(deps, 1)[0]?.created_at).toBe(NOW + 1);
  });

  it('dates the authorization it signs after a revocation on the relay dated ahead', async () => {
    const event = publishedConfig(NOW - 100);
    const revocation = ownerSigned({ ...buildCatalogRevocation(SERVER_KEY), created_at: NOW + 30 });
    const deps = sessionDeps(fakeApi(), fakeReader([event, revocation]));
    const { container } = await mountSettings({ deps, config: configOf(event) });
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.storeEvents).mock.calls.length === 1);
    const [, authorization] = storedEvents(deps, 0);
    expect(tagOf(authorization, 'mode')).toBe('hosted');
    expect(authorization?.created_at).toBe(NOW + 31);
  });

  it('authorizes again a key this session revoked, though the relay still shows it', async () => {
    const event = publishedConfig(NOW - 100);
    const auth = ownerSigned({
      ...buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }),
      created_at: NOW - 50,
    });
    const deps = sessionDeps(fakeApi(), fakeReader([event, auth]));
    deps.journal.note([
      ownerSigned({ ...buildCatalogRevocation(SERVER_KEY), created_at: NOW - 10 }),
    ]);
    const { container } = await mountSettings({ deps, config: configOf(event) });
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.storeEvents).mock.calls.length === 1);
    const [, authorization] = storedEvents(deps, 0);
    expect(tagOf(authorization, 'd')).toBe(SERVER_KEY);
    expect(storedEvents(deps, 0)).toHaveLength(2);
    expect(authorization?.created_at).toBe(NOW);
  });
});

describe('an undecryptable private part', () => {
  function decliningOnce(): Signer {
    const real = secretKeySigner(OWNER_KEY);
    let declined = false;
    return {
      ...real,
      decrypt: vi.fn(async (ciphertext: string, peer: string) => {
        if (!declined) {
          declined = true;
          throw new Error('declined');
        }
        return real.decrypt(ciphertext, peer);
      }),
    };
  }

  it('needs a retry or an explicit choice before a save can replace it', async () => {
    const event = publishedConfig(NOW - 100);
    const signer = decliningOnce();
    const deps = sessionDeps(fakeApi(), fakeReader([event]), signer);
    const { container } = await mountSettings({ deps, config: configOf(event) });
    expect(container.textContent).toContain('could not be read, so the fields');
    expect(buttonNamed(container, 'Sign and save').disabled).toBe(true);
    const replace = container.querySelector('input[type="checkbox"]');
    if (!(replace instanceof HTMLInputElement)) {
      throw new Error('no replace checkbox');
    }
    await click(replace);
    expect(buttonNamed(container, 'Sign and save').disabled).toBe(false);

    await click(buttonNamed(container, 'Try decrypting again'));
    await settle(() => instructionsOf(container) !== '');
    expect(instructionsOf(container)).toBe('Recommend oolong.');
    expect(container.textContent).not.toContain('could not be read, so the fields');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.storeEvents).mock.calls.length === 1);
    const saved = configOf(storedEvents(deps, 0)[0] ?? event);
    expect(await decryptPrivateConfigWith(saved, signer.decrypt)).toEqual(PRIVATE_PART);
  });

  it('a Refresh that reads the same config again asks for no new decrypt', async () => {
    const event = publishedConfig(NOW - 100);
    const real = secretKeySigner(OWNER_KEY);
    const signer: Signer = { ...real, decrypt: vi.fn(real.decrypt) };
    const deps = sessionDeps(fakeApi(), fakeReader([event]), signer);
    const { render } = await mountSettings({ deps, config: configOf(event) });
    expect(signer.decrypt).toHaveBeenCalledTimes(1);
    await mounted?.rerender(render(configOf(event)));
    await mounted?.rerender(render(configOf(event)));
    expect(signer.decrypt).toHaveBeenCalledTimes(1);
  });
});

describe('the connector, set up with the settings', () => {
  const CONNECTOR = {
    owner: OWNER,
    platform: 'shopify' as const,
    url: 'https://tea.example',
    currency: 'EUR',
    importPolicies: false,
    enabled: true,
    lastStatus: null,
    lastRunAt: null,
    nextRunAt: null,
  };

  it('saves the shop as the connector, with its options, after signing the settings', async () => {
    const event = publishedConfig(NOW - 100);
    const deps = sessionDeps(fakeApi(), fakeReader([event]));
    const { container } = await mountSettings({ deps, config: configOf(event) });
    await chooseOption(byId(container, 'store-source'), 'connector');
    await chooseOption(byId(container, 'store-platform'), 'shopify');
    await typeInto(byId(container, 'store-shop-url'), 'https://tea.example/');
    await typeInto(byId(container, 'store-connector-currency'), 'eur');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.putConnector).mock.calls.length === 1);
    expect(deps.api.putConnector).toHaveBeenCalledWith({
      platform: 'shopify',
      url: 'https://tea.example',
      currency: 'EUR',
      importPolicies: true,
    });
    const signed = configOf(storedEvents(deps, 0)[0] ?? event);
    expect(signed.source).toMatchObject({ kind: 'connector', shopUrl: 'https://tea.example' });
  });

  it('keeps a feed address, the currency and the policy import from the connector the form opens with', async () => {
    const config = configOf(publishedConfig(NOW - 100));
    const deps = sessionDeps(fakeApi(), fakeReader([publishedConfig(NOW - 100)]));
    const { container } = await mountSettings({
      deps,
      config: { ...config, source: { kind: 'connector', platform: 'google' } },
      view: storeView({
        connector: { ...CONNECTOR, platform: 'google', url: 'https://tea.example/feed.xml' },
      }),
    });
    const feed = byId(container, 'store-feed-url');
    expect(feed instanceof HTMLInputElement && feed.value).toBe('https://tea.example/feed.xml');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.putConnector).mock.calls.length === 1);
    expect(deps.api.putConnector).toHaveBeenCalledWith({
      platform: 'google',
      url: 'https://tea.example/feed.xml',
      currency: 'EUR',
      importPolicies: false,
    });
  });

  it('refuses a bad feed address or currency before signing anything', async () => {
    const event = publishedConfig(NOW - 100);
    const deps = sessionDeps(fakeApi(), fakeReader([event]));
    const { container } = await mountSettings({ deps, config: configOf(event) });
    await chooseOption(byId(container, 'store-source'), 'connector');
    await chooseOption(byId(container, 'store-platform'), 'google');
    await typeInto(byId(container, 'store-feed-url'), 'http://tea.example/feed.xml');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => (container.textContent ?? '').includes('Feed address'));
    await typeInto(byId(container, 'store-feed-url'), 'https://tea.example/feed.xml');
    await typeInto(byId(container, 'store-connector-currency'), 'EURO');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => (container.textContent ?? '').includes('three letters'));
    expect(deps.api.storeEvents).not.toHaveBeenCalled();
    expect(deps.api.putConnector).not.toHaveBeenCalled();
  });

  it('removes the connector when the products no longer come from it', async () => {
    const event = publishedConfig(NOW - 100);
    const deps = sessionDeps(fakeApi(), fakeReader([event]));
    const { container } = await mountSettings({
      deps,
      config: configOf(event),
      view: storeView({ connector: CONNECTOR }),
    });
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.deleteConnector).mock.calls.length === 1);
    expect(deps.api.putConnector).not.toHaveBeenCalled();
  });

  it('keeps the saved message when the connector step fails or adds a note', async () => {
    const event = publishedConfig(NOW - 100);
    const shopConfig = {
      ...configOf(event),
      source: {
        kind: 'connector' as const,
        platform: 'shopify' as const,
        shopUrl: 'https://tea.example',
      },
    };
    const choosingView = storeView({ status: 'pending', tier: null, connector: CONNECTOR });
    const managedView = storeView({ status: 'pending', connector: CONNECTOR });

    const failing = sessionDeps(
      fakeApi({ putConnector: vi.fn(async () => Promise.reject(new Error('down'))) }),
      fakeReader([event]),
    );
    const first = await mountSettings({ deps: failing, config: shopConfig, view: choosingView });
    await click(buttonNamed(first.container, 'Sign and save'));
    await settle(() =>
      (first.container.textContent ?? '').includes(
        'Your settings are saved, but the connector could not be updated',
      ),
    );
    expect(first.container.textContent).toContain('Saved. Choose a plan in Billing to go live.');
    expect(first.container.textContent).not.toContain('published in a moment');
    expectConnectorErrorOnlyInAlert(first.container);
    await mounted?.unmount();

    const paused = sessionDeps(
      fakeApi({
        putConnector: vi.fn(async () => ({ connector: { ...CONNECTOR, enabled: false } })),
      }),
      fakeReader([event]),
    );
    const second = await mountSettings({ deps: paused, config: shopConfig, view: managedView });
    await typeInto(byId(second.container, 'store-shop-url'), 'https://tea.example/shop');
    await click(buttonNamed(second.container, 'Sign and save'));
    await settle(() => (second.container.textContent ?? '').includes('Syncing is paused'));
    expect(second.container.textContent).toContain(
      "Saved. We manage your store's plan. Message us with your Store ID to make it live. Syncing is paused",
    );
    await mounted?.unmount();

    const removed = sessionDeps(fakeApi(), fakeReader([event]));
    const third = await mountSettings({
      deps: removed,
      config: configOf(event),
      view: managedView,
    });
    await click(buttonNamed(third.container, 'Sign and save'));
    await settle(() => (third.container.textContent ?? '').includes('The connector is removed'));
    expect(third.container.textContent).toContain(
      'Message us with your Store ID to make it live. The connector is removed',
    );
    expect(third.container.textContent).not.toContain('Save your settings again');
  });

  it('says when a save pauses syncing or removes the connector, and puts nothing when there was none', async () => {
    const event = publishedConfig(NOW - 100);
    const paused = sessionDeps(
      fakeApi({
        putConnector: vi.fn(async () => ({ connector: { ...CONNECTOR, enabled: false } })),
      }),
      fakeReader([event]),
    );
    const first = await mountSettings({
      deps: paused,
      config: {
        ...configOf(event),
        source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
      },
      view: storeView({ connector: CONNECTOR }),
    });
    await typeInto(byId(first.container, 'store-shop-url'), 'https://tea.example/shop');
    await click(buttonNamed(first.container, 'Sign and save'));
    await settle(() => (first.container.textContent ?? '').includes('Syncing is paused'));
    await mounted?.unmount();

    const removed = sessionDeps(fakeApi(), fakeReader([event]));
    const second = await mountSettings({
      deps: removed,
      config: configOf(event),
      view: storeView({ connector: CONNECTOR }),
    });
    await click(buttonNamed(second.container, 'Sign and save'));
    await settle(() => (second.container.textContent ?? '').includes('The connector is removed'));
    await mounted?.unmount();

    const none = sessionDeps(fakeApi(), fakeReader([event]));
    const third = await mountSettings({ deps: none, config: configOf(event) });
    await click(buttonNamed(third.container, 'Sign and save'));
    await settle(() => vi.mocked(none.api.storeEvents).mock.calls.length === 1);
    expect(none.api.deleteConnector).not.toHaveBeenCalled();
    expect(none.api.putConnector).not.toHaveBeenCalled();
  });

  it('says the settings are saved when only the connector step failed, and puts nothing when signing failed', async () => {
    const event = publishedConfig(NOW - 100);
    const deps = sessionDeps(
      fakeApi({ putConnector: vi.fn(async () => Promise.reject(new Error('down'))) }),
      fakeReader([event]),
    );
    const { container } = await mountSettings({
      deps,
      config: {
        ...configOf(event),
        source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
      },
      view: storeView({ connector: CONNECTOR }),
    });
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() =>
      (container.textContent ?? '').includes(
        'Your settings are saved, but the connector could not be updated',
      ),
    );
    expect(deps.api.storeEvents).toHaveBeenCalledTimes(1);
    expectConnectorErrorOnlyInAlert(container);
    await mounted?.unmount();

    const failing = sessionDeps(
      fakeApi({ storeEvents: vi.fn(async () => Promise.reject(new Error('refused'))) }),
      fakeReader([event]),
    );
    const again = await mountSettings({
      deps: failing,
      config: {
        ...configOf(event),
        source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
      },
      view: storeView({ connector: CONNECTOR }),
    });
    await click(buttonNamed(again.container, 'Sign and save'));
    await settle(() => (again.container.textContent ?? '').includes('refused'));
    expect(failing.api.putConnector).not.toHaveBeenCalled();
  });

  it('offers the policy import for Shopify only, and sends it off for WooCommerce', async () => {
    const event = publishedConfig(NOW - 100);
    const deps = sessionDeps(fakeApi(), fakeReader([event]));
    const { container } = await mountSettings({ deps, config: configOf(event) });
    await chooseOption(byId(container, 'store-source'), 'connector');
    await chooseOption(byId(container, 'store-platform'), 'woocommerce');
    expect(container.textContent).not.toContain('Import the shop');
    await typeInto(byId(container, 'store-shop-url'), 'https://tea.example');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(deps.api.putConnector).mock.calls.length === 1);
    expect(vi.mocked(deps.api.putConnector).mock.calls[0]?.[0]).toMatchObject({
      platform: 'woocommerce',
      importPolicies: false,
    });
  });
});

describe('withConnector', () => {
  it('takes a feed only from a Google connector, and the currency and policy import from any', () => {
    const shop = withConnector(EMPTY_FORM, {
      platform: 'shopify',
      url: 'https://tea.example',
      currency: 'EUR',
      importPolicies: false,
    });
    expect(shop).toMatchObject({ feedUrl: '', connectorCurrency: 'EUR', importPolicies: false });
    const feed = withConnector(EMPTY_FORM, {
      platform: 'google',
      url: 'https://tea.example/feed.xml',
      importPolicies: true,
    });
    expect(feed).toMatchObject({ feedUrl: 'https://tea.example/feed.xml', connectorCurrency: '' });
    expect(withConnector(EMPTY_FORM, null)).toBe(EMPTY_FORM);
  });
});
