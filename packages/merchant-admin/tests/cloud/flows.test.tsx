import * as nip19 from 'nostr-tools/nip19';
import type { NostrEvent } from 'nostr-tools/pure';
import { StrictMode, act } from 'react';
import { type Root as ReactRoot, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { key as makeKey } from '../../../merchant-node/tests/admin/fixtures';
import type { CloudProps } from '../../src/cloud/CloudApp';
import { OwnerKey, parseOwnerKey } from '../../src/cloud/lib/owner-key';
import { short } from '../../src/lib/core';
import { Root } from '../../src/Root';
import { fakeDeps, relayClient, storeEvents } from '../fakes';
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
const USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** The fake catalog with some tiers' ways to pay set. */
function tiersPaying(payable: Record<string, { card: boolean; crypto: boolean }>) {
  const tiers = tiersAnswer();
  const list = Array.isArray(tiers.tiers) ? tiers.tiers : [];
  return {
    tiers: list.map((tier: unknown) => {
      const id = tier !== null && typeof tier === 'object' && 'id' in tier ? tier.id : undefined;
      const set = typeof id === 'string' ? payable[id] : undefined;
      return set === undefined || tier === null || typeof tier !== 'object'
        ? tier
        : { ...tier, payable: set };
    }),
  };
}

/** One order as cloud-api serves it, placed a minute ago (the charts read the clock). */
function servedOrder(
  key: string,
  payment: Record<string, unknown> | null,
): Record<string, unknown> {
  const [buyer = '', orderId = ''] = key.split(':');
  return {
    key,
    buyer,
    orderId,
    createdAt: Math.floor(Date.now() / 1000) - 60,
    product: '30402:store:course',
    email: null,
    customerRef: null,
    payment,
    deliveredAt: null,
    webhook: null,
    feeUnresolved: [],
    blockedTx: null,
  };
}
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
  /** Every file handed to the browser, as text. */
  files?: { fileName: string; text: string }[];
  leave?: () => void;
  relays?: NostrEvent[];
  /** What the store-key reads on the relays answer (the sign-in's probe, the self-hosted admin). */
  storeRelays?: NostrEvent[];
  /** Every relay read fails. */
  relaysDown?: boolean;
  /** No relay read ever ends. */
  relaysHang?: boolean;
  /** The relay reads cannot even start. */
  depsThrow?: boolean;
  /** The first relay read cannot start; later ones can. */
  depsThrowOnce?: boolean;
  /** Closing the relay client throws. */
  closeThrows?: boolean;
  /** Each `GET /owner` is answered only once what this gives for it settles. */
  ownerGate?: () => Promise<void>;
  /** `POST /signup` is answered only once this settles. */
  signupGate?: Promise<void>;
  /** Rendered inside `<StrictMode>`, as `main.tsx` renders the page. */
  strict?: boolean;
  /** The `nth` answer (from 1) to `GET <path>` is made at once but handed back only once this settles. */
  hold?: { path: string; nth: number; until: Promise<void> };
}

/** The admin, its cloud part answered by `routes`. */
async function admin(routes: Record<string, Answer>, options: Options = {}) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const cloudApi = fakeCloud({ 'GET /tiers': { body: tiersAnswer() }, ...routes });
  const relays = options.relays ?? [];
  const relayClients = { opened: 0, closed: 0 };
  let threwOnce = false;
  const { ownerGate, signupGate, hold } = options;
  let seen = 0;
  const fetcher = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (hold !== undefined && request.method === 'GET' && path === hold.path) {
      seen += 1;
      if (seen === hold.nth) {
        // Answered as the cloud was then, landing late.
        const answer = await cloudApi.fetcher(request);
        await hold.until;
        return answer;
      }
    }
    if (path === '/owner' && ownerGate !== undefined) {
      await ownerGate();
    }
    if (path === '/signup' && signupGate !== undefined) {
      await signupGate;
    }
    return cloudApi.fetcher(request);
  };
  const cloud: CloudProps = {
    apiOrigin: API,
    download: (data, fileName) => {
      options.downloads?.push(fileName);
      options.files?.push({
        fileName,
        text: typeof data === 'string' ? data : new TextDecoder().decode(data),
      });
    },
    relayQuery: async (filter) =>
      relays.filter((event) => filter.kinds?.includes(event.kind) === true),
    startTier: undefined,
    termsUrl: 'https://paycore.elisym.network/terms',
    billingUrl: undefined,
    navigate: () => undefined,
    wallets: { solana: undefined, evm: undefined },
    fetcher,
    ...options.cloudProps,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  const element = (
    <Root
      ownTab={options.ownTab ?? true}
      createDeps={() => {
        if (options.depsThrow === true || (options.depsThrowOnce === true && !threwOnce)) {
          threwOnce = true;
          throw new Error('no relays');
        }
        relayClients.opened += 1;
        const client = relayClient(
          () => options.storeRelays ?? [],
          () => options.relaysDown === true,
        );
        return fakeDeps(
          {
            ...client,
            ...(options.relaysHang === true
              ? { query: () => new Promise<never>(() => undefined) }
              : {}),
            close: () => {
              if (options.closeThrows === true) {
                throw new Error('close failed');
              }
              relayClients.closed += 1;
            },
          },
          [],
        );
      }}
      leave={options.leave ?? (() => undefined)}
      cloud={options.cloud === false ? undefined : cloud}
    />
  );
  await act(async () =>
    root.render(options.strict === true ? <StrictMode>{element}</StrictMode> : element),
  );
  return { host, calls: cloudApi.calls, relayClients };
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

/** Pastes a key into the one key field and asks to open it. */
async function pasteKey(host: HTMLElement, key: OwnerKey | string) {
  const field = host.querySelector('input#store-key');
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('no key field');
  }
  field.value = typeof key === 'string' ? key : key.nsec();
  await click(host, 'Open store');
}

/** Signs in from the front door's one key field. */
async function signIn(host: HTMLElement, key: OwnerKey | string) {
  await click(host, 'Sign in');
  await pasteKey(host, key);
}

/** A gate the test opens: what waits on it is answered then. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => undefined as void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
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

/** In the create flow: picks `tier` (unless it is picked already) and goes on to the access key. */
async function toKeyStep(host: HTMLElement, tier = 'starter') {
  await eventually(host, () => host.querySelector(`button[data-tier="${tier}"]`) !== null);
  const card = host.querySelector<HTMLButtonElement>(`button[data-tier="${tier}"]`);
  if (card?.getAttribute('aria-checked') !== 'true') {
    await act(async () => card?.click());
  }
  await click(host, 'Continue');
}

/** In the create flow at the access key: makes it, saves it, ticks, and goes on to the terms. */
async function makeAndSaveKey(host: HTMLElement) {
  await click(host, 'Create my access key');
  await click(host, 'Download the key file');
  await act(async () => checkbox(host).click());
  await click(host, 'Continue');
}

