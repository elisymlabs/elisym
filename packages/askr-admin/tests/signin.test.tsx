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

describe('replacing a lost secret key (K21)', () => {
  const STORE = getPublicKey(generateSecretKey());
  type Recover = (signer: Signer, from: string, dryRun: boolean) => Promise<void>;

  async function toStore(recover: Recover) {
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(<SignIn onSigner={onSigner} recover={recover} />);
    const { container } = mounted;
    await click(buttonNamed(container, 'Lost your secret key?'));
    return { container, onSigner };
  }

  async function toProof(recover: Recover) {
    const { container, onSigner } = await toStore(recover);
    const field = byId(container, 'recover-store');
    await typeInto(field, 'not a store id');
    await click(buttonNamed(container, 'Continue'));
    expect(container.textContent).toContain('That is not a Store ID');
    expect(recover).not.toHaveBeenCalled();
    await typeInto(field, nip19.npubEncode(STORE));
    await click(buttonNamed(container, 'Continue'));
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

  it('checks first, makes a new key, shows the site proof for it, and signs in once the store moved', async () => {
    const recover = vi.fn<Recover>(async () => undefined);
    const { container, onSigner, newKey } = await toProof(recover);
    expect(recover.mock.calls[0]?.[0].pubkey).toBe(newKey);
    expect(recover.mock.calls[0]?.[1]).toBe(STORE);
    expect(recover.mock.calls[0]?.[2]).toBe(true);
    expect(container.textContent).toContain(
      `<meta name="askr-verification" content="${nip19.npubEncode(newKey)}">`,
    );
    expect(container.textContent).toContain('Keep it on your site');
    await click(buttonNamed(container, 'Check my site and move the store'));
    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover.mock.calls[1]?.[0].pubkey).toBe(newKey);
    expect(recover.mock.calls[1]?.[2]).toBe(false);
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(newKey);
  });

  it('shows no key when the check says what stands in the way', async () => {
    const recover = vi.fn<Recover>(async () => {
      throw new ApiError(409, 'no_site_yet', { readyAt: null });
    });
    const { container } = await toStore(recover);
    await typeInto(byId(container, 'recover-store'), nip19.npubEncode(STORE));
    await click(buttonNamed(container, 'Continue'));
    expect(container.textContent).toContain('none is listed');
    expect(container.textContent).not.toMatch(/nsec1/);
  });

  it('goes on with a new key saved earlier, straight to the proof', async () => {
    const recover = vi.fn<Recover>(async () => undefined);
    const saved = generateSecretKey();
    const { container, onSigner } = await toStore(recover);
    await typeInto(byId(container, 'recover-store'), nip19.npubEncode(STORE));
    const checkbox = container.querySelector('input[type="checkbox"]');
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error('no checkbox');
    }
    await click(checkbox);
    const keyField = byId(container, 'recover-key');
    if (!(keyField instanceof HTMLInputElement)) {
      throw new Error('no key field');
    }
    keyField.value = 'nope';
    await click(buttonNamed(container, 'Continue'));
    expect(container.textContent).toContain('That is not a secret key');
    keyField.value = nip19.nsecEncode(saved);
    await click(buttonNamed(container, 'Continue'));
    expect(container.textContent).toContain(nip19.npubEncode(getPublicKey(saved)));
    expect(container.textContent).not.toContain('It is shown only once');
    await click(buttonNamed(container, 'Check my site and move the store'));
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(getPublicKey(saved));
  });

  it('says why the site did not prove it, and stays on the step to retry', async () => {
    const recover = vi.fn<Recover>(async (_signer, _from, dryRun) => {
      if (!dryRun) {
        throw new ApiError(409, 'site_not_proven', {
          failures: [{ origin: 'https://shop.example', reason: 'not_found' }],
        });
      }
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
