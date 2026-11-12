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
import type { StoreView } from '../src/lib/types';
import {
  ASSISTANT,
  NOW,
  OWNER_KEY,
  SERVER_KEY,
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

describe('the settings save', () => {
  it.each([
    ['active', storeView(), 'published to the relay in a moment'],
    [
      'pending',
      storeView({ status: 'pending', tier: null }),
      'published once your store is activated',
    ],
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
    expect(container.textContent).toContain('could not be decrypted');
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
    expect(container.textContent).not.toContain('could not be decrypted');
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
