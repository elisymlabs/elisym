import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgetOnDevice } from '../../src/hosted/components/ForgetOnDevice';
import { MoveKeyChoice } from '../../src/hosted/components/MoveKeyChoice';
import { SignIn } from '../../src/hosted/components/SignIn';
import { forgetKey, readRemembered, rememberKey } from '../../src/hosted/lib/remembered';
import * as signerModule from '../../src/hosted/lib/signer';
import type { OwnerKey, Signer } from '../../src/hosted/lib/signer';
import { type Mounted, buttonNamed, click, inputById, mount, settle, turns } from '../mount';
import { type MemoryStorage, freshDeviceKeys, installStorage } from './stored';

/** Every key handed to a signer, every new owner key made and every pasted key read, by reference. */
const handed = vi.hoisted(() => ({
  keys: [] as Uint8Array[],
  made: [] as { secretKey: Uint8Array }[],
  parsed: [] as Uint8Array[],
}));

vi.mock('../../src/hosted/lib/signer', async (importOriginal) => {
  const actual = await importOriginal<typeof signerModule>();
  return {
    ...actual,
    secretKeySigner: (secretKey: Uint8Array): Signer => {
      const signer = actual.secretKeySigner(secretKey);
      handed.keys.push(secretKey);
      return signer;
    },
    parseSecretKey: (input: string): Uint8Array | undefined => {
      const parsed = actual.parseSecretKey(input);
      if (parsed !== undefined) {
        handed.parsed.push(parsed);
      }
      return parsed;
    },
    generateOwnerKey: (): OwnerKey => {
      const made = actual.generateOwnerKey();
      handed.made.push(made);
      return made;
    },
  };
});

const isZero = (bytes: Uint8Array | undefined) =>
  bytes !== undefined && bytes.length === 32 && bytes.every((byte) => byte === 0);

let mounted: Mounted | undefined;
let storage: MemoryStorage;
beforeEach(() => {
  handed.keys.length = 0;
  handed.made.length = 0;
  handed.parsed.length = 0;
  storage = installStorage();
  freshDeviceKeys();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the sign-in leaves no copy of the key behind', () => {
  it('zeroes the pasted key once the signer has its own copy', async () => {
    const secretKey = generateSecretKey();
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} />);
    const { container } = mounted;
    await click(inputById(container, 'sign-in-remember'));
    inputById(container, 'owner-key').value = nip19.nsecEncode(secretKey);
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(handed.keys).toHaveLength(1);
    expect(isZero(handed.keys[0])).toBe(true);
    // The signer still signs: it zeroed only the bytes it was handed.
    const event = await onSigner.mock.calls[0]?.[0].signEvent({
      kind: 1,
      created_at: 0,
      tags: [],
      content: '',
    });
    expect(event?.pubkey).toBe(getPublicKey(secretKey));
  });

  it('zeroes a pasted key that could not be remembered, too', async () => {
    mounted = await mount(<SignIn onSigner={() => undefined} />);
    const { container } = mounted;
    inputById(container, 'owner-key').value = nip19.nsecEncode(generateSecretKey());
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => (container.textContent ?? '').includes('could not be remembered'));
    expect(handed.parsed).toHaveLength(1);
    expect(isZero(handed.parsed[0])).toBe(true);
    expect(handed.keys).toHaveLength(0);
  });

  it('zeroes a new key after Continue, and on Back', async () => {
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} />);
    const { container } = mounted;
    await click(buttonNamed(container, 'Create an owner key'));
    await click(buttonNamed(container, 'Back'));
    expect(isZero(handed.made[0]?.secretKey)).toBe(true);
    await click(buttonNamed(container, 'Create an owner key'));
    const saved = [...container.querySelectorAll('input[type="checkbox"]')].find(
      (box) => box.id === '',
    );
    if (!(saved instanceof HTMLInputElement)) {
      throw new Error('no "I saved my key" box');
    }
    await click(saved);
    await click(buttonNamed(container, 'Continue'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(handed.made).toHaveLength(2);
    expect(handed.keys[0]).toBe(handed.made[1]?.secretKey);
    expect(isZero(handed.made[1]?.secretKey)).toBe(true);
  });

  it('zeroes a remembered key once unlocked', async () => {
    expect(await rememberKey(generateSecretKey())).toBe(true);
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} />);
    await click(buttonNamed(mounted.container, 'Continue'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(handed.keys).toHaveLength(1);
    expect(isZero(handed.keys[0])).toBe(true);
  });
});

