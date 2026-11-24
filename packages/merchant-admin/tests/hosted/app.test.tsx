import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedApp } from '../../src/hosted/App';
import { ApiError } from '../../src/hosted/lib/api';
import { readHostedConfig } from '../../src/hosted/lib/hosted-config';
import { rememberKey } from '../../src/hosted/lib/remembered';
import { OTHER_OPERATOR, OTHER_SERVER, type SessionApi } from '../../src/hosted/lib/session';
import type { Signer } from '../../src/hosted/lib/signer';
import { markTabSignedIn } from '../../src/hosted/lib/tab-session';
import type { StoreView } from '../../src/hosted/lib/types';
import { type Mounted, buttonNamed, click, inputById, mount, settle, turns } from '../mount';
import { CONFIG, META, OWNER, OWNER_KEY, storeView } from './fakes';
import { MemoryStorage, freshDeviceKeys, installStorage, plainForms } from './stored';

const TAB_SESSION_KEY = 'paycore-hosted.tab-session';
const CONFIGURED = readHostedConfig(CONFIG.apiBase, CONFIG.operator);

let mounted: Mounted | undefined;
let tab: MemoryStorage;
beforeEach(() => {
  installStorage();
  freshDeviceKeys();
  tab = new MemoryStorage();
  vi.spyOn(globalThis, 'sessionStorage', 'get').mockReturnValue(tab);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fakeApi(overrides: Partial<SessionApi> = {}): SessionApi {
  return { meta: async () => META, store: async () => storeView(), ...overrides };
}

async function app(api: SessionApi = fakeApi(), config = CONFIGURED) {
  const signers: Signer[] = [];
  const createApi = vi.fn((signer: Signer, apiBase: string) => {
    signers.push(signer);
    expect(apiBase).toBe(CONFIG.apiBase);
    return api;
  });
  const leave = vi.fn();
  mounted = await mount(<HostedApp ownTab config={config} createApi={createApi} leave={leave} />);
  return { container: mounted.container, createApi, leave, signers };
}

async function pasteOwnerKey(container: HTMLElement, secretKey = OWNER_KEY) {
  await click(inputById(container, 'sign-in-remember'));
  inputById(container, 'owner-key').value = nip19.nsecEncode(secretKey);
  await click(buttonNamed(container, 'Sign in'));
}

describe('hosted mode before it is set up', () => {
  it('says it is not available yet and asks for no key, while the config is empty', async () => {
    const { container, createApi } = await app(fakeApi(), readHostedConfig('', ''));
    expect(container.textContent).toContain('Hosted stores are not available yet');
    expect(container.querySelector('#owner-key')).toBeNull();
    expect(container.querySelector('main a')?.getAttribute('href')).toBe('/');
    expect(createApi).not.toHaveBeenCalled();
  });

  it('treats a config it cannot use as not available', async () => {
    const { container } = await app(
      fakeApi(),
      readHostedConfig('http://x.example', 'paycore.example'),
    );
    expect(container.textContent).toContain('not available yet');
  });

  it('asks for the owner key only in a tab of its own', async () => {
    mounted = await mount(
      <HostedApp
        ownTab={false}
        config={CONFIGURED}
        createApi={() => fakeApi()}
        leave={() => undefined}
      />,
    );
    expect(mounted.container.textContent).toContain('asks for your owner key only in a');
    expect(mounted.container.querySelector('#owner-key')).toBeNull();
  });
});

describe('a signed-in session', () => {
  it('opens the store once the server names the committed operator and base', async () => {
    const { container, createApi } = await app(
      fakeApi({
        store: async () =>
          storeView({ status: 'degraded', alerts: ['webhook_secret_missing', 'secret text'] }),
      }),
    );
    await pasteOwnerKey(container);
    await settle(() => container.querySelector('#store-status') !== null);
    expect(createApi.mock.calls[0]?.[0].pubkey).toBe(OWNER);
    expect(container.querySelector('#store-status')?.textContent).toBe('Active, needs attention');
    expect(container.textContent).toContain(nip19.npubEncode(OWNER));
    expect(container.textContent).toContain('Generate a secret in Settings');
    expect(container.textContent).toContain('Your store needs attention');
    expect(container.textContent).not.toContain('secret text');
  });

  it('stops when the server names another operator', async () => {
    const store = vi.fn(async (): Promise<StoreView> => storeView());
    const { container } = await app(
      fakeApi({ meta: async () => ({ ...META, operator: 'other.example' }), store }),
    );
    await pasteOwnerKey(container);
    await settle(() => (container.textContent ?? '').includes(OTHER_OPERATOR));
    expect(store).not.toHaveBeenCalled();
  });

  it('stops when the server has another public base', async () => {
    const { container } = await app(
      fakeApi({ meta: async () => ({ ...META, publicBase: 'https://other.example' }) }),
    );
    await pasteOwnerKey(container);
    await settle(() => (container.textContent ?? '').includes(OTHER_SERVER));
  });

  it('says there is no store yet', async () => {
    const { container } = await app(
      fakeApi({
        store: async () => {
          throw new ApiError(404, 'no_store');
        },
      }),
    );
    await pasteOwnerKey(container);
    await settle(() => (container.textContent ?? '').includes('No store yet'));
  });

  it('says why it failed, and opens the store on Retry', async () => {
    let fail = true;
    const { container } = await app(
      fakeApi({
        store: async () => {
          if (fail) {
            throw new ApiError(0, 'network');
          }
          return storeView({ status: 'active' });
        },
      }),
    );
    await pasteOwnerKey(container);
    await settle(() => (container.textContent ?? '').includes('could not be reached'));
    fail = false;
    await click(buttonNamed(container, 'Retry'));
    await settle(() => container.querySelector('#store-status')?.textContent === 'Active');
  });

  it('shows loading until the store answers', async () => {
    let answer: (view: StoreView) => void = () => undefined;
    const { container } = await app(
      fakeApi({
        store: () =>
          new Promise<StoreView>((resolve) => {
            answer = resolve;
          }),
      }),
    );
    await pasteOwnerKey(container);
    await settle(() => (container.textContent ?? '').includes('Opening your store'));
    answer(storeView());
    await settle(() => container.querySelector('#store-status') !== null);
  });
});

describe('signing out', () => {
  it('zeroes the key, clears the tab session and leaves the page', async () => {
    const { container, leave, signers } = await app();
    await pasteOwnerKey(container);
    await settle(() => container.querySelector('#store-status') !== null);
    expect(tab.items.get(TAB_SESSION_KEY)).toBe(OWNER);
    const [signer] = signers;
    if (signer === undefined) {
      throw new Error('no signer');
    }
    await click(buttonNamed(container, 'Sign out'));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(tab.items.has(TAB_SESSION_KEY)).toBe(false);
    await expect(
      signer.signEvent({ kind: 1, created_at: 0, tags: [], content: '' }),
    ).rejects.toThrow('signed out');
    expect(container.querySelector('#owner-key')).not.toBeNull();
  });

  it('works from a refusal too', async () => {
    const { container, leave, signers } = await app(
      fakeApi({ meta: async () => ({ ...META, operator: 'other.example' }) }),
    );
    await pasteOwnerKey(container);
    await settle(() => (container.textContent ?? '').includes(OTHER_OPERATOR));
    await click(buttonNamed(container, 'Sign out'));
    expect(leave).toHaveBeenCalledTimes(1);
    await expect(
      signers[0]?.signEvent({ kind: 1, created_at: 0, tags: [], content: '' }),
    ).rejects.toThrow('signed out');
  });
});

describe('a reload of a signed-in tab', () => {
  it('keeps only the owner public key in the tab, never the key', async () => {
    const { container } = await app();
    await pasteOwnerKey(container);
    await settle(() => container.querySelector('#store-status') !== null);
    expect(tab.items.get(TAB_SESSION_KEY)).toBe(OWNER);
    for (const plain of plainForms(OWNER_KEY)) {
      expect(tab.writes.join('\n')).not.toContain(plain);
    }
  });

  it('signs in again with the remembered key, with no press', async () => {
    expect(await rememberKey(OWNER_KEY)).toBe(true);
    markTabSignedIn(OWNER);
    const { container, createApi } = await app();
    await settle(() => createApi.mock.calls.length > 0);
    expect(createApi.mock.calls[0]?.[0].pubkey).toBe(OWNER);
    await settle(() => container.querySelector('#store-status') !== null);
  });

  it('asks for Continue when the tab was signed in as an owner this device does not remember', async () => {
    expect(await rememberKey(OWNER_KEY)).toBe(true);
    markTabSignedIn(getPublicKey(generateSecretKey()));
    const { container, createApi } = await app();
    await turns();
    expect(createApi).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Continue on this device');
  });

  it('asks for Continue when the tab was not signed in', async () => {
    expect(await rememberKey(OWNER_KEY)).toBe(true);
    const { createApi } = await app();
    await turns();
    expect(createApi).not.toHaveBeenCalled();
  });

  it('does without session storage when the browser blocks it', async () => {
    vi.spyOn(globalThis, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const { container } = await app();
    await pasteOwnerKey(container);
    await settle(() => container.querySelector('#store-status') !== null);
  });
});
