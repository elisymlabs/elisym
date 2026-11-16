import {
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  buildCatalogAuth,
  buildConfigEvent,
  decryptPrivateConfig,
  parseConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { KeysSection } from '../src/components/KeysSection';
import { Session } from '../src/components/Session';
import { ApiError } from '../src/lib/api';
import type { SessionDeps } from '../src/lib/deps';
import { errorMessage } from '../src/lib/errors';
import { secretKeySigner } from '../src/lib/signer';
import {
  NOW,
  OWNER,
  OWNER_KEY,
  SERVER_KEY,
  fakeApi,
  fakeReader,
  sessionDeps,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, click, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** The previous owner key, its assistant key, and a key it authorized for its own backend. */
const OLD_KEY = generateSecretKey();
const OLD = getPublicKey(OLD_KEY);
const ASSISTANT_KEY = generateSecretKey();
const ASSISTANT = getPublicKey(ASSISTANT_KEY);
const BACKEND = getPublicKey(generateSecretKey());
const PRIVATE_PART = { voice: 'warm', instructions: 'Sell tea', notes: 'n' };

function oldConfig(): NostrEvent {
  return finalizeEvent(
    buildConfigEvent(
      {
        assistant: ASSISTANT,
        origins: ['https://tea.example'],
        name: 'Moved Tea',
        language: 'en',
        currency: 'USD',
        source: { kind: 'admin' },
        catalogKey: SERVER_KEY,
        private: PRIVATE_PART,
        createdAt: NOW - 500,
      },
      OLD_KEY,
    ),
    OLD_KEY,
  );
}

/** A config the signed-in owner published, so the dashboard opens. */
function ownConfig(): NostrEvent {
  return finalizeEvent(
    buildConfigEvent(
      {
        assistant: ASSISTANT,
        origins: ['https://tea.example'],
        name: 'Own Tea',
        language: 'en',
        currency: 'USD',
        source: { kind: 'admin' },
        catalogKey: SERVER_KEY,
        createdAt: NOW - 500,
      },
      OWNER_KEY,
    ),
    OWNER_KEY,
  );
}

function oldAuthorizations(): NostrEvent[] {
  return [SERVER_KEY, BACKEND].map((key) =>
    finalizeEvent(
      buildCatalogAuth({
        key,
        mode: key === SERVER_KEY ? 'hosted' : 'self-host',
        createdAt: NOW - 400,
      }),
      OLD_KEY,
    ),
  );
}

function movedDeps(config: NostrEvent | null): SessionDeps {
  const api = fakeApi({
    store: vi.fn(async () => storeView({ movedFrom: OLD, assistant: ASSISTANT })),
    movedSettings: vi.fn(async () => ({ from: OLD, config, private: PRIVATE_PART })),
  });
  return sessionDeps(api, fakeReader(oldAuthorizations()));
}

describe('finishing a move to a new secret key (K20)', () => {
  it('signs the previous settings again with the new key, and every catalog key it authorized', async () => {
    const deps = movedDeps(oldConfig());
    mounted = await mount(
      <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
    );
    await settle(() => vi.mocked(deps.api.storeEvents).mock.calls.length > 0);
    const signed = vi.mocked(deps.api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(signed.every((event) => event.pubkey === OWNER)).toBe(true);
    const config = signed.find((event) => event.kind === KIND_CONFIG);
    const parsed = config === undefined ? undefined : parseConfig(config);
    expect(parsed?.name).toBe('Moved Tea');
    expect(parsed?.assistant).toBe(ASSISTANT);
    expect(parsed?.origins).toEqual(['https://tea.example']);
    // The private part is sealed again, for the same assistant, from the new key.
    expect(parsed === undefined ? undefined : decryptPrivateConfig(parsed, ASSISTANT_KEY)).toEqual(
      PRIVATE_PART,
    );
    const authorized = signed
      .filter((event) => event.kind === KIND_CATALOG_AUTH)
      .map((event) => event.tags.find((tag) => tag[0] === 'd')?.[1]);
    expect(authorized.sort()).toEqual([SERVER_KEY, BACKEND].sort());
  });

  it('sets up anew when the previous settings are not found', async () => {
    const deps = movedDeps(null);
    mounted = await mount(
      <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Set up your assistant'));
    expect(deps.api.storeEvents).not.toHaveBeenCalled();
  });

  it('refuses settings the server says the old key signed but did not', async () => {
    const forged = finalizeEvent({ ...oldConfig(), created_at: NOW - 400 }, OWNER_KEY);
    const deps = movedDeps(forged);
    mounted = await mount(
      <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Set up your assistant'));
    expect(deps.api.storeEvents).not.toHaveBeenCalled();
  });

  it('shows the failure and retries on request', async () => {
    const deps = movedDeps(oldConfig());
    vi.mocked(deps.api.storeEvents).mockRejectedValueOnce(new ApiError(0, 'network'));
    mounted = await mount(
      <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('could not be reached'));
    await click(buttonNamed(container, 'Retry'));
    await settle(() => vi.mocked(deps.api.storeEvents).mock.calls.length === 2);
  });
});

describe('replacing the key from the admin (K20)', () => {
  it('asks first, then hands over to the replacement', async () => {
    const onReplaceKey = vi.fn();
    mounted = await mount(
      <KeysSection
        deps={sessionDeps(fakeApi(), fakeReader([]))}
        view={storeView()}
        config={undefined}
        configError=""
        onRetry={async () => undefined}
        onChanged={async () => undefined}
        onReplaceKey={onReplaceKey}
      />,
    );
    const { container } = mounted;
    await click(buttonNamed(container, 'Replace my secret key'));
    expect(onReplaceKey).not.toHaveBeenCalled();
    await click(buttonNamed(container, 'Continue'));
    expect(onReplaceKey).toHaveBeenCalledTimes(1);
  });

  it('signs out to the replacement, filled in with this Store ID', async () => {
    const recover = vi.fn(async () => storeView());
    const createDeps = vi.fn((signer: ReturnType<typeof secretKeySigner>) =>
      sessionDeps(fakeApi({ recover }), fakeReader([ownConfig()]), signer),
    );
    mounted = await mount(<App createDeps={createDeps} />);
    const { container } = mounted;
    const field = container.querySelector('#owner-key');
    if (!(field instanceof HTMLInputElement)) {
      throw new Error('no key field');
    }
    field.value = nsecEncode(OWNER_KEY);
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => (container.textContent ?? '').includes('Advanced'));
    await click(buttonNamed(container, 'Advanced'));
    await click(buttonNamed(container, 'Replace my secret key'));
    await click(buttonNamed(container, 'Continue'));
    const storeField = container.querySelector('#recover-store');
    expect(storeField instanceof HTMLInputElement && storeField.value).toBe(npubEncode(OWNER));
  });
});

describe('recovery errors in plain words (K20)', () => {
  it.each([
    [new ApiError(409, 'no_site_yet', { readyAt: NOW }), 'Try again after'],
    [new ApiError(409, 'no_site_yet', { readyAt: null }), 'lists no site'],
    [new ApiError(409, 'site_not_proven', { failures: 'x' }), "None of your store's sites"],
    [
      new ApiError(409, 'site_not_proven', {
        failures: [
          { origin: 'https://a.example', reason: 'blocked' },
          { origin: 'https://b.example', reason: 'fetch_failed' },
          { origin: 'https://c.example', reason: 'odd' },
          { nothing: true },
        ],
      }),
      'https://a.example: refused our check (often a bot filter in front of the site); https://b.example: could not be reached; https://c.example: not proven.',
    ],
    [new ApiError(409, 'paycore_source'), 'Contact us'],
    [new ApiError(409, 'key_in_use'), 'already belongs to a store'],
    [new ApiError(409, 'moved'), 'already moved'],
    [new ApiError(404, 'no_store'), 'no store with this Store ID'],
  ])('%s', (error, text) => {
    expect(errorMessage(error)).toContain(text);
  });
});
