import {
  LIMITS,
  buildCatalogAuth,
  buildConfigEvent,
  buildPolicyEvent,
  decryptPrivateConfigWith,
  parseConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorSection } from '../src/components/ConnectorSection';
import { PoliciesSection } from '../src/components/PoliciesSection';
import { Session } from '../src/components/Session';
import { SettingsSection } from '../src/components/SettingsSection';
import { ApiError } from '../src/lib/api';
import type { AdminClient } from '../src/lib/deps';
import type { ConnectorRecord, ConnectorSyncResult } from '../src/lib/types';
import {
  ASSISTANT,
  NOW,
  OWNER,
  OWNER_KEY,
  SERVER_KEY,
  SERVER_KEY_SECRET,
  adminConfig,
  catalogSyncOf,
  failingReader,
  fakeApi,
  fakeReader,
  sessionDeps,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle, typeInto } from './mount';

let mounted: Mounted | undefined;

function buttonTexts(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('button')].map((button) => button.textContent);
}
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
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

function serverAuthorization(createdAt: number): NostrEvent {
  return finalizeEvent(
    { ...buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }), created_at: createdAt },
    OWNER_KEY,
  );
}

function fieldValue(container: HTMLElement, id: string): string {
  const field = byId(container, id);
  return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
    ? field.value
    : '';
}

