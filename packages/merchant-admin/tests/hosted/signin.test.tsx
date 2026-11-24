import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignIn } from '../../src/hosted/components/SignIn';
import { readRemembered, rememberKey } from '../../src/hosted/lib/remembered';
import type { Signer } from '../../src/hosted/lib/signer';
import { type Mounted, buttonNamed, click, inputById, mount, settle } from '../mount';
import { type MemoryStorage, freshDeviceKeys, installStorage, plainForms } from './stored';

let mounted: Mounted | undefined;
let storage: MemoryStorage;
beforeEach(() => {
  storage = installStorage();
  freshDeviceKeys();
  vi.spyOn(globalThis, 'sessionStorage', 'get').mockReturnValue(installSession());
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installSession(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => void items.set(name, value),
    removeItem: (name) => void items.delete(name),
    clear: () => items.clear(),
  };
}

function rememberBox(container: HTMLElement, id: string): HTMLInputElement {
  return inputById(container, `${id}-remember`);
}

async function signInWith(pasted: string, remember: boolean) {
  const onSigner = vi.fn<(signer: Signer) => void>();
  mounted = await mount(<SignIn onSigner={onSigner} />);
  const { container } = mounted;
  if (!remember) {
    await click(rememberBox(container, 'sign-in'));
  }
  const field = inputById(container, 'owner-key');
  field.value = pasted;
  await click(buttonNamed(container, 'Sign in'));
  await settle(
    () =>
      onSigner.mock.calls.length > 0 ||
      (container.textContent ?? '').includes('That is not an owner key'),
  );
  return { container, field, onSigner };
}

describe('signing in with a pasted owner key', () => {
  it('takes an nsec, clears the field, and signs as that key without remembering it', async () => {
    const secretKey = generateSecretKey();
    const { field, onSigner } = await signInWith(nip19.nsecEncode(secretKey), false);
    expect(field.value).toBe('');
    expect(onSigner).toHaveBeenCalledTimes(1);
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(getPublicKey(secretKey));
    expect(storage.writes.filter((write) => !write.startsWith('paycore-hosted.probe'))).toEqual([]);
  });

  it('takes 64 hex characters, and remembers the key sealed when the box stays on', async () => {
    const secretKey = generateSecretKey();
    const { onSigner } = await signInWith(bytesToHex(secretKey), true);
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(getPublicKey(secretKey));
    expect(readRemembered().keys.map((key) => key.owner)).toEqual([getPublicKey(secretKey)]);
    for (const plain of plainForms(secretKey)) {
      expect(storage.everything()).not.toContain(plain);
    }
  });

  it('refuses what is not an owner key, and clears it', async () => {
    const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const { container, field, onSigner } = await signInWith(npub, false);
    expect(onSigner).not.toHaveBeenCalled();
    expect(field.value).toBe('');
    expect(container.textContent).toContain('That is not an owner key');
  });

  it('keeps the pasted key in the field when it could not be remembered, so a retry needs no paste', async () => {
    storage.failing.add('setItem');
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} />);
    const { container } = mounted;
    // The box is offered only where the browser keeps things: here it cannot, so it says so.
    expect(container.textContent).toContain('does not let the admin remember your key');
    storage.failing.clear();
    await mounted.unmount();
    mounted = await mount(<SignIn onSigner={onSigner} />);
    const field = inputById(mounted.container, 'owner-key');
    const nsec = nip19.nsecEncode(generateSecretKey());
    field.value = nsec;
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    await click(buttonNamed(mounted.container, 'Sign in'));
    const shown = mounted.container;
    await settle(() => (shown.textContent ?? '').includes('could not be remembered'));
    expect(onSigner).not.toHaveBeenCalled();
    expect(field.value).toBe(nsec);
  });

  it('clears the field when the page is hidden, so the back/forward cache does not keep it', async () => {
    mounted = await mount(<SignIn onSigner={() => undefined} />);
    const field = inputById(mounted.container, 'owner-key');
    field.value = nip19.nsecEncode(generateSecretKey());
    window.dispatchEvent(new Event('pagehide'));
    expect(field.value).toBe('');
  });

  it('links back to the self-host sign-in, and offers no browser extension', async () => {
    mounted = await mount(<SignIn onSigner={() => undefined} />);
    const links = [...mounted.container.querySelectorAll('main a')];
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Sign in with your store key', '/'],
    ]);
    expect(mounted.container.textContent).not.toMatch(/extension|NIP-07|askr/i);
  });
});

