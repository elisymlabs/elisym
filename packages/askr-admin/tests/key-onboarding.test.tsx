import { nip19 } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { Session } from '../src/components/Session';
import { SignIn } from '../src/components/SignIn';
import { ApiError } from '../src/lib/api';
import type { BillingReturn } from '../src/lib/billing';
import type { PlanIntent } from '../src/lib/plan-intent';
import { readRemembered, rememberKey } from '../src/lib/remembered';
import type { Signer } from '../src/lib/signer';
import { markTabSignedIn } from '../src/lib/tab-session';
import { BILLING_ON, OWNER, OWNER_KEY, fakeApi, fakeReader, sessionDeps, storeView } from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle } from './mount';
import { type MemoryStorage, freshDeviceKeys, installStorage } from './stored';

const NO_RECOVERY = async () => undefined;
const STARTER_MONTHLY: PlanIntent = { plan: 'starter', interval: 'month' };
const HAVE_A_STORE = 'Already have a store? Sign in';
const SAVED_LABEL = 'I saved my key (in a password manager, or the downloaded file)';
const NEW_KEY_LEAD =
  'Askr has no accounts or passwords. This key is how you sign in: keep it like a password. Anyone who has it controls your store, and nobody can recover it for you. It is shown only once.';
const NSEC = /nsec1[02-9ac-hj-np-z]+/u;