describe('settings', () => {
  it('edits the relay config: its fields and decrypted private part, dated after it, no repeat authorization', async () => {
    const event = publishedConfig(NOW + 100);
    const config = parseConfig(event);
    const api = fakeApi();
    const deps = sessionDeps(api, fakeReader([event, serverAuthorization(NOW - 10)]));
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
    expect(fieldValue(container, 'store-name')).toBe('Relay Tea');
    expect(fieldValue(container, 'store-instructions')).toBe('Recommend oolong.');

    await typeInto(byId(container, 'store-greeting'), 'Hello!');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const events = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(events).toHaveLength(1);
    const saved = events[0] === undefined ? undefined : parseConfig(events[0]);
    expect(saved?.createdAt).toBe(NOW + 101);
    expect(saved?.name).toBe('Relay Tea');
    expect(saved?.greeting).toBe('Hello!');
    expect(
      saved === undefined ? undefined : await decryptPrivateConfigWith(saved, deps.signer.decrypt),
    ).toEqual(PRIVATE_PART);
  });

  it('signs the server K authorization when the relay does not show it', async () => {
    const event = publishedConfig(NOW - 100);
    const api = fakeApi();
    mounted = await mount(
      <SettingsSection
        deps={sessionDeps(api, fakeReader([event]))}
        view={storeView()}
        config={parseConfig(event)}
        configError=""
        onRetry={async () => undefined}
        onSaved={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => container.querySelector('#store-name') !== null);
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    expect(vi.mocked(api.storeEvents).mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('offers no form while the config could not be read, only a retry', async () => {
    const onRetry = vi.fn(async () => undefined);
    const api = fakeApi();
    mounted = await mount(
      <SettingsSection
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView()}
        config={undefined}
        configError="The relay could not be read."
        onRetry={onRetry}
        onSaved={async () => undefined}
      />,
    );
    const { container } = mounted;
    expect(container.querySelector('#store-name')).toBeNull();
    expect(container.textContent).toContain('cannot be changed until they are read');
    await click(buttonNamed(container, 'Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(api.storeEvents).not.toHaveBeenCalled();
  });
});

describe('the session', () => {
  it('does not onboard again a store whose first settings wait on the server', async () => {
    const api = fakeApi({
      store: vi.fn(async () =>
        storeView({ status: 'pending', tier: null, events: { pending: 2, failing: [] } }),
      ),
    });
    mounted = await mount(
      <Session
        deps={sessionDeps(api, fakeReader([]))}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Overview'));
    expect(container.textContent).not.toContain('Set up your assistant');
    expect(container.textContent).toContain('2 signed changes waiting until your store is active.');
  });

  it('never onboards over a config it could not read: an error and a retry instead', async () => {
    const api = fakeApi();
    const reader = failingReader();
    const query = vi.spyOn(reader, 'query');
    mounted = await mount(
      <Session
        deps={sessionDeps(api, reader)}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Overview'));
    expect(container.textContent).not.toContain('Set up your assistant');
    const calls = query.mock.calls.length;
    await click(buttonNamed(container, 'Retry'));
    await settle(() => query.mock.calls.length > calls);
  });

  it('onboards a store with nothing signed yet', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ status: 'pending', tier: null })),
    });
    mounted = await mount(
      <Session
        deps={sessionDeps(api, fakeReader([]))}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Set up your assistant'));
  });

  async function storeReadsDuringSync(api: AdminClient, deps: ReturnType<typeof sessionDeps>) {
    vi.useFakeTimers();
    mounted = await mount(
      <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const before = vi.mocked(api.store).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    return vi.mocked(api.store).mock.calls.length - before;
  }

  const runningApi = () =>
    fakeApi({
      store: vi.fn(async () => storeView({ catalogSync: catalogSyncOf('running') })),
    });

  it('re-reads a running sync every few seconds with a key in memory', async () => {
    const api = runningApi();
    const reads = await storeReadsDuringSync(
      api,
      sessionDeps(api, fakeReader([publishedConfig(NOW - 10)])),
    );
    expect(reads).toBeGreaterThanOrEqual(3);
  });
});

describe('the connector', () => {
  const CONNECTOR: ConnectorRecord = {
    owner: OWNER,
    platform: 'shopify',
    url: 'https://tea.example',
    importPolicies: true,
    enabled: false,
    lastStatus: null,
    lastRunAt: null,
    nextRunAt: null,
  };
  const OK_PREVIEW: ConnectorSyncResult = {
    status: 'ok',
    diff: { created: ['shopify:1'], updated: [], hidden: [], unchanged: [] },
    truncated: [],
    skipped: [],
  };

  async function mountConnector() {
    const api = fakeApi({
      previewConnector: vi.fn(async () => ({ result: OK_PREVIEW })),
      putConnector: vi.fn(async () => ({ connector: CONNECTOR })),
    });
    const deps = sessionDeps(api, fakeReader([]));
    const render = (connector: ConnectorRecord) => (
      <ConnectorSection
        deps={deps}
        view={storeView({ connector })}
        config={adminConfig({
          source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
        })}
        reload={async () => undefined}
      />
    );
    mounted = await mount(render(CONNECTOR));
    return { api, container: mounted.container, render };
  }

  const SHOP_CONFIG = adminConfig({
    source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
  });

  /** A connector section whose preview answers as `previewConnector` does. */
  async function mountWith(previewConnector: AdminClient['previewConnector'], pollMs?: number) {
    const api = fakeApi({ previewConnector: vi.fn(previewConnector) });
    const reload = vi.fn(async () => undefined);
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({ connector: CONNECTOR })}
        config={SHOP_CONFIG}
        reload={reload}
        {...(pollMs === undefined ? {} : { pollMs })}
      />,
    );
    return { api, reload, container: mounted.container };
  }

  it('one press checks the shop, then turns syncing on when it can be read', async () => {
    const { api, container } = await mountConnector();
    expect(buttonTexts(container)).not.toContain('Preview first import');
    await click(buttonNamed(container, 'Turn on syncing'));
    await settle(() => (container.textContent ?? '').includes('Syncing is on.'));
    expect(api.previewConnector).toHaveBeenCalledTimes(1);
    expect(api.enableConnector).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      'Syncing is on. Products read: 1 new, 0 updated, 0 removed, 0 unchanged. The first sync starts now.',
    );
  });

  it('does not turn syncing on when the site cannot be verified, and says why', async () => {
    const { api, container } = await mountWith(async () => ({
      result: {
        status: 'verification_failed' as const,
        failures: [{ origin: 'https://tea.example', reason: 'not_found' as const }],
      },
    }));
    await click(buttonNamed(container, 'Turn on syncing'));
    await settle(() => (container.textContent ?? '').includes('could not be verified'));
    expect(api.enableConnector).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Syncing stays off');
  });

  it('a check that passes after a refusal no longer shows the refusal', async () => {
    let calls = 0;
    const { container } = await mountWith(async () => {
      calls += 1;
      return calls === 1
        ? {
            result: {
              status: 'verification_failed' as const,
              failures: [{ origin: 'https://tea.example', reason: 'not_found' as const }],
            },
          }
        : { result: OK_PREVIEW };
    });
    await click(buttonNamed(container, 'Turn on syncing'));
    await settle(() => (container.textContent ?? '').includes('Syncing stays off'));
    await click(buttonNamed(container, 'Turn on syncing'));
    await settle(() => (container.textContent ?? '').includes('Syncing is on.'));
    expect(container.textContent).not.toContain('Syncing stays off');
  });

  it('does not turn syncing on for a shop larger than the plan, and names the way up', async () => {
    const { api, container } = await mountWith(async () => ({
      result: {
        status: 'error' as const,
        message: 'The shop has 900 products, more than the 500 the plan allows',
        reason: 'too_many_products' as const,
        count: 900,
        max: 500,
      },
    }));
    await click(buttonNamed(container, 'Turn on syncing'));
    await settle(() => (container.textContent ?? '').includes('Move to a larger plan'));
    expect(api.enableConnector).not.toHaveBeenCalled();
  });

  it('turns nothing on when the page is left before the shop answers', async () => {
    let answer: (result: ConnectorSyncResult) => void = () => undefined;
    const { api, container } = await mountWith(
      () =>
        new Promise((resolve) => {
          answer = (result) => resolve({ result });
        }),
    );
    await click(buttonNamed(container, 'Turn on syncing'));
    expect(buttonNamed(container, 'Checking your shop...').disabled).toBe(true);
    await mounted?.unmount();
    mounted = undefined;
    await act(async () => {
      answer(OK_PREVIEW);
    });
    expect(api.enableConnector).not.toHaveBeenCalled();
  });

  it('turns nothing on when Cancel is pressed before the shop answers', async () => {
    let answer: (result: ConnectorSyncResult) => void = () => undefined;
    const { api, container } = await mountWith(
      () =>
        new Promise((resolve) => {
          answer = (result) => resolve({ result });
        }),
    );
    await click(buttonNamed(container, 'Turn on syncing'));
    await click(buttonNamed(container, 'Cancel'));
    await act(async () => {
      answer(OK_PREVIEW);
    });
    await settle(() => buttonTexts(container).includes('Turn on syncing'));
    expect(api.enableConnector).not.toHaveBeenCalled();
  });

  it('waits out a running sync, up to its bound, then says so', async () => {
    const { api, container } = await mountWith(async () => {
      throw new ApiError(409, 'sync_running');
    }, 1);
    await click(buttonNamed(container, 'Turn on syncing'));
    await settle(() => (container.textContent ?? '').includes('already running'));
    // The first try and 10 more, 30 s apart in use.
    expect(api.previewConnector).toHaveBeenCalledTimes(11);
    expect(api.enableConnector).not.toHaveBeenCalled();
  });

  it('a running sync, then an ok preview: syncing turns on', async () => {
    let calls = 0;
    const { api, container } = await mountWith(async () => {
      calls += 1;
      if (calls < 3) {
        throw new ApiError(409, 'sync_running');
      }
      return { result: OK_PREVIEW };
    }, 1);
    await click(buttonNamed(container, 'Turn on syncing'));
    await settle(() => (container.textContent ?? '').includes('Syncing is on.'));
    expect(api.enableConnector).toHaveBeenCalledTimes(1);
  });

  it('Cancel or leaving the page while it waits for a running sync sends nothing more', async () => {
    const refuse = async (): Promise<{ result: ConnectorSyncResult }> => {
      throw new ApiError(409, 'sync_running');
    };
    const first = await mountWith(refuse, 60_000);
    await click(buttonNamed(first.container, 'Turn on syncing'));
    await settle(() => vi.mocked(first.api.previewConnector).mock.calls.length === 1);
    await click(buttonNamed(first.container, 'Cancel'));
    await settle(() => buttonTexts(first.container).includes('Turn on syncing'));
    expect(first.api.previewConnector).toHaveBeenCalledTimes(1);
    await mounted?.unmount();
    vi.useFakeTimers();
    const second = await mountWith(refuse, 60_000);
    await click(buttonNamed(second.container, 'Turn on syncing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await mounted?.unmount();
    mounted = undefined;
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(second.api.previewConnector).toHaveBeenCalledTimes(1);
  });

  it('has no form of its own: the shop is set up in Settings', async () => {
    const { container } = await mountConnector();
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('Change the shop or its options in Settings');
  });

  it('says how to connect a shop when there is none', async () => {
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(fakeApi(), fakeReader([]))}
        view={storeView()}
        config={adminConfig()}
        reload={async () => undefined}
      />,
    );
    expect(mounted.container.textContent).toContain('choose it as your product source in Settings');
    expect(mounted.container.querySelector('button')).toBeNull();
  });

  it.each([
    [adminConfig(), 'do not name this connector'],
    [
      adminConfig({ source: { kind: 'connector', platform: 'shopify' } }),
      'do not name your shop address',
    ],
    [
      adminConfig({
        source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://other.example' },
      }),
      'another shop address',
    ],
    [
      adminConfig({
        catalogKey: OWNER,
        source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
      }),
      'another key for your products',
    ],
  ])(
    'says what the settings and the connector disagree on, and checks nothing: %#',
    async (config, text) => {
      const api = fakeApi();
      mounted = await mount(
        <ConnectorSection
          deps={sessionDeps(api, fakeReader([]))}
          view={storeView({ connector: CONNECTOR })}
          config={config}
          reload={async () => undefined}
        />,
      );
      expect(mounted.container.textContent).toContain(text);
      expect(buttonNamed(mounted.container, 'Turn on syncing').disabled).toBe(true);
    },
  );

  it('names a platform the settings do not, and takes the same shop typed another way as agreeing', async () => {
    const wrongPlatform = adminConfig({
      source: { kind: 'connector', platform: 'woocommerce', shopUrl: 'https://tea.example' },
    });
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(fakeApi(), fakeReader([]))}
        view={storeView({ connector: CONNECTOR })}
        config={wrongPlatform}
        reload={async () => undefined}
      />,
    );
    expect(mounted.container.textContent).toContain('do not name this connector');
    await mounted.unmount();
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(fakeApi(), fakeReader([]))}
        view={storeView({ connector: { ...CONNECTOR, url: 'https://tea.example/' } })}
        config={SHOP_CONFIG}
        reload={async () => undefined}
      />,
    );
    expect(mounted.container.textContent).not.toContain('disagree');
    expect(buttonNamed(mounted.container, 'Turn on syncing').disabled).toBe(false);
  });

  it('a feed needs no shop address in the settings', async () => {
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(fakeApi(), fakeReader([]))}
        view={storeView({
          connector: { ...CONNECTOR, platform: 'google', url: 'https://tea.example/feed.xml' },
        })}
        config={adminConfig({ source: { kind: 'connector', platform: 'google' } })}
        reload={async () => undefined}
      />,
    );
    expect(buttonNamed(mounted.container, 'Turn on syncing').disabled).toBe(false);
    expect(mounted.container.textContent).toContain('every site its products link to');
  });

  it('turns syncing off, and a store with no plan is sent to choose one', async () => {
    const api = fakeApi();
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({ connector: { ...CONNECTOR, enabled: true } })}
        config={SHOP_CONFIG}
        reload={async () => undefined}
      />,
    );
    await click(buttonNamed(mounted.container, 'Turn off syncing'));
    expect(api.disableConnector).toHaveBeenCalledTimes(1);
    await settle(() => (mounted?.container.textContent ?? '').includes('Syncing is off'));
    await mounted.unmount();
    const onChoosePlan = vi.fn();
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({ status: 'pending', tier: null, connector: CONNECTOR })}
        config={SHOP_CONFIG}
        reload={async () => undefined}
        onChoosePlan={onChoosePlan}
      />,
    );
    expect(mounted.container.textContent).toContain('Choose a plan to connect your shop.');
    expect(buttonTexts(mounted.container)).not.toContain('Turn on syncing');
    await click(buttonNamed(mounted.container, 'Choose a plan'));
    expect(onChoosePlan).toHaveBeenCalledTimes(1);
    await mounted.unmount();
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({ status: 'suspended', connector: CONNECTOR })}
        config={SHOP_CONFIG}
        reload={async () => undefined}
        onChoosePlan={onChoosePlan}
      />,
    );
    expect(mounted.container.textContent).toContain('Your store is not active yet');
    expect(mounted.container.textContent).not.toContain('Choose a plan to');
    expect(buttonTexts(mounted.container)).not.toContain('Turn on syncing');
  });

  it('shows what the plan allows', async () => {
    const { container } = await mountConnector();
    expect(container.textContent).toMatch(/Syncs every \d+ minutes?, up to \d+ products/);
  });
});

