import type { NostrEvent } from 'nostr-tools/pure';
import { act } from 'react';
import { type Root as ReactRoot, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudProps } from '../../src/cloud/CloudApp';
import { OwnerKey } from '../../src/cloud/lib/owner-key';
import { Root } from '../../src/Root';
import {
  type Answer,
  FakeStore,
  TENANT_ID,
  fakeCloud,
  readyState,
  storeState,
  tiersAnswer,
} from './fake-api';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const API = 'https://api.cloud.test';
const BASE_USDC = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
let mounted: { root: ReactRoot; host: HTMLElement } | undefined;

async function unmount() {
  await act(async () => mounted?.root.unmount());
  mounted?.host.remove();
  mounted = undefined;
}

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
});

interface Options {
  cloud?: boolean;
  ownTab?: boolean;
  cloudProps?: Partial<CloudProps>;
  downloads?: string[];
  leave?: () => void;
  relays?: NostrEvent[];
}

/** The admin, its cloud part answered by `routes`. */
async function admin(routes: Record<string, Answer>, options: Options = {}) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const cloudApi = fakeCloud({ 'GET /tiers': { body: tiersAnswer() }, ...routes });
  const relays = options.relays ?? [];
  const cloud: CloudProps = {
    apiOrigin: API,
    download: (_data, fileName) => options.downloads?.push(fileName),
    relayQuery: async (filter) =>
      relays.filter((event) => filter.kinds?.includes(event.kind) === true),
    startTier: undefined,
    termsUrl: 'https://paycore.elisym.network/terms',
    billingUrl: undefined,
    navigate: () => undefined,
    wallets: { solana: undefined, evm: undefined },
    fetcher: cloudApi.fetcher,
    ...options.cloudProps,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () =>
    root.render(
      <Root
        ownTab={options.ownTab ?? true}
        createDeps={() => {
          throw new Error('no relay reads in these tests');
        }}
        leave={options.leave ?? (() => undefined)}
        cloud={options.cloud === false ? undefined : cloud}
      />,
    ),
  );
  return { host, calls: cloudApi.calls };
}

async function eventually(host: HTMLElement, ready: () => boolean) {
  for (let attempt = 0; attempt < 80 && !ready(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  expect(ready(), host.textContent ?? '').toBe(true);
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text,
  );
  if (found === undefined) {
    throw new Error(`no button "${text}" in: ${host.textContent ?? ''}`);
  }
  return found;
}

function hasButton(host: HTMLElement, text: string): boolean {
  return [...host.querySelectorAll('button')].some((candidate) => candidate.textContent === text);
}

async function click(host: HTMLElement, text: string) {
  await act(async () => button(host, text).click());
}

/** Sets a controlled field as a person would. */
async function fill(host: HTMLElement, selector: string, value: string) {
  const field = host.querySelector(selector);
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLSelectElement)) {
    throw new Error(`no ${selector}`);
  }
  const prototype =
    field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

function ownerKeyField(host: HTMLElement): HTMLInputElement {
  const field = host.querySelector('input#owner-key');
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('no owner key field');
  }
  return field;
}

/** Signs in to the cloud part with `key` from the front door. */
async function signIn(host: HTMLElement, key: OwnerKey) {
  await click(host, 'A store in our cloud');
  ownerKeyField(host).value = key.nsec();
  await click(host, 'Open my store');
}

function steps(host: HTMLElement) {
  return [...host.querySelectorAll('ol[aria-label="Store setup"] li')].map((item) => ({
    key: item.getAttribute('data-step'),
    current: item.getAttribute('aria-current') === 'step',
    badge: item.querySelector('span')?.className ?? '',
  }));
}

async function openStep(host: HTMLElement, label: string) {
  const find = () =>
    [...host.querySelectorAll('ol[aria-label="Store setup"] button')].find(
      (candidate) => candidate.textContent?.startsWith(label) === true,
    );
  await eventually(host, () => find() !== undefined);
  const step = find();
  if (step instanceof HTMLButtonElement) {
    await act(async () => step.click());
  }
}

/** The open step's body (the others stay mounted, hidden). */
function openBody(host: HTMLElement): string {
  return (
    [...host.querySelectorAll<HTMLElement>('ol[aria-label="Store setup"] ~ div > div')].find(
      (each) => !each.hidden,
    )?.textContent ?? ''
  );
}

