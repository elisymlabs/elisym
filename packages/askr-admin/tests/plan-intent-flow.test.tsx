import { buildConfigEvent } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { decode, nsecEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { NewOwnerKey } from '../src/components/NewOwnerKey';
import { Onboarding } from '../src/components/Onboarding';
import { Session } from '../src/components/Session';
import { SignIn } from '../src/components/SignIn';
import { PRICING_URL } from '../src/constants';
import { ApiError } from '../src/lib/api';
import { type BillingReturn, UPDATED_TEXT } from '../src/lib/billing';
import type { AdminClient } from '../src/lib/deps';
import { errorMessage } from '../src/lib/errors';
import { PAID_THROUGH_US_TEXT, type PlanIntent } from '../src/lib/plan-intent';
import { type Signer, npubOf } from '../src/lib/signer';
import type { StoreView } from '../src/lib/types';
import {
  ASSISTANT,
  BILLING_OFF,
  BILLING_ON,
  FREE_TIER,
  NOW,
  OWNER_KEY,
  SERVER_KEY,
  fakeApi,
  fakeReader,
  sessionDeps,
  signedConfig,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle, typeInto } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  // App marks this tab on a sign-in (`tab-session`): no mark is left for the next test.
  sessionStorage.clear();
  vi.restoreAllMocks();
});

const GROWTH_YEARLY: PlanIntent = { plan: 'growth', interval: 'year' };
const LINE = 'You chose Growth: $79 a month, billed yearly ($948).';
/** The compact line before sign-in (R4). */
const COMPACT_LINE = 'Growth · $79/month, billed yearly ($948/year)';
const HAVE_A_STORE = 'Already have a store? Sign in';

const PENDING = storeView({ status: 'pending', tier: null, billing: BILLING_ON });

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

/** The current step of the indicator, or undefined when none is shown. */
function currentStep(container: HTMLElement): string | undefined {
  const steps = container.querySelector('#plan-steps');
  if (steps === null) {
    return undefined;
  }
  // The step's number and label, without the arrow before it.
  return (steps.querySelector('[aria-current="step"]')?.textContent ?? '').replace(/^→/u, '');
}

/**
 * The whole admin opened from the landing's "Choose Growth" (yearly): it opens on a new key, and
 * the owner, who already has their key, signs in with it instead.
 */
async function signedIn(api: AdminClient, relay: NostrEvent[] = [], intent = GROWTH_YEARLY) {
  const created: { deps: ReturnType<typeof sessionDeps> }[] = [];
  const createDeps = vi.fn((signer: Signer) => {
    const deps = sessionDeps(api, fakeReader(relay), signer);
    created.push({ deps });
    return deps;
  });
  mounted = await mount(<App createDeps={createDeps} initialIntent={intent} />);
  const { container } = mounted;
  expect(container.querySelector('h1')?.textContent).toBe('Save your key');
  expect(byId(container, 'plan-intent').textContent).toContain(COMPACT_LINE);
  await click(buttonNamed(container, HAVE_A_STORE));
  expect(byId(container, 'plan-intent').textContent).toContain(COMPACT_LINE);
  const field = byId(container, 'owner-key');
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('no key field');
  }
  field.value = nsecEncode(OWNER_KEY);
  await click(buttonNamed(container, 'Sign in'));
  await settle(() => createDeps.mock.calls.length > 0);
  const deps = created[0]?.deps;
  if (deps === undefined) {
    throw new Error('no deps');
  }
  return { container, openUrl: vi.mocked(deps.openUrl) };
}

/** An API with no store yet for this key: Onboarding's step 1. */
function newVisitorApi(overrides: Partial<AdminClient> = {}): AdminClient {
  return fakeApi({
    store: vi.fn(async () => Promise.reject(new ApiError(404, 'no_store'))),
    createStore: vi.fn(async () => PENDING),
    ...overrides,
  });
}