describe('a double press', () => {
  it('signs in once when Sign in is pressed twice before the page re-renders', async () => {
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} />);
    const { container } = mounted;
    inputById(container, 'owner-key').value = nip19.nsecEncode(generateSecretKey());
    const button = buttonNamed(container, 'Sign in');
    await act(async () => {
      button.click();
      button.click();
    });
    await settle(() => onSigner.mock.calls.length > 0);
    await turns();
    expect(onSigner).toHaveBeenCalledTimes(1);
  });

  it('unlocks once when Continue is pressed twice before the page re-renders', async () => {
    expect(await rememberKey(generateSecretKey())).toBe(true);
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} />);
    const button = buttonNamed(mounted.container, 'Continue');
    await act(async () => {
      button.click();
      button.click();
    });
    await settle(() => onSigner.mock.calls.length > 0);
    await turns();
    expect(onSigner).toHaveBeenCalledTimes(1);
  });
});

describe('a key forgotten in another tab', () => {
  it('is not used: Continue says so and signs nothing', async () => {
    const secretKey = generateSecretKey();
    expect(await rememberKey(secretKey)).toBe(true);
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} />);
    const { container } = mounted;
    // Another tab forgets it after this page read the list.
    expect(forgetKey(getPublicKey(secretKey))).toBe(true);
    await click(buttonNamed(container, 'Continue'));
    await turns();
    expect(container.textContent).toContain('it was forgotten in another tab');
    expect(onSigner).not.toHaveBeenCalled();
    expect(handed.keys).toHaveLength(0);
  });
});

describe('forgetting when the browser refuses', () => {
  it('says so in Forget this device, and keeps saying it is remembered', async () => {
    const secretKey = generateSecretKey();
    expect(await rememberKey(secretKey)).toBe(true);
    mounted = await mount(<ForgetOnDevice owner={getPublicKey(secretKey)} />);
    const { container } = mounted;
    storage.failing.add('removeItem');
    await click(buttonNamed(container, 'Forget this device'));
    await click(buttonNamed(container, 'Forget'));
    expect(container.textContent).toContain('did not let the admin forget it');
    expect(container.textContent).toContain('This device remembers your owner key');
    storage.failing.clear();
    expect(readRemembered().keys).toHaveLength(1);
    await click(buttonNamed(container, 'Forget this device'));
    await click(buttonNamed(container, 'Forget'));
    expect(container.textContent).toContain('no longer remembers your owner key');
    expect(readRemembered().keys).toHaveLength(0);
  });

  it('says so in the sign-in list, and keeps the key offered', async () => {
    expect(await rememberKey(generateSecretKey())).toBe(true);
    mounted = await mount(<SignIn onSigner={() => undefined} />);
    const { container } = mounted;
    storage.failing.add('removeItem');
    const rowForget = container.querySelector('button[aria-label^="Forget owner"]');
    if (!(rowForget instanceof HTMLButtonElement)) {
      throw new Error('no Forget');
    }
    await click(rowForget);
    const confirm = [...container.querySelectorAll('button')]
      .filter((button) => button.textContent === 'Forget')
      .at(-1);
    if (confirm === undefined) {
      throw new Error('no confirmation');
    }
    await click(confirm);
    expect(container.textContent).toContain('did not let the admin forget it');
    expect(container.textContent).toContain('Continue on this device');
  });
});