function checkbox(host: HTMLElement): HTMLInputElement {
  const box = host.querySelector('input[type="checkbox"]');
  if (!(box instanceof HTMLInputElement)) {
    throw new Error('no checkbox');
  }
  return box;
}

describe('the front door', () => {
  it('offers a cloud store and a sign-in to either kind of store, under one heading', async () => {
    const { host } = await admin({});
    expect(host.querySelector('h1')?.textContent).toBe('Pay Core admin');
    expect([...host.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual([
      'Create a store in our cloud',
      'Sign in',
    ]);
    expect(button(host, 'A store in our cloud').getAttribute('aria-label')).toBe(
      'Sign in to a store in our cloud',
    );
    expect(button(host, 'A store you run yourself').getAttribute('aria-label')).toBe(
      'Sign in to a store you run yourself',
    );
  });

  it('built with no cloud, it is the self-hosted sign-in alone', async () => {
    const { host } = await admin({}, { cloud: false });
    expect(host.textContent).not.toContain('Create a store in our cloud');
    expect(host.querySelector('input#store-key')).not.toBeNull();
  });

  it('a store you run yourself opens the store-key sign-in', async () => {
    const { host } = await admin({});
    await click(host, 'A store you run yourself');
    expect(host.querySelector('input#store-key')).not.toBeNull();
  });

  it('Create a store opens the owner key step, and Back returns to the front door', async () => {
    const { host } = await admin({});
    await click(host, 'Create a store');
    expect(hasButton(host, 'Create a new owner key')).toBe(true);
    await click(host, 'Back');
    expect(host.textContent).toContain('Create a store in our cloud');
  });

  it('asks for no key in a tab another page opened or framed, cloud or not', async () => {
    const { host } = await admin({}, { ownTab: false });
    expect(host.textContent).toContain('Open this page in its own tab');
    expect(host.querySelector('input')).toBeNull();
    expect(hasButton(host, 'Create a store')).toBe(false);
  });

  it('a card payment returning opens the cloud part, and says so once signed in', async () => {
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes(), {
      cloudProps: { checkoutReturn: { tenantId: TENANT_ID, outcome: 'done' } },
    });
    expect(hasButton(host, 'Create a new owner key')).toBe(true);
    ownerKeyField(host).value = OwnerKey.create().nsec();
    await click(host, 'Open my store');
    await eventually(host, () => host.textContent?.includes('Card payment received') === true);
  });
});

describe('making a cloud store', () => {
  it('a /start link makes the key, has it saved, then signs up for the plan it chose', async () => {
    const downloads: string[] = [];
    const { host, calls } = await admin(
      {
        'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
        'POST /signup': { body: { tenantId: TENANT_ID } },
      },
      { cloudProps: { startTier: 'business' }, downloads },
    );
    await click(host, 'Create a new owner key');
    await click(host, 'Download the key file');
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^paycore-owner-npub1/);
    await act(async () => checkbox(host).click());
    await click(host, 'Continue');
    await eventually(host, () => hasButton(host, 'Create the store'));
    await act(async () => checkbox(host).click());
    await click(host, 'Create the store');
    await eventually(host, () => calls.some((call) => call.path === '/signup'));
    const signup = calls.find((call) => call.path === '/signup');
    expect(signup?.body).toEqual({ tier: 'business', terms: 't1' });
    // Signed by the key just made, as every request.
    expect(signup?.signer).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a key with no store yet is offered an invite to redeem', async () => {
    const { host } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Redeem an invite') === true);
  });
});

describe('the owner key in the page', () => {
  it('Sign out closes the key and leaves the page; the bar names the key', async () => {
    const close = vi.spyOn(OwnerKey.prototype, 'close');
    const leave = vi.fn();
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes(), { leave });
    const key = OwnerKey.create();
    const npub = key.npub;
    await signIn(host, key);
    await eventually(host, () => hasButton(host, 'Sign out'));
    const shown = host.querySelector(`header [title="${npub}"]`);
    expect(shown?.textContent).toBe(`${npub.slice(0, 12)}...${npub.slice(-6)}`);
    expect(shown?.className).toContain('sr-only');
    close.mockClear();
    await click(host, 'Sign out');
    expect(close).toHaveBeenCalled();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('leaving the page closes the key', async () => {
    const close = vi.spyOn(OwnerKey.prototype, 'close');
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, 'Sign out'));
    close.mockClear();
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(close).toHaveBeenCalled();
  });
});