async function createStore(container: HTMLElement) {
  await settle(() => container.querySelector('#onboarding-email') !== null);
  await typeInto(byId(container, 'onboarding-email'), 'owner@tea.example');
  await click(buttonNamed(container, 'Create my store and pay'));
}

describe('the plan chosen on the landing, before the key (D3)', () => {
  it('says the plan in one compact line on the key screen, with the plans and a way to drop it', async () => {
    const onDismiss = vi.fn();
    mounted = await mount(
      <SignIn
        onSigner={() => undefined}
        recover={async () => undefined}
        intent={GROWTH_YEARLY}
        onDismissIntent={onDismiss}
      />,
    );
    expect(mounted.container.querySelector('h1')?.textContent).toBe('Save your key');
    const line = byId(mounted.container, 'plan-intent');
    expect(line.querySelector('p')?.textContent).toBe(COMPACT_LINE);
    expect(line.textContent).not.toMatch(/Stripe/u);
    const another = [...line.querySelectorAll('a')].find(
      (link) => link.textContent === 'Change plan',
    );
    expect(another?.getAttribute('href')).toBe(PRICING_URL);
    await click(buttonNamed(line, 'Dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('says it on the sign-in screen too', async () => {
    mounted = await mount(
      <SignIn onSigner={() => undefined} recover={async () => undefined} intent={GROWTH_YEARLY} />,
    );
    await click(buttonNamed(mounted.container, HAVE_A_STORE));
    expect(mounted.container.querySelector('#owner-key')).not.toBeNull();
    expect(byId(mounted.container, 'plan-intent').textContent).toContain(COMPACT_LINE);
  });

  it('says nothing without a plan', async () => {
    mounted = await mount(<SignIn onSigner={() => undefined} recover={async () => undefined} />);
    expect(mounted.container.querySelector('#plan-intent')).toBeNull();
    await click(buttonNamed(mounted.container, 'Create a secret key'));
    expect(mounted.container.querySelector('h1')?.textContent).toBe('Save your key');
    expect(mounted.container.querySelector('#plan-intent')).toBeNull();
    await mounted.unmount();
    mounted = await mount(
      <NewOwnerKey
        nsec="nsec1x"
        npub="npub1x"
        heading="Save your key"
        lead="Keep it."
        continueLabel="Continue"
        cancelLabel="Back"
        onContinue={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(mounted.container.querySelector('#plan-intent')).toBeNull();
    expect(mounted.container.querySelector('#plan-steps')).toBeNull();
  });

  it('a monthly choice says the monthly price', async () => {
    mounted = await mount(
      <SignIn
        onSigner={() => undefined}
        recover={async () => undefined}
        intent={{ plan: 'pro', interval: 'month' }}
      />,
    );
    expect(byId(mounted.container, 'plan-intent').querySelector('p')?.textContent).toBe(
      'Pro · $199/month',
    );
  });
});

describe('a new visitor with a chosen plan (D4, step 1)', () => {
  it('creates the store, then opens its checkout: createStore, checkout, openUrl in order', async () => {
    const order: string[] = [];
    const api = newVisitorApi({
      createStore: vi.fn(async () => {
        order.push('createStore');
        return PENDING;
      }),
      checkout: vi.fn(async () => {
        order.push('checkout');
        return { url: 'https://checkout.stripe.test/c/1' };
      }),
    });
    const { container, openUrl } = await signedIn(api);
    openUrl.mockImplementation(() => {
      order.push('openUrl');
    });
    expect(byId(container, 'plan-intent').textContent).toContain(
      `${LINE} Create your store to go on to checkout.`,
    );
    // Not paid yet: paying is the step, and Billing is not where it happens.
    expect(currentStep(container)).toBe('2Pay');
    expect(text(container)).not.toContain('choose a plan in Billing');
    await createStore(container);
    await settle(() => order.length === 3);
    expect(order).toEqual(['createStore', 'checkout', 'openUrl']);
    expect(api.checkout).toHaveBeenCalledWith('growth', 'year');
    expect(openUrl).toHaveBeenCalledWith('https://checkout.stripe.test/c/1');
    // Its checkout opened: the chosen plan is done with.
    await settle(() => container.querySelector('#plan-intent') === null);
  });

  it('stays on step 1 while the checkout is asked for: step 2 comes only after it', async () => {
    let answer: (value: { url: string }) => void = () => undefined;
    const api = newVisitorApi({
      checkout: vi.fn(
        () =>
          new Promise<{ url: string }>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const { container, openUrl } = await signedIn(api);
    await createStore(container);
    await settle(() => vi.mocked(api.checkout).mock.calls.length === 1);
    expect(container.querySelector('#onboarding-email')).not.toBeNull();
    expect(text(container)).not.toContain('Describe your store');
    expect(buttonNamed(container, 'Creating...').disabled).toBe(true);
    await act(async () => {
      answer({ url: 'https://checkout.stripe.test/c/1' });
    });
    await settle(() => openUrl.mock.calls.length === 1);
  });

  it('keeps the chosen plan when the store cannot be created', async () => {
    const api = newVisitorApi({
      createStore: vi.fn(async () => Promise.reject(new ApiError(429, 'rate_limited'))),
    });
    const { container } = await signedIn(api);
    await createStore(container);
    await settle(() => text(container).includes(errorMessage(new ApiError(429, 'rate_limited'))));
    expect(api.checkout).not.toHaveBeenCalled();
    expect(container.querySelector('#plan-intent')).not.toBeNull();
    expect(buttonNamed(container, 'Create my store and pay').disabled).toBe(false);
  });

  it('a refused checkout is said in step 2, next to Continue to checkout, which tries again', async () => {
    const checkout = vi
      .fn<AdminClient['checkout']>()
      .mockRejectedValueOnce(new ApiError(502, 'billing_failed'))
      .mockResolvedValue({ url: 'https://checkout.stripe.test/c/2' });
    const api = newVisitorApi({ checkout });
    const { container, openUrl } = await signedIn(api);
    await createStore(container);
    await settle(() => text(container).includes('Describe your store'));
    expect(text(container)).toContain('Stripe did not answer. Retry in a moment.');
    // The plan is still to pay for: still step 2, in the settings section too.
    expect(currentStep(container)).toBe('2Pay');
    const again = byId(container, 'intent-checkout');
    expect(again.textContent).toBe('Continue to checkout');
    expect(openUrl).not.toHaveBeenCalled();
    await click(again);
    await settle(() => openUrl.mock.calls.length > 0);
    expect(checkout).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenCalledWith('https://checkout.stripe.test/c/2');
  });

  it('billing off: says paid plans are set up with us, and drops the chosen plan', async () => {
    const api = newVisitorApi({
      createStore: vi.fn(async () => storeView({ status: 'pending', tier: null })),
      checkout: vi.fn(async () => Promise.reject(new ApiError(503, 'billing_unavailable'))),
    });
    const { container, openUrl } = await signedIn(api);
    await createStore(container);
    await settle(() => text(container).includes(PAID_THROUGH_US_TEXT));
    expect(PAID_THROUGH_US_TEXT).toBe(
      'Paid plans are set up with us: message us with your Store ID.',
    );
    expect(text(container)).toContain('Describe your store');
    expect(container.querySelector('#plan-intent')).toBeNull();
    expect(container.querySelector('#intent-checkout')).toBeNull();
    // Nothing to pay here: the steps go with the plan.
    expect(currentStep(container)).toBeUndefined();
    expect(container.querySelector('.contact-link')).not.toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['billing_unavailable', 503, true],
    ['billing_failed', 502, false],
    ['rate_limited', 429, false],
  ] as const)('a %s checkout refusal drops the chosen plan: %s', async (code, status, dropped) => {
    const api = newVisitorApi({
      checkout: vi.fn(async () => Promise.reject(new ApiError(status, code))),
    });
    const onIntentDone = vi.fn();
    const onCreated = vi.fn();
    mounted = await mount(
      <Onboarding
        deps={sessionDeps(api, fakeReader([]))}
        view={undefined}
        onCreated={onCreated}
        onDone={async () => undefined}
        onSignOut={() => undefined}
        intent={GROWTH_YEARLY}
        onIntentDone={onIntentDone}
      />,
    );
    await typeInto(byId(mounted.container, 'onboarding-email'), 'owner@tea.example');
    await click(buttonNamed(mounted.container, 'Create my store and pay'));
    await settle(() => onCreated.mock.calls.length === 1);
    expect(onIntentDone).toHaveBeenCalledTimes(dropped ? 1 : 0);
  });

  it('without a chosen plan, Create my store opens no checkout', async () => {
    const api = newVisitorApi();
    mounted = await mount(
      <Onboarding
        deps={sessionDeps(api, fakeReader([]))}
        view={undefined}
        onCreated={() => undefined}
        onDone={async () => undefined}
        onSignOut={() => undefined}
      />,
    );
    await typeInto(byId(mounted.container, 'onboarding-email'), 'owner@tea.example');
    await click(buttonNamed(mounted.container, 'Create my store'));
    await settle(() => vi.mocked(api.createStore).mock.calls.length > 0);
    expect(api.checkout).not.toHaveBeenCalled();
  });
});

describe('an existing store with no settings and a chosen plan (D4, step 2)', () => {
  it('offers Continue to checkout, busy until the page leaves', async () => {
    const api = fakeApi({ store: vi.fn(async () => PENDING) });
    const { container, openUrl } = await signedIn(api);
    await settle(() => text(container).includes('Describe your store'));
    expect(byId(container, 'plan-intent').textContent).toContain(
      `${LINE} Pay for it now, or describe your store first.`,
    );
    const button = byId(container, 'intent-checkout');
    expect(api.checkout).not.toHaveBeenCalled();
    await click(button);
    await settle(() => openUrl.mock.calls.length > 0);
    expect(api.checkout).toHaveBeenCalledWith('growth', 'year');
  });

  it('keeps Continue to checkout busy until a pageshow, then it works again', async () => {
    const view = PENDING;
    const onIntentDone = vi.fn();
    const api = fakeApi();
    const deps = sessionDeps(api, fakeReader([]));
    mounted = await mount(
      <Onboarding
        deps={deps}
        view={view}
        onCreated={() => undefined}
        onDone={async () => undefined}
        onSignOut={() => undefined}
        intent={GROWTH_YEARLY}
        onIntentDone={onIntentDone}
      />,
    );
    const button = byId(mounted.container, 'intent-checkout');
    await click(button);
    await settle(() => vi.mocked(deps.openUrl).mock.calls.length > 0);
    expect(button).toHaveProperty('disabled', true);
    expect(onIntentDone).toHaveBeenCalledTimes(1);
    await act(async () => {
      globalThis.dispatchEvent(new Event('pageshow'));
    });
    expect(button).toHaveProperty('disabled', false);
  });

  it('a refused Continue to checkout is said, the button works again, and a second click asks again', async () => {
    const checkout = vi
      .fn<AdminClient['checkout']>()
      .mockRejectedValueOnce(new ApiError(502, 'billing_failed'))
      .mockResolvedValue({ url: 'https://checkout.stripe.test/c/2' });
    const deps = sessionDeps(fakeApi({ checkout }), fakeReader([]));
    mounted = await mount(
      <Onboarding
        deps={deps}
        view={PENDING}
        onCreated={() => undefined}
        onDone={async () => undefined}
        onSignOut={() => undefined}
        intent={GROWTH_YEARLY}
        onIntentDone={() => undefined}
      />,
    );
    const { container } = mounted;
    const button = byId(container, 'intent-checkout');
    await click(button);
    await settle(() => text(container).includes('Stripe did not answer. Retry in a moment.'));
    expect(button).toHaveProperty('disabled', false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(deps.openUrl).not.toHaveBeenCalled();
    await click(button);
    await settle(() => vi.mocked(deps.openUrl).mock.calls.length > 0);
    expect(checkout).toHaveBeenCalledTimes(2);
    expect(deps.openUrl).toHaveBeenCalledWith('https://checkout.stripe.test/c/2');
  });

  it('offers nothing to buy when the store cannot check out', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ status: 'pending', tier: null, billing: BILLING_OFF })),
    });
    const { container } = await signedIn(api);
    await settle(() => text(container).includes('Describe your store'));
    expect(container.querySelector('#intent-checkout')).toBeNull();
  });

  it('Dismiss drops it', async () => {
    const api = fakeApi({ store: vi.fn(async () => PENDING) });
    const { container } = await signedIn(api);
    await settle(() => text(container).includes('Describe your store'));
    expect(currentStep(container)).toBe('2Pay');
    await click(buttonNamed(byId(container, 'plan-intent'), 'Dismiss'));
    expect(container.querySelector('#plan-intent')).toBeNull();
    expect(container.querySelector('#intent-checkout')).toBeNull();
    expect(currentStep(container)).toBeUndefined();
    expect(text(container)).toContain('choose a plan in Billing');
  });
});

describe('a returning owner with a chosen plan (D4, Shell)', () => {
  const relay = () => [signedConfig(OWNER_KEY, 'Tea Shop', NOW - 10)];

  it('opens Billing on the chosen card, its button focused, nothing called before the click', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ tier: { ...FREE_TIER }, billing: BILLING_ON })),
    });
    const { container, openUrl } = await signedIn(api, relay());
    await settle(() => container.querySelector('#plans') !== null);
    expect(container.querySelector('h1')?.textContent).toBe('Billing');
    expect(byId(container, 'plan-growth').getAttribute('data-chosen')).toBe('true');
    const button = byId(container, 'upgrade-growth');
    expect(button.textContent).toBe('Continue to checkout');
    expect(document.activeElement).toBe(button);
    expect(api.checkout).not.toHaveBeenCalled();
    await click(button);
    await settle(() => openUrl.mock.calls.length > 0);
    expect(api.checkout).toHaveBeenCalledWith('growth', 'year');
    // Acted on: the card no longer stands out.
    await settle(() => container.querySelector('[data-chosen]') === null);
  });

  it('Dismiss in Billing drops the plan: the card no longer stands out, and Billing opened again takes no focus', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ tier: { ...FREE_TIER }, billing: BILLING_ON })),
    });
    const { container } = await signedIn(api, relay());
    await settle(() => container.querySelector('#plans') !== null);
    expect(document.activeElement).toBe(byId(container, 'upgrade-growth'));
    await click(buttonNamed(byId(container, 'plan-intent'), 'Dismiss'));
    expect(container.querySelector('#plan-intent')).toBeNull();
    expect(container.querySelector('[data-chosen]')).toBeNull();
    expect(byId(container, 'upgrade-growth').textContent).toBe('Upgrade');
    await click(buttonNamed(container, 'Overview'));
    expect(container.querySelector('h1')?.textContent).toBe('Overview');
    await click(buttonNamed(container, 'Billing'));
    await settle(() => container.querySelector('#plans') !== null);
    expect(document.activeElement).not.toBe(byId(container, 'upgrade-growth'));
    expect(api.checkout).not.toHaveBeenCalled();
  });

  it('paying for the same plan: Billing says so, and calls nothing', async () => {
    const api = fakeApi({
      store: vi.fn(async () =>
        storeView({
          billing: {
            ...BILLING_ON,
            checkoutAvailable: false,
            manageable: true,
            plan: 'growth',
            interval: 'year',
            status: 'active',
          },
        }),
      ),
    });
    const { container } = await signedIn(api, relay());
    await settle(() => container.querySelector('#plans') !== null);
    expect(text(container)).toContain('You are already on Growth, billed yearly.');
    expect(api.checkout).not.toHaveBeenCalled();
    expect(api.billingPortal).not.toHaveBeenCalled();
  });

  it('opens Overview when the plan was dismissed before signing in', async () => {
    const api = fakeApi({ store: vi.fn(async () => storeView({ billing: BILLING_ON })) });
    mounted = await mount(
      <App
        createDeps={(signer) => sessionDeps(api, fakeReader(relay()), signer)}
        initialIntent={GROWTH_YEARLY}
      />,
    );
    const { container } = mounted;
    await click(buttonNamed(byId(container, 'plan-intent'), 'Dismiss'));
    expect(container.querySelector('#plan-intent')).toBeNull();
    // Without the plan, the key screen goes Back to the sign-in.
    await click(buttonNamed(container, 'Back'));
    const field = byId(container, 'owner-key');
    if (field instanceof HTMLInputElement) {
      field.value = nsecEncode(OWNER_KEY);
    }
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => container.querySelector('h1')?.textContent === 'Overview');
    expect(container.querySelector('[data-chosen]')).toBeNull();
  });

  it('drops it on Sign out, so it never carries to another key', async () => {
    const api = fakeApi({ store: vi.fn(async () => storeView({ billing: BILLING_ON })) });
    const { container } = await signedIn(api, relay());
    await settle(() => container.querySelector('#plans') !== null);
    await click(buttonNamed(container, 'Sign out'));
    await settle(() => container.querySelector('#owner-key') !== null);
    expect(container.querySelector('#plan-intent')).toBeNull();
  });

  it('drops it when the key is replaced', async () => {
    const api = fakeApi({ store: vi.fn(async () => storeView({ billing: BILLING_ON })) });
    const { container } = await signedIn(api, relay());
    await settle(() => container.querySelector('#plans') !== null);
    await click(buttonNamed(container, 'Advanced'));
    await click(buttonNamed(container, 'Replace my secret key'));
    await click(buttonNamed(container, 'Continue'));
    await settle(() => container.querySelector('#recover-store') !== null);
    await click(buttonNamed(container, 'Back'));
    await settle(() => container.querySelector('#owner-key') !== null);
    expect(container.querySelector('#plan-intent')).toBeNull();
  });
});