let mounted: Mounted | undefined;
let storage: MemoryStorage;
beforeEach(() => {
  storage = installStorage();
  freshDeviceKeys();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

function heading(container: HTMLElement): string | undefined {
  return container.querySelector('h1')?.textContent ?? undefined;
}

/** The new key shown on the screen, as a secret key. */
function shownKey(container: HTMLElement): Uint8Array {
  const nsec = NSEC.exec(text(container))?.[0];
  const decoded = nsec === undefined ? undefined : nip19.decode(nsec);
  if (decoded?.type !== 'nsec') {
    throw new Error('no key shown');
  }
  return decoded.data;
}

/** The "I saved my key" checkbox. */
function savedBox(container: HTMLElement): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find(
    (candidate) => candidate.textContent === SAVED_LABEL,
  );
  const box = label?.querySelector('input[type="checkbox"]');
  if (!(box instanceof HTMLInputElement)) {
    throw new Error('no saved checkbox');
  }
  return box;
}

async function signInWith(intent: PlanIntent | undefined, onSigner = vi.fn()) {
  mounted = await mount(
    <SignIn
      onSigner={onSigner}
      recover={NO_RECOVERY}
      {...(intent === undefined ? {} : { intent })}
    />,
  );
  return { container: mounted.container, onSigner };
}

describe('a visitor who chose a plan, with nothing remembered here (R1)', () => {
  it('opens on the new key: the plan line, step 1 of 3, Continue to payment, no Store ID, no warning', async () => {
    const { container } = await signInWith(STARTER_MONTHLY);
    expect(heading(container)).toBe('Save your key');
    expect(text(container)).toContain(NEW_KEY_LEAD);
    expect(byId(container, 'plan-intent').querySelector('p')?.textContent).toBe(
      'Starter · $29/month',
    );
    const steps = byId(container, 'plan-steps');
    expect(steps.tagName).toBe('OL');
    expect(
      [...steps.querySelectorAll('li')].map((item) => item.getAttribute('aria-current')),
    ).toEqual(['step', null, null]);
    expect(steps.textContent).toBe('1Save your key→2Pay→3Set up your store');
    expect(buttonNamed(container, 'Continue to payment').disabled).toBe(true);
    expect(buttonNamed(container, HAVE_A_STORE)).toBeDefined();
    expect(container.querySelector('#owner-key')).toBeNull();
    // One key block, no Store ID on this screen, and no yellow warning.
    expect(
      [...container.querySelectorAll('.code-frame header span')].map((label) => label.textContent),
    ).toEqual(['Your key']);
    expect(text(container)).not.toContain('npub1');
    expect(container.querySelector('.bg-warn-bg')).toBeNull();
  });

  it('makes one key across StrictMode renders, and signs in with the key shown', async () => {
    const onSigner = vi.fn<(signer: Signer) => void>();
    mounted = await mount(
      <StrictMode>
        <SignIn onSigner={onSigner} recover={NO_RECOVERY} intent={STARTER_MONTHLY} />
      </StrictMode>,
    );
    const { container } = mounted;
    const shown = shownKey(container);
    await click(savedBox(container));
    await click(buttonNamed(container, 'Continue to payment'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(onSigner).toHaveBeenCalledTimes(1);
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(getPublicKey(shown));
  });

  it('goes on only once "I saved my key" is ticked, and forgets nothing it was not told to keep', async () => {
    const { container, onSigner } = await signInWith(STARTER_MONTHLY);
    const next = buttonNamed(container, 'Continue to payment');
    expect(next.disabled).toBe(true);
    await click(next);
    expect(onSigner).not.toHaveBeenCalled();
    const remember = byId(container, 'new-key-remember');
    await click(remember);
    await click(savedBox(container));
    expect(next.disabled).toBe(false);
    await click(next);
    expect(onSigner).toHaveBeenCalledTimes(1);
    expect(storage.everything()).toBe('');
    expect(readRemembered().keys).toEqual([]);
  });

  it('"Already have a store? Sign in" shows the sign-in with the plan line, and drops the key', async () => {
    const { container } = await signInWith(STARTER_MONTHLY);
    const first = nip19.nsecEncode(shownKey(container));
    await click(buttonNamed(container, HAVE_A_STORE));
    expect(container.querySelector('#owner-key')).not.toBeNull();
    expect(byId(container, 'plan-intent').textContent).toContain('Starter · $29/month');
    expect(container.querySelector('#plan-steps')).toBeNull();
    expect(text(container)).not.toContain(first);
    // A key made from here is a new one, with the steps.
    await click(buttonNamed(container, 'Create a secret key'));
    expect(nip19.nsecEncode(shownKey(container))).not.toBe(first);
    expect(container.querySelector('#plan-steps [aria-current="step"]')?.textContent).toBe(
      '1Save your key',
    );
  });

  it('Dismiss keeps the same key and turns the screen into the plain one: Continue and Back', async () => {
    mounted = await mount(
      <App
        createDeps={(signer) => sessionDeps(fakeApi(), fakeReader([]), signer)}
        initialIntent={STARTER_MONTHLY}
      />,
    );
    const { container } = mounted;
    const before = nip19.nsecEncode(shownKey(container));
    await click(buttonNamed(byId(container, 'plan-intent'), 'Dismiss'));
    expect(nip19.nsecEncode(shownKey(container))).toBe(before);
    expect(container.querySelector('#plan-intent')).toBeNull();
    expect(container.querySelector('#plan-steps')).toBeNull();
    expect(buttonNamed(container, 'Continue')).toBeDefined();
    expect(buttonNamed(container, 'Back')).toBeDefined();
    expect(container.querySelector('button')?.textContent).not.toBe('Continue to payment');
    expect(text(container)).not.toContain(HAVE_A_STORE);
  });
});

describe('a visitor who chose a plan, with something that says they have a store (R1)', () => {
  it('a key remembered here: the sign-in to unlock it, not a new key', async () => {
    expect(await rememberKey(OWNER_KEY)).toBe(true);
    const { container } = await signInWith(STARTER_MONTHLY);
    expect(text(container)).toContain('Continue on this device');
    expect(container.querySelector('#owner-key')).not.toBeNull();
    expect(text(container)).not.toContain('Save your key');
    expect(byId(container, 'plan-intent').textContent).toContain('Starter · $29/month');
  });

  it('a remembered key that could not be read: the sign-in, with its notice', async () => {
    storage.setItem('askr-admin.remembered-keys', '{not json');
    const { container } = await signInWith(STARTER_MONTHLY);
    expect(container.querySelector('#owner-key')).not.toBeNull();
    expect(text(container)).toContain('could not be read, so it is not offered');
    expect(text(container)).not.toContain('Save your key');
  });

  it('keys a newer admin remembered: the sign-in, with its notice', async () => {
    storage.setItem('askr-admin.remembered-keys', JSON.stringify({ version: 9, keys: [] }));
    const { container } = await signInWith(STARTER_MONTHLY);
    expect(container.querySelector('#owner-key')).not.toBeNull();
    expect(text(container)).toContain('A newer version of this admin');
    expect(text(container)).not.toContain('Save your key');
  });

  it('a tab signed in before a reload: the sign-in, not a new key', async () => {
    markTabSignedIn(OWNER);
    const { container } = await signInWith(STARTER_MONTHLY);
    expect(container.querySelector('#owner-key')).not.toBeNull();
    expect(text(container)).not.toContain('Save your key');
  });

  it('a key being replaced: the replacement, not a new key', async () => {
    mounted = await mount(
      <SignIn
        onSigner={() => undefined}
        recover={NO_RECOVERY}
        replaceKeyOf={nip19.npubEncode(OWNER)}
        intent={STARTER_MONTHLY}
      />,
    );
    const { container } = mounted;
    expect(container.querySelector('#recover-store')).not.toBeNull();
    expect(text(container)).not.toContain('Save your key');
    // Leaving the replacement goes to the sign-in, with no key made meanwhile.
    await click(buttonNamed(container, 'Back'));
    expect(container.querySelector('#owner-key')).not.toBeNull();
    expect(text(container)).not.toContain('Save your key');
  });

  it('a remembered key and a tab signed in before a reload: signed in again with no press', async () => {
    expect(await rememberKey(OWNER_KEY)).toBe(true);
    markTabSignedIn(OWNER);
    const createDeps = vi.fn((signer: Signer) => sessionDeps(fakeApi(), fakeReader([]), signer));
    mounted = await mount(<App createDeps={createDeps} initialIntent={STARTER_MONTHLY} />);
    await settle(() => createDeps.mock.calls.length > 0);
    expect(createDeps.mock.calls[0]?.[0].pubkey).toBe(OWNER);
  });
});

describe('a visitor with no plan chosen', () => {
  it('sees the sign-in first; a new key has Continue and Back, and no steps', async () => {
    const { container, onSigner } = await signInWith(undefined);
    expect(container.querySelector('#owner-key')).not.toBeNull();
    await click(buttonNamed(container, 'Create a secret key'));
    expect(heading(container)).toBe('Save your key');
    expect(text(container)).toContain(NEW_KEY_LEAD);
    expect(container.querySelector('#plan-steps')).toBeNull();
    expect(container.querySelector('#plan-intent')).toBeNull();
    expect(container.querySelector('.bg-warn-bg')).toBeNull();
    const shown = shownKey(container);
    await click(savedBox(container));
    await click(buttonNamed(container, 'Continue'));
    await settle(() => onSigner.mock.calls.length > 0);
    expect(onSigner.mock.calls[0]?.[0].pubkey).toBe(getPublicKey(shown));
  });

  it('Back goes to the sign-in', async () => {
    const { container } = await signInWith(undefined);
    await click(buttonNamed(container, 'Create a secret key'));
    await click(buttonNamed(container, 'Back'));
    expect(container.querySelector('#owner-key')).not.toBeNull();
  });
});

describe('the steps in Onboarding, back from Stripe (R2)', () => {
  async function returning(flag: BillingReturn | undefined) {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ status: 'pending', tier: null, billing: BILLING_ON })),
    });
    mounted = await mount(
      <Session
        deps={{ ...sessionDeps(api, fakeReader([])), takeBillingReturn: () => flag }}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => text(container).includes('Describe your store'));
    return container;
  }

  it('just paid (success): step 3, setting up the store', async () => {
    const container = await returning('success');
    expect(container.querySelector('#plan-steps [aria-current="step"]')?.textContent).toMatch(
      /^→3Set up your store$/u,
    );
  });

  it('a canceled checkout: no steps', async () => {
    const container = await returning('canceled');
    expect(container.querySelector('#plan-steps')).toBeNull();
  });

  it('no return: no steps', async () => {
    const container = await returning(undefined);
    expect(container.querySelector('#plan-steps')).toBeNull();
  });

  it('a store not yet created, with no plan: no steps', async () => {
    const api = fakeApi({
      store: vi.fn(async () => Promise.reject(new ApiError(404, 'no_store'))),
    });
    mounted = await mount(
      <Session
        deps={sessionDeps(api, fakeReader([]))}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => container.querySelector('#onboarding-email') !== null);
    expect(container.querySelector('#plan-steps')).toBeNull();
  });
});
