import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignIn } from '../src/components/SignIn';
import { ApiError } from '../src/lib/api';
import type { Signer } from '../src/lib/signer';
import { type Mounted, buttonNamed, byId, click, mount, typeInto } from './mount';

const NO_RECOVERY = async () => undefined;

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
    mounted = await mount(<SignIn onSigner={onSigner} recover={NO_RECOVERY} />);
    const field = setKey(mounted.container, nip19.nsecEncode(secretKey));
    await click(buttonNamed(mounted.container, 'Sign in'));
    expect(field.value).toBe('');
    expect(onSigner).toHaveBeenCalledTimes(1);
    const signer = onSigner.mock.calls[0]?.[0];
    expect(signer?.pubkey).toBe(getPublicKey(secretKey));
  });

  it('refuses something that is not a secret key', async () => {
    const onSigner = vi.fn();
    mounted = await mount(<SignIn onSigner={onSigner} recover={NO_RECOVERY} />);
    setKey(mounted.container, nip19.npubEncode(getPublicKey(generateSecretKey())));
    await click(buttonNamed(mounted.container, 'Sign in'));
    expect(onSigner).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain('That is not a secret key');
  });

  it('shows a new key once with a warning, and continues only once saved', async () => {
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} recover={NO_RECOVERY} />);
    await click(buttonNamed(mounted.container, 'Create a secret key'));
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
    mounted = await mount(<SignIn onSigner={() => undefined} recover={NO_RECOVERY} />);
    const field = setKey(mounted.container, nip19.nsecEncode(generateSecretKey()));
    window.dispatchEvent(new Event('pagehide'));
    expect(field.value).toBe('');
  });
});

describe('replacing a lost secret key (K20)', () => {
  const STORE = getPublicKey(generateSecretKey());

  async function toProof(recover: (signer: Signer, from: string) => Promise<void>) {
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} recover={recover} />);
    const { container } = mounted;
    await click(buttonNamed(container, 'Lost your secret key?'));
    const field = byId(container, 'recover-store');
    await typeInto(field, 'not a store id');
    await click(buttonNamed(container, 'Make a new secret key'));
    expect(container.textContent).toContain('That is not a Store ID');
    await typeInto(field, nip19.npubEncode(STORE));
    await click(buttonNamed(container, 'Make a new secret key'));
    const text = container.textContent ?? '';
    const nsec = /nsec1[02-9ac-hj-np-z]+/.exec(text)?.[0];
    const checkbox = container.querySelector('input[type="checkbox"]');
    if (nsec === undefined || !(checkbox instanceof HTMLInputElement)) {
      throw new Error('no new key shown');
    }
    await click(checkbox);
    await click(buttonNamed(container, 'Continue'));
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') {
      throw new Error('not an nsec');
    }
    return { container, onSigner, newKey: getPublicKey(decoded.data) };
  }

  it('makes a new key, shows the site proof for it, and signs in once the store moved', async () => {
    const recover = vi.fn(async (_signer: Signer, _from: string) => undefined);
    const { container, onSigner, newKey } = await toProof(recover);
    expect(container.textContent).toContain(
      `<meta name="askr-verification" content="${nip19.npubEncode(newKey)}">`,
    );
    await click(buttonNamed(container, 'Check my site and move the store'));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0]?.[0].pubkey).toBe(newKey);
    expect(recover.mock.calls[0]?.[1]).toBe(STORE);
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(newKey);
  });

  it('says why the site did not prove it, and stays on the step to retry', async () => {
    const recover = vi.fn(async () => {
      throw new ApiError(409, 'site_not_proven', {
        failures: [{ origin: 'https://shop.example', reason: 'not_found' }],
      });
    });
    const { container, onSigner } = await toProof(recover);
    await click(buttonNamed(container, 'Check my site and move the store'));
    expect(container.textContent).toContain('https://shop.example: the tag or file was not found');
    expect(onSigner).not.toHaveBeenCalled();
    expect(buttonNamed(container, 'Check my site and move the store').disabled).toBe(false);
  });

  it('opens on the replacement for the Store ID the admin started it from', async () => {
    mounted = await mount(
      <SignIn
        onSigner={() => undefined}
        recover={NO_RECOVERY}
        replaceKeyOf={nip19.npubEncode(STORE)}
      />,
    );
    const field = byId(mounted.container, 'recover-store');
    expect(field instanceof HTMLInputElement && field.value).toBe(nip19.npubEncode(STORE));
  });

  it('offers no browser extension sign-in', async () => {
    mounted = await mount(<SignIn onSigner={() => undefined} recover={NO_RECOVERY} />);
    expect(mounted.container.textContent).not.toMatch(/extension|nostr/i);
  });
});