describe('policies', () => {
  const RETURNS = finalizeEvent(
    {
      ...buildPolicyEvent({ slug: 'returns', title: 'Returns', body: '30 days' }),
      created_at: NOW - 5,
    },
    SERVER_KEY_SECRET,
  );

  it('can be edited only when the settings read them from the server key', async () => {
    const other = getPublicKey(generateSecretKey());
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader([RETURNS]))}
        view={storeView()}
        config={adminConfig({ policyKey: other })}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('your own catalog key'));
    expect(mounted.container.textContent).not.toContain('Add a policy');
    await mounted.unmount();

    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader([RETURNS]))}
        view={storeView()}
        config={adminConfig()}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Returns'));
    expect(buttonNamed(mounted.container, 'Add a policy')).toBeDefined();
    expect(buttonNamed(mounted.container, 'Delete')).toBeDefined();
  });

  it('refuses a new policy whose short name is taken, instead of replacing that one', async () => {
    const api = fakeApi();
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(api, fakeReader([RETURNS]))}
        view={storeView()}
        config={adminConfig()}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Returns'));
    await click(buttonNamed(container, 'Add a policy'));
    await typeInto(byId(container, 'policy-slug'), 'returns');
    await typeInto(byId(container, 'policy-title'), 'New returns');
    await typeInto(byId(container, 'policy-body'), '14 days');
    await click(buttonNamed(container, 'Save'));
    expect(container.textContent).toContain('a policy named "returns" already exists');
    expect(api.putPolicy).not.toHaveBeenCalled();
  });

  it('asks before deleting, and sends one delete however often it is clicked', async () => {
    let finish: () => void = () => undefined;
    const api = fakeApi({
      deletePolicy: vi.fn(
        () =>
          new Promise<{ id: string }>((resolve) => {
            finish = () => resolve({ id: 'x' });
          }),
      ),
    });
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(api, fakeReader([RETURNS]))}
        view={storeView()}
        config={adminConfig()}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Returns'));
    await click(buttonNamed(container, 'Delete'));
    expect(api.deletePolicy).not.toHaveBeenCalled();
    await click(buttonNamed(container, 'Delete for good'));
    expect(api.deletePolicy).toHaveBeenCalledWith('returns');
    expect(buttonNamed(container, 'Delete').disabled).toBe(true);
    await click(buttonNamed(container, 'Delete'));
    expect(container.textContent).not.toContain('Delete for good');
    expect(api.deletePolicy).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
  });

  const SHOPIFY_IMPORT: ConnectorRecord = {
    owner: OWNER,
    platform: 'shopify',
    url: 'https://tea.example',
    importPolicies: true,
    enabled: true,
    lastStatus: null,
    lastRunAt: null,
    nextRunAt: null,
  };
  const SIZING = finalizeEvent(
    {
      ...buildPolicyEvent({ slug: 'sizing', title: 'Size guide', body: 'Runs small' }),
      created_at: NOW - 5,
    },
    SERVER_KEY_SECRET,
  );

  it('shows the policies a Shopify import owns read-only, and refuses a new one by their names', async () => {
    const api = fakeApi();
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(api, fakeReader([RETURNS, SIZING]))}
        view={storeView({ connector: SHOPIFY_IMPORT })}
        config={adminConfig()}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Size guide'));
    expect(container.textContent).toContain('returns - from Shopify');
    expect(container.textContent).toContain('Change those in Shopify');
    const labels = [...container.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).toContain('Edit Size guide');
    expect(labels).not.toContain('Edit Returns');
    expect(labels).not.toContain('Delete Returns');
    await click(buttonNamed(container, 'Add a policy'));
    await typeInto(byId(container, 'policy-slug'), 'shipping');
    await typeInto(byId(container, 'policy-title'), 'Shipping');
    await typeInto(byId(container, 'policy-body'), 'Two days');
    await click(buttonNamed(container, 'Save'));
    expect(container.textContent).toContain('"shipping" is imported from your Shopify store');
    expect(api.putPolicy).not.toHaveBeenCalled();
  });

  it('leaves every policy editable once the import is off', async () => {
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader([RETURNS]))}
        view={storeView({ connector: { ...SHOPIFY_IMPORT, importPolicies: false } })}
        config={adminConfig()}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Returns'));
    expect(container.textContent).not.toContain('from Shopify');
    expect(buttonNamed(container, 'Edit')).toBeDefined();
  });

  function manyPolicies(count: number, secret: Uint8Array = SERVER_KEY_SECRET): NostrEvent[] {
    return Array.from({ length: count }, (_unused, index) =>
      finalizeEvent(
        {
          ...buildPolicyEvent({ slug: `p${index}`, title: `Policy ${index}`, body: 'Text' }),
          created_at: NOW - 5,
        },
        secret,
      ),
    );
  }

  it('offers no new policy at the cap, and says only the first ones are read past it', async () => {
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader(manyPolicies(LIMITS.MAX_POLICIES)))}
        view={storeView()}
        config={adminConfig()}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Policy 0'));
    expect(mounted.container.textContent).toContain('Delete one to add another');
    expect(mounted.container.textContent).not.toContain('Add a policy');
    await mounted.unmount();

    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader(manyPolicies(LIMITS.MAX_POLICIES + 1)))}
        view={storeView()}
        config={adminConfig()}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Policy 0'));
    expect(mounted.container.textContent).toContain('the assistant does not read the ones marked');
    // The worker's pick: `p9` sorts last of p0..p50 by character order, so it is left out.
    const unread = [...mounted.container.querySelectorAll('li')].filter((row) =>
      (row.textContent ?? '').includes('not read by the assistant'),
    );
    expect(unread.map((row) => row.textContent)).toEqual([expect.stringContaining('p9')]);
  });

  it('marks as unread what the worker leaves out, imported slugs first whatever the read order', async () => {
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader([...manyPolicies(LIMITS.MAX_POLICIES), RETURNS]))}
        view={storeView()}
        config={adminConfig()}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Policy 0'));
    const unread = [...mounted.container.querySelectorAll('li')]
      .filter((row) => (row.textContent ?? '').includes('not read by the assistant'))
      .map((row) => row.textContent);
    expect(unread).toEqual([expect.stringContaining('p9')]);
  });

  it('counts the policies an import has yet to bring when marking unread ones', async () => {
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader(manyPolicies(LIMITS.MAX_POLICIES)))}
        view={storeView({ connector: SHOPIFY_IMPORT })}
        config={adminConfig()}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Policy 0'));
    const unread = [...mounted.container.querySelectorAll('li')].filter((row) =>
      (row.textContent ?? '').includes('not read by the assistant'),
    );
    expect(unread).toHaveLength(4);
    expect(mounted.container.textContent).toContain('Delete the ones it does not need');
  });

  it('tells a store on its own key to remove extra policies where it publishes them', async () => {
    const ownSecret = generateSecretKey();
    const other = getPublicKey(ownSecret);
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader(manyPolicies(LIMITS.MAX_POLICIES + 1, ownSecret)))}
        view={storeView()}
        config={adminConfig({ policyKey: other })}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Policy 0'));
    expect(mounted.container.textContent).toContain('where you publish them');
    expect(mounted.container.textContent).not.toContain('Delete the ones it does not need');
  });

  it('offers a new policy one below the cap', async () => {
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader(manyPolicies(LIMITS.MAX_POLICIES - 1)))}
        view={storeView()}
        config={adminConfig()}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Policy 0'));
    expect(buttonNamed(mounted.container, 'Add a policy')).toBeDefined();
    expect(mounted.container.textContent).not.toContain('not read by the assistant');
  });

  it('counts the places a Shopify import will take, as the server does', async () => {
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader(manyPolicies(LIMITS.MAX_POLICIES - 4)))}
        view={storeView({ connector: SHOPIFY_IMPORT })}
        config={adminConfig()}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Policy 0'));
    expect(mounted.container.textContent).toContain('counting the ones Shopify imports');
    expect(mounted.container.textContent).not.toContain('Add a policy');
  });

  it('treats a non-Shopify connector as importing nothing', async () => {
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader([RETURNS]))}
        view={storeView({ connector: { ...SHOPIFY_IMPORT, platform: 'woocommerce' } })}
        config={adminConfig()}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Returns'));
    expect(mounted.container.textContent).not.toContain('from Shopify');
    expect(buttonNamed(mounted.container, 'Edit')).toBeDefined();
  });

  it('shows no editing notes when the policies are read from another key', async () => {
    const ownSecret = generateSecretKey();
    const other = getPublicKey(ownSecret);
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader(manyPolicies(LIMITS.MAX_POLICIES, ownSecret)))}
        view={storeView({ connector: SHOPIFY_IMPORT })}
        config={adminConfig({ policyKey: other })}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('your own catalog key'));
    expect(mounted.container.textContent).toContain('Policy 49');
    expect(mounted.container.textContent).not.toContain('Delete one to add another');
    expect(mounted.container.textContent).not.toContain('Change those in Shopify');
  });
});

