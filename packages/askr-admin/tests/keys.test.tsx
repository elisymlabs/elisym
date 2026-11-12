import {
  KIND_CATALOG_AUTH,
  buildCatalogAuth,
  buildCatalogRevocation,
  buildConfigEvent,
  decryptPrivateConfig,
  parseConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogKeys } from '../src/components/CatalogKeys';
import { RotateAssistant } from '../src/components/RotateAssistant';
import {
  ASSISTANT,
  NOW,
  OWNER,
  OWNER_KEY,
  SERVER_KEY,
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
});

function tagOf(event: NostrEvent | undefined, name: string): string | undefined {
  return event?.tags.find((tag) => tag[0] === name)?.[1];
}

function signedAuth(key: string, createdAt: number): NostrEvent {
  return finalizeEvent(
    {
      ...buildCatalogAuth({ key, mode: key === SERVER_KEY ? 'hosted' : 'self-host' }),
      created_at: createdAt,
    },
    OWNER_KEY,
  );
}

function signedConfig(name: string, createdAt: number, privatePart = PRIVATE_PART): NostrEvent {
  return finalizeEvent(
    {
      ...buildConfigEvent(
        {
          assistant: ASSISTANT,
          origins: ['https://tea.example'],
          name,
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: SERVER_KEY,
          private: privatePart,
        },
        OWNER_KEY,
      ),
      created_at: createdAt,
    },
    OWNER_KEY,
  );
}

const PRIVATE_PART = { voice: 'calm', instructions: 'Be brief.', notes: '' };

function configOf(event: NostrEvent) {
  const config = parseConfig(event);
  if (config === undefined) {
    throw new Error('config does not parse');
  }
  return config;
}

async function mountKeys(events: NostrEvent[], api = fakeApi()) {
  mounted = await mount(
    <CatalogKeys
      deps={sessionDeps(api, fakeReader(events))}
      view={storeView()}
      config={undefined}
    />,
  );
  const { container } = mounted;
  await settle(() => (container.textContent ?? '').includes(nip19.npubEncode(SERVER_KEY)));
  return { api, container };
}