describe('a new owner key', () => {
  it('is shown once with a warning, and goes on only once saved', async () => {
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} />);
    const { container } = mounted;
    await click(buttonNamed(container, 'Create an owner key'));
    const text = container.textContent ?? '';
    expect(text).toContain('It is shown only once');
    const nsec = /nsec1[02-9ac-hj-np-z]+/.exec(text)?.[0];
    if (nsec === undefined) {
      throw new Error('no nsec shown');
    }
    const continueButton = buttonNamed(container, 'Continue');
    expect(continueButton.disabled).toBe(true);
    const saved = [...container.querySelectorAll('input[type="checkbox"]')].find(
      (box) => box.id === '',
    );
    if (!(saved instanceof HTMLInputElement)) {
      throw new Error('no "I saved my key" box');
    }
    await click(saved);
    expect(continueButton.disabled).toBe(false);
    await click(continueButton);
    await settle(() => onSigner.mock.calls.length > 0);
    const decoded = nip19.decode(nsec);
    expect(decoded.type === 'nsec' && onSigner.mock.calls[0]?.[0].pubkey).toBe(
      decoded.type === 'nsec' ? getPublicKey(decoded.data) : '',
    );
    // Remembered by default: the next visit offers Continue.
    expect(readRemembered().keys).toHaveLength(1);
  });

  it('goes back to the sign-in without the key', async () => {
    mounted = await mount(<SignIn onSigner={() => undefined} />);
    const { container } = mounted;
    await click(buttonNamed(container, 'Create an owner key'));
    await click(buttonNamed(container, 'Back'));
    expect(container.textContent).not.toMatch(/nsec1/);
    expect(container.textContent).toContain('Create an owner key');
  });
});

describe('a key this device remembers', () => {
  it('signs in with one press of Continue, as that owner', async () => {
    const secretKey = generateSecretKey();
    expect(await rememberKey(secretKey)).toBe(true);
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} />);
    const { container } = mounted;
    expect(container.textContent).toContain('Continue on this device');
    await click(buttonNamed(container, 'Continue'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(getPublicKey(secretKey));
  });

  it('is forgotten after a confirmation, and then no longer offered', async () => {
    expect(await rememberKey(generateSecretKey())).toBe(true);
    mounted = await mount(<SignIn onSigner={() => undefined} />);
    const { container } = mounted;
    const rowForget = container.querySelector('button[aria-label^="Forget owner"]');
    if (!(rowForget instanceof HTMLButtonElement)) {
      throw new Error('no Forget');
    }
    await click(rowForget);
    expect(container.textContent).toContain('Forget the key remembered for owner');
    await click(buttonNamed(container, 'Keep it'));
    expect(readRemembered().keys).toHaveLength(1);
    await click(rowForget);
    const confirm = [...container.querySelectorAll('button')]
      .filter((button) => button.textContent === 'Forget')
      .at(-1);
    if (confirm === undefined) {
      throw new Error('no confirmation');
    }
    await click(confirm);
    expect(readRemembered().keys).toHaveLength(0);
    expect(container.textContent).not.toContain('Continue on this device');
  });

  it('offers to clear what could not be read, keeping what can', async () => {
    const secretKey = generateSecretKey();
    expect(await rememberKey(secretKey)).toBe(true);
    const stored = JSON.parse(storage.getItem('paycore-hosted.remembered-keys') ?? '{}');
    storage.setItem(
      'paycore-hosted.remembered-keys',
      JSON.stringify({ ...stored, keys: [...stored.keys, 'junk'] }),
    );
    mounted = await mount(<SignIn onSigner={() => undefined} />);
    const { container } = mounted;
    expect(container.textContent).toContain('could not be read');
    await click(buttonNamed(container, 'Clear it'));
    await click(buttonNamed(container, 'Clear'));
    expect(readRemembered()).toMatchObject({
      damaged: false,
      keys: [{ owner: getPublicKey(secretKey) }],
    });
    expect(container.textContent).not.toContain('could not be read');
  });
});