describe('a store moved to a new key, with a chosen plan (D4, FinishMove)', () => {
  it('keeps the plan through the move, and Billing opens on it once the settings are signed', async () => {
    const oldKey = generateSecretKey();
    const old = getPublicKey(oldKey);
    const moved = finalizeEvent(
      buildConfigEvent(
        {
          assistant: ASSISTANT,
          origins: ['https://tea.example'],
          name: 'Moved Tea',
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: SERVER_KEY,
          createdAt: NOW - 500,
        },
        oldKey,
      ),
      oldKey,
    );
    let signed: NostrEvent[] = [];
    let view: StoreView = storeView({
      movedFrom: old,
      tier: { ...FREE_TIER },
      billing: BILLING_ON,
    });
    const api = fakeApi({
      store: vi.fn(async () => view),
      movedSettings: vi.fn(async () => ({
        from: old,
        signedBy: old,
        config: moved,
        private: null,
      })),
      storeEvents: vi.fn(async (events: NostrEvent[]) => {
        signed = events;
        view = { ...view, movedFrom: null, events: { pending: events.length, failing: [] } };
        return { stored: events.map((event) => event.id) };
      }),
      storedEvents: vi.fn(async () => ({ events: signed, truncated: false })),
    });
    const { container } = await signedIn(api);
    await settle(() => text(container).includes('Check and sign your settings'));
    expect(container.querySelector('#plan-intent')).toBeNull();
    await click(buttonNamed(container, 'Sign with my new key'));
    await settle(() => container.querySelector('#plans') !== null);
    expect(container.querySelector('h1')?.textContent).toBe('Billing');
    expect(byId(container, 'upgrade-growth').textContent).toBe('Continue to checkout');
  });
});