describe('policies right after a plan is chosen', () => {
  const RETURNS = finalizeEvent(
    {
      ...buildPolicyEvent({ slug: 'returns', title: 'Returns', body: '30 days.' }),
      created_at: NOW - 40,
    },
    SERVER_KEY_SECRET,
  );

  async function addShipping(container: HTMLElement) {
    await click(buttonNamed(container, 'Add a policy'));
    await typeInto(byId(container, 'policy-slug'), 'shipping');
    await typeInto(byId(container, 'policy-title'), 'Shipping');
    await typeInto(byId(container, 'policy-body'), 'Two days');
    await click(buttonNamed(container, 'Save'));
  }

  it('Cancel while the store is set up ends the wait and sends no further save', async () => {
    const api = fakeApi({
      putPolicy: vi.fn(async () => {
        throw new ApiError(409, 'publish_refused', { message: 'the relay refused' });
      }),
      store: vi.fn(async () => storeView({ events: { pending: 1, failing: [] } })),
    });
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(api, fakeReader([RETURNS]))}
        view={storeView()}
        config={adminConfig()}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Returns'));
    await addShipping(container);
    await settle(() => vi.mocked(api.store).mock.calls.length === 1);
    expect(buttonNamed(container, 'Saving...').disabled).toBe(true);
    await click(buttonNamed(container, 'Cancel'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(api.putPolicy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('#policy-slug')).toBeNull();
  });

  it('a store with no plan is sent to choose one; its policies still show, with no actions', async () => {
    const onChoosePlan = vi.fn();
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), fakeReader([RETURNS]))}
        view={storeView({ status: 'pending', tier: null })}
        config={adminConfig()}
        onChoosePlan={onChoosePlan}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Returns'));
    expect(container.textContent).toContain('Choose a plan to add policies.');
    expect(container.textContent).not.toContain('Add a policy');
    expect(container.textContent).not.toContain('Delete');
    expect(container.textContent).not.toContain('your own catalog key');
    await click(buttonNamed(container, 'Choose a plan'));
    expect(onChoosePlan).toHaveBeenCalledTimes(1);
  });

  it('a suspended store, or one pending on a plan we manage, keeps the inactive wording', async () => {
    for (const view of [storeView({ status: 'suspended' }), storeView({ status: 'pending' })]) {
      mounted = await mount(
        <PoliciesSection
          deps={sessionDeps(fakeApi(), fakeReader([RETURNS]))}
          view={view}
          config={adminConfig()}
          onChoosePlan={() => undefined}
        />,
      );
      await settle(() => (mounted?.container.textContent ?? '').includes('Returns'));
      expect(mounted.container.textContent).toContain('Your store is not active yet');
      expect(mounted.container.textContent).not.toContain('Choose a plan to');
      expect(mounted.container.textContent).not.toContain('Add a policy');
      await mounted.unmount();
      mounted = undefined;
    }
  });
});