describe('a cloud store, set up step by step', () => {
  it('starts at paying while the store is not paid', async () => {
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).some((step) => step.current));
    const current = steps(host).find((step) => step.current);
    expect(current?.key).toBe('pay');
    expect(current?.badge).toContain('bg-accent text-accent-text');
    expect(steps(host).find((step) => step.key === 'plan')?.badge).toContain('bg-accent-soft');
    expect(steps(host).find((step) => step.key === 'name')?.badge).toContain('bg-surface-2');
    expect(host.textContent).toContain('Billing');
  });

  it('names a store never saved with its name alone, then goes on to the payouts', async () => {
    const store = new FakeStore(storeState({ paid: true }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('input#setup-store-name') !== null);
    expect(steps(host).find((step) => step.current)?.key).toBe('name');
    // Before a name, the payouts step asks for one.
    await openStep(host, 'Get paid to');
    expect(openBody(host)).toContain('Name your store first');
    await click(host, 'Name your store');
    await fill(host, 'input#setup-store-name', 'My shop');
    await click(host, 'Save and continue');
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'My shop',
      solana: null,
      tempo: null,
      evm: { ethereum: null, arbitrum: null, base: null },
    });
    await eventually(host, () => openBody(host).includes('Where buyers'));
  });

  it('the payouts step waits for the store to be read', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop', rails: ['solana'] }));
    const { host } = await admin({
      ...store.routes(),
      [`GET /tenants/${TENANT_ID}/store`]: { status: 503, body: { error: 'internal' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).find((step) => step.current)?.key === 'payouts');
    expect(openBody(host)).toContain('Preparing your store');
  });

  it('a payout on a rail the store keeps off turns it on first, then the list is signed', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop', rails: ['solana'] }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, 'Sign and save payouts'));
    await fill(host, 'select#payout-asset', BASE_USDC);
    await fill(host, 'input#payout-address', `0x${'ab'.repeat(20)}`);
    await click(host, 'Add without the wallet');
    await click(host, 'Sign and save payouts');
    await eventually(host, () => calls.some((call) => call.path.endsWith('/owner-events')));
    const storeAt = calls.findIndex(
      (call) => call.method === 'POST' && call.path.endsWith('/store'),
    );
    expect(calls[storeAt]?.body).toMatchObject({ name: 'Shop', solana: {}, evm: { base: {} } });
    expect(storeAt).toBeLessThan(calls.findIndex((call) => call.path.endsWith('/owner-events')));
    // Kept: the flow goes on to the products.
    await eventually(host, () => openBody(host).includes('Add a product'));
  });

  it('says how many entries of the last list it could not keep', async () => {
    const key = OwnerKey.create();
    const bad = (count: number) =>
      key.sign({
        kind: 10133,
        created_at: Math.floor(Date.now() / 1000) - 10,
        tags: Array.from({ length: count }, (_value, index) => [
          'accept',
          `solana:nowhere/token:bad${index}`,
          'x',
        ]),
        content: '',
      });
    for (const [count, said] of [
      [1, '1 entry of your last list could not be kept'],
      [2, '2 entries of your last list could not be kept'],
    ] as const) {
      const store = new FakeStore(storeState({ paid: true, name: 'Shop', rails: ['solana'] }));
      const { host } = await admin(store.routes(), { relays: [bad(count)] });
      await signIn(host, key);
      await eventually(host, () => host.textContent?.includes(said) === true);
      await unmount();
    }
  });

  it('adds a product as a form and saves the whole set once', async () => {
    const store = new FakeStore(
      storeState({ paid: true, name: 'Shop', rails: ['solana'], payoutListId: 'f'.repeat(64) }),
    );
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => openBody(host).includes('Add a product'));
    await click(host, 'Add a product');
    const id = host.querySelector('input[id$="-title"]')?.id ?? '';
    const product = id.replace(/-title$/, '');
    await fill(host, `input#${product}-title`, 'Deposit 10 USD');
    await fill(host, `input#${product}-price`, '10');
    // Not yet saved: removable, never called published.
    expect(hasButton(host, 'Remove deposit-10-usd')).toBe(true);
    expect(host.textContent).not.toContain('Published: take it off sale');
    await click(host, 'Save 1 change');
    const saved = calls.find((call) => call.path.endsWith('/products'));
    const products =
      saved?.body !== null && typeof saved?.body === 'object' && 'products' in saved.body
        ? saved.body.products
        : undefined;
    expect(Object.keys(products ?? {})).toEqual(['deposit-10-usd']);
    await eventually(host, () => host.textContent?.includes('Saved.') === true);
  });

  it('install gives the script once and a button for each kept product', async () => {
    const store = new FakeStore(readyState());
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await openStep(host, 'Install');
    await eventually(host, () => openBody(host).includes('The script, once per page'));
    const codes = [...host.querySelectorAll('code')].map((code) => code.textContent ?? '');
    expect(codes.filter((code) => code.startsWith('<script'))).toHaveLength(1);
    expect(codes.filter((code) => code.startsWith('<elisym-buy product="naddr1'))).toHaveLength(1);
  });

  it('launch opens only when every check holds, and is the merchant’s click', async () => {
    const store = new FakeStore(readyState());
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).find((step) => step.current)?.key === 'launch');
    await eventually(host, () => hasButton(host, 'Launch the store'));
    expect(button(host, 'Launch the store').disabled).toBe(false);
    await click(host, 'Launch the store');
    expect(calls.filter((call) => call.path.endsWith('/launch'))).toHaveLength(1);
    // Launched: the dashboard, with its state.
    await eventually(host, () => host.querySelector('[data-run-state]') !== null);
  });

  it("a domain: its check's own reason keeps Launch closed; refusals are worded", async () => {
    const cases: [Answer, string][] = [
      [
        { body: { levelA: false, reason: 'nostr.json names another owner' } },
        'nostr.json names another owner',
      ],
      [{ status: 409, body: { error: 'no_store_key' } }, 'The store key is still being made'],
      [{ body: { levelA: false } }, 'The cloud did not answer as expected (HTTP 200).'],
    ];
    for (const [answer, said] of cases) {
      const store = new FakeStore(readyState({ nip05: '_@shop.example' }));
      const { host } = await admin({
        ...store.routes(),
        [`GET /tenants/${TENANT_ID}/domain`]: answer,
      });
      await signIn(host, OwnerKey.create());
      await eventually(host, () => hasButton(host, 'Launch the store'));
      await eventually(
        host,
        () => host.querySelector('li[data-check="domain"]')?.textContent?.includes(said) === true,
      );
      expect(button(host, 'Launch the store').disabled).toBe(true);
      await unmount();
    }
  });
});