describe('the front door', () => {
  it('offers a cloud store and one sign-in, under one heading', async () => {
    const { host } = await admin({});
    expect(host.querySelector('h1')?.textContent).toBe('Take crypto payments on your site');
    expect([...host.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual([
      'How it works',
      'What you need',
      'Questions',
    ]);
    expect(hasButton(host, 'Create a store')).toBe(true);
    expect(hasButton(host, 'Sign in')).toBe(true);
  });

  it('built with no cloud, it is the self-hosted sign-in alone, and asks no cloud', async () => {
    const { host, calls } = await admin({}, { cloud: false });
    expect(host.textContent).not.toContain('Take crypto payments on your site');
    expect(host.querySelector('input#store-key')).not.toBeNull();
    expect(host.textContent).not.toContain('We ask our cloud');
    expect(calls).toEqual([]);
  });

  it('the one sign-in says which key it takes, and Back returns to the front door', async () => {
    const { host } = await admin({});
    await click(host, 'Sign in');
    expect(host.textContent).toContain('For a store in our cloud, paste your access key');
    expect(host.textContent).toContain('We ask our cloud whether this key runs a store there');
    await click(host, 'Back');
    expect(host.textContent).toContain('Take crypto payments on your site');
  });

  it('Create a store opens the plan step, and Back returns to the front door', async () => {
    const { host } = await admin({});
    await click(host, 'Create a store');
    expect(host.querySelector('h1')?.textContent).toBe('Create a store');
    expect(host.querySelector('ol[aria-label="Create a store"]')).not.toBeNull();
    await click(host, 'Back');
    expect(host.textContent).toContain('Take crypto payments on your site');
  });

  it('asks for no key in a tab another page opened or framed, cloud or not', async () => {
    const { host } = await admin({}, { ownTab: false });
    expect(host.textContent).toContain('Open this page in its own tab');
    expect(host.querySelector('input')).toBeNull();
    expect(hasButton(host, 'Create a store')).toBe(false);
  });

  it('a card payment returning opens the sign-in, never a new key, and says so once signed in', async () => {
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes(), {
      cloudProps: {
        checkoutReturn: { tenantId: TENANT_ID, outcome: 'done' },
        startTier: 'starter',
      },
    });
    expect(host.textContent).toContain(
      'Your card payment came back: sign in with your access key to see your store.',
    );
    expect(hasButton(host, 'Create my access key')).toBe(false);
    await pasteKey(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Card payment received') === true);
  });
});

describe('one key field, routed', () => {
  it('a self-hosted store key opens the self-hosted admin, its store read from the relays', async () => {
    const store = makeKey();
    const owner = makeKey();
    const { host, calls } = await admin(
      { 'GET /owner': { body: { tenantId: null, termsVersion: 't1' } } },
      { storeRelays: storeEvents(store, owner) },
    );
    await signIn(host, nip19.nsecEncode(store.secretKey));
    await eventually(host, () => host.querySelector('#shell-store-name')?.textContent === 'Shop');
    // The cloud was asked once, by a request the key signed; nothing else of it was used.
    // The front page read the plan catalog, with no key; the sign-in asked the cloud once.
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /tiers',
      'GET /owner',
    ]);
    expect(calls[0]?.signer).toBeUndefined();
    expect(calls[1]?.signer).toBe(store.pubkey);
  });

  it('a cloud that does not answer leaves a self-hosted store to its relays', async () => {
    const store = makeKey();
    const { host } = await admin(
      { 'GET /owner': { status: 503, body: { error: 'internal' } } },
      { storeRelays: storeEvents(store, makeKey()) },
    );
    await signIn(host, nip19.nsecEncode(store.secretKey));
    await eventually(host, () => host.querySelector('#shell-store-name')?.textContent === 'Shop');
  });

  it('nothing anywhere: said, and the field stays for another try', async () => {
    const { host } = await admin({ 'GET /owner': { status: 503, body: { error: 'internal' } } });
    await signIn(host, OwnerKey.create());
    await eventually(
      host,
      () =>
        host.textContent?.includes('Our cloud is not answering, and the relays showed nothing') ===
        true,
    );
    expect(host.querySelector('input#store-key')).not.toBeNull();
    expect(button(host, 'Open store').getAttribute('aria-disabled')).toBe('false');
  });

  it('a key with no store anywhere opens the cloud part, saying the relays showed nothing', async () => {
    const { host } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Have an invite from us?') === true);
    expect(host.textContent).toContain('the relays showed nothing for this key');
    expect(host.textContent).toContain(
      'If this is the key of a store you run yourself, do not create a store here with it',
    );
  });

  it('an operator key is refused in words, never read as a store key', async () => {
    const { host, calls } = await admin({
      'GET /owner': { status: 403, body: { error: 'forbidden' } },
      'GET /partner': { status: 403, body: { error: 'forbidden' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(
      host,
      () => host.textContent?.includes('This key cannot be used here.') === true,
    );
    expect(calls.filter((call) => call.path === '/partner')).toHaveLength(1);
  });

  it('a cloud store opens with the key the field took: no second key step', async () => {
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, 'Sign out'));
    expect(host.querySelector('input#owner-key')).toBeNull();
    expect(host.querySelector('input#store-key')).toBeNull();
    expect(host.textContent).not.toContain('the relays showed nothing');
  });

  it('a cloud store opens on the cloud answer alone: the relays are not waited for', async () => {
    const store = new FakeStore(storeState());
    const { host, relayClients } = await admin(store.routes(), { relaysHang: true });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, 'Sign out'));
    expect(relayClients).toEqual({ opened: 1, closed: 1 });
  });

  it('Back while a key is checked drops its route: the front door stays', async () => {
    const owner = gate();
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes(), { ownerGate: () => owner.wait });
    const close = vi.spyOn(OwnerKey.prototype, 'close');
    await signIn(host, OwnerKey.create());
    expect(button(host, 'Opening your store...').getAttribute('aria-disabled')).toBe('true');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Opening your store...');
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    await click(host, 'Back');
    await click(host, 'Create a store');
    await toKeyStep(host);
    await click(host, 'Create my access key');
    const made = close.mock.calls.length;
    await act(async () => owner.open());
    await eventually(host, () => close.mock.calls.length > made);
    // The route's key was closed; the key just made is still the one on screen.
    expect(hasButton(host, 'Download the key file')).toBe(true);
    expect(hasButton(host, 'Sign out')).toBe(false);
  });

  it('Back while a key is checked, then the sign-in again: the field takes a key at once', async () => {
    const owner = gate();
    const { host } = await admin(
      { 'GET /owner': { body: { tenantId: null, termsVersion: 't1' } } },
      { ownerGate: () => owner.wait },
    );
    await signIn(host, OwnerKey.create());
    await click(host, 'Back');
    await click(host, 'Sign in');
    expect(button(host, 'Open store').getAttribute('aria-disabled')).toBe('false');
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    await act(async () => owner.open());
    await pasteKey(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Have an invite from us?') === true);
  });

  it('reads that cannot even start: said, no key kept, and the field takes another', async () => {
    const { host } = await admin({}, { depsThrow: true });
    const secret = makeKey().secretKey;
    const pasted = Buffer.from(secret).toString('hex');
    // Each array zeroed, as it was just before.
    const zeroedFrom: string[] = [];
    const fill = Uint8Array.prototype.fill;
    vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
      this: Uint8Array,
      ...args: Parameters<Uint8Array['fill']>
    ) {
      if (args[0] === 0) {
        zeroedFrom.push(Buffer.from(this).toString('hex'));
      }
      return fill.apply(this, args);
    });
    await signIn(host, pasted);
    await eventually(host, () => host.textContent?.includes('Our cloud is not answering') === true);
    expect(button(host, 'Open store').getAttribute('aria-disabled')).toBe('false');
    expect(zeroedFrom).toContain(pasted);
  });

  it('a route that fails after Back says nothing to the next sign-in', async () => {
    const owner = gate();
    const second = gate();
    let asked = 0;
    const { host } = await admin(
      { 'GET /owner': { body: { tenantId: null, termsVersion: 't1' } } },
      {
        closeThrows: true,
        ownerGate: () => {
          asked += 1;
          return asked === 1 ? owner.wait : second.wait;
        },
      },
    );
    await signIn(host, OwnerKey.create());
    await click(host, 'Back');
    await click(host, 'Sign in');
    await pasteKey(host, OwnerKey.create());
    await act(async () => owner.open());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // The second key is still being checked; the first one's failure changed nothing.
    expect(host.textContent).not.toContain('Our cloud is not answering');
    expect(button(host, 'Opening your store...').getAttribute('aria-disabled')).toBe('true');
    await act(async () => second.open());
    await eventually(host, () => host.textContent?.includes('Our cloud is not answering') === true);
  });

  it('the relays-showed-nothing note goes once the key has a store: an invite redeemed', async () => {
    const store = new FakeStore(storeState());
    let redeemed = false;
    const { host } = await admin({
      ...store.routes(),
      'GET /owner': () => ({
        body: { tenantId: redeemed ? TENANT_ID : null, termsVersion: 't1' },
      }),
      'POST /redeem': () => {
        redeemed = true;
        return { body: { tenantId: TENANT_ID } };
      },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Have an invite from us?') === true);
    expect(host.textContent).toContain('the relays showed nothing');
    await click(host, 'Use your invite');
    await fill(host, 'input#invite', 'invite-1');
    await click(host, 'Redeem');
    await eventually(host, () => host.textContent?.includes('Have an invite from us?') === false);
    await eventually(host, () => host.textContent?.includes('Your store') === true);
    expect(host.textContent).not.toContain('the relays showed nothing');
  });

  it('while a key is checked, Enter reads nothing more and the field keeps what it has', async () => {
    const owner = gate();
    let probes = 0;
    const { host } = await admin(
      { 'GET /owner': { body: { tenantId: null, termsVersion: 't1' } } },
      {
        ownerGate: () => {
          probes += 1;
          return owner.wait;
        },
      },
    );
    await signIn(host, OwnerKey.create());
    const field = host.querySelector('input#store-key');
    if (!(field instanceof HTMLInputElement)) {
      throw new Error('no key field');
    }
    field.value = 'typed';
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await click(host, 'Opening your store...');
    expect(field.value).toBe('typed');
    expect(probes).toBe(1);
    await act(async () => owner.open());
    await eventually(host, () => host.textContent?.includes('Have an invite from us?') === true);
  });

  it('a relay read that fails counts as no store: with the cloud down, nothing opens', async () => {
    const store = makeKey();
    const { host, relayClients } = await admin(
      { 'GET /owner': { status: 503, body: { error: 'internal' } } },
      { storeRelays: storeEvents(store, makeKey()), relaysDown: true },
    );
    await signIn(host, nip19.nsecEncode(store.secretKey));
    await eventually(host, () => host.textContent?.includes('Our cloud is not answering') === true);
    expect(host.querySelector('#shell-store-name')).toBeNull();
    expect(relayClients).toEqual({ opened: 1, closed: 1 });
  });

  it('a cloud that hangs is given up on after the probe time, and the relays decide', async () => {
    const store = makeKey();
    const { host } = await admin(
      {},
      {
        storeRelays: storeEvents(store, makeKey()),
        ownerGate: () => new Promise<void>(() => undefined),
        cloudProps: { probeMs: 100 },
      },
    );
    await signIn(host, nip19.nsecEncode(store.secretKey));
    await eventually(host, () => host.querySelector('#shell-store-name')?.textContent === 'Shop');
  });

  it('what went wrong is cleared on the next try and on Back', async () => {
    const second = gate();
    let asked = 0;
    const { host } = await admin(
      { 'GET /owner': { status: 503, body: { error: 'internal' } } },
      {
        ownerGate: () => {
          asked += 1;
          return asked < 3 ? Promise.resolve() : second.wait;
        },
      },
    );
    const said = () => host.textContent?.includes('Our cloud is not answering') === true;
    await signIn(host, OwnerKey.create());
    await eventually(host, said);
    await click(host, 'Back');
    await click(host, 'Sign in');
    expect(said()).toBe(false);
    await pasteKey(host, OwnerKey.create());
    await eventually(host, said);
    // A new try, while it is checked: the last one's words are gone.
    await pasteKey(host, OwnerKey.create());
    expect(said()).toBe(false);
    await act(async () => second.open());
    await eventually(host, said);
  });
});

