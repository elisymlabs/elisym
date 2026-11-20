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
  // App marks this tab on a sign-in (`tab-session`): no mark is left for the next test.
  sessionStorage.clear();
});

/** The previous owner key, its assistant key, and a key it authorized for its own backend. */
const OLD_KEY = generateSecretKey();
const OLD = getPublicKey(OLD_KEY);
const ASSISTANT_KEY = generateSecretKey();
const ASSISTANT = getPublicKey(ASSISTANT_KEY);
const BACKEND = getPublicKey(generateSecretKey());
const PRIVATE_PART = { voice: 'warm', instructions: 'Sell tea', notes: 'n' };

function oldConfig(source: 'admin' | 'catalog' = 'admin'): NostrEvent {
  return finalizeEvent(
    buildConfigEvent(
      {
        assistant: ASSISTANT,
        origins: ['https://tea.example'],
        name: 'Moved Tea',
        language: 'en',
        currency: 'USD',
        source: { kind: source },
        catalogKey: source === 'catalog' ? BACKEND : SERVER_KEY,
        private: PRIVATE_PART,
        createdAt: NOW - 500,
      },
      OLD_KEY,
    ),
    OLD_KEY,
  );
}

/** The old config, signed again by the old key with a paycore source, which no reader takes. */
function paycoreConfig(): NostrEvent {
  const valid = oldConfig();
  return finalizeEvent(
    {
      kind: valid.kind,
      created_at: valid.created_at,
      tags: valid.tags.map((tag) => (tag[0] === 'source' ? ['source', 'paycore'] : tag)),
      content: valid.content,
    },
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

function movedDeps(
  config: NostrEvent | null,
  privatePart: unknown = PRIVATE_PART,
  chain: { from: string; signedBy: string | null } = { from: OLD, signedBy: OLD },
): SessionDeps {
  const api = fakeApi({
    store: vi.fn(async () => storeView({ movedFrom: chain.from, assistant: ASSISTANT })),
    movedSettings: vi.fn(async () => ({ ...chain, config, private: privatePart })),
  });
  return sessionDeps(api, fakeReader(oldAuthorizations()));
}

async function mountMoved(deps: SessionDeps) {
  mounted = await mount(
    <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
  );
  const { container } = mounted;
  await settle(() => (container.textContent ?? '').includes('Check and sign your settings'));
  return container;
}

function nameField(container: HTMLElement): string {
  const field = container.querySelector('#store-name');
  return field instanceof HTMLInputElement ? field.value : '';
}

describe('finishing a move to a new secret key (K21)', () => {
  it('shows the previous settings for review and signs them only when asked, authorizing only the source key', async () => {
    const deps = movedDeps(oldConfig());
    const container = await mountMoved(deps);
    expect(nameField(container)).toBe('Moved Tea');
    expect(container.textContent).toContain('may have changed them');
    expect(container.textContent).toContain('not carried over');
    expect(deps.api.storeEvents).not.toHaveBeenCalled();
    await click(buttonNamed(container, 'Sign with my new key'));
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
    // The backend key the old key authorized is not carried over: it may be a thief's.
    const authorized = signed
      .filter((event) => event.kind === KIND_CATALOG_AUTH)
      .map((event) => event.tags.find((tag) => tag[0] === 'd')?.[1]);
    expect(authorized).toEqual([SERVER_KEY]);
  });

  it('starts from an empty form when the previous settings are missing or not the old key own', async () => {
    const missing = await mountMoved(movedDeps(null));
    expect(missing.textContent).toContain('could not be found');
    expect(nameField(missing)).toBe('');
    await mounted?.unmount();
    const forged = finalizeEvent({ ...oldConfig(), created_at: NOW - 400 }, OWNER_KEY);
    const notOld = await mountMoved(movedDeps(forged));
    expect(notOld.textContent).toContain('could not be found');
    expect(nameField(notOld)).toBe('');
  });

  it('takes the settings an earlier key signed when the key moved from signed none', async () => {
    const thief = getPublicKey(generateSecretKey());
    const container = await mountMoved(
      movedDeps(oldConfig(), PRIVATE_PART, { from: thief, signedBy: OLD }),
    );
    expect(nameField(container)).toBe('Moved Tea');
    await mounted?.unmount();
    // Named as signed by the key moved from, but it was not: not taken.
    const wrong = await mountMoved(
      movedDeps(oldConfig(), PRIVATE_PART, { from: thief, signedBy: thief }),
    );
    expect(nameField(wrong)).toBe('');
  });

  it('says when the private instructions could not be read; a catalog key store needs no relinking', async () => {
    const lost = await mountMoved(movedDeps(oldConfig(), null));
    expect(lost.textContent).toContain('private instructions could not be read');
    expect(nameField(lost)).toBe('Moved Tea');
    await mounted?.unmount();
    const catalog = await mountMoved(movedDeps(oldConfig('catalog')));
    expect(nameField(catalog)).toBe('Moved Tea');
    expect(catalog.textContent).not.toContain('with our help');
    expect(catalog.textContent).not.toContain('PayCore');
  });

  it('previous settings naming a paycore source are not found: the form starts empty, nothing breaks', async () => {
    const container = await mountMoved(movedDeps(paycoreConfig()));
    expect(container.textContent).toContain('Your previous settings could not be found');
    expect(nameField(container)).toBe('');
    expect(container.textContent).not.toContain('PayCore');
  });

  it('shows a failed read and retries on request', async () => {
    const deps = movedDeps(oldConfig());
    vi.mocked(deps.api.movedSettings).mockRejectedValueOnce(new ApiError(0, 'network'));
    mounted = await mount(
      <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('could not be reached'));
    await click(buttonNamed(container, 'Retry'));
    await settle(() => nameField(container) === 'Moved Tea');
  });

  it('is shown only for a store that moved: a new one without settings is set up', async () => {
    const api = fakeApi({ store: vi.fn(async () => storeView({ assistant: ASSISTANT })) });
    mounted = await mount(
      <Session
        deps={sessionDeps(api, fakeReader([]))}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Set up your assistant'));
    expect(api.movedSettings).not.toHaveBeenCalled();
  });
});

describe('signing in with a key the store moved away from (K21)', () => {
  it('says so and offers to take the store back for this Store ID', async () => {
    const onReplaceKey = vi.fn();
    const api = fakeApi({
      store: vi.fn(async () => {
        throw new ApiError(409, 'moved');
      }),
    });
    mounted = await mount(
      <Session
        deps={sessionDeps(api, fakeReader([]))}
        onSignOut={() => undefined}
        onReplaceKey={onReplaceKey}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('moved to another secret key'));
    expect(container.textContent).not.toContain('Create my store');
    await click(buttonNamed(container, 'Take my store back'));
    expect(onReplaceKey).toHaveBeenCalledWith(npubEncode(OWNER));
  });
});

describe('replacing the key from the admin (K21)', () => {
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

describe('recovery errors in plain words (K21)', () => {
  it.each([
    [new ApiError(409, 'no_site_yet', { readyAt: NOW }), 'Try again after'],
    [new ApiError(409, 'no_site_yet', { readyAt: null }), 'shared hosting'],
    [new ApiError(409, 'proof_running'), 'Retry in a minute'],
    [new ApiError(409, 'moved_meanwhile'), 'moved by another request'],
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
    [new ApiError(503, 'read_failed'), 'could not be read just now'],
    [new ApiError(429, 'rate_limited'), 'Too many tries'],
    [
      new ApiError(409, 'site_not_proven', { failures: [], unlisted: 2 }),
      '2 sites your store listed earlier',
    ],
    [new ApiError(409, 'key_in_use'), 'already belongs to a store'],
    [new ApiError(409, 'moved'), 'take your store back'],
    [new ApiError(404, 'no_store'), 'no store with this Store ID'],
  ])('%s', (error, text) => {
    expect(errorMessage(error)).toContain(text);
  });
});