describe('review round 1: policies and the connector', () => {
  const RETURNS = finalizeEvent(
    {
      ...buildPolicyEvent({ slug: 'returns', title: 'Returns', body: '30 days.' }),
      created_at: NOW - 40,
    },
    SERVER_KEY_SECRET,
  );

  async function startShipping(api: AdminClient) {
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(api, fakeReader([RETURNS]))}
        view={storeView()}
        config={adminConfig()}
        pollMs={5}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Returns'));
    await click(buttonNamed(container, 'Add a policy'));
    await typeInto(byId(container, 'policy-slug'), 'shipping');
    await typeInto(byId(container, 'policy-title'), 'Shipping');
    await typeInto(byId(container, 'policy-body'), 'Two days');
    await click(buttonNamed(container, 'Save'));
    return container;
  }

  const refusingApi = () =>
    fakeApi({
      putPolicy: vi.fn(async () => {
        throw new ApiError(409, 'publish_refused', { message: 'the relay refused' });
      }),
      store: vi.fn(async () => storeView({ events: { pending: 1, failing: [] } })),
    });

  it('says why a save waits, and Cancel ends it with no further save', async () => {
    const api = refusingApi();
    const container = await startShipping(api);
    await settle(() =>
      (container.textContent ?? '').includes('Your store is being set up, your change goes out'),
    );
    await click(buttonNamed(container, 'Cancel'));
    const puts = vi.mocked(api.putPolicy).mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(api.putPolicy).toHaveBeenCalledTimes(puts);
  });

  it('leaving the page ends the wait with no further save', async () => {
    const api = refusingApi();
    await startShipping(api);
    await settle(() => vi.mocked(api.store).mock.calls.length >= 1);
    await mounted?.unmount();
    mounted = undefined;
    const puts = vi.mocked(api.putPolicy).mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(api.putPolicy).toHaveBeenCalledTimes(puts);
  });

  it('Cancel is off while a save is in flight, so its answer is not lost', async () => {
    let answer: () => void = () => undefined;
    const api = fakeApi({
      putPolicy: vi.fn(
        () =>
          new Promise<{ id: string }>((resolve) => {
            answer = () => resolve({ id: 'p' });
          }),
      ),
    });
    const container = await startShipping(api);
    expect(buttonNamed(container, 'Cancel').disabled).toBe(true);
    await act(async () => {
      answer();
    });
    await settle(() => container.querySelector('#policy-slug') === null);
  });

  it('turning on reads the store again, and Cancel goes once turning on has begun', async () => {
    let enabled: () => void = () => undefined;
    const api = fakeApi({
      previewConnector: vi.fn(async () => ({
        result: {
          status: 'ok' as const,
          diff: { created: [], updated: [], hidden: [], unchanged: [] },
          truncated: [],
          skipped: [],
        },
      })),
      enableConnector: vi.fn(
        () =>
          new Promise<{ connector: null }>((resolve) => {
            enabled = () => resolve({ connector: null });
          }),
      ),
    });
    const reload = vi.fn(async () => undefined);
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({
          connector: {
            owner: OWNER,
            platform: 'shopify',
            url: 'https://tea.example',
            importPolicies: false,
            enabled: false,
            lastStatus: null,
            lastRunAt: null,
            nextRunAt: null,
          },
        })}
        config={adminConfig({
          source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
        })}
        reload={reload}
      />,
    );
    const { container } = mounted;
    await click(buttonNamed(container, 'Turn on syncing'));
    await settle(() => vi.mocked(api.enableConnector).mock.calls.length === 1);
    expect(buttonTexts(container)).not.toContain('Cancel');
    await act(async () => {
      enabled();
    });
    await settle(() => (container.textContent ?? '').includes('Syncing is on.'));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('review round 3: a policy save taken back', () => {
  it('reads nothing more and leaves the editor opened next alone', async () => {
    const reader = fakeReader([
      finalizeEvent(
        {
          ...buildPolicyEvent({ slug: 'returns', title: 'Returns', body: '30 days.' }),
          created_at: NOW - 40,
        },
        SERVER_KEY_SECRET,
      ),
    ]);
    const query = vi.spyOn(reader, 'query');
    const api = fakeApi({
      putPolicy: vi.fn(async () => {
        throw new ApiError(409, 'publish_refused', { message: 'the relay refused' });
      }),
      store: vi.fn(async () => storeView({ events: { pending: 1, failing: [] } })),
    });
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(api, reader)}
        view={storeView()}
        config={adminConfig()}
        pollMs={60_000}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Returns'));
    await click(buttonNamed(container, 'Add a policy'));
    await typeInto(byId(container, 'policy-slug'), 'shipping');
    await typeInto(byId(container, 'policy-title'), 'Shipping');
    await typeInto(byId(container, 'policy-body'), 'Two days');
    await click(buttonNamed(container, 'Save'));
    await settle(() => (container.textContent ?? '').includes('Your store is being set up'));
    const reads = query.mock.calls.length;
    await click(buttonNamed(container, 'Cancel'));
    await click(buttonNamed(container, 'Add a policy'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(query).toHaveBeenCalledTimes(reads);
    expect(container.querySelector('#policy-slug')).not.toBeNull();
  });
});

describe('review round 12', () => {
  it('turning on stops at a refusal other than a running sync', async () => {
    const api = fakeApi({
      previewConnector: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized');
      }),
    });
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({
          connector: {
            owner: OWNER,
            platform: 'shopify',
            url: 'https://tea.example',
            importPolicies: false,
            enabled: false,
            lastStatus: null,
            lastRunAt: null,
            nextRunAt: null,
          },
        })}
        config={adminConfig({
          source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
        })}
        reload={async () => undefined}
        pollMs={1}
      />,
    );
    const { container } = mounted;
    await click(buttonNamed(container, 'Turn on syncing'));
    await settle(() =>
      (container.textContent ?? '').includes('The server did not accept your signature.'),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(api.previewConnector).toHaveBeenCalledTimes(1);
    expect(api.enableConnector).not.toHaveBeenCalled();
  });

  it('a policy save that failed leaves Cancel working, for this editor and the next', async () => {
    const reader = fakeReader([
      finalizeEvent(
        {
          ...buildPolicyEvent({ slug: 'returns', title: 'Returns', body: '30 days.' }),
          created_at: NOW - 40,
        },
        SERVER_KEY_SECRET,
      ),
    ]);
    const api = fakeApi({
      putPolicy: vi.fn(async () => {
        throw new ApiError(400, 'bad_request');
      }),
    });
    mounted = await mount(
      <PoliciesSection deps={sessionDeps(api, reader)} view={storeView()} config={adminConfig()} />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Returns'));
    await click(buttonNamed(container, 'Add a policy'));
    await typeInto(byId(container, 'policy-slug'), 'shipping');
    await typeInto(byId(container, 'policy-title'), 'Shipping');
    await typeInto(byId(container, 'policy-body'), 'Two days');
    await click(buttonNamed(container, 'Save'));
    await settle(() =>
      (container.textContent ?? '').includes('The server could not read the request'),
    );
    expect(buttonNamed(container, 'Cancel').disabled).toBe(false);
    await click(buttonNamed(container, 'Cancel'));
    expect(container.querySelector('#policy-slug')).toBeNull();
    await click(buttonNamed(container, 'Add a policy'));
    expect(buttonNamed(container, 'Cancel').disabled).toBe(false);
  });
});