describe('a launched cloud store', () => {
  it('opens on its dashboard: its state, its orders this month, its products as published', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live', paidOrders: 12 }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('[data-run-state="live"]') !== null);
    expect(host.textContent).toContain('Paid orders this month: 12 of 2,000 on your plan');
    expect(host.textContent).not.toContain('Set up your store');
    await eventually(
      host,
      () => host.textContent?.includes('Published: take it off sale') === true,
    );
    expect(hasButton(host, 'Remove course')).toBe(false);
  });

  it('taking it off sale asks once more, and Cancel brings the buttons back', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, 'Take the store off sale'));
    const confirming = () =>
      [...host.querySelectorAll('button')].some(
        (candidate) =>
          candidate.textContent === 'Cancel' ||
          candidate.textContent?.startsWith('Confirm:') === true,
      );
    // Nothing asked yet: no confirm step at all.
    expect(confirming()).toBe(false);
    await click(host, 'Take the store off sale');
    expect(hasButton(host, 'Take the store off sale')).toBe(false);
    expect(hasButton(host, 'Confirm: take it off sale')).toBe(true);
    await click(host, 'Cancel');
    expect(hasButton(host, 'Take the store off sale')).toBe(true);
    expect(confirming()).toBe(false);
  });
});

describe('a partner key', () => {
  it('opens the partner view', async () => {
    const { host } = await admin({
      'GET /owner': { status: 403, body: { error: 'forbidden' } },
      'GET /partner': {
        body: {
          partnerId: 'p000000000001',
          paidUntil: 1_900_000_000,
          volumeSince: 1_897_408_000,
          volume: { orders: 0, paid: {} },
          merchants: [],
        },
      },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('p000000000001') === true);
  });
});
