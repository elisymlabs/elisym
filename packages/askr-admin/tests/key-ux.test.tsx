import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { KeysSection } from '../src/components/KeysSection';
import { Session } from '../src/components/Session';
import { SignIn } from '../src/components/SignIn';
import { UnlockRemembered } from '../src/components/UnlockRemembered';
import { ApiError } from '../src/lib/api';
import { readRemembered, rememberKey, unlockKey } from '../src/lib/remembered';
import { type Signer, secretKeySigner } from '../src/lib/signer';
import {
  NOW,
  OWNER,
  OWNER_KEY,
  fakeApi,
  fakeReader,
  sessionDeps,
  signedConfig,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle } from './mount';
import { type MemoryStorage, freshDeviceKeys, installStorage, plainForms } from './stored';

const NO_RECOVERY = async () => undefined;
const UI_WORDS_NOT_FOR_MERCHANTS = /nostr|nip-?49|ncryptsec|npub|nsec/i;
const STORE_ID_VALUE = /npub1[02-9ac-hj-np-z]+(?:\.\.\.[02-9ac-hj-np-z]+)?/g;

let mounted: Mounted | undefined;
let storage: MemoryStorage;
beforeEach(() => {
  storage = installStorage();
  freshDeviceKeys();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function inputById(container: HTMLElement, id: string): HTMLInputElement {
  const field = byId(container, id);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input`);
  }
  return field;
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

/** Clear "remember" with prefix `id`: it starts ticked. */
async function rememberNot(container: HTMLElement, id: string) {
  const box = inputById(container, `${id}-remember`);
  expect(box.checked).toBe(true);
  await click(box);
  expect(box.checked).toBe(false);
}

/** Remember `secretKey` here, as an earlier visit would have. */
async function remembered(secretKey: Uint8Array) {
  expect(await rememberKey(secretKey)).toBe(true);
}

function expectNoPlainKey(secretKey: Uint8Array) {
  const everything = `${storage.everything()}\n${storage.writes.join('\n')}`;
  for (const plain of plainForms(secretKey)) {
    expect(everything).not.toContain(plain);
  }
}

async function signInScreen(onSigner = vi.fn<(signer: Signer) => void>()) {
  mounted = await mount(<SignIn onSigner={onSigner} recover={NO_RECOVERY} />);
  return { container: mounted.container, onSigner };
}

describe('a new secret key', () => {
  it('downloads as a small text file with the key and the Store ID', async () => {
    const created: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
      if (object instanceof Blob) {
        created.push(object);
      }
      return 'blob:askr-test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function record(this: HTMLAnchorElement) {
        names.push(this.download);
      },
    );
    const { container } = await signInScreen();
    await click(buttonNamed(container, 'Create a secret key'));
    const nsec = /nsec1[02-9ac-hj-np-z]+/.exec(text(container))?.[0] ?? '';
    const npub = /npub1[02-9ac-hj-np-z]+/.exec(text(container))?.[0] ?? '';
    await click(buttonNamed(container, 'Download as a file'));
    expect(names).toEqual([`askr-secret-key-${npub.slice(5, 13)}.txt`]);
    const content = (await created[0]?.text()) ?? '';
    expect(content).toContain(`Secret key: ${nsec}`);
    expect(content).toContain(`Store ID: ${npub}`);
    expect(content).toContain('Whoever has this file controls your store');
    expect(text(container)).toContain(`Saved as askr-secret-key-${npub.slice(5, 13)}.txt`);
  });

  it('is remembered on this device by default, sealed, never in plain form', async () => {
    const { container, onSigner } = await signInScreen();
    await click(buttonNamed(container, 'Create a secret key'));
    expect(inputById(container, 'new-key-remember').checked).toBe(true);
    expect(text(container)).toContain('Kept encrypted in this browser');
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')];
    const saved = checkboxes.find((box) => box.id === '');
    if (!(saved instanceof HTMLInputElement)) {
      throw new Error('no saved checkbox');
    }
    await click(saved);
    await click(buttonNamed(container, 'Continue'));
    await settle(() => onSigner.mock.calls.length > 0);
    const pubkey = onSigner.mock.calls[0]?.[0].pubkey;
    expect(readRemembered().keys.map((key) => key.store)).toEqual([pubkey]);
    const nsec = /nsec1[02-9ac-hj-np-z]+/.exec(text(container))?.[0];
    const decoded = nsec === undefined ? undefined : nip19.decode(nsec);
    if (decoded?.type !== 'nsec') {
      throw new Error('no key shown');
    }
    expectNoPlainKey(decoded.data);
  });

  it('is not remembered when the box is cleared', async () => {
    const { container, onSigner } = await signInScreen();
    await click(buttonNamed(container, 'Create a secret key'));
    await rememberNot(container, 'new-key');
    expect(text(container)).not.toContain('Kept encrypted in this browser');
    const saved = [...container.querySelectorAll('input[type="checkbox"]')].find(
      (box) => box.id === '',
    );
    if (!(saved instanceof HTMLInputElement)) {
      throw new Error('no saved checkbox');
    }
    await click(saved);
    await click(buttonNamed(container, 'Continue'));
    expect(onSigner).toHaveBeenCalledTimes(1);
    expect(storage.everything()).toBe('');
  });
});

describe('signing in with a pasted key and remembering it', () => {
  it('remembers it sealed and signs in with one press next time', async () => {
    const first = await signInScreen();
    inputById(first.container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    expect(inputById(first.container, 'sign-in-remember').checked).toBe(true);
    expect(first.container.querySelector('input[type="password"]')).toBeNull();
    await click(buttonNamed(first.container, 'Sign in'));
    await settle(() => first.onSigner.mock.calls.length > 0);
    expect(first.onSigner.mock.calls[0]?.[0].pubkey).toBe(OWNER);
    expect(inputById(first.container, 'owner-key').value).toBe('');
    expectNoPlainKey(OWNER_KEY);
    await mounted?.unmount();

    const next = await signInScreen();
    expect(text(next.container)).toContain('Continue on this device');
    expect(next.container.querySelector('input[type="password"]')).toBeNull();
    await click(buttonNamed(next.container, 'Continue'));
    await settle(() => next.onSigner.mock.calls.length > 0);
    expect(next.onSigner.mock.calls[0]?.[0].pubkey).toBe(OWNER);
  });

  it('is not remembered when the box is cleared', async () => {
    const { container, onSigner } = await signInScreen();
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await rememberNot(container, 'sign-in');
    await click(buttonNamed(container, 'Sign in'));
    expect(onSigner).toHaveBeenCalledTimes(1);
    expect(storage.everything()).toBe('');
  });

  it('says so and stays when this browser refuses the write', async () => {
    const { container, onSigner } = await signInScreen();
    storage.failing.add('setItem');
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => text(container).includes('could not be remembered'));
    expect(onSigner).not.toHaveBeenCalled();
    // The key stays for the retry the message suggests.
    expect(inputById(container, 'owner-key').value).toBe(nip19.nsecEncode(OWNER_KEY));
    storage.failing.delete('setItem');
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(inputById(container, 'owner-key').value).toBe('');
    expect(readRemembered().keys.map((key) => key.store)).toEqual([OWNER]);
  });

  it('says what to do when the device key is gone, and signs in nobody', async () => {
    await remembered(OWNER_KEY);
    freshDeviceKeys();
    const { container, onSigner } = await signInScreen();
    await click(buttonNamed(container, 'Continue'));
    await settle(() => text(container).includes('can no longer open the key'));
    expect(text(container)).not.toMatch(/tag|invalid|operation/i);
    expect(onSigner).not.toHaveBeenCalled();
    // The press is over: Continue works again, and a second press tries again.
    const again = buttonNamed(container, 'Continue');
    expect(again.disabled).toBe(false);
    await click(again);
    await settle(() => text(container).includes('can no longer open the key'));
    expect(buttonNamed(container, 'Continue').disabled).toBe(false);
  });

  it('says to try again when storage does not answer, and signs in on the retry', async () => {
    await remembered(OWNER_KEY);
    const { container, onSigner } = await signInScreen();
    const working = indexedDB;
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('Connection to Indexed Database server lost', 'UnknownError');
      },
    });
    await click(buttonNamed(container, 'Continue'));
    await settle(() => text(container).includes('did not answer'));
    expect(text(container)).not.toContain('Forget it');
    vi.stubGlobal('indexedDB', working);
    await click(buttonNamed(container, 'Continue'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(OWNER);
  });

  it('does not use a key forgotten in another tab since the page opened', async () => {
    await remembered(OWNER_KEY);
    const { container, onSigner } = await signInScreen();
    // Another tab forgets it.
    storage.removeItem('askr-admin.remembered-keys');
    await click(buttonNamed(container, 'Continue'));
    await settle(() => text(container).includes('forgotten in another tab'));
    expect(onSigner).not.toHaveBeenCalled();
  });

  it('takes no Forget while it signs in', async () => {
    await remembered(OWNER_KEY);
    const { container, onSigner } = await signInScreen();
    act(() => {
      buttonNamed(container, 'Continue').click();
    });
    expect(buttonNamed(container, 'Signing in...').disabled).toBe(true);
    expect(buttonNamed(container, 'Forget').disabled).toBe(true);
    await settle(() => onSigner.mock.calls.length > 0);
    expect(readRemembered().keys).toHaveLength(1);
  });

  it('closes an open Forget confirmation when another store starts signing in', async () => {
    const other = generateSecretKey();
    await remembered(OWNER_KEY);
    await remembered(other);
    const { container, onSigner } = await signInScreen();
    // Ask to forget the first store (the newest, the other one) ...
    await click(buttonNamed(container, 'Forget'));
    expect(text(container)).toContain('Forget the key remembered for store');
    // ... then sign in as the second one meanwhile.
    const continues = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Continue',
    );
    const second = continues[1];
    if (second === undefined) {
      throw new Error('no second store');
    }
    act(() => {
      second.click();
    });
    expect(text(container)).not.toContain('Forget the key remembered for store');
    for (const button of container.querySelectorAll('button')) {
      if (button.textContent === 'Forget') {
        expect(button.disabled).toBe(true);
      }
    }
    await settle(() => onSigner.mock.calls.length > 0);
    expect(readRemembered().keys).toHaveLength(2);
  });
});

describe('the sign-in page with keys remembered', () => {
  it('lists each store remembered here, newest first, and signs in as the one pressed', async () => {
    const other = generateSecretKey();
    await remembered(OWNER_KEY);
    await remembered(other);
    const { container, onSigner } = await signInScreen();
    const labels = [...container.querySelectorAll('button')]
      .map((button) => button.getAttribute('aria-label') ?? '')
      .filter((label) => label.startsWith('Continue as store'));
    const short = (pubkey: string) => {
      const npub = nip19.npubEncode(pubkey);
      return `${npub.slice(0, 12)}...${npub.slice(-6)}`;
    };
    expect(labels).toEqual([
      `Continue as store ${short(getPublicKey(other))}`,
      `Continue as store ${short(OWNER)}`,
    ]);
    const second = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === labels[1],
    );
    if (second === undefined) {
      throw new Error('no second store');
    }
    await click(second);
    await settle(() => onSigner.mock.calls.length > 0);
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(OWNER);
  });

  it('forgets a store only after a confirmation', async () => {
    await remembered(OWNER_KEY);
    const { container } = await signInScreen();
    await click(buttonNamed(container, 'Forget'));
    await click(buttonNamed(container, 'Keep it'));
    expect(readRemembered().keys).toHaveLength(1);
    await click(buttonNamed(container, 'Forget'));
    expect(text(container)).toContain('you need your secret key, or the file you downloaded');
    const buttons = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Forget',
    );
    const confirm = buttons.at(-1);
    if (confirm === undefined) {
      throw new Error('no confirmation');
    }
    await click(confirm);
    expect(readRemembered().keys).toEqual([]);
    expect(text(container)).not.toContain('Continue on this device');
  });

  it('says it could not forget when the browser refuses', async () => {
    await remembered(OWNER_KEY);
    const { container } = await signInScreen();
    storage.failing.add('removeItem');
    await click(buttonNamed(container, 'Forget'));
    const confirm = [...container.querySelectorAll('button')]
      .filter((button) => button.textContent === 'Forget')
      .at(-1);
    if (confirm === undefined) {
      throw new Error('no confirmation');
    }
    await click(confirm);
    expect(text(container)).toContain('did not let the admin forget it');
  });

  it('says what was damaged and clears it on request', async () => {
    storage.setItem('askr-admin.remembered-keys', '{not json');
    const { container } = await signInScreen();
    expect(text(container)).toContain('could not be read, so it is not offered');
    expect(text(container)).not.toContain('Continue on this device');
    await click(buttonNamed(container, 'Clear it'));
    await click(buttonNamed(container, 'Keep it'));
    expect(storage.getItem('askr-admin.remembered-keys')).toBe('{not json');
    await click(buttonNamed(container, 'Clear it'));
    await click(buttonNamed(container, 'Clear'));
    expect(storage.getItem('askr-admin.remembered-keys')).toBeNull();
    expect(text(container)).not.toContain('could not be read');
  });

  it('uses merchant words only', async () => {
    await remembered(OWNER_KEY);
    const { container } = await signInScreen();
    // A Store ID's value starts with npub1, as everywhere in the admin; no word names the scheme.
    const words = text(container).replaceAll(STORE_ID_VALUE, '');
    expect(text(container)).toContain('npub1');
    expect(words).not.toMatch(UI_WORDS_NOT_FOR_MERCHANTS);
  });

  it.each([
    ['refuses writes', () => storage.failing.add('setItem')],
    ['has no IndexedDB', () => vi.stubGlobal('indexedDB', undefined)],
  ])('offers no remembering where the browser %s, and still signs in', async (_name, prepare) => {
    prepare();
    const { container, onSigner } = await signInScreen();
    expect(text(container)).toContain('does not let the admin remember your key');
    expect(container.querySelector('#sign-in-remember')).toBeNull();
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await click(buttonNamed(container, 'Sign in'));
    expect(onSigner).toHaveBeenCalledTimes(1);
  });
});

describe('forgetting the key from inside the admin', () => {
  async function keysSection() {
    mounted = await mount(
      <KeysSection
        deps={sessionDeps(fakeApi(), fakeReader([]))}
        view={storeView()}
        config={undefined}
        configError=""
        onRetry={async () => undefined}
        onChanged={async () => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    return mounted.container;
  }

  it('is offered under the secret key when this device remembers it', async () => {
    await remembered(OWNER_KEY);
    const container = await keysSection();
    expect(text(container)).toContain('This device remembers this secret key');
    await click(buttonNamed(container, 'Forget this device'));
    await click(buttonNamed(container, 'Forget'));
    expect(readRemembered().keys).toEqual([]);
    expect(text(container)).toContain('no longer remembers');
  });

  it('is not offered when this device does not remember it', async () => {
    await remembered(generateSecretKey());
    const container = await keysSection();
    expect(text(container)).not.toContain('Forget this device');
  });

  it('says so when the browser refuses', async () => {
    await remembered(OWNER_KEY);
    const container = await keysSection();
    storage.failing.add('setItem');
    storage.failing.add('removeItem');
    await click(buttonNamed(container, 'Forget this device'));
    await click(buttonNamed(container, 'Forget'));
    expect(text(container)).toContain('did not let the admin forget it');
    expect(readRemembered().keys).toHaveLength(1);
  });

  it('says at Sign out that the key stays remembered, until it is forgotten', async () => {
    await remembered(OWNER_KEY);
    mounted = await mount(
      <Session
        deps={sessionDeps(fakeApi(), fakeReader([signedConfig(OWNER_KEY, 'Tea', NOW)]))}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => text(container).includes('Signing out keeps your key remembered'));
    await click(buttonNamed(container, 'Advanced'));
    await click(buttonNamed(container, 'Forget this device'));
    await click(buttonNamed(container, 'Forget'));
    expect(readRemembered().keys).toEqual([]);
    expect(text(container)).not.toContain('Signing out keeps your key remembered');
  });

  it('is offered for a remembered key the store moved away from', async () => {
    await remembered(OWNER_KEY);
    const api = fakeApi({
      store: vi.fn(async () => {
        throw new ApiError(409, 'moved');
      }),
    });
    mounted = await mount(
      <Session
        deps={sessionDeps(api, fakeReader([]))}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => text(container).includes('moved to another secret key'));
    expect(text(container)).toContain('Take my store back');
    await click(buttonNamed(container, 'Forget this device'));
    await click(buttonNamed(container, 'Forget'));
    expect(readRemembered().keys).toEqual([]);
  });
});

describe('replacing the key on a device that remembers the old one (K21)', () => {
  const OLD_KEY = generateSecretKey();
  const OLD = getPublicKey(OLD_KEY);

  async function toProof(
    recover: (signer: Signer, from: string, dryRun: boolean) => Promise<void>,
  ) {
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(
      <SignIn onSigner={onSigner} recover={recover} replaceKeyOf={nip19.npubEncode(OLD)} />,
    );
    const { container } = mounted;
    await click(buttonNamed(container, 'Continue'));
    const nsec = /nsec1[02-9ac-hj-np-z]+/.exec(text(container))?.[0];
    const decoded = nsec === undefined ? undefined : nip19.decode(nsec);
    if (decoded?.type !== 'nsec') {
      throw new Error('no new key shown');
    }
    expect(buttonNamed(container, 'Download as a file')).toBeDefined();
    // The new key is not offered to remember before the store moved to it.
    expect(container.querySelector('#new-key-remember')).toBeNull();
    const saved = container.querySelector('input[type="checkbox"]');
    if (!(saved instanceof HTMLInputElement)) {
      throw new Error('no saved checkbox');
    }
    await click(saved);
    await click(buttonNamed(container, 'Continue'));
    return { container, onSigner, newKey: decoded.data };
  }

  it('drops the old key and remembers the new one once the store moved', async () => {
    await remembered(OLD_KEY);
    const { container, onSigner, newKey } = await toProof(async () => undefined);
    expect(inputById(container, 'moved-key-remember').checked).toBe(true);
    await click(buttonNamed(container, 'Check my site and move the store'));
    await settle(() => onSigner.mock.calls.length > 0);
    const keys = readRemembered().keys;
    expect(keys.map((key) => key.store)).toEqual([getPublicKey(newKey)]);
    const [kept] = keys;
    expect(kept === undefined ? false : (await unlockKey(kept)).ok).toBe(true);
    expectNoPlainKey(newKey);
  });

  it('drops the old key even when the new one is not to be remembered', async () => {
    await remembered(OLD_KEY);
    const { container, onSigner } = await toProof(async () => undefined);
    await rememberNot(container, 'moved-key');
    await click(buttonNamed(container, 'Check my site and move the store'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(readRemembered().keys).toEqual([]);
  });

  it('keeps everything as it was while the store has not moved', async () => {
    await remembered(OLD_KEY);
    const { container, onSigner } = await toProof(async (_signer, _from, dryRun) => {
      if (!dryRun) {
        throw new ApiError(409, 'site_not_proven', { failures: [] });
      }
    });
    await click(buttonNamed(container, 'Check my site and move the store'));
    await settle(() => text(container).includes("None of your store's sites"));
    expect(onSigner).not.toHaveBeenCalled();
    expect(readRemembered().keys.map((key) => key.store)).toEqual([OLD]);
  });
});

describe('a move that this browser does not let the admin record', () => {
  const OLD_KEY = generateSecretKey();

  async function proofWith(prepare: () => void, rememberNew: boolean) {
    await remembered(OLD_KEY);
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(
      <SignIn
        onSigner={onSigner}
        recover={async () => undefined}
        replaceKeyOf={nip19.npubEncode(getPublicKey(OLD_KEY))}
      />,
    );
    const { container } = mounted;
    await click(buttonNamed(container, 'Continue'));
    const saved = container.querySelector('input[type="checkbox"]');
    if (!(saved instanceof HTMLInputElement)) {
      throw new Error('no saved checkbox');
    }
    await click(saved);
    await click(buttonNamed(container, 'Continue'));
    if (!rememberNew) {
      await rememberNot(container, 'moved-key');
    }
    prepare();
    await click(buttonNamed(container, 'Check my site and move the store'));
    await settle(() => text(container).includes('Your store moved'));
    expect(onSigner).not.toHaveBeenCalled();
    await click(buttonNamed(container, 'Continue'));
    expect(onSigner).toHaveBeenCalledTimes(1);
    return text(container);
  }

  it('says the new key was not remembered, then goes on', async () => {
    const said = await proofWith(() => storage.failing.add('setItem'), true);
    expect(said).toContain('did not let the admin remember the new key');
    expect(said).not.toContain('forget the old key');
    expect(said).toContain('Keep the new key you saved');
  });

  it('says the old key was not forgotten, then goes on', async () => {
    const said = await proofWith(() => {
      storage.failing.add('removeItem');
      storage.failing.add('setItem');
    }, false);
    expect(said).toContain('did not let the admin forget the old key');
    expect(said).not.toContain('remember the new key');
  });

  it('says both when neither could be recorded', async () => {
    const said = await proofWith(() => {
      storage.failing.add('removeItem');
      storage.failing.add('setItem');
    }, true);
    expect(said).toContain('did not let the admin forget the old key');
    expect(said).toContain('did not let the admin remember the new key');
  });
});

describe('presses and leftovers', () => {
  it('signs in once on a double press of a remembered store, without a stray error', async () => {
    await remembered(OWNER_KEY);
    const { container, onSigner } = await signInScreen();
    const unlock = buttonNamed(container, 'Continue');
    await act(async () => {
      unlock.click();
      unlock.click();
    });
    await settle(() => onSigner.mock.calls.length > 0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onSigner).toHaveBeenCalledTimes(1);
  });

  it('remembers and signs in once on a double press', async () => {
    const { container, onSigner } = await signInScreen();
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    const signIn = buttonNamed(container, 'Sign in');
    await act(async () => {
      signIn.click();
      signIn.click();
    });
    await settle(() => onSigner.mock.calls.length > 0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(onSigner).toHaveBeenCalledTimes(1);
  });

  it('remembers a new key and signs in once on a double press of Continue', async () => {
    const { container, onSigner } = await signInScreen();
    await click(buttonNamed(container, 'Create a secret key'));
    const saved = [...container.querySelectorAll('input[type="checkbox"]')].find(
      (box) => box.id === '',
    );
    if (!(saved instanceof HTMLInputElement)) {
      throw new Error('no saved checkbox');
    }
    await click(saved);
    const next = buttonNamed(container, 'Continue');
    await act(async () => {
      next.click();
      next.click();
    });
    await settle(() => onSigner.mock.calls.length > 0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(onSigner).toHaveBeenCalledTimes(1);
  });

  it('refuses a key no signer can use, and the next good one still signs in', async () => {
    const { container, onSigner } = await signInScreen();
    inputById(container, 'owner-key').value = '0'.repeat(64);
    await click(buttonNamed(container, 'Sign in'));
    expect(text(container)).toContain('That is not a secret key');
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(onSigner).toHaveBeenCalledTimes(1);
  });

  it('says to clear what could not be read when that blocks remembering', async () => {
    storage.setItem('askr-admin.remembered-keys', '{not json');
    const { container, onSigner } = await signInScreen();
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => text(container).includes('could not be remembered'));
    expect(text(container)).toContain('clear what could not be read first');
    expect(onSigner).not.toHaveBeenCalled();
  });

  it('wipes the unlocked key once the signer has its own copy', async () => {
    await remembered(OWNER_KEY);
    const handed: Uint8Array[] = [];
    const signers: Signer[] = [];
    mounted = await mount(
      <UnlockRemembered
        keys={readRemembered().keys}
        onUnlocked={(secretKey) => {
          handed.push(secretKey);
          signers.push(secretKeySigner(secretKey));
        }}
        onForgotten={() => undefined}
      />,
    );
    const { container } = mounted;
    await click(buttonNamed(container, 'Continue'));
    await settle(() => handed.length > 0);
    expect(handed[0]?.every((byte) => byte === 0)).toBe(true);
    expect(signers[0]?.pubkey).toBe(OWNER);
  });

  it('shows a key remembered meanwhile after coming back from the replacement', async () => {
    const { container } = await signInScreen();
    expect(text(container)).not.toContain('Continue on this device');
    await click(buttonNamed(container, 'Lost your secret key?'));
    await remembered(OWNER_KEY);
    await click(buttonNamed(container, 'Back'));
    expect(text(container)).toContain('Continue on this device');
  });

  it('leaves keys a newer admin remembered alone, and says to reload', async () => {
    storage.setItem('askr-admin.remembered-keys', JSON.stringify({ version: 9, keys: [] }));
    const { container } = await signInScreen();
    expect(text(container)).toContain('A newer version of this admin');
    expect(text(container)).not.toContain('Clear it');
  });
});

describe('the whole app', () => {
  it('unlocks a remembered key straight into the store', async () => {
    await remembered(OWNER_KEY);
    const createDeps = vi.fn((signer: Signer) => sessionDeps(fakeApi(), fakeReader([]), signer));
    mounted = await mount(<App createDeps={createDeps} />);
    const { container } = mounted;
    await click(buttonNamed(container, 'Continue'));
    await settle(() => createDeps.mock.calls.length > 0);
    expect(createDeps.mock.calls[0]?.[0].pubkey).toBe(OWNER);
    await settle(() => text(container).includes('Set up your assistant'));
  });
});