describe('the create wizard', () => {
  it('opens a step at a time: past the current one nothing opens, and focus goes to each heading', async () => {
    const { host } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await click(host, 'Create a store');
    const steps = () => host.querySelector('ol[aria-label="Create a store"]');
    await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
    // At the plan, the later steps are names, not buttons.
    expect(steps()?.querySelectorAll('button')).toHaveLength(1);
    expect(button(host, 'Continue').disabled).toBe(true);
    await toKeyStep(host);
    expect(document.activeElement).toBe(host.querySelector('h1'));
    expect(host.querySelector('h1')?.textContent).toBe('Save your access key');
    expect(steps()?.querySelectorAll('button')).toHaveLength(2);
    await makeAndSaveKey(host);
    expect(document.activeElement).toBe(host.querySelector('h1'));
    await eventually(host, () => hasButton(host, 'Create my store'));
    expect(steps()?.querySelectorAll('button')).toHaveLength(3);
  });

  it('makes one access key a visit: back at the plan, the key stays, and only the plan changes', async () => {
    const { host, calls } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
      'POST /signup': { body: { tenantId: TENANT_ID } },
    });
    const made = vi.spyOn(OwnerKey, 'create');
    await click(host, 'Create a store');
    await toKeyStep(host);
    // Before a key, a saved one can be used instead; after, that way is gone.
    expect(hasButton(host, 'sign in')).toBe(true);
    await click(host, 'Create my access key');
    expect(hasButton(host, 'sign in')).toBe(false);
    await click(host, 'Download the key file');
    await act(async () => checkbox(host).click());
    // Back to the plan through the steps: another plan, then on, with the same key.
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'ol[aria-label="Create a store"] li[data-step="plan"] button',
        )
        ?.click(),
    );
    await toKeyStep(host, 'business');
    expect(hasButton(host, 'Create my access key')).toBe(false);
    expect(button(host, 'Continue').disabled).toBe(false);
    await click(host, 'Continue');
    await eventually(host, () => hasButton(host, 'Create my store'));
    expect(host.textContent).toContain('Start a Business store');
    await act(async () => checkbox(host).click());
    await click(host, 'Create my store');
    await eventually(host, () => calls.some((call) => call.path === '/signup'));
    expect(made).toHaveBeenCalledTimes(1);
    const signers = new Set(
      calls.filter((call) => call.signer !== undefined).map((call) => call.signer),
    );
    expect(signers.size).toBe(1);
  });

  it('a plan picked over the /start one stays picked when the plan step opens again', async () => {
    const { host } = await admin({}, { cloudProps: { startTier: 'starter' } });
    await eventually(host, () => host.querySelector('button[data-tier="business"]') !== null);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[data-tier="business"]')?.click(),
    );
    await click(host, 'Continue');
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'ol[aria-label="Create a store"] li[data-step="plan"] button',
        )
        ?.click(),
    );
    await eventually(host, () => host.querySelector('button[data-tier="business"]') !== null);
    expect(host.querySelector('button[aria-checked="true"]')?.getAttribute('data-tier')).toBe(
      'business',
    );
  });

  it('Back to the front door after a key is made closes it', async () => {
    const { host } = await admin({});
    await click(host, 'Create a store');
    await toKeyStep(host);
    await click(host, 'Create my access key');
    const close = vi.spyOn(OwnerKey.prototype, 'close');
    await click(host, 'Back');
    expect(close).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Take crypto payments on your site');
  });

  it('a page back from the back/forward cache on the key step starts over', async () => {
    const leave = vi.fn();
    const { host } = await admin({}, { leave });
    await click(host, 'Create a store');
    await toKeyStep(host);
    await click(host, 'Create my access key');
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    await act(async () => window.dispatchEvent(event));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('in StrictMode, a key made and one signed in with both sign their requests', async () => {
    const { host, calls } = await admin(
      { 'GET /owner': { body: { tenantId: null, termsVersion: 't1' } } },
      { strict: true },
    );
    await click(host, 'Create a store');
    await toKeyStep(host);
    await makeAndSaveKey(host);
    await eventually(host, () => hasButton(host, 'Create my store'));
    expect(
      calls.filter((call) => call.path === '/owner').every((call) => call.signer !== undefined),
    ).toBe(true);
    await unmount();
    const store = new FakeStore(storeState());
    const signedIn = await admin(store.routes(), { strict: true });
    const key = OwnerKey.create();
    const pubkey = key.pubkey;
    await signIn(signedIn.host, key);
    await eventually(signedIn.host, () => hasButton(signedIn.host, 'Sign out'));
    await eventually(signedIn.host, () =>
      signedIn.calls.some((call) => call.path.startsWith('/tenants/')),
    );
    const afterMount = signedIn.calls.filter((call) => call.path.startsWith('/tenants/'));
    expect(afterMount.every((call) => call.signer === pubkey)).toBe(true);
  });
});