describe('catalog keys', () => {
  it('lists the keys O authorizes and authorizes a pasted merchant npub self-host', async () => {
    const { api, container } = await mountKeys([signedAuth(SERVER_KEY, NOW - 10)]);
    expect(container.textContent).toContain('the server key of this admin');

    const merchantKey = getPublicKey(generateSecretKey());
    await typeInto(byId(container, 'authorize-key'), nip19.npubEncode(merchantKey));
    await click(buttonNamed(container, 'Sign and authorize'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const [authorization] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(authorization?.kind).toBe(KIND_CATALOG_AUTH);
    expect(authorization?.pubkey).toBe(OWNER);
    expect(tagOf(authorization, 'd')).toBe(merchantKey);
    expect(tagOf(authorization, 'mode')).toBe('self-host');
  });

  it('authorizes the server K pasted back as hosted', async () => {
    const { api, container } = await mountKeys([signedAuth(SERVER_KEY, NOW - 10)]);
    await typeInto(byId(container, 'authorize-key'), SERVER_KEY);
    await click(buttonNamed(container, 'Sign and authorize'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const [authorization] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(tagOf(authorization, 'mode')).toBe('hosted');
    expect(authorization?.created_at).toBe(NOW);
  });

  it('asks before revoking, louder for a key the store relies on, and only then signs', async () => {
    const { api, container } = await mountKeys([signedAuth(SERVER_KEY, NOW - 10)]);
    await click(buttonNamed(container, 'Revoke'));
    expect(api.storeEvents).not.toHaveBeenCalled();
    expect(container.textContent).toContain('This key is the server key of this admin');
    await click(buttonNamed(container, 'Keep it'));
    expect(container.textContent).not.toContain('This key is');
    expect(api.storeEvents).not.toHaveBeenCalled();

    await click(buttonNamed(container, 'Revoke'));
    await click(buttonNamed(container, 'Revoke this key'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const [revocation] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(tagOf(revocation, 'd')).toBe(SERVER_KEY);
    expect(tagOf(revocation, 'mode')).toBe('revoked');
  });

  it('dates a revocation after an authorization dated ahead of now, so it wins', async () => {
    const { api, container } = await mountKeys([
      signedAuth(SERVER_KEY, NOW - 10),
      signedAuth(SERVER_KEY, NOW + 30),
    ]);
    await click(buttonNamed(container, 'Revoke'));
    await click(buttonNamed(container, 'Revoke this key'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const [revocation] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(revocation?.created_at).toBe(NOW + 31);
  });
});

describe('authorizing', () => {
  it('re-authorizes a key after a revocation dated ahead of now, so the new one wins', async () => {
    const merchant = getPublicKey(generateSecretKey());
    const revocation = finalizeEvent(
      { ...buildCatalogRevocation(merchant), created_at: NOW + 30 },
      OWNER_KEY,
    );
    const { api, container } = await mountKeys([signedAuth(SERVER_KEY, NOW - 10), revocation]);
    await typeInto(byId(container, 'authorize-key'), merchant);
    await click(buttonNamed(container, 'Sign and authorize'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const [authorization] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(tagOf(authorization, 'mode')).toBe('self-host');
    expect(authorization?.created_at).toBe(NOW + 31);
  });

  it('is not offered while the authorizations could not be read', async () => {
    const api = fakeApi();
    mounted = await mount(
      <CatalogKeys
        deps={sessionDeps(api, failingReader())}
        view={storeView()}
        config={undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('could not be read'));
    await typeInto(byId(container, 'authorize-key'), SERVER_KEY);
    expect(buttonNamed(container, 'Sign and authorize').disabled).toBe(true);
    await click(buttonNamed(container, 'Sign and authorize'));
    expect(api.storeEvents).not.toHaveBeenCalled();
  });
});

describe('assistant rotation', () => {
  async function mountRotate(options: {
    config: ReturnType<typeof configOf> | undefined;
    configError?: string;
    api?: ReturnType<typeof fakeApi>;
    deps?: ReturnType<typeof sessionDeps>;
    onRetry?: () => Promise<void>;
  }) {
    const api = options.api ?? fakeApi();
    const deps = options.deps ?? sessionDeps(api, fakeReader([]));
    mounted = await mount(
      <RotateAssistant
        deps={deps}
        view={storeView()}
        config={options.config}
        configError={options.configError ?? ''}
        onRetry={options.onRetry ?? (async () => undefined)}
        onChanged={async () => undefined}
      />,
    );
    return { api, container: mounted.container };
  }

  it('re-signs the published config naming the next assistant, private part sealed to it', async () => {
    const config = configOf(signedConfig('Tea Shop', NOW - 100));
    const nextKey = generateSecretKey();
    const next = getPublicKey(nextKey);
    const api = fakeApi({ rotateAssistant: vi.fn(async () => ({ nextAssistant: next })) });
    const { container } = await mountRotate({ config, api });
    await click(buttonNamed(container, 'Rotate assistant key'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);

    const events = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(events).toHaveLength(1);
    const rotated = events[0] === undefined ? undefined : parseConfig(events[0]);
    expect(rotated?.assistant).toBe(next);
    expect(rotated?.name).toBe('Tea Shop');
    expect(rotated?.createdAt).toBeGreaterThan(config.createdAt);
    expect(rotated === undefined ? undefined : decryptPrivateConfig(rotated, nextKey)).toEqual(
      PRIVATE_PART,
    );
    expect(container.textContent).toContain('current assistant keeps answering');
  });

  it('signs from a newer config this session saved but the relay does not show yet', async () => {
    const api = fakeApi({
      rotateAssistant: vi.fn(async () => ({ nextAssistant: getPublicKey(generateSecretKey()) })),
    });
    const deps = sessionDeps(api, fakeReader([]));
    const saved = signedConfig('Tea Shop renamed', NOW + 5);
    deps.journal.note([saved]);
    const { container } = await mountRotate({
      config: configOf(signedConfig('Tea Shop', NOW - 100)),
      api,
      deps,
    });
    await click(buttonNamed(container, 'Rotate assistant key'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const [rotated] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(rotated === undefined ? undefined : parseConfig(rotated)?.name).toBe('Tea Shop renamed');
    expect(rotated?.created_at).toBe(NOW + 6);
  });

  it('refuses before rotating when the private part cannot be decrypted', async () => {
    const config = { ...configOf(signedConfig('Tea Shop', NOW - 100)), privateContent: 'garbage' };
    const { api, container } = await mountRotate({ config });
    await click(buttonNamed(container, 'Rotate assistant key'));
    await settle(() => (container.textContent ?? '').includes('could not be decrypted'));
    expect(api.rotateAssistant).not.toHaveBeenCalled();
    expect(api.storeEvents).not.toHaveBeenCalled();
  });

  it('does not start while the config could not be read, and offers a retry', async () => {
    const onRetry = vi.fn(async () => undefined);
    const { api, container } = await mountRotate({
      config: undefined,
      configError: 'The relay could not be read.',
      onRetry,
    });
    expect(buttonNamed(container, 'Rotate assistant key').disabled).toBe(true);
    await click(buttonNamed(container, 'Rotate assistant key'));
    expect(api.rotateAssistant).not.toHaveBeenCalled();
    await click(buttonNamed(container, 'Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
