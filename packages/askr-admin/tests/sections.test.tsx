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
import type { AdminClient } from '../src/lib/deps';
import { extensionSigner, secretKeySigner } from '../src/lib/signer';
import type { ConnectorRecord, ConnectorSyncResult } from '../src/lib/types';
import {
  ASSISTANT,
  NOW,
  NIP44_STUB,
  OWNER,
  OWNER_KEY,
  SERVER_KEY,
  SERVER_KEY_SECRET,
  adminConfig,
  failingReader,
  fakeApi,
  fakeReader,
  sessionDeps,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle, typeInto } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
});

const PRIVATE_PART = { voice: 'calm', instructions: 'Recommend oolong.', notes: 'Berlin' };
const EMPTY_DIFF = { created: [], updated: [], hidden: [], unchanged: [] };

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
      <Session deps={sessionDeps(api, fakeReader([]))} onSignOut={() => undefined} />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Overview'));
    expect(container.textContent).not.toContain('Set up your assistant');
    expect(container.textContent).toContain('2 signed changes waiting for activation');
  });

  it('never onboards over a config it could not read: an error and a retry instead', async () => {
    const api = fakeApi();
    const reader = failingReader();
    const query = vi.spyOn(reader, 'query');
    mounted = await mount(<Session deps={sessionDeps(api, reader)} onSignOut={() => undefined} />);
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
      <Session deps={sessionDeps(api, fakeReader([]))} onSignOut={() => undefined} />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Set up your assistant'));
  });

  async function storeReadsDuringSync(api: AdminClient, deps: ReturnType<typeof sessionDeps>) {
    vi.useFakeTimers();
    mounted = await mount(<Session deps={deps} onSignOut={() => undefined} />);
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
      store: vi.fn(async () => storeView({ catalogSync: { state: 'running', diff: EMPTY_DIFF } })),
    });

  it('re-reads a running sync every few seconds with a key in memory', async () => {
    const api = runningApi();
    const reads = await storeReadsDuringSync(
      api,
      sessionDeps(api, fakeReader([publishedConfig(NOW - 10)])),
    );
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('re-reads it only every 30 seconds with an extension, which may prompt for each', async () => {
    const api = runningApi();
    const signer = await extensionSigner({
      getPublicKey: async () => OWNER,
      nip44: NIP44_STUB,
      signEvent: async (template) => secretKeySigner(OWNER_KEY).signEvent(template),
    });
    const reads = await storeReadsDuringSync(
      api,
      sessionDeps(api, fakeReader([publishedConfig(NOW - 10)]), signer),
    );
    expect(reads).toBe(0);
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

  it('turns syncing on only after an ok preview of the connector as saved', async () => {
    const { api, container } = await mountConnector();
    expect(buttonNamed(container, 'Turn on syncing').disabled).toBe(true);
    await click(buttonNamed(container, 'Preview first import'));
    await settle(() => !buttonNamed(container, 'Turn on syncing').disabled);
    await click(buttonNamed(container, 'Turn on syncing'));
    expect(api.enableConnector).toHaveBeenCalledTimes(1);
  });

  it('does not turn syncing on after a preview that failed verification', async () => {
    const api = fakeApi({
      previewConnector: vi.fn(async () => ({
        result: {
          status: 'verification_failed' as const,
          failures: [{ origin: 'https://tea.example', reason: 'not_found' as const }],
        },
      })),
    });
    mounted = await mount(
      <ConnectorSection
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({ connector: CONNECTOR })}
        config={adminConfig()}
        reload={async () => undefined}
      />,
    );
    const { container } = mounted;
    await click(buttonNamed(container, 'Preview first import'));
    await settle(() => (container.textContent ?? '').includes('could not be verified'));
    expect(buttonNamed(container, 'Turn on syncing').disabled).toBe(true);
  });

  it('drops the preview on any edit and on a save, so another shop is never turned on unseen', async () => {
    const { container } = await mountConnector();
    await click(buttonNamed(container, 'Preview first import'));
    await settle(() => !buttonNamed(container, 'Turn on syncing').disabled);
    await typeInto(byId(container, 'connector-currency'), 'EUR');
    expect(buttonNamed(container, 'Turn on syncing').disabled).toBe(true);
    // Back to what is saved: a new preview is still needed.
    await typeInto(byId(container, 'connector-currency'), '');
    expect(buttonNamed(container, 'Preview first import').disabled).toBe(false);
    expect(buttonNamed(container, 'Turn on syncing').disabled).toBe(true);

    await click(buttonNamed(container, 'Preview first import'));
    await settle(() => !buttonNamed(container, 'Turn on syncing').disabled);
    await click(buttonNamed(container, 'Save connector'));
    await settle(() => (container.textContent ?? '').includes('Connector saved'));
    expect(buttonNamed(container, 'Turn on syncing').disabled).toBe(true);
  });

  it('turns syncing off when the saved connector changes elsewhere after a preview', async () => {
    const { container, render } = await mountConnector();
    await click(buttonNamed(container, 'Preview first import'));
    await settle(() => !buttonNamed(container, 'Turn on syncing').disabled);
    await mounted?.rerender(render({ ...CONNECTOR, url: 'https://other.example' }));
    expect(buttonNamed(container, 'Turn on syncing').disabled).toBe(true);
  });

  it('previews only the saved connector: unsaved edits need a save first, and the preview names its address', async () => {
    const { api, container, render } = await mountConnector();
    await typeInto(byId(container, 'connector-url'), 'https://other.example');
    expect(buttonNamed(container, 'Preview first import').disabled).toBe(true);
    expect(buttonNamed(container, 'Turn on syncing').disabled).toBe(true);
    expect(container.textContent).toContain('Save the connector to preview these settings');
    await click(buttonNamed(container, 'Preview first import'));
    expect(api.previewConnector).not.toHaveBeenCalled();

    await click(buttonNamed(container, 'Save connector'));
    await settle(() => vi.mocked(api.putConnector).mock.calls.length === 1);
    await mounted?.rerender(render({ ...CONNECTOR, url: 'https://other.example' }));
    expect(buttonNamed(container, 'Preview first import').disabled).toBe(false);
    await click(buttonNamed(container, 'Preview first import'));
    await settle(() =>
      (container.textContent ?? '').includes('Of https://other.example, as saved'),
    );
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
    await click(buttonNamed(container, 'Publish'));
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
    await click(buttonNamed(container, 'Publish'));
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