describe('the wizard, at the terms and on its way out', () => {
  it('a terms read that fails says so; Try again reads them again, signed by the new key', async () => {
    let reads = 0;
    const { host, calls } = await admin({
      'GET /owner': () => {
        reads += 1;
        return reads === 1
          ? { status: 503, body: { error: 'internal' } }
          : { body: { tenantId: null, termsVersion: 't1' } };
      },
    });
    await click(host, 'Create a store');
    await toKeyStep(host);
    await makeAndSaveKey(host);
    await eventually(host, () => hasButton(host, 'Try again'));
    // Said, and announced.
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'The cloud refused it (internal).',
    );
    expect(hasButton(host, 'Create my store')).toBe(false);
    await click(host, 'Try again');
    await eventually(host, () => hasButton(host, 'Create my store'));
    const owners = calls.filter((call) => call.path === '/owner');
    expect(owners).toHaveLength(2);
    expect(owners[0]?.signer).toMatch(/^[0-9a-f]{64}$/);
    expect(owners[1]?.signer).toBe(owners[0]?.signer);
  });

  it('a key whose store exists already goes straight to it', async () => {
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes());
    await click(host, 'Create a store');
    await toKeyStep(host);
    await makeAndSaveKey(host);
    await eventually(host, () => hasButton(host, 'Sign out'));
    expect(hasButton(host, 'Create my store')).toBe(false);
  });

  it('terms changed since they were shown: refused, read again, the new version to accept', async () => {
    let version = 't1';
    const { host } = await admin({
      'GET /owner': () => ({ body: { tenantId: null, termsVersion: version } }),
      'POST /signup': () => {
        version = 't2';
        return { status: 409, body: { error: 'terms_not_accepted' } };
      },
    });
    await click(host, 'Create a store');
    await toKeyStep(host);
    await makeAndSaveKey(host);
    await eventually(host, () => hasButton(host, 'Create my store'));
    await act(async () => checkbox(host).click());
    await click(host, 'Create my store');
    await eventually(host, () => host.textContent?.includes('(version t2)') === true);
    expect(checkbox(host).checked).toBe(false);
  });

  it('a plan picked over the /start one is the one signed up for', async () => {
    const { host, calls } = await admin(
      {
        'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
        'POST /signup': { body: { tenantId: TENANT_ID } },
      },
      { cloudProps: { startTier: 'starter' } },
    );
    await toKeyStep(host, 'business');
    await makeAndSaveKey(host);
    await eventually(host, () => hasButton(host, 'Create my store'));
    await act(async () => checkbox(host).click());
    await click(host, 'Create my store');
    await eventually(host, () => calls.some((call) => call.path === '/signup'));
    expect(calls.find((call) => call.path === '/signup')?.body).toEqual({
      tier: 'business',
      terms: 't1',
    });
  });

  it('while the signup is on its way, the steps and Back hold still', async () => {
    const signup = gate();
    const { host } = await admin(
      {
        'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
        'POST /signup': { status: 409, body: { error: 'key_owns_a_store' } },
      },
      { signupGate: signup.wait },
    );
    await click(host, 'Create a store');
    await toKeyStep(host);
    await makeAndSaveKey(host);
    await eventually(host, () => hasButton(host, 'Create my store'));
    await act(async () => checkbox(host).click());
    await click(host, 'Create my store');
    expect(button(host, 'Back').disabled).toBe(true);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'ol[aria-label="Create a store"] li[data-step="plan"] button',
        )
        ?.click(),
    );
    expect(host.querySelector('h1')?.textContent).toBe('Accept the terms and create your store');
    await act(async () => signup.open());
    await eventually(host, () => button(host, 'Back').disabled === false);
  });

  it('once the key is made, focus goes to saving it', async () => {
    const { host } = await admin({});
    await click(host, 'Create a store');
    await toKeyStep(host);
    await click(host, 'Create my access key');
    expect(document.activeElement).toBe(button(host, 'Download the key file'));
  });

  it('picking plans reads the catalog once', async () => {
    const { host, calls } = await admin({});
    await click(host, 'Create a store');
    await eventually(host, () => host.querySelector('button[data-tier="business"]') !== null);
    for (const tier of ['business', 'starter', 'business']) {
      await act(async () =>
        host.querySelector<HTMLButtonElement>(`button[data-tier="${tier}"]`)?.click(),
      );
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // One read by the front page, one by the plan step: none per pick.
    expect(calls.filter((call) => call.path === '/tiers')).toHaveLength(2);
  });

  it('the card-return line is said once: Back and the sign-in again no longer show it', async () => {
    const { host } = await admin(
      {},
      { cloudProps: { checkoutReturn: { tenantId: TENANT_ID, outcome: 'done' } } },
    );
    expect(host.textContent).toContain('Your card payment came back');
    await click(host, 'Back');
    await click(host, 'Sign in');
    expect(host.textContent).not.toContain('Your card payment came back');
  });
});