describe('the session without App', () => {
  it('works with no chosen plan and no callback', async () => {
    const api = fakeApi({ store: vi.fn(async () => PENDING) });
    mounted = await mount(
      <Session
        deps={sessionDeps(api, fakeReader([]))}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    await settle(() => text(mounted?.container ?? document.body).includes('Describe your store'));
    expect(mounted.container.querySelector('#intent-checkout')).toBeNull();
    expect(currentStep(mounted.container)).toBeUndefined();
    expect(text(mounted.container)).toContain('choose a plan in Billing');
  });
});

describe('a new visitor from the landing, from the key to checkout (K3)', () => {
  it('saves the key, goes on to payment (step 2), creates the store and opens its checkout', async () => {
    const api = newVisitorApi({
      checkout: vi.fn(async () => ({ url: 'https://checkout.stripe.test/c/1' })),
    });
    const created: ReturnType<typeof sessionDeps>[] = [];
    mounted = await mount(
      <App
        createDeps={(signer) => {
          const deps = sessionDeps(api, fakeReader([]), signer);
          created.push(deps);
          return deps;
        }}
        initialIntent={GROWTH_YEARLY}
      />,
    );
    const { container } = mounted;
    expect(currentStep(container)).toBe('1Save your key');
    const nsec = /nsec1[02-9ac-hj-np-z]+/u.exec(text(container))?.[0] ?? '';
    const saved = [...container.querySelectorAll('input[type="checkbox"]')].find(
      (box) => box.id === '',
    );
    if (!(saved instanceof HTMLInputElement)) {
      throw new Error('no saved checkbox');
    }
    await click(saved);
    await click(buttonNamed(container, 'Continue to payment'));
    await settle(() => container.querySelector('#onboarding-email') !== null);
    expect(currentStep(container)).toBe('2Pay');
    // Signed in as the key shown, whose Store ID Onboarding shows.
    const shown = decode(nsec);
    if (shown.type !== 'nsec') {
      throw new Error('no key shown');
    }
    expect(created[0]?.signer.pubkey).toBe(getPublicKey(shown.data));
    expect(text(container)).toContain(npubOf(getPublicKey(shown.data)));
    await typeInto(byId(container, 'onboarding-email'), 'owner@tea.example');
    await click(buttonNamed(container, 'Create my store and pay'));
    await settle(() => vi.mocked(created[0]?.openUrl ?? vi.fn()).mock.calls.length > 0);
    expect(api.checkout).toHaveBeenCalledWith('growth', 'year');
  });
});

describe('back from Stripe (D8)', () => {
  const relay = () => [signedConfig(OWNER_KEY, 'Tea Shop', NOW - 10)];

  async function returning(flag: BillingReturn) {
    const api = fakeApi({ store: vi.fn(async () => storeView({ billing: BILLING_ON })) });
    mounted = await mount(
      <Session
        deps={{ ...sessionDeps(api, fakeReader(relay())), takeBillingReturn: () => flag }}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => container.querySelector('h1') !== null);
    return container;
  }

  it('from a portal change (updated): opens on Billing, where the change shows', async () => {
    const container = await returning('updated');
    expect(container.querySelector('h1')?.textContent).toBe('Billing');
    expect(container.querySelector('#plans')).not.toBeNull();
    expect(text(container)).toContain(UPDATED_TEXT);
  });

  it('from a checkout (canceled): opens on Overview', async () => {
    const container = await returning('canceled');
    expect(container.querySelector('h1')?.textContent).toBe('Overview');
  });
});
