import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignIn } from '../src/components/SignIn';
import type { Nip07Provider, Signer } from '../src/lib/signer';
import { NIP44_STUB } from './fakes';
import { type Mounted, buttonNamed, byId, click, mount } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function setKey(container: HTMLElement, value: string) {
  const field = byId(container, 'owner-key');
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('no key field');
  }
  field.value = value;
  return field;
}

describe('sign-in', () => {
  it('takes a pasted nsec, clears the field, and signs as that key', async () => {
    const secretKey = generateSecretKey();
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} findExtension={() => undefined} />);
    const field = setKey(mounted.container, nip19.nsecEncode(secretKey));
    await click(buttonNamed(mounted.container, 'Sign in'));
    expect(field.value).toBe('');
    expect(onSigner).toHaveBeenCalledTimes(1);
    const signer = onSigner.mock.calls[0]?.[0];
    expect(signer?.pubkey).toBe(getPublicKey(secretKey));
    expect(signer?.kind).toBe('secret-key');
  });

  it('refuses something that is not a secret key', async () => {
    const onSigner = vi.fn();
    mounted = await mount(<SignIn onSigner={onSigner} findExtension={() => undefined} />);
    setKey(mounted.container, nip19.npubEncode(getPublicKey(generateSecretKey())));
    await click(buttonNamed(mounted.container, 'Sign in'));
    expect(onSigner).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain('That is not a secret key');
  });

  it('uses a NIP-07 extension when there is one, and says so when there is none', async () => {
    const pubkey = getPublicKey(generateSecretKey());
    const extension: Nip07Provider = {
      getPublicKey: async () => pubkey,
      nip44: NIP44_STUB,
      signEvent: async () => {
        throw new Error('not used');
      },
    };
    const onSigner = vi.fn<(signer: Signer) => void>();
    let found: Nip07Provider | undefined;
    mounted = await mount(<SignIn onSigner={onSigner} findExtension={() => found} />);
    await click(buttonNamed(mounted.container, 'Sign in with a browser extension'));
    expect(mounted.container.textContent).toContain('No Nostr signing extension');
    found = extension;
    await click(buttonNamed(mounted.container, 'Sign in with a browser extension'));
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(pubkey);
    expect(onSigner.mock.calls[0]?.[0].kind).toBe('extension');
  });

  it('shows a new key once with a warning, and continues only once saved', async () => {
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} findExtension={() => undefined} />);
    await click(buttonNamed(mounted.container, 'Create a new owner key'));
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('It is shown only once');
    const nsec = /nsec1[02-9ac-hj-np-z]+/.exec(text)?.[0];
    if (nsec === undefined) {
      throw new Error('no nsec shown');
    }
    const continueButton = buttonNamed(mounted.container, 'Continue');
    expect(continueButton.disabled).toBe(true);
    const checkbox = mounted.container.querySelector('input[type="checkbox"]');
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error('no checkbox');
    }
    await click(checkbox);
    await click(continueButton);
    const decoded = nip19.decode(nsec);
    expect(decoded.type).toBe('nsec');
    if (decoded.type === 'nsec') {
      expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(getPublicKey(decoded.data));
    }
  });
});

describe('the key field', () => {
  it('is cleared when the page is hidden, so the back/forward cache does not keep it', async () => {
    mounted = await mount(<SignIn onSigner={() => undefined} findExtension={() => undefined} />);
    const field = setKey(mounted.container, nip19.nsecEncode(generateSecretKey()));
    window.dispatchEvent(new Event('pagehide'));
    expect(field.value).toBe('');
  });
});
