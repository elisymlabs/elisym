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
import { OWNER, OWNER_KEY, fakeApi, fakeReader, sessionDeps, storeView } from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle, typeInto } from './mount';
import { type MemoryStorage, installStorage, plainForms } from './stored';

const PASSWORD = 'a long enough password';
const NO_RECOVERY = async () => undefined;
const UI_WORDS_NOT_FOR_MERCHANTS = /nostr|nip-?49|ncryptsec|npub|nsec/i;
const STORE_ID_VALUE = /npub1[02-9ac-hj-np-z]+(?:\.\.\.[02-9ac-hj-np-z]+)?/g;

let mounted: Mounted | undefined;
let storage: MemoryStorage;
beforeEach(() => {
  storage = installStorage();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
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

/** Tick "remember" with prefix `id` and type the password twice. */
async function chooseRemember(container: HTMLElement, id: string, first: string, second = first) {
  await click(inputById(container, `${id}-remember`));
  inputById(container, `${id}-password`).value = first;
  inputById(container, `${id}-repeat`).value = second;
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

  it('is remembered on this device only locked, once the password is long enough and repeated', async () => {
    const { container, onSigner } = await signInScreen();
    await click(buttonNamed(container, 'Create a secret key'));
    await click(inputById(container, 'new-key-remember'));
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')];
    const saved = checkboxes.find((box) => box.id === '');
    if (!(saved instanceof HTMLInputElement)) {
      throw new Error('no saved checkbox');
    }
    await click(saved);
    inputById(container, 'new-key-password').value = 'short';
    inputById(container, 'new-key-repeat').value = 'short';
    await click(buttonNamed(container, 'Continue'));
    expect(text(container)).toContain('at least 10 characters');
    expect(onSigner).not.toHaveBeenCalled();
    inputById(container, 'new-key-password').value = PASSWORD;
    inputById(container, 'new-key-repeat').value = `${PASSWORD}!`;
    await click(buttonNamed(container, 'Continue'));
    expect(text(container)).toContain('not the same');
    expect(storage.writes.filter((write) => write.includes('remembered'))).toEqual([]);
    inputById(container, 'new-key-repeat').value = PASSWORD;
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

  it('is not remembered unless chosen', async () => {
    const { container, onSigner } = await signInScreen();
    await click(buttonNamed(container, 'Create a secret key'));
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
  it('remembers it locked and unlocks it next time with the password', async () => {
    const first = await signInScreen();
    inputById(first.container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await chooseRemember(first.container, 'sign-in', PASSWORD);
    await click(buttonNamed(first.container, 'Sign in'));
    await settle(() => first.onSigner.mock.calls.length > 0);
    expect(first.onSigner.mock.calls[0]?.[0].pubkey).toBe(OWNER);
    expect(inputById(first.container, 'owner-key').value).toBe('');
    expectNoPlainKey(OWNER_KEY);
    await mounted?.unmount();

    const next = await signInScreen();
    expect(text(next.container)).toContain('Unlock with your password');
    expect(next.container.innerHTML).not.toMatch(/ncryptsec/i);
    const password = inputById(next.container, 'unlock-password');
    password.value = 'not the password';
    await click(buttonNamed(next.container, 'Unlock'));
    await settle(() => text(next.container).includes('does not unlock'));
    expect(text(next.container)).not.toMatch(/tag|invalid|error/i);
    expect(password.value).toBe('');
    expect(next.onSigner).not.toHaveBeenCalled();
    password.value = PASSWORD;
    await click(buttonNamed(next.container, 'Unlock'));
    await settle(() => next.onSigner.mock.calls.length > 0);
    expect(next.onSigner.mock.calls[0]?.[0].pubkey).toBe(OWNER);
  });

  it('asks for a password before unlocking', async () => {
    rememberKey(OWNER_KEY, PASSWORD);
    const { container, onSigner } = await signInScreen();
    await click(buttonNamed(container, 'Unlock'));
    expect(text(container)).toContain('Type the password');
    expect(onSigner).not.toHaveBeenCalled();
  });

  it('keeps the pasted key in place while the password needs fixing', async () => {
    const { container, onSigner } = await signInScreen();
    const field = inputById(container, 'owner-key');
    field.value = nip19.nsecEncode(OWNER_KEY);
    await chooseRemember(container, 'sign-in', 'short');
    await click(buttonNamed(container, 'Sign in'));
    expect(text(container)).toContain('at least 10 characters');
    expect(field.value).toBe(nip19.nsecEncode(OWNER_KEY));
    expect(onSigner).not.toHaveBeenCalled();
  });

  it('says so and stays when this browser refuses the write', async () => {
    const { container, onSigner } = await signInScreen();
    storage.failing.add('setItem');
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await chooseRemember(container, 'sign-in', PASSWORD);
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
});

describe('the sign-in page with keys remembered', () => {
  it('lists each store remembered here and unlocks the one chosen', async () => {
    const other = generateSecretKey();
    rememberKey(OWNER_KEY, PASSWORD);
    rememberKey(other, 'the other password');
    const { container, onSigner } = await signInScreen();
    const select = byId(container, 'remembered-store');
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no store choice');
    }
    expect([...select.options].map((option) => option.value)).toEqual([getPublicKey(other), OWNER]);
    inputById(container, 'unlock-password').value = 'the other password';
    await click(buttonNamed(container, 'Unlock'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(getPublicKey(other));
  });

  it('forgets this device only after a confirmation', async () => {
    rememberKey(OWNER_KEY, PASSWORD);
    const { container } = await signInScreen();
    await click(buttonNamed(container, 'Forget this device'));
    await click(buttonNamed(container, 'Keep it'));
    expect(readRemembered().keys).toHaveLength(1);
    await click(buttonNamed(container, 'Forget this device'));
    expect(text(container)).toContain('you need your secret key, or the file you downloaded');
    await click(buttonNamed(container, 'Forget'));
    expect(readRemembered().keys).toEqual([]);
    expect(text(container)).not.toContain('Unlock with your password');
  });

  it('says it could not forget when the browser refuses', async () => {
    rememberKey(OWNER_KEY, PASSWORD);
    const { container } = await signInScreen();
    storage.failing.add('removeItem');
    await click(buttonNamed(container, 'Forget this device'));
    await click(buttonNamed(container, 'Forget'));
    expect(text(container)).toContain('did not let the admin forget it');
  });

  it('says what was damaged and clears it on request', async () => {
    storage.setItem('askr-admin.remembered-keys', '{not json');
    const { container } = await signInScreen();
    expect(text(container)).toContain('could not be read, so it is not offered');
    expect(text(container)).not.toContain('Unlock with your password');
    await click(buttonNamed(container, 'Clear it'));
    await click(buttonNamed(container, 'Keep it'));
    expect(storage.getItem('askr-admin.remembered-keys')).toBe('{not json');
    await click(buttonNamed(container, 'Clear it'));
    await click(buttonNamed(container, 'Clear'));
    expect(storage.getItem('askr-admin.remembered-keys')).toBeNull();
    expect(text(container)).not.toContain('could not be read');
  });

  it('uses merchant words only', async () => {
    rememberKey(OWNER_KEY, PASSWORD);
    const { container } = await signInScreen();
    await click(inputById(container, 'sign-in-remember'));
    // A Store ID's value starts with npub1, as everywhere in the admin; no word names the scheme.
    const words = text(container).replaceAll(STORE_ID_VALUE, '');
    expect(text(container)).toContain('npub1');
    expect(words).not.toMatch(UI_WORDS_NOT_FOR_MERCHANTS);
  });

  it('clears both password fields and the unlock password when the page is hidden', async () => {
    rememberKey(OWNER_KEY, PASSWORD);
    const { container } = await signInScreen();
    await chooseRemember(container, 'sign-in', PASSWORD);
    inputById(container, 'unlock-password').value = PASSWORD;
    window.dispatchEvent(new Event('pagehide'));
    expect(inputById(container, 'unlock-password').value).toBe('');
    expect(inputById(container, 'sign-in-password').value).toBe('');
    expect(inputById(container, 'sign-in-repeat').value).toBe('');
  });

  it('offers no remembering where the browser keeps nothing, and still signs in', async () => {
    storage.failing.add('setItem');
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
    rememberKey(OWNER_KEY, PASSWORD);
    const container = await keysSection();
    expect(text(container)).toContain('This device remembers this secret key');
    await click(buttonNamed(container, 'Forget this device'));
    await click(buttonNamed(container, 'Forget'));
    expect(readRemembered().keys).toEqual([]);
    expect(text(container)).toContain('no longer remembers');
  });

  it('is not offered when this device does not remember it', async () => {
    rememberKey(generateSecretKey(), PASSWORD);
    const container = await keysSection();
    expect(text(container)).not.toContain('Forget this device');
  });

  it('says so when the browser refuses', async () => {
    rememberKey(OWNER_KEY, PASSWORD);
    const container = await keysSection();
    storage.failing.add('setItem');
    storage.failing.add('removeItem');
    await click(buttonNamed(container, 'Forget this device'));
    await click(buttonNamed(container, 'Forget'));
    expect(text(container)).toContain('did not let the admin forget it');
    expect(readRemembered().keys).toHaveLength(1);
  });

  it('is offered for a remembered key the store moved away from', async () => {
    rememberKey(OWNER_KEY, PASSWORD);
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

  it('drops the old key and remembers the new one once the store moved, if chosen', async () => {
    rememberKey(OLD_KEY, PASSWORD);
    const { container, onSigner, newKey } = await toProof(async () => undefined);
    await chooseRemember(container, 'moved-key', 'the new password');
    await click(buttonNamed(container, 'Check my site and move the store'));
    await settle(() => onSigner.mock.calls.length > 0);
    const keys = readRemembered().keys;
    expect(keys.map((key) => key.store)).toEqual([getPublicKey(newKey)]);
    const [remembered] = keys;
    expect(remembered === undefined ? false : unlockKey(remembered, 'the new password').ok).toBe(
      true,
    );
    expectNoPlainKey(newKey);
  });

  it('drops the old key even when the new one is not to be remembered', async () => {
    rememberKey(OLD_KEY, PASSWORD);
    const { container, onSigner } = await toProof(async () => undefined);
    await click(buttonNamed(container, 'Check my site and move the store'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(readRemembered().keys).toEqual([]);
  });

  it('keeps everything as it was while the store has not moved', async () => {
    rememberKey(OLD_KEY, PASSWORD);
    const { container, onSigner } = await toProof(async (_signer, _from, dryRun) => {
      if (!dryRun) {
        throw new ApiError(409, 'site_not_proven', { failures: [] });
      }
    });
    await chooseRemember(container, 'moved-key', 'the new password');
    await click(buttonNamed(container, 'Check my site and move the store'));
    await settle(() => text(container).includes("None of your store's sites"));
    expect(onSigner).not.toHaveBeenCalled();
    expect(readRemembered().keys.map((key) => key.store)).toEqual([OLD]);
  });

  it('refuses a short password before checking the site', async () => {
    const recover = vi.fn(async () => undefined);
    const { container } = await toProof(recover);
    await chooseRemember(container, 'moved-key', 'short');
    await click(buttonNamed(container, 'Check my site and move the store'));
    expect(text(container)).toContain('at least 10 characters');
    expect(recover).toHaveBeenCalledTimes(1);
  });
});

describe('a move that this browser does not let the admin record', () => {
  const OLD_KEY = generateSecretKey();

  async function proofWith(prepare: () => void, rememberNew: boolean) {
    rememberKey(OLD_KEY, PASSWORD);
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
    if (rememberNew) {
      await chooseRemember(container, 'moved-key', 'the new password');
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
  it('unlocks once on a double press, without a stray error', async () => {
    rememberKey(OWNER_KEY, PASSWORD);
    const { container, onSigner } = await signInScreen();
    inputById(container, 'unlock-password').value = PASSWORD;
    const unlock = buttonNamed(container, 'Unlock');
    await act(async () => {
      unlock.click();
      unlock.click();
    });
    await settle(() => onSigner.mock.calls.length > 0);
    expect(text(container)).not.toContain('Type the password');
    expect(onSigner).toHaveBeenCalledTimes(1);
  });

  it('remembers and signs in once on a double press', async () => {
    const { container, onSigner } = await signInScreen();
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await chooseRemember(container, 'sign-in', PASSWORD);
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
    await chooseRemember(container, 'new-key', PASSWORD);
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
    expect(onSigner).toHaveBeenCalledTimes(1);
  });

  it('says to clear what could not be read when that blocks remembering', async () => {
    storage.setItem('askr-admin.remembered-keys', '{not json');
    const { container, onSigner } = await signInScreen();
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await chooseRemember(container, 'sign-in', PASSWORD);
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => text(container).includes('could not be remembered'));
    expect(text(container)).toContain('clear what could not be read first');
    expect(onSigner).not.toHaveBeenCalled();
  });

  it('wipes the unlocked key once the signer has its own copy', async () => {
    rememberKey(OWNER_KEY, PASSWORD);
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
    inputById(container, 'unlock-password').value = PASSWORD;
    await click(buttonNamed(container, 'Unlock'));
    await settle(() => handed.length > 0);
    expect(handed[0]?.every((byte) => byte === 0)).toBe(true);
    expect(signers[0]?.pubkey).toBe(OWNER);
  });

  it('shows a key remembered meanwhile after coming back from the replacement', async () => {
    const { container } = await signInScreen();
    expect(text(container)).not.toContain('Unlock with your password');
    await click(buttonNamed(container, 'Lost your secret key?'));
    rememberKey(OWNER_KEY, PASSWORD);
    await click(buttonNamed(container, 'Back'));
    expect(text(container)).toContain('Unlock with your password');
  });

  it('leaves keys a newer admin remembered alone, and says to reload', async () => {
    storage.setItem('askr-admin.remembered-keys', JSON.stringify({ version: 9, keys: [] }));
    const { container } = await signInScreen();
    expect(text(container)).toContain('A newer version of this admin');
    expect(text(container)).not.toContain('Clear it');
  });

  it('gives a password manager the Store ID as the user name, never the secret key field', async () => {
    const { container } = await signInScreen();
    await click(inputById(container, 'sign-in-remember'));
    const username = inputById(container, 'sign-in-username');
    expect(username.autocomplete).toBe('username');
    expect(username.value).toBe('Askr store');
    await typeInto(inputById(container, 'owner-key'), nip19.nsecEncode(OWNER_KEY));
    expect(username.value).toBe(nip19.npubEncode(OWNER));
    await typeInto(inputById(container, 'owner-key'), 'nsec1nope');
    expect(username.value).toBe('Askr store');
    const form = username.closest('form');
    expect(form).not.toBeNull();
    expect(form?.contains(inputById(container, 'sign-in-password'))).toBe(true);
    expect(inputById(container, 'owner-key').closest('form')).toBeNull();
    await mounted?.unmount();

    const fresh = await signInScreen();
    await click(buttonNamed(fresh.container, 'Create a secret key'));
    await click(inputById(fresh.container, 'new-key-remember'));
    const npub = /npub1[02-9ac-hj-np-z]+/.exec(text(fresh.container))?.[0];
    expect(inputById(fresh.container, 'new-key-username').value).toBe(npub);
  });
});

describe('the whole app', () => {
  it('unlocks a remembered key straight into the store', async () => {
    rememberKey(OWNER_KEY, PASSWORD);
    const createDeps = vi.fn((signer: Signer) => sessionDeps(fakeApi(), fakeReader([]), signer));
    mounted = await mount(<App createDeps={createDeps} />);
    const { container } = mounted;
    await typeInto(inputById(container, 'unlock-password'), PASSWORD);
    await click(buttonNamed(container, 'Unlock'));
    await settle(() => createDeps.mock.calls.length > 0);
    expect(createDeps.mock.calls[0]?.[0].pubkey).toBe(OWNER);
    await settle(() => text(container).includes('Set up your assistant'));
  });
});