describe('a plan picked before the sign-in', () => {
  it('reaches the store part the sign-in opens', async () => {
    const { host } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await click(host, 'Create a store');
    await toKeyStep(host, 'business');
    const close = vi.spyOn(OwnerKey.prototype, 'close');
    await click(host, 'sign in');
    // Leaving for the sign-in closes nothing made (none was), and keeps the plan.
    expect(close).not.toHaveBeenCalled();
    await pasteKey(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('button[data-tier="business"]') !== null);
    expect(host.querySelector('button[data-tier="business"]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('is kept across a sign-in the cloud did not answer, and the retry has it', async () => {
    let answered = false;
    const { host } = await admin({
      'GET /owner': () =>
        answered
          ? { body: { tenantId: null, termsVersion: 't1' } }
          : { status: 503, body: { error: 'internal' } },
    });
    await click(host, 'Create a store');
    await toKeyStep(host, 'business');
    await click(host, 'sign in');
    await pasteKey(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Our cloud is not answering') === true);
    answered = true;
    await pasteKey(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('button[data-tier="business"]') !== null);
    expect(host.querySelector('button[data-tier="business"]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('is kept across a sign-in whose reads could not even start', async () => {
    const { host } = await admin(
      { 'GET /owner': { body: { tenantId: null, termsVersion: 't1' } } },
      { depsThrowOnce: true },
    );
    await click(host, 'Create a store');
    await toKeyStep(host, 'business');
    await click(host, 'sign in');
    await pasteKey(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Our cloud is not answering') === true);
    await pasteKey(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('button[data-tier="business"]') !== null);
    expect(host.querySelector('button[data-tier="business"]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('is dropped when the sign-in is left', async () => {
    const { host } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await click(host, 'Create a store');
    await toKeyStep(host, 'business');
    await click(host, 'sign in');
    await click(host, 'Back');
    await click(host, 'Sign in');
    await pasteKey(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('button[data-tier="business"]') !== null);
    expect(host.querySelector('button[aria-checked="true"]')).toBeNull();
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
    // Opened from a /start link, its plan is picked at once.
    await eventually(host, () => host.querySelector('button[data-tier="business"]') !== null);
    expect(host.querySelector('button[data-tier="business"]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    await click(host, 'Continue');
    await click(host, 'Create my access key');
    await click(host, 'Download the key file');
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^paycore-owner-npub1/);
    await act(async () => checkbox(host).click());
    await click(host, 'Continue');
    await eventually(host, () => hasButton(host, 'Create my store'));
    expect(host.textContent).toContain('Start a Business store');
    expect(host.textContent).not.toContain('do not create a store here');
    await act(async () => checkbox(host).click());
    await click(host, 'Create my store');
    await eventually(host, () => calls.some((call) => call.path === '/signup'));
    const signup = calls.find((call) => call.path === '/signup');
    expect(signup?.body).toEqual({ tier: 'business', terms: 't1' });
    // Signed by the key just made, as every request.
    expect(signup?.signer).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a key with no store, with no /start link: the plans, then signup for the one picked', async () => {
    const { host, calls } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
      'POST /signup': { body: { tenantId: TENANT_ID } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
    // The invite comes first, the plans after it; only self-serve plans are cards.
    const text = host.textContent ?? '';
    expect(text.indexOf('Have an invite from us?')).toBeLessThan(text.indexOf('Choose a plan'));
    expect(host.querySelector('button[data-tier="high-risk"]')).toBeNull();
    const talk = host.querySelector('a[href="https://x.com/elisymlabs"]');
    expect(talk?.textContent).toBe('Talk to us');
    expect(talk?.getAttribute('rel')).toBe('noopener noreferrer');
    // One single-choice group of plans, its cards radios with no list inside.
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Plans');
    expect(host.querySelector('button[data-tier="starter"]')?.getAttribute('role')).toBe('radio');
    expect(host.querySelector('button[data-tier] ul, button[data-tier] li')).toBeNull();
    // The catalog is read with no auth.
    expect(calls.find((call) => call.path === '/tiers')?.signer).toBeUndefined();
    expect(hasButton(host, 'Create my store')).toBe(false);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[data-tier="starter"]')?.click(),
    );
    expect(host.querySelector('button[data-tier="starter"]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(host.textContent).toContain('Start a Starter store ($29/mo)');
    await act(async () => checkbox(host).click());
    await click(host, 'Create my store');
    await eventually(host, () => calls.some((call) => call.path === '/signup'));
    expect(calls.find((call) => call.path === '/signup')?.body).toEqual({
      tier: 'starter',
      terms: 't1',
    });
  });

  it('the invite opens in place, above the plans', async () => {
    const { host } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, 'Use your invite'));
    expect(host.querySelector('input#invite')).toBeNull();
    await click(host, 'Use your invite');
    expect(host.querySelector('input#invite')).not.toBeNull();
    const text = host.textContent ?? '';
    expect(text.indexOf('Redeem an invite')).toBeLessThan(text.indexOf('Choose a plan'));
  });

  it('a /start link to a plan that cannot start here picks nothing and says so', async () => {
    for (const tier of ['high-risk', 'nope']) {
      const { host } = await admin(
        { 'GET /owner': { body: { tenantId: null, termsVersion: 't1' } } },
        { cloudProps: { startTier: tier } },
      );
      await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
      expect(host.textContent).toContain('That plan cannot be started here');
      expect(host.querySelector('button[aria-checked="true"]')).toBeNull();
      expect(button(host, 'Continue').disabled).toBe(true);
      await unmount();
    }
  });

  it('a plan with no way to pay yet cannot be picked', async () => {
    const { host } = await admin({
      'GET /tiers': { body: tiersPaying({ starter: { card: false, crypto: false } }) },
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
    const starter = host.querySelector<HTMLButtonElement>('button[data-tier="starter"]');
    expect(starter?.disabled).toBe(true);
    expect(starter?.textContent).toContain('Not available yet');
    expect(host.querySelector('button[data-tier="business"]')?.textContent).toContain(
      'Pay by card',
    );
  });

  it('a /start link to a self-serve plan with no way to pay picks nothing and says so', async () => {
    const { host } = await admin(
      {
        'GET /tiers': { body: tiersPaying({ starter: { card: false, crypto: false } }) },
        'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
      },
      { cloudProps: { startTier: 'starter' } },
    );
    await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
    expect(host.textContent).toContain('That plan cannot be started here');
    expect(host.querySelector('button[aria-checked="true"]')).toBeNull();
    expect(button(host, 'Continue').disabled).toBe(true);
    // Picking a plan that can start clears the words.
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[data-tier="business"]')?.click(),
    );
    expect(host.textContent).not.toContain('That plan cannot be started here');
  });

  it('a plan that is not self-serve is never a card nor started by a link, even when payable', async () => {
    const { host } = await admin(
      {
        'GET /tiers': { body: tiersPaying({ 'high-risk': { card: false, crypto: true } }) },
        'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
      },
      { cloudProps: { startTier: 'high-risk' } },
    );
    await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
    expect(host.querySelector('button[data-tier="high-risk"]')).toBeNull();
    expect(host.textContent).toContain('That plan cannot be started here');
    expect(button(host, 'Continue').disabled).toBe(true);
  });

  it('says so in one line when no plan can be started here', async () => {
    const off = { card: false, crypto: false };
    const { host } = await admin({
      'GET /tiers': { body: tiersPaying({ starter: off, business: off }) },
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
    expect(host.textContent).toContain('No plan can be started here right now: talk to us.');
  });

  it('while a signup is on its way, no other plan can be picked', async () => {
    const signup = gate();
    const { host, calls } = await admin(
      {
        'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
        'POST /signup': { status: 409, body: { error: 'key_owns_a_store' } },
      },
      { signupGate: signup.wait },
    );
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[data-tier="starter"]')?.click(),
    );
    await act(async () => checkbox(host).click());
    await click(host, 'Create my store');
    const business = () => host.querySelector<HTMLButtonElement>('button[data-tier="business"]');
    expect(business()?.disabled).toBe(true);
    await act(async () => business()?.click());
    expect(host.textContent).toContain('Start a Starter store');
    await act(async () => signup.open());
    await eventually(host, () => calls.some((call) => call.path === '/signup'));
    // Refused: the plans open again, and only the one signup went out.
    await eventually(host, () => business()?.disabled === false);
    expect(calls.filter((call) => call.path === '/signup')).toHaveLength(1);
  });

  it('arrow keys move between the plans that can start, and pick', async () => {
    const { host } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
    const starter = host.querySelector<HTMLButtonElement>('button[data-tier="starter"]');
    expect(starter?.tabIndex).toBe(0);
    expect(host.querySelector<HTMLButtonElement>('button[data-tier="business"]')?.tabIndex).toBe(
      -1,
    );
    await act(async () => {
      starter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    const business = host.querySelector<HTMLButtonElement>('button[data-tier="business"]');
    expect(business?.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(business);
  });

  it('a catalog that cannot be read says so, and Try again reads it again', async () => {
    let reads = 0;
    const { host } = await admin({
      'GET /tiers': () => {
        reads += 1;
        // The front page's read, then the plan picker's first one fails.
        return reads === 2 ? { status: 502, body: 'down' } : { body: tiersAnswer() };
      },
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(
      host,
      () => host.textContent?.includes('The plans could not be loaded') === true,
    );
    await click(host, 'Try again');
    await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
    expect(reads).toBe(3);
  });
});

describe('the owner key in the page', () => {
  it('Sign out closes the key and leaves the page; the sidebar names the key', async () => {
    const close = vi.spyOn(OwnerKey.prototype, 'close');
    const leave = vi.fn();
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes(), { leave });
    const key = OwnerKey.create();
    const npub = key.npub;
    await signIn(host, key);
    await eventually(host, () => hasButton(host, 'Sign out'));
    // The store's frame names the key in its account block, by its public id only.
    const shown = host.querySelector(`#store-sidebar [title="${npub}"]`);
    expect(shown?.textContent).toBe(short(npub));
    expect(
      host.querySelector('#store-sidebar button[aria-label="Copy your public id (safe to share)"]'),
    ).not.toBeNull();
    close.mockClear();
    await click(host, 'Sign out');
    expect(close).toHaveBeenCalled();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('a new key is saved before anything else, then the store part signs as it', async () => {
    const files: { fileName: string; text: string }[] = [];
    const { host, calls } = await admin(
      { 'GET /owner': { body: { tenantId: null, termsVersion: 't1' } } },
      { files },
    );
    await click(host, 'Create a store');
    await toKeyStep(host);
    await click(host, 'Create my access key');
    const checkbox = host.querySelector('input[type="checkbox"]');
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error('no checkbox');
    }
    expect(button(host, 'Continue').disabled).toBe(true);
    expect(checkbox.disabled).toBe(true);
    await click(host, 'Download the key file');
    expect(files).toHaveLength(1);
    const nsecLine = files[0]?.text.split('\n').find((line) => line.startsWith('nsec1')) ?? '';
    const key = parseOwnerKey(nsecLine);
    if (key === undefined) {
      throw new Error('no key in the file');
    }
    expect(files[0]?.fileName).toBe(`paycore-owner-${key.npub.slice(0, 14)}.txt`);
    // Saved, not yet confirmed: still no way on.
    expect(button(host, 'Continue').disabled).toBe(true);
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    await click(host, 'Continue');
    // The terms step reads the key's own /owner, signed by the key in the file.
    await eventually(host, () => calls.some((call) => call.path === '/owner'));
    expect(calls.find((call) => call.path === '/owner')?.signer).toBe(key.pubkey);
    expect(host.querySelector('h1')?.textContent).toBe('Accept the terms and create your store');
    // The secret is nowhere in the page.
    expect(document.documentElement.outerHTML).not.toContain(nsecLine);
  });

  it('a page brought back from the back/forward cache starts over; a fresh show does not', async () => {
    const leave = vi.fn();
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes(), { leave });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, 'Sign out'));
    const shown = (persisted: boolean) => {
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: persisted });
      return event;
    };
    await act(async () => window.dispatchEvent(shown(false)));
    expect(leave).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(shown(true)));
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

  it('charts its orders as the self-hosted overview does: credited, net of the fee', async () => {
    const store = new FakeStore(
      readyState({
        activated: true,
        runState: 'live',
        orders: [
          servedOrder('b1:o1', {
            signature: 'sig1',
            amount: '1500000',
            fee: '5000',
            asset: USDC,
            medium: 'solana',
            paidAt: Math.floor(Date.now() / 1000) - 60,
          }),
          servedOrder('b2:o2', null),
        ],
      }),
    );
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('#totals') !== null);
    expect(host.querySelector('#totals')?.textContent).toContain('1.495 USDC');
    expect(host.querySelector('#charts')).not.toBeNull();
    // Placed a minute ago: in the chart's last days, net of the fee.
    expect(host.querySelector('#credited-readout')?.textContent).toMatch(/^1\.495 USDC credited/);
    expect(host.textContent).toContain('No payment credited');
    // Paid and not completed yet: the store confirmed it, so no "not confirmed" warning.
    expect(host.querySelector('#status-reported')).toBeNull();
  });

  it('says a cloud store with nothing credited has nothing "by your store" yet', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('#totals') !== null);
    expect(host.querySelector('#totals')?.textContent).toContain(
      'nothing credited yetby your store',
    );
  });

  it('words its charts for a store in our cloud: "your store", never "your node"', async () => {
    const store = new FakeStore(
      readyState({
        activated: true,
        runState: 'live',
        orders: [
          servedOrder('b1:o1', {
            signature: 'sig1',
            amount: '7',
            fee: '0',
            asset: 'solana:nowhere/token:nothing',
            medium: 'solana',
            paidAt: Math.floor(Date.now() / 1000) - 60,
          }),
        ],
      }),
    );
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('#uncharted') !== null);
    expect(host.querySelector('#uncharted')?.textContent).toContain(
      'in an asset your store did not name',
    );
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

describe('the cloud store on the frame', () => {
  const path = `/tenants/${TENANT_ID}`;
  const reads = (calls: { method: string; path: string }[], suffix: string) =>
    calls.filter((call) => call.method === 'GET' && call.path === `${path}${suffix}`).length;
  const nav = (host: HTMLElement, label: string) => {
    const found = [...host.querySelectorAll('#store-sidebar nav button')].find(
      (candidate) => candidate.textContent?.startsWith(label) === true,
    );
    if (!(found instanceof HTMLButtonElement)) {
      throw new Error(`no page ${label}`);
    }
    return found;
  };
  const paidOrder = () => ({
    ...servedOrder('b1:o1', {
      signature: 'sig1',
      amount: '1500000',
      fee: '0',
      asset: USDC,
      medium: 'solana',
      paidAt: Math.floor(Date.now() / 1000) - 60,
    }),
    email: 'buyer@shop.test',
    customerRef: 'cust-42',
    deliveredAt: Math.floor(Date.now() / 1000) - 30,
    webhook: { state: 'failed', attempts: 2, lastStatus: 500, lastError: null },
  });

  it('reads the store, its status, what it keeps and its orders once for every page', async () => {
    const store = new FakeStore(
      readyState({ activated: true, runState: 'live', orders: [paidOrder()] }),
    );
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('[data-run-state="live"]') !== null);
    await eventually(host, () => reads(calls, '/orders') === 1);
    for (const label of [
      'Orders',
      'Products',
      'Payouts',
      'Install',
      'Settings',
      'Plan & billing',
    ]) {
      await act(async () => nav(host, label).click());
    }
    expect(nav(host, 'Plan & billing').getAttribute('aria-current')).toBe('page');
    expect([
      reads(calls, ''),
      reads(calls, '/status'),
      reads(calls, '/store'),
      reads(calls, '/orders'),
    ]).toEqual([1, 1, 1, 1]);
    // One status for every page: the Overview's run state is the only one.
    expect(host.querySelectorAll('[data-run-state]')).toHaveLength(1);
  });

  it('Refresh reads all four again', async () => {
    const store = new FakeStore(
      readyState({ activated: true, runState: 'live', orders: [paidOrder()] }),
    );
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => reads(calls, '/orders') === 1 && reads(calls, '/store') === 1);
    await click(host, 'Refresh');
    await eventually(
      host,
      () =>
        reads(calls, '') === 2 &&
        reads(calls, '/status') === 2 &&
        reads(calls, '/store') === 2 &&
        reads(calls, '/orders') === 2,
    );
  });

  it('a save on the Products page moves the status Overview shows', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('[data-run-state="live"]') !== null);
    await act(async () => nav(host, 'Products').click());
    await click(host, 'Add a product');
    const titles = [...host.querySelectorAll('#page-products input[id$="-title"]')];
    const id = titles.at(-1)?.id.replace(/-title$/, '') ?? '';
    await fill(host, `input#${id}-title`, 'Lamp');
    await fill(host, `input#${id}-price`, '12');
    store.state.runState = 'applying';
    const before = reads(calls, '/status');
    await click(host, 'Save 1 change');
    await eventually(host, () => reads(calls, '/status') > before);
    await eventually(host, () => host.querySelector('[data-run-state="applying"]') !== null);
  });

  it('lists its orders on the shared list: contact, no claimed total, its own commands, one CSV', async () => {
    const store = new FakeStore(
      readyState({
        activated: true,
        runState: 'live',
        orders: [paidOrder(), servedOrder('b2:o2', null)],
      }),
    );
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await act(async () => nav(host, 'Orders').click());
    await eventually(host, () => host.querySelectorAll('#orders tr').length === 2);
    const orders = host.querySelector('#page-orders');
    expect(orders?.textContent).toContain('buyer@shop.test');
    expect(orders?.textContent).toContain('ref cust-42');
    expect(orders?.textContent).toContain('Credited by your store');
    expect(
      [...(orders?.querySelectorAll('button') ?? [])].filter(
        (each) => each.textContent === 'Download CSV',
      ),
    ).toHaveLength(1);
    // The search finds an order by its buyer's email.
    const search = orders?.querySelector('input[type="search"]');
    if (!(search instanceof HTMLInputElement)) {
      throw new Error('no search');
    }
    await fill(host, '#page-orders input[type="search"]', 'buyer@shop');
    expect(host.querySelectorAll('#orders tr')).toHaveLength(1);
    const show = host.querySelector('#orders button[aria-label="Show order details"]');
    if (!(show instanceof HTMLButtonElement)) {
      throw new Error('no details button');
    }
    await act(async () => show.click());
    const details = host.querySelector('#orders dl');
    expect(details?.textContent).toContain('cust-42');
    expect(details?.textContent).not.toContain("Buyer's claimed total");
    expect(hasButton(host, 'Retry the webhook now')).toBe(true);
  });

  it('orders that cannot be read are said, never shown as no orders', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host } = await admin({
      ...store.routes(),
      [`GET ${path}/orders`]: { status: 503, body: { error: 'ledger_unreadable' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelectorAll('#page-overview [role="alert"]').length > 0);
    expect(host.querySelector('#page-overview')?.textContent).not.toContain('No orders yet');
    expect(host.querySelector('#page-orders [role="alert"]')).not.toBeNull();
    expect(host.querySelector('#page-orders')?.textContent).not.toContain('No orders found');
    expect(hasButton(host, 'Read the orders again')).toBe(true);
  });

  it('a store not launched holds its setup on Overview: the other pages wait', async () => {
    const store = new FakeStore(storeState({ paid: true }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).length > 0);
    expect(nav(host, 'Orders').getAttribute('aria-disabled')).toBe('true');
    expect(nav(host, 'Help').getAttribute('aria-disabled')).toBeNull();
    // No ledger to read before launch.
    expect(reads(calls, '/orders')).toBe(0);
  });

  it('an exported store shows only its handover, with no pages to choose', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const routes = store.routes();
    const { host } = await admin({
      ...routes,
      [`GET ${path}`]: () => ({
        body: {
          ...store.view(),
          export: { exportedAt: 1_900_000_000, archiveReady: true, destroyAt: 1_900_600_000 },
        },
      }),
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Handover') === true);
    expect(host.querySelectorAll('#store-sidebar nav button')).toHaveLength(0);
    expect(host.querySelector('[id^="page-"]')).toBeNull();
  });

  it('a destroyed store says so alone: no pages, and nothing to read again', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host } = await admin({
      ...store.routes(),
      [`GET ${path}`]: () => ({
        body: {
          ...store.view(),
          export: { exportedAt: 1_900_000_000, archiveReady: true, destroyAt: 1_900_600_000 },
        },
      }),
      [`POST ${path}/export/confirm`]: () => ({ body: { tenantId: TENANT_ID, destroyed: true } }),
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, "My own node runs: destroy the cloud's copy"));
    expect(hasButton(host, 'Refresh')).toBe(true);
    await click(host, "My own node runs: destroy the cloud's copy");
    await click(host, "Confirm: destroy the cloud's copy");
    await eventually(host, () => host.textContent?.includes('Destroyed:') === true);
    expect(host.textContent).toContain('your access key is free');
    expect(host.querySelectorAll('#store-sidebar nav button')).toHaveLength(0);
    expect(hasButton(host, 'Refresh')).toBe(false);
    expect(hasButton(host, 'Sign out')).toBe(true);
  });

  it('after Launch reads what the store keeps, and its status, again', async () => {
    const store = new FakeStore(readyState());
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, 'Launch the store'));
    const kept = reads(calls, '/store');
    const statuses = reads(calls, '/status');
    await click(host, 'Launch the store');
    await eventually(host, () => host.querySelector('[data-run-state]') !== null);
    await eventually(
      host,
      () => reads(calls, '/store') > kept && reads(calls, '/status') > statuses,
    );
  });

  it('the store name field keeps its label: the sidebar names the store under its own id', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('input#store-name') !== null);
    expect(host.querySelectorAll('#store-name')).toHaveLength(1);
    expect(host.querySelector('label[for="store-name"]')).not.toBeNull();
    expect(host.querySelector('#shell-store-name')?.textContent).toBe('Shop');
  });

  it('the CSV can be asked with no open or paid order: hand answers and closed ones are in it', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const routes = store.routes();
    const { host } = await admin({
      ...routes,
      [`GET ${path}/orders`]: () => ({
        body: {
          tenantId: TENANT_ID,
          orders: [],
          answeredByHand: [
            { key: 'b9:o9', kind: 'delivered', tx: null, amount: null, asset: null },
          ],
          closed: ['b9:o9'],
          unresolvedPayments: [],
        },
      }),
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Answered by hand') === true);
    expect(button(host, 'Download CSV').disabled).toBe(false);
  });

  it('the CSV button waits while the CSV is read', async () => {
    let release = () => undefined as void;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new FakeStore(
      readyState({ activated: true, runState: 'live', orders: [paidOrder()] }),
    );
    const { host } = await admin(
      { ...store.routes(), [`GET ${path}/orders.csv`]: { body: 'a,b' } },
      { hold: { path: `${path}/orders.csv`, nth: 1, until } },
    );
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelectorAll('#orders tr').length === 1);
    await click(host, 'Download CSV');
    expect(button(host, 'Download CSV').disabled).toBe(true);
    await act(async () => release());
    await eventually(host, () => !button(host, 'Download CSV').disabled);
  });

  it('a command asked takes the focus, and Cancel gives it back to the button that asked', async () => {
    const store = new FakeStore(
      readyState({ activated: true, runState: 'live', orders: [paidOrder()] }),
    );
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await act(async () => nav(host, 'Orders').click());
    await eventually(host, () => host.querySelectorAll('#orders tr').length === 1);
    const show = host.querySelector('#orders button[aria-label="Show order details"]');
    if (!(show instanceof HTMLButtonElement)) {
      throw new Error('no details button');
    }
    await act(async () => show.click());
    const ask = button(host, 'Retry the webhook now');
    ask.focus();
    await act(async () => ask.click());
    expect(document.activeElement).toBe(button(host, 'Confirm'));
    expect(button(host, 'Confirm').closest('[aria-live="polite"]')).not.toBeNull();
    await click(host, 'Cancel');
    expect(document.activeElement).toBe(button(host, 'Retry the webhook now'));
  });

  it('counts orders only once they are read', async () => {
    const store = new FakeStore(
      readyState({ activated: true, runState: 'live', orders: [paidOrder()] }),
    );
    const failing = await admin({
      ...store.routes(),
      [`GET ${path}/orders`]: { status: 503, body: { error: 'ledger_unreadable' } },
    });
    await signIn(failing.host, OwnerKey.create());
    await eventually(
      failing.host,
      () => failing.host.querySelector('#page-orders [role="alert"]') !== null,
    );
    expect(nav(failing.host, 'Orders').textContent).toBe('Orders');
    await unmount();
    const read = await admin(store.routes());
    await signIn(read.host, OwnerKey.create());
    await eventually(read.host, () => nav(read.host, 'Orders').textContent === 'Orders1');
  });

  it('a page whose read failed says why and tries again; a store not read is never called unlaunched', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    let statusFails = true;
    let keptFails = true;
    let viewFails = true;
    const routes = store.routes();
    const { host } = await admin({
      ...routes,
      [`GET ${path}`]: () =>
        viewFails ? { status: 503, body: { error: 'internal' } } : { body: store.view() },
      [`GET ${path}/status`]: () =>
        statusFails ? { status: 503, body: { error: 'internal' } } : { body: store.status() },
      [`GET ${path}/store`]: () =>
        keptFails ? { status: 503, body: { error: 'internal' } } : { body: store.storeRead() },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('#page-products [role="alert"]') !== null);
    // The view not read: no page is called waiting for a launch.
    expect(nav(host, 'Products').getAttribute('aria-disabled')).toBeNull();
    expect(host.textContent).not.toContain('Opens once your store is live');
    viewFails = false;
    statusFails = false;
    keptFails = false;
    await act(async () => {
      const retry = host.querySelector('#page-products button');
      if (retry instanceof HTMLButtonElement) {
        retry.click();
      }
    });
    // The store read: Products now waits on its own read, tried again by its own button.
    await eventually(host, () => host.textContent?.includes('Paid until') === true);
    expect(host.textContent).not.toContain('Opens once');
    const retryProducts = [...host.querySelectorAll('#page-products button')].find(
      (each) => each.textContent === 'Try again',
    );
    if (retryProducts instanceof HTMLButtonElement) {
      await act(async () => retryProducts.click());
    }
    await eventually(host, () => host.querySelector('#page-products [role="alert"]') === null);
  });

  it('Products and Payouts say a failed read in words, with Try again', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    let statusFails = true;
    let keptFails = true;
    const { host } = await admin({
      ...store.routes(),
      [`GET ${path}/status`]: () =>
        statusFails ? { status: 503, body: { error: 'internal' } } : { body: store.status() },
      [`GET ${path}/store`]: () =>
        keptFails ? { status: 503, body: { error: 'internal' } } : { body: store.storeRead() },
    });
    await signIn(host, OwnerKey.create());
    const refused = (page: string) =>
      [...host.querySelectorAll(`#page-${page} [role="alert"]`)].some(
        (each) => each.textContent === 'The cloud refused it (internal).',
      );
    await eventually(host, () => refused('products') && refused('payouts'));
    statusFails = false;
    keptFails = false;
    for (const page of ['products', 'payouts']) {
      const retry = [...host.querySelectorAll(`#page-${page} button`)].find(
        (each) => each.textContent === 'Try again',
      );
      if (!(retry instanceof HTMLButtonElement)) {
        throw new Error(`no Try again on ${page}`);
      }
      await act(async () => retry.click());
    }
    await eventually(host, () => !refused('products') && !refused('payouts'));
  });

  it('an exported store reads no orders, and its status and kept store no more', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host, calls } = await admin({
      ...store.routes(),
      [`GET ${path}`]: () => ({
        body: {
          ...store.view(),
          export: { exportedAt: 1_900_000_000, archiveReady: true, destroyAt: 1_900_600_000 },
        },
      }),
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Handover') === true);
    const statuses = reads(calls, '/status');
    const kept = reads(calls, '/store');
    await click(host, 'Refresh');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(reads(calls, '/orders')).toBe(0);
    expect([reads(calls, '/status'), reads(calls, '/store')]).toEqual([statuses, kept]);
  });

  it('only the newest read of the store counts: an older one landing late changes nothing', async () => {
    let release = () => undefined as void;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    let views = 0;
    const { host } = await admin(
      {
        ...store.routes(),
        [`GET ${path}`]: () => {
          views += 1;
          return {
            body: {
              ...store.view(),
              export: { exportedAt: 1_900_000_000, archiveReady: views >= 3, destroyAt: null },
            },
          };
        },
      },
      { hold: { path, nth: 2, until } },
    );
    const handoverRefresh = () => {
      const found = [...host.querySelectorAll('main button')].find(
        (each) => each.textContent === 'Refresh',
      );
      if (!(found instanceof HTMLButtonElement)) {
        throw new Error('no Refresh in the handover');
      }
      return found;
    };
    await signIn(host, OwnerKey.create());
    await eventually(
      host,
      () => host.textContent?.includes('The handover is being packed') === true,
    );
    // The second read is held (packed: no); the third lands first (packed: yes).
    await act(async () => handoverRefresh().click());
    await act(async () => handoverRefresh().click());
    await eventually(host, () => hasButton(host, 'Download the handover'));
    await act(async () => release());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(hasButton(host, 'Download the handover')).toBe(true);
  });

  it('an exported store polls no status: its timer stops', { timeout: 15_000 }, async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host, calls } = await admin({
      ...store.routes(),
      [`GET ${path}`]: () => ({
        body: {
          ...store.view(),
          export: { exportedAt: 1_900_000_000, archiveReady: true, destroyAt: 1_900_600_000 },
        },
      }),
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Handover') === true);
    const statuses = reads(calls, '/status');
    // Past one poll's wait (5 s): no status is read again.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_600));
    });
    expect(reads(calls, '/status')).toBe(statuses);
  });

  it('an exported store retries no failed read of what it keeps', { timeout: 15_000 }, async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host, calls } = await admin({
      ...store.routes(),
      [`GET ${path}`]: () => ({
        body: {
          ...store.view(),
          export: { exportedAt: 1_900_000_000, archiveReady: true, destroyAt: 1_900_600_000 },
        },
      }),
      [`GET ${path}/store`]: { status: 503, body: { error: 'internal' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Handover') === true);
    await eventually(host, () => reads(calls, '/store') >= 1);
    const kept = reads(calls, '/store');
    // Past the retry's wait (2 s): nothing is read again.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_600));
    });
    expect(reads(calls, '/store')).toBe(kept);
  });

  it('the Orders count goes when a later read fails', async () => {
    const store = new FakeStore(
      readyState({ activated: true, runState: 'live', orders: [paidOrder()] }),
    );
    let fails = false;
    const routes = store.routes();
    const served = routes[`GET ${path}/orders`];
    const { host } = await admin({
      ...routes,
      [`GET ${path}/orders`]: (body) => {
        if (fails) {
          return { status: 503, body: { error: 'ledger_unreadable' } };
        }
        return typeof served === 'function' ? served(body) : (served ?? { body: {} });
      },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => nav(host, 'Orders').textContent === 'Orders1');
    fails = true;
    await click(host, 'Refresh');
    await eventually(host, () => nav(host, 'Orders').textContent === 'Orders');
  });

  it('a store elisym holds says so, as the sale page does', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'held' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('[data-run-state="held"]') !== null);
    expect(host.querySelector('[data-run-state="held"]')?.textContent).toContain(
      'Held by elisym: contact elisym',
    );
  });

  it('a store gone shows no run state', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'gone' }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => reads(calls, '/status') === 1);
    await eventually(host, () => host.textContent?.includes('Plan') === true);
    expect(host.querySelector('[data-run-state]')).toBeNull();
  });

  it('before launch: one status read for the whole page, and Refresh reads no orders', async () => {
    const store = new FakeStore(storeState({ paid: true }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).length > 0);
    expect(reads(calls, '/status')).toBe(1);
    await click(host, 'Refresh');
    await eventually(host, () => reads(calls, '/status') === 2);
    expect(reads(calls, '/orders')).toBe(0);
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