describe('the move key step leaves no copy of the new key behind', () => {
  const TEMPLATE = { kind: 1, created_at: 0, tags: [], content: '' };

  async function keyStep(check: (pubkey: string) => string | undefined = () => undefined) {
    const signers: Signer[] = [];
    const onKey = vi.fn((secretKey: Uint8Array) => {
      signers.push(signerModule.secretKeySigner(secretKey));
    });
    const onCancel = vi.fn();
    mounted = await mount(<MoveKeyChoice check={check} onKey={onKey} onCancel={onCancel} />);
    return { container: mounted.container, onKey, onCancel, signers };
  }

  function savedBox(container: HTMLElement): HTMLInputElement {
    const saved = [...container.querySelectorAll('input[type="checkbox"]')].find(
      (box) => box.id === '',
    );
    if (!(saved instanceof HTMLInputElement)) {
      throw new Error('no "I saved my key" box');
    }
    return saved;
  }

  it('zeroes the pasted key once it was handed on, and the copy handed on still signs', async () => {
    const secretKey = generateSecretKey();
    const { container, onKey, signers } = await keyStep();
    inputById(container, 'move-new-key').value = nip19.nsecEncode(secretKey);
    await click(buttonNamed(container, 'Use this key'));
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(handed.parsed).toHaveLength(1);
    expect(isZero(handed.parsed[0])).toBe(true);
    expect(inputById(container, 'move-new-key').value).toBe('');
    const event = await signers[0]?.signEvent(TEMPLATE);
    expect(event?.pubkey).toBe(getPublicKey(secretKey));
  });

  it('zeroes a pasted key it refused (the current owner key)', async () => {
    const secretKey = generateSecretKey();
    const { container, onKey } = await keyStep(
      () => 'That is the owner key you are signed in with.',
    );
    inputById(container, 'move-new-key').value = nip19.nsecEncode(secretKey);
    await click(buttonNamed(container, 'Use this key'));
    expect(onKey).not.toHaveBeenCalled();
    expect(handed.parsed).toHaveLength(1);
    expect(isZero(handed.parsed[0])).toBe(true);
  });

  it('zeroes a new key after Continue, once handed on, and the copy handed on still signs', async () => {
    const { container, onKey, signers } = await keyStep();
    await click(buttonNamed(container, 'Create a new owner key'));
    const made = handed.made[0];
    if (made === undefined) {
      throw new Error('no key made');
    }
    const pubkey = getPublicKey(made.secretKey);
    expect(isZero(made.secretKey)).toBe(false);
    await click(savedBox(container));
    await click(buttonNamed(container, 'Continue'));
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(isZero(made.secretKey)).toBe(true);
    const event = await signers[0]?.signEvent(TEMPLATE);
    expect(event?.pubkey).toBe(pubkey);
  });

  it('zeroes a new key on Back, and hands nothing on', async () => {
    const { container, onKey } = await keyStep();
    await click(buttonNamed(container, 'Create a new owner key'));
    await click(buttonNamed(container, 'Back'));
    expect(handed.made).toHaveLength(1);
    expect(isZero(handed.made[0]?.secretKey)).toBe(true);
    expect(onKey).not.toHaveBeenCalled();
    expect(container.querySelector('#move-new-key')).not.toBeNull();
  });

  it('clears a typed key from the field on pagehide', async () => {
    const { container, onKey } = await keyStep();
    inputById(container, 'move-new-key').value = nip19.nsecEncode(generateSecretKey());
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(inputById(container, 'move-new-key').value).toBe('');
    expect(onKey).not.toHaveBeenCalled();
  });

  it('zeroes a new key when the step goes away without Continue or Back', async () => {
    const { container, onKey } = await keyStep();
    await click(buttonNamed(container, 'Create a new owner key'));
    const made = handed.made[0];
    expect(made !== undefined && !isZero(made.secretKey)).toBe(true);
    await mounted?.unmount();
    mounted = undefined;
    expect(isZero(made?.secretKey)).toBe(true);
    expect(onKey).not.toHaveBeenCalled();
  });

  it('zeroes a new key on pagehide and shows the paste field again', async () => {
    const { container, onKey } = await keyStep();
    await click(buttonNamed(container, 'Create a new owner key'));
    const made = handed.made[0];
    if (made === undefined) {
      throw new Error('no key made');
    }
    const nsec = nip19.nsecEncode(Uint8Array.from(made.secretKey));
    expect(container.textContent).toContain(nsec);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(isZero(made.secretKey)).toBe(true);
    expect(container.textContent).not.toContain(nsec);
    expect(container.querySelector('#move-new-key')).not.toBeNull();
    expect(onKey).not.toHaveBeenCalled();
  });
});