describe('policies, the sweep', () => {
  const RETURNS = finalizeEvent(
    {
      ...buildPolicyEvent({ slug: 'returns', title: 'Returns', body: '30 days.' }),
      created_at: NOW - 40,
    },
    SERVER_KEY_SECRET,
  );
  const refusingApi = () =>
    fakeApi({
      putPolicy: vi.fn(async () => {
        throw new ApiError(409, 'publish_refused', { message: 'the relay refused' });
      }),
      store: vi.fn(async () => storeView({ events: { pending: 1, failing: [] } })),
    });
  const section = (api: AdminClient, config: ReturnType<typeof adminConfig>, pollMs: number) => (
    <PoliciesSection
      deps={sessionDeps(api, fakeReader([RETURNS]))}
      view={storeView()}
      config={config}
      pollMs={pollMs}
    />
  );
  async function startShipping(container: HTMLElement) {
    await settle(() => (container.textContent ?? '').includes('Returns'));
    await click(buttonNamed(container, 'Add a policy'));
    await typeInto(byId(container, 'policy-slug'), 'shipping');
    await typeInto(byId(container, 'policy-title'), 'Shipping');
    await typeInto(byId(container, 'policy-body'), 'Two days');
    await click(buttonNamed(container, 'Save'));
  }

  it('a save waiting while the store is set up ends when its editor leaves the page', async () => {
    const api = refusingApi();
    mounted = await mount(section(api, adminConfig(), 5));
    const { container } = mounted;
    await startShipping(container);
    await settle(() => vi.mocked(api.store).mock.calls.length >= 1);
    // The settings now read policies from another key: the editor goes, the section stays.
    await mounted.rerender(
      section(api, adminConfig({ policyKey: getPublicKey(generateSecretKey()) }), 5),
    );
    expect(container.querySelector('#policy-slug')).toBeNull();
    const puts = vi.mocked(api.putPolicy).mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(api.putPolicy).toHaveBeenCalledTimes(puts);
  });

  it.each(['cancel', 'unmount'])(
    'a save waiting while the store is set up stops at once on %s, no timer left',
    async (how) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const api = refusingApi();
      mounted = await mount(section(api, adminConfig(), 600_000));
      const { container } = mounted;
      await startShipping(container);
      await settle(() => (container.textContent ?? '').includes('Your store is being set up'));
      const before = vi.getTimerCount();
      if (how === 'cancel') {
        await click(buttonNamed(container, 'Cancel'));
      } else {
        await mounted.unmount();
        mounted = undefined;
      }
      expect(vi.getTimerCount()).toBe(before - 1);
      expect(api.putPolicy).toHaveBeenCalledTimes(1);
    },
  );
});

describe('confirmation round: the connector', () => {
  it('Turn off syncing reads the store again', async () => {
    const api = fakeApi();
    const reload = vi.fn(async () => undefined);
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({
          connector: {
            owner: OWNER,
            platform: 'shopify',
            url: 'https://tea.example',
            importPolicies: false,
            enabled: true,
            lastStatus: null,
            lastRunAt: null,
            nextRunAt: null,
          },
        })}
        config={adminConfig({
          source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
        })}
        reload={reload}
      />,
    );
    const { container } = mounted;
    await click(buttonNamed(container, 'Turn off syncing'));
    await settle(() => (container.textContent ?? '').includes('Syncing is off'));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
