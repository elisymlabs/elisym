import { npubEncode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SignIn } from '../src/components/SignIn';
import { rememberKey } from '../src/lib/remembered';
import type { Signer } from '../src/lib/signer';
import { clearTabSignedIn, markTabSignedIn, tabSignedInStore } from '../src/lib/tab-session';
import { NOW, OWNER, OWNER_KEY, fakeApi, fakeReader, sessionDeps, signedConfig } from './fakes';
import { type Mounted, buttonNamed, click, mount, settle as settleUntil } from './mount';
import { MemoryStorage, freshDeviceKeys, installStorage, plainForms } from './stored';

const NO_RECOVERY = async () => undefined;
const TAB_SESSION_KEY = 'askr-admin-tab-session';

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

/** The end of a Store ID as the sign-in list shows it. */
function npubTail(store: string): string {
  return npubEncode(store).slice(-6);
}

async function settle() {
  for (let round = 0; round < 20; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('a reload of a signed-in tab', () => {
  it('signs in again with the remembered key, with no press', async () => {
    const secretKey = generateSecretKey();
    expect(await rememberKey(secretKey)).toBe(true);
    markTabSignedIn(getPublicKey(secretKey));
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} recover={NO_RECOVERY} />);
    await settle();
    expect(onSigner).toHaveBeenCalledTimes(1);
    expect(onSigner.mock.calls[0]?.[0]?.pubkey).toBe(getPublicKey(secretKey));
  });

  it('asks for Continue when the tab was not signed in', async () => {
    const secretKey = generateSecretKey();
    expect(await rememberKey(secretKey)).toBe(true);
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} recover={NO_RECOVERY} />);
    await settle();
    expect(onSigner).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain('Continue on this device');
  });

  it('asks for Continue when the tab was signed in as a store this device does not remember', async () => {
    const remembered = generateSecretKey();
    expect(await rememberKey(remembered)).toBe(true);
    markTabSignedIn(getPublicKey(generateSecretKey()));
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} recover={NO_RECOVERY} />);
    await settle();
    expect(onSigner).not.toHaveBeenCalled();
  });

  it('keeps only the Store ID in the tab, never the key', async () => {
    const secretKey = generateSecretKey();
    expect(await rememberKey(secretKey)).toBe(true);
    // As App does on a sign-in.
    mounted = await mount(
      <SignIn onSigner={(signer) => markTabSignedIn(signer.pubkey)} recover={NO_RECOVERY} />,
    );
    await click(buttonNamed(mounted.container, 'Continue'));
    await settle();
    expect(tab.items.get(TAB_SESSION_KEY)).toBe(getPublicKey(secretKey));
    for (const plain of plainForms(secretKey)) {
      expect(tab.writes.join('\n')).not.toContain(plain);
    }
  });

  it('ends with Sign out', () => {
    markTabSignedIn('a'.repeat(64));
    expect(tabSignedInStore()).toBe('a'.repeat(64));
    clearTabSignedIn();
    expect(tabSignedInStore()).toBeUndefined();
  });

  it('does without session storage when the browser blocks it', () => {
    vi.spyOn(globalThis, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => markTabSignedIn('a'.repeat(64))).not.toThrow();
    expect(tabSignedInStore()).toBeUndefined();
    expect(() => clearTabSignedIn()).not.toThrow();
  });
});

describe('a reload of a tab that failed to sign in on its own', () => {
  it('tries once: forgetting another store does not sign in after all', async () => {
    const first = generateSecretKey();
    const second = generateSecretKey();
    expect(await rememberKey(first)).toBe(true);
    expect(await rememberKey(second)).toBe(true);
    markTabSignedIn(getPublicKey(first));
    const working = indexedDB;
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('Connection to Indexed Database server lost', 'UnknownError');
      },
    });
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} recover={NO_RECOVERY} />);
    const { container } = mounted;
    await settleUntil(() => (container.textContent ?? '').includes('did not answer'));
    // Storage answers again: only a press may sign in now, not a change of the list.
    vi.stubGlobal('indexedDB', working);
    const forgetSecond = container.querySelector(
      `button[aria-label^="Forget store"][aria-label$="${npubTail(getPublicKey(second))} on this device"]`,
    );
    if (!(forgetSecond instanceof HTMLButtonElement)) {
      throw new Error('no Forget for the second store');
    }
    await click(forgetSecond);
    const row = forgetSecond.closest('li');
    if (row === null) {
      throw new Error('no row for the second store');
    }
    // The row's own Forget opens the question; the last Forget in it answers yes.
    const confirm = [...row.querySelectorAll('button')]
      .filter((button) => button.textContent === 'Forget')
      .at(-1);
    if (confirm === undefined) {
      throw new Error('no Forget confirmation');
    }
    await click(confirm);
    await settle();
    expect(container.textContent).not.toContain('Forget the key remembered for store');
    expect(container.querySelectorAll('button[aria-label^="Continue as store"]')).toHaveLength(1);
    expect(onSigner).not.toHaveBeenCalled();
  });
});

describe('the whole app in a tab', () => {
  async function signedInApp() {
    expect(await rememberKey(OWNER_KEY)).toBe(true);
    const createDeps = vi.fn((signer: Signer) => sessionDeps(fakeApi(), fakeReader([]), signer));
    mounted = await mount(<App createDeps={createDeps} />);
    const { container } = mounted;
    await click(buttonNamed(container, 'Continue'));
    await settleUntil(() => createDeps.mock.calls.length > 0);
    return { container, createDeps };
  }

  /** A reload: the page starts again in the same tab. */
  async function reload() {
    await mounted?.unmount();
    const createDeps = vi.fn((signer: Signer) => sessionDeps(fakeApi(), fakeReader([]), signer));
    mounted = await mount(<App createDeps={createDeps} />);
    return { container: mounted.container, createDeps };
  }

  it('marks the tab with the Store ID in hex on Continue', async () => {
    await signedInApp();
    expect(tab.items.get(TAB_SESSION_KEY)).toBe(OWNER);
    expect(OWNER).toBe(getPublicKey(OWNER_KEY));
  });

  it('signs in again on a reload, with no press', async () => {
    await signedInApp();
    const { createDeps } = await reload();
    await settleUntil(() => createDeps.mock.calls.length > 0);
    expect(createDeps.mock.calls[0]?.[0].pubkey).toBe(OWNER);
  });

  it('asks for Continue on a reload after Sign out', async () => {
    const { container } = await signedInApp();
    await settleUntil(() => (container.textContent ?? '').includes('Set up your assistant'));
    await click(buttonNamed(container, 'Sign out'));
    expect(tab.items.has(TAB_SESSION_KEY)).toBe(false);
    const reloaded = await reload();
    await settle();
    expect(reloaded.container.textContent).toContain('Continue on this device');
    expect(reloaded.createDeps).not.toHaveBeenCalled();
  });

  it('asks for Continue when the merchant backs out of replacing the key', async () => {
    expect(await rememberKey(OWNER_KEY)).toBe(true);
    const createDeps = vi.fn((signer: Signer) =>
      sessionDeps(fakeApi(), fakeReader([signedConfig(OWNER_KEY, 'Tea', NOW - 500)]), signer),
    );
    mounted = await mount(<App createDeps={createDeps} />);
    const { container } = mounted;
    await click(buttonNamed(container, 'Continue'));
    await settleUntil(() => (container.textContent ?? '').includes('Advanced'));
    await click(buttonNamed(container, 'Advanced'));
    await click(buttonNamed(container, 'Replace my secret key'));
    await click(buttonNamed(container, 'Continue'));
    expect(tab.items.has(TAB_SESSION_KEY)).toBe(false);
    await click(buttonNamed(container, 'Back'));
    await settle();
    expect(container.textContent).toContain('Continue on this device');
    expect(createDeps).toHaveBeenCalledTimes(1);
  });
});
