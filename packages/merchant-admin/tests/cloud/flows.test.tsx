import { paytoProofMessage } from '@elisym/commerce';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import * as nip19 from 'nostr-tools/nip19';
import type { NostrEvent } from 'nostr-tools/pure';
import { StrictMode, act } from 'react';
import { type Root as ReactRoot, createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { key as makeKey } from '../../../merchant-node/tests/admin/fixtures';
import type { CloudProps } from '../../src/cloud/CloudApp';
import { KeyInUseWarning } from '../../src/cloud/components/KeyInUseWarning';
import { NETWORKS_NOT_ON, READING_PAYOUTS } from '../../src/cloud/components/PayoutsPanel';
import { EXPLAINED } from '../../src/cloud/lib/errors';
import { decisionText } from '../../src/cloud/lib/owner-events';
import { OwnerKey, parseOwnerKey } from '../../src/cloud/lib/owner-key';
import { payoutAssets } from '../../src/cloud/lib/payouts';
import { problemText } from '../../src/cloud/lib/problems';
import { cardRefusalText, cryptoRefusalText } from '../../src/cloud/lib/rails';
import * as SALE from '../../src/cloud/lib/sale';
import { shownTime } from '../../src/cloud/lib/store-view';
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

/** What the open page shows: on Overview, the step open in the checklist; else the page. */
function openBody(host: HTMLElement): string {
  const page = [...host.querySelectorAll<HTMLElement>('[id^="page-"]')].find(
    (each) => !each.hidden,
  );
  if (page?.id === 'page-overview') {
    return (
      [...page.querySelectorAll<HTMLElement>('[data-step-body]')].find((each) => !each.hidden)
        ?.textContent ?? ''
    );
  }
  return page?.textContent ?? '';
}

/** A page's button in the sidebar. */
function pageButton(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('#store-sidebar nav button')].find(
    (candidate) => candidate.textContent?.startsWith(label) === true,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`no page ${label}`);
  }
  return found;
}

/** Opens a page from the sidebar, once the sidebar has it. */
/** A Solana payout added in the form: the one a store needs before any on an EVM chain. */
async function addSolanaPayout(host: HTMLElement) {
  await fill(host, 'select#payout-asset', USDC);
  await fill(
    host,
    'input#payout-address',
    base58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey())),
  );
  await click(host, 'Add');
}

async function openPage(host: HTMLElement, label: string) {
  await eventually(host, () =>
    [...host.querySelectorAll('#store-sidebar nav button')].some(
      (candidate) => candidate.textContent?.startsWith(label) === true,
    ),
  );
  const found = pageButton(host, label);
  await act(async () => found.click());
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
        host.textContent?.includes(
          'Our cloud is not answering, and the network showed no store',
        ) === true,
    );
    expect(host.querySelector('input#store-key')).not.toBeNull();
    expect(button(host, 'Open store').getAttribute('aria-disabled')).toBe('false');
  });

  it('a key with no store anywhere opens the cloud part, saying the network showed no store', async () => {
    const { host } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Have an invite from us?') === true);
    expect(host.textContent).toContain('the network showed no store for this key');
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
    expect(host.textContent).not.toContain('the network showed no store');
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
    expect(host.textContent).toContain('the network showed no store');
    await click(host, 'Use your invite');
    await fill(host, 'input#invite', 'invite-1');
    await click(host, 'Redeem');
    await eventually(host, () => host.textContent?.includes('Have an invite from us?') === false);
    await eventually(host, () => host.textContent?.includes('Your store') === true);
    expect(host.textContent).not.toContain('the network showed no store');
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
  it('starts at paying while the store is not paid: the steps after it say they wait', async () => {
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).some((step) => step.current));
    expect(steps(host).map((step) => step.key)).toEqual([
      'pay',
      'name',
      'payouts',
      'products',
      'install',
      'launch',
    ]);
    const current = steps(host).find((step) => step.current);
    expect(current?.key).toBe('pay');
    expect(current?.badge).toContain('bg-accent text-accent-text');
    expect(steps(host).find((step) => step.key === 'name')?.badge).toContain('bg-surface-2');
    // Paying opens in its row; the steps after it cannot open yet.
    expect(openBody(host)).toContain('Billing');
    expect(host.textContent).toContain('Pay the first month to open this.');
    const nameRow = host.querySelector('li[data-step="name"]');
    expect(nameRow?.querySelector('button')).toBeNull();
  });

  it('names a store never saved with its name alone, then goes on to the payouts', async () => {
    const store = new FakeStore(storeState({ paid: true }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('input#setup-store-name') !== null);
    expect(steps(host).find((step) => step.current)?.key).toBe('name');
    // Before a name, the payouts step asks for one, and its page is shut.
    expect(pageButton(host, 'Payouts').getAttribute('aria-disabled')).toBe('true');
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
    await eventually(host, () => steps(host).find((step) => step.current)?.key === 'payouts');
    // Named: the payouts step opens its page.
    await openStep(host, 'Get paid to');
    await eventually(host, () => openBody(host).includes('Where buyers'));
  });

  it('the payouts page says why it cannot show the payouts when the store cannot be read', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop', rails: ['solana'] }));
    const { host } = await admin({
      ...store.routes(),
      [`GET /tenants/${TENANT_ID}/store`]: { status: 503, body: { error: 'internal' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).find((step) => step.current)?.key === 'payouts');
    await openStep(host, 'Get paid to');
    await eventually(host, () => openBody(host).includes('Try again'));
  });

  it('a payout on a rail the store keeps off turns it on first, then the list is signed', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop', rails: ['solana'] }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Payouts');
    await eventually(host, () => hasButton(host, 'Sign and save payouts'));
    await addSolanaPayout(host);
    await fill(host, 'select#payout-asset', BASE_USDC);
    await fill(host, 'input#payout-address', `0x${'ab'.repeat(20)}`);
    await click(host, 'Add');
    await click(host, 'Sign and save payouts');
    await eventually(host, () => calls.some((call) => call.path.endsWith('/owner-events')));
    const storeAt = calls.findIndex(
      (call) => call.method === 'POST' && call.path.endsWith('/store'),
    );
    expect(calls[storeAt]?.body).toMatchObject({ name: 'Shop', solana: {}, evm: { base: {} } });
    expect(storeAt).toBeLessThan(calls.findIndex((call) => call.path.endsWith('/owner-events')));
    // Kept: the checklist goes on to the products.
    await eventually(host, () => steps(host).find((step) => step.current)?.key === 'products');
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
      await openPage(host, 'Payouts');
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
    await eventually(host, () => steps(host).find((step) => step.current)?.key === 'products');
    await openStep(host, 'Products');
    await eventually(host, () => openBody(host).includes('Add product'));
    await click(host, 'Add product');
    const id = host.querySelector('input[id$="-title"]')?.id ?? '';
    const product = id.replace(/-title$/, '');
    await fill(host, `input#${product}-title`, 'Deposit 10 USD');
    await fill(host, `input#${product}-price`, '10');
    // Not yet saved: removable, never called published.
    expect(hasButton(host, 'Remove deposit-10-usd')).toBe(true);
    expect(host.textContent).not.toContain('Published: take it off sale');
    await click(host, 'Save product');
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
    await eventually(host, () => steps(host).length > 0);
    await openStep(host, 'Install');
    await eventually(host, () => openBody(host).includes('The script, once per page'));
    const codes = [...host.querySelectorAll('code')].map((code) => code.textContent ?? '');
    expect(codes.filter((code) => code.startsWith('<script'))).toHaveLength(1);
    expect(codes.filter((code) => code.startsWith('<elisym-buy product="naddr1'))).toHaveLength(1);
  });

  it('launch opens only when every check holds, is the merchant’s click, and says the store is live', async () => {
    const store = new FakeStore(readyState());
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).find((step) => step.current)?.key === 'launch');
    await eventually(host, () => hasButton(host, 'Launch the store'));
    expect(button(host, 'Launch the store').disabled).toBe(false);
    await click(host, 'Launch the store');
    expect(calls.filter((call) => call.path.endsWith('/launch'))).toHaveLength(1);
    // Launched: the dashboard, with its state, and the news said once.
    await eventually(host, () => host.querySelector('[data-run-state]') !== null);
    expect(host.textContent).toContain('Your store is live');
    expect(host.querySelector('ol[aria-label="Store setup"]')).toBeNull();
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
    expect(host.textContent).toContain('Paid orders this month12 of 2,000');
    expect(host.textContent).not.toContain('Getting started');
    await openPage(host, 'Products');
    await eventually(host, () => host.querySelector('[aria-label="Edit Course"]') !== null);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Edit Course"]')?.click(),
    );
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      'Published: take it off sale',
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
    await click(host, 'Add product');
    const titles = [...host.querySelectorAll('#page-products input[id$="-title"]')];
    const id = titles.at(-1)?.id.replace(/-title$/, '') ?? '';
    await fill(host, `input#${id}-title`, 'Lamp');
    await fill(host, `input#${id}-price`, '12');
    store.state.runState = 'applying';
    const before = reads(calls, '/status');
    await click(host, 'Save product');
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

  it('a store paid and set up but not launched opens every page; its orders say when they come', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop' }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).length > 0);
    for (const label of ['Orders', 'Products', 'Payouts', 'Install', 'Settings', 'Help']) {
      expect(nav(host, label).getAttribute('aria-disabled'), label).toBeNull();
    }
    // Nothing to take off sale or export before it is live.
    const settings = host.querySelector('#page-settings')?.textContent ?? '';
    expect(settings).toContain('Save settings');
    expect(settings).not.toContain('Take the store off sale');
    expect(settings).not.toContain('Leave the cloud');
    await act(async () => nav(host, 'Orders').click());
    expect(openBody(host)).toContain('Orders show here once your store is live.');
    await click(host, 'Finish getting started');
    expect(host.querySelector<HTMLElement>('#page-overview')?.hidden).toBe(false);
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
    await eventually(host, () =>
      hasButton(host, "My own payment server runs: destroy the cloud's copy"),
    );
    expect(hasButton(host, 'Refresh')).toBe(true);
    await click(host, "My own payment server runs: destroy the cloud's copy");
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

describe('a cloud store in words: its locks, its summary, its settings', () => {
  const reasonOf = (host: HTMLElement, label: string) => {
    const id = pageButton(host, label).getAttribute('aria-describedby') ?? '';
    return id === '' ? '' : (document.getElementById(id)?.textContent ?? '');
  };

  it('not paid: Plan & billing opens, the other pages say to pay first', async () => {
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).length > 0);
    expect(pageButton(host, 'Plan & billing').getAttribute('aria-disabled')).toBeNull();
    for (const label of ['Orders', 'Products', 'Payouts', 'Install', 'Settings']) {
      expect(pageButton(host, label).getAttribute('aria-disabled'), label).toBe('true');
      expect(reasonOf(host, label), label).toBe('Pay the first month to open this');
    }
  });

  it('paid, its store key being made: the pages say it is being prepared', async () => {
    const store = new FakeStore(storeState({ paid: true, preparing: true }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).length > 0);
    expect(reasonOf(host, 'Products')).toBe('Paid. Preparing your store: this takes a minute');
    expect(openBody(host)).toContain('Paid. Preparing your store');
  });

  it('invited, its key not made: no pay step, every page but Overview and Help prepared for', async () => {
    const store = new FakeStore(storeState({ launch: 'operator' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).length > 0);
    expect(steps(host).map((step) => step.key)).not.toContain('pay');
    expect(host.textContent).toContain('We launch this store for you once it is set up');
    for (const label of ['Plan & billing', 'Products', 'Settings']) {
      expect(reasonOf(host, label), label).toBe('We are preparing your store: this takes a minute');
    }
  });

  it('invited and set up: the checklist has no Launch button, we launch it', async () => {
    const store = new FakeStore(readyState({ launch: 'operator' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).find((step) => step.current)?.key === 'launch');
    expect(openBody(host)).toContain('We launch it with you');
    expect(hasButton(host, 'Launch the store')).toBe(false);
  });

  it('sums the store up in words: plan with its price, its state, its payments, its orders', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(
      host,
      () =>
        host.querySelector('#page-overview')?.textContent?.includes('Starter, $29/month') === true,
    );
    const overview = host.querySelector('#page-overview')?.textContent ?? '';
    expect(overview).toContain('StatusSet up, not live yet');
    expect(overview).toContain('PaymentsLive payments');
    expect(overview).toContain('Paid orders this month0 of 2,000');
    expect(overview).not.toContain('mainnet');
    expect(overview).not.toContain(TENANT_ID);
    // The id is in Help, for support.
    expect(host.querySelector('#page-help')?.textContent).toContain(TENANT_ID);
    await unmount();
    const test = new FakeStore(storeState({ paid: true, name: 'Shop', network: 'devnet' }));
    const again = await admin(test.routes());
    await signIn(again.host, OwnerKey.create());
    await eventually(again.host, () => again.host.textContent?.includes('Test payments') === true);
  });

  it('Install with nothing to sell says so, and leads to the products', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Install');
    expect(openBody(host)).toContain('Nothing to install yet');
    const lead = [...(host.querySelector('#page-install')?.querySelectorAll('button') ?? [])].find(
      (each) => each.textContent === 'Add a product',
    );
    await act(async () => lead?.click());
    expect(host.querySelector<HTMLElement>('#page-products')?.hidden).toBe(false);
  });

  it('Settings are rows with no RPC to type; an own endpoint is named, kept as it was, and dropped by Use ours', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop', rails: ['solana'] }));
    const routes = store.routes();
    const own = 'https://rpc.merchant.example';
    const { host, calls } = await admin({
      ...routes,
      [`GET /tenants/${TENANT_ID}/store`]: () => {
        const answer = routes[`GET /tenants/${TENANT_ID}/store`];
        const given = typeof answer === 'function' ? answer(undefined) : answer;
        const body = given?.body !== null && typeof given?.body === 'object' ? given.body : {};
        const choice =
          'choice' in body && body.choice !== null && typeof body.choice === 'object'
            ? body.choice
            : {};
        return { body: { ...body, choice: { ...choice, solana: { rpcUrl: own } } } };
      },
    });
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(host, () => host.querySelector('input#store-name') !== null);
    expect(host.querySelector('input[id$="-rpc"]')).toBeNull();
    expect(host.textContent).not.toContain('Advanced');
    expect(host.querySelector('#page-settings')?.textContent).toContain(
      'Uses your own network endpoint.',
    );
    await fill(host, 'input#store-name', 'Shop two');
    await click(host, 'Save settings');
    const posts = () =>
      calls.filter((call) => call.method === 'POST' && call.path.endsWith('/store'));
    // Untouched, it goes back as it was.
    expect(posts()[0]?.body).toMatchObject({ name: 'Shop two', solana: { rpcUrl: own } });
    // Use ours drops it: the network runs on our endpoint.
    await click(host, 'Use ours');
    await click(host, 'Save settings');
    expect(posts()[1]?.body).toMatchObject({ name: 'Shop two', solana: {} });
    expect(JSON.stringify(posts()[1]?.body)).not.toContain(own);
  });

  it('a refusal is said in words at its field, the line as it came under Details', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop' }));
    const raw = 'webhookUrl: must be an https URL on a public host, with no user name or password';
    const { host } = await admin({
      ...store.routes(),
      [`POST /tenants/${TENANT_ID}/store`]: {
        status: 422,
        body: { error: 'store_refused', detail: `${raw}\nrelays.0: not a wss URL` },
      },
    });
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(host, () => host.querySelector('input#store-webhook') !== null);
    await click(host, 'Save settings');
    await eventually(host, () => host.querySelector('[data-problem-field="webhook"]') !== null);
    const webhookRow = host.querySelector('input#store-webhook')?.closest('div.grid');
    const shown = webhookRow?.querySelector('[data-problem-field="webhook"]');
    expect(shown?.querySelector('span')?.textContent).toBe(
      'Webhook: use an https address on a public server.',
    );
    expect(shown?.querySelector('details')?.textContent).toContain(raw);
    // A refusal of no field the form has: one sentence for the store, under the rows.
    expect(host.querySelector('[data-problem-field="store"] span')?.textContent).toContain(
      'The store could not take this change',
    );
  });
});

describe('a cloud store, its review fixes', () => {
  it('a name saved in the checklist shows in Settings, and a webhook save there keeps it and the rails', async () => {
    const store = new FakeStore(storeState({ paid: true, rails: ['solana'] }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('input#setup-store-name') !== null);
    await fill(host, 'input#setup-store-name', 'My shop');
    await click(host, 'Save and continue');
    store.keep();
    await click(host, 'Refresh');
    await eventually(
      host,
      () => host.querySelector<HTMLInputElement>('input#store-name')?.value === 'My shop',
    );
    await fill(host, 'input#store-webhook', 'https://shop.example/hook');
    await click(host, 'Save settings');
    const saved = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/store'));
    expect(saved.at(-1)?.body).toMatchObject({
      name: 'My shop',
      webhookUrl: 'https://shop.example/hook',
      solana: {},
    });
  });

  it('a store in retention says when payments close, to the minute, on Overview and Plan & billing', async () => {
    const payBy = 1_900_000_000;
    const store = new FakeStore(storeState({ payBy }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    const said = `Pay byPayments close at this time; after it the store is deleted.${shownTime(payBy)}`;
    await eventually(
      host,
      () => host.querySelector('#page-overview')?.textContent?.includes(said) === true,
    );
    expect(host.querySelector('#page-billing')?.textContent).toContain(said);
  });

  it('a store a partner pays for says so on Plan & billing too', async () => {
    const store = new FakeStore(readyState());
    const routes = store.routes();
    const { host } = await admin({
      ...routes,
      [`GET /tenants/${TENANT_ID}`]: () => {
        const answer = routes[`GET /tenants/${TENANT_ID}`];
        const given = typeof answer === 'function' ? answer(undefined) : answer;
        const body = given?.body !== null && typeof given?.body === 'object' ? given.body : {};
        return { body: { ...body, partner: { paidUntil: 1_900_000_000 } } };
      },
    });
    await signIn(host, OwnerKey.create());
    await eventually(
      host,
      () =>
        host.querySelector('#page-billing')?.textContent?.includes('Your partner pays until') ===
        true,
    );
  });

  it('an invited store waiting for its key says so on each step after it', async () => {
    const store = new FakeStore(storeState({ launch: 'operator' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).length > 0);
    const name = host.querySelector('li[data-step="name"]')?.textContent ?? '';
    expect(name).toContain('We are preparing your store: this takes a minute.');
    expect(name).not.toContain('Opens once your store is paid');
  });

  it('a row is a disclosure: its button opens it, and closes it again; paying heads under the list', async () => {
    const store = new FakeStore(storeState());
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => steps(host).length > 0);
    const pay = host.querySelector<HTMLButtonElement>('li[data-step="pay"] button');
    expect(pay?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('li[data-step="pay"] h3')?.textContent).toBe('Billing');
    expect(host.querySelector('li[data-step="pay"] h4')?.textContent).toBe('Card');
    await act(async () => pay?.click());
    expect(pay?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector<HTMLElement>('#step-body-pay')?.hidden).toBe(true);
    await act(async () => pay?.click());
    expect(host.querySelector<HTMLElement>('#step-body-pay')?.hidden).toBe(false);
  });

  it('Name your store from the payouts row puts focus in the name; a name kept moves it to the next step', async () => {
    const store = new FakeStore(storeState({ paid: true }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('input#setup-store-name') !== null);
    await openStep(host, 'Get paid to');
    await click(host, 'Name your store');
    expect(document.activeElement?.id).toBe('setup-store-name');
    await fill(host, 'input#setup-store-name', 'My shop');
    await click(host, 'Save and continue');
    store.keep();
    await eventually(host, () => steps(host).find((step) => step.current)?.key === 'payouts');
    await eventually(
      host,
      () => document.activeElement === host.querySelector('li[data-step="payouts"] button'),
    );
  });

  it('Launch: the news is in a live region there from the start, and takes the focus', async () => {
    const store = new FakeStore(readyState());
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, 'Launch the store'));
    const live = [...host.querySelectorAll('#page-overview [role="status"]')].find(
      (each) => each.textContent === '',
    );
    expect(live).not.toBeUndefined();
    await click(host, 'Launch the store');
    await eventually(host, () => live?.textContent?.startsWith('Your store is live') === true);
    expect(document.activeElement).toBe(live);
  });

  it('Settings fields name their help, and a refusal at a field marks it invalid', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop' }));
    const { host } = await admin({
      ...store.routes(),
      [`POST /tenants/${TENANT_ID}/store`]: {
        status: 422,
        body: { error: 'store_refused', detail: 'webhook.url: must be a URL' },
      },
    });
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(host, () => host.querySelector('input#store-webhook') !== null);
    const field = () => host.querySelector('input#store-webhook');
    expect(field()?.getAttribute('aria-describedby')).toBe('store-webhook-help');
    expect(document.getElementById('store-webhook-help')?.textContent).toContain('paid order');
    expect(field()?.getAttribute('aria-invalid')).toBeNull();
    await click(host, 'Save settings');
    await eventually(host, () => field()?.getAttribute('aria-invalid') === 'true');
    expect(field()?.getAttribute('aria-describedby')).toBe(
      'store-webhook-help store-webhook-problems',
    );
    expect(document.getElementById('store-webhook-problems')?.textContent).toContain('Webhook:');
  });

  it('a status that cannot be read says so with Try again, which reads it again', async () => {
    const store = new FakeStore(storeState());
    let fail = true;
    const routes = store.routes();
    const { host, calls } = await admin({
      ...routes,
      [`GET /tenants/${TENANT_ID}/status`]: () => {
        if (fail) {
          return { status: 503, body: { error: 'internal' } };
        }
        const answer = routes[`GET /tenants/${TENANT_ID}/status`];
        return typeof answer === 'function' ? answer(undefined) : (answer ?? { body: {} });
      },
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => hasButton(host, 'Try again'));
    fail = false;
    const before = calls.filter((call) => call.path.endsWith('/status')).length;
    await click(host, 'Try again');
    await eventually(host, () => steps(host).length > 0);
    expect(calls.filter((call) => call.path.endsWith('/status')).length).toBeGreaterThan(before);
  });

  it(
    'before launch, a status poll that ran out offers to read it again',
    { timeout: 20_000 },
    async () => {
      let skew = 0;
      const store = new FakeStore(storeState({ paid: true }));
      const { host, calls } = await admin(store.routes(), {
        cloudProps: { localNow: () => Math.floor(Date.now() / 1000) + skew },
      });
      await signIn(host, OwnerKey.create());
      await eventually(host, () => steps(host).length > 0);
      expect(hasButton(host, 'Read it again')).toBe(false);
      skew = 121;
      for (let attempt = 0; attempt < 80 && !hasButton(host, 'Read it again'); attempt += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
      }
      expect(hasButton(host, 'Read it again')).toBe(true);
      const before = calls.filter((call) => call.path.endsWith('/status')).length;
      await click(host, 'Read it again');
      await eventually(
        host,
        () => calls.filter((call) => call.path.endsWith('/status')).length > before,
      );
    },
  );
});

describe('a cloud store, its round-2 pins', () => {
  const statusReads = (calls: { method: string; path: string }[]) =>
    calls.filter((call) => call.method === 'GET' && call.path.endsWith('/status')).length;

  it('a step being typed in stays open when a read moves the list on, and closes once its save settles', async () => {
    const store = new FakeStore(storeState({ paid: true }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('input#setup-store-name') !== null);
    const body = () => host.querySelector<HTMLElement>('#step-body-name');
    await fill(host, 'input#setup-store-name', 'Typed');
    // Named elsewhere meanwhile: the list leads with the payouts now, the name stays open.
    store.state.name = 'Elsewhere';
    await click(host, 'Refresh');
    await eventually(host, () => steps(host).find((step) => step.current)?.key === 'payouts');
    expect(body()?.hidden).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input#setup-store-name')?.value).toBe('Typed');
    await click(host, 'Save the name');
    store.keep();
    await eventually(host, () => body()?.hidden === true);
  });

  it('a save on its own page reads the status again at once: Settings and Products', async () => {
    const store = new FakeStore(
      storeState({ paid: true, name: 'Shop', rails: ['solana'], payoutListId: 'f'.repeat(64) }),
    );
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(host, () => host.querySelector('input#store-name') !== null);
    const beforeSettings = statusReads(calls);
    await fill(host, 'input#store-webhook', 'https://shop.example/hook');
    await click(host, 'Save settings');
    await eventually(host, () => statusReads(calls) > beforeSettings);
    await openPage(host, 'Products');
    await eventually(host, () => hasButton(host, 'Add product'));
    await click(host, 'Add product');
    const id = host.querySelector('input[id$="-title"]')?.id ?? '';
    const product = id.replace(/-title$/, '');
    await fill(host, `input#${product}-title`, 'Mug');
    await fill(host, `input#${product}-price`, '5');
    const beforeProducts = statusReads(calls);
    await click(host, 'Save product');
    store.keep();
    await eventually(host, () => host.textContent?.includes('Saved.') === true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    // One read finds it kept; once kept, the page reads the status again at once (two in all).
    expect(statusReads(calls) - beforeProducts).toBeGreaterThanOrEqual(2);
  });

  it('after a Settings save, a later read still fills the fields nothing was typed in', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(host, () => host.querySelector('input#store-name') !== null);
    await fill(host, 'input#store-name', 'Shop two');
    await click(host, 'Save settings');
    store.keep();
    await eventually(host, () => host.textContent?.includes('Saved:') === true);
    // Renamed elsewhere since: the next read shows it.
    store.state.name = 'Renamed';
    await click(host, 'Refresh');
    await eventually(
      host,
      () => host.querySelector<HTMLInputElement>('input#store-name')?.value === 'Renamed',
    );
  });

  it('the plan with its price on Plan & billing, for the plan the store is on', async () => {
    for (const [tier, said] of [
      ['starter', 'Starter, $29/month'],
      ['business', 'Business, $99/month'],
    ] as const) {
      const store = new FakeStore(storeState({ paid: true, name: 'Shop', tier }));
      const { host } = await admin(store.routes());
      await signIn(host, OwnerKey.create());
      await eventually(
        host,
        () => host.querySelector('#page-billing')?.textContent?.includes(`Plan${said}`) === true,
      );
      expect(host.querySelector('#page-overview')?.textContent).toContain(`Plan${said}`);
      await unmount();
    }
  });

  it('a launched store whose status cannot be read is still said live', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host } = await admin({
      ...store.routes(),
      [`GET /tenants/${TENANT_ID}/status`]: { status: 503, body: { error: 'internal' } },
    });
    await signIn(host, OwnerKey.create());
    await eventually(
      host,
      () => host.querySelector('#page-overview')?.textContent?.includes('StatusLive') === true,
    );
    expect(host.querySelector('#page-overview')?.textContent).not.toContain('not live yet');
  });

  it('a refusal of the name marks the name field invalid', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop' }));
    const { host } = await admin({
      ...store.routes(),
      [`POST /tenants/${TENANT_ID}/store`]: {
        status: 422,
        body: { error: 'store_refused', detail: 'name: is required' },
      },
    });
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(host, () => host.querySelector('input#store-name') !== null);
    await click(host, 'Save settings');
    await eventually(
      host,
      () => host.querySelector('input#store-name')?.getAttribute('aria-invalid') === 'true',
    );
    expect(host.querySelector('input#store-name')?.getAttribute('aria-describedby')).toBe(
      'store-name-help store-name-problems',
    );
  });

  it('an own endpoint refused says to use ours; one that is ours says it is our side', async () => {
    const store = new FakeStore(storeState({ paid: true, name: 'Shop', rails: ['solana'] }));
    const routes = store.routes();
    let own = true;
    const { host } = await admin({
      ...routes,
      [`GET /tenants/${TENANT_ID}/store`]: () => {
        const answer = routes[`GET /tenants/${TENANT_ID}/store`];
        const given = typeof answer === 'function' ? answer(undefined) : answer;
        const body = given?.body !== null && typeof given?.body === 'object' ? given.body : {};
        const choice =
          'choice' in body && body.choice !== null && typeof body.choice === 'object'
            ? body.choice
            : {};
        return {
          body: {
            ...body,
            choice: { ...choice, solana: own ? { rpcUrl: 'https://rpc.mine.example' } : {} },
          },
        };
      },
      [`POST /tenants/${TENANT_ID}/store`]: {
        status: 422,
        body: { error: 'store_refused', detail: 'solana.rpcUrl: resolves to a private address' },
      },
    });
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(host, () => host.querySelector('input#store-name') !== null);
    await click(host, 'Save settings');
    await eventually(
      host,
      () => host.textContent?.includes('Your own Solana endpoint was refused') === true,
    );
    await unmount();
    own = false;
    const again = await admin({
      ...routes,
      [`POST /tenants/${TENANT_ID}/store`]: {
        status: 422,
        body: { error: 'store_refused', detail: 'solana.rpcUrl: resolves to a private address' },
      },
    });
    await signIn(again.host, OwnerKey.create());
    await openPage(again.host, 'Settings');
    await eventually(again.host, () => again.host.querySelector('input#store-name') !== null);
    await click(again.host, 'Save settings');
    await eventually(
      again.host,
      () => again.host.textContent?.includes('Solana is not available on our side yet') === true,
    );
    expect(again.host.textContent).not.toContain('Your own Solana endpoint');
  });
});

describe('a refused endpoint, said as of the settings it was for', () => {
  const OWN = 'https://rpc.mine.example';
  const REFUSED = 'solana.rpcUrl: resolves to a private address';
  const SAID = 'Your own Solana endpoint was refused: switch to ours in Settings (Use ours).';

  /**
   * A store whose kept Solana runs on its own endpoint, with these routes over
   * it; `waiting`: an edit still waiting to be kept, its Solana as given.
   */
  function ownEndpointStore(
    extra: Record<string, Answer> = {},
    refused: string[] | null = null,
    waiting: Record<string, unknown> | null = null,
  ) {
    const store = new FakeStore(
      storeState({ paid: true, name: 'Shop', rails: ['solana'], payoutListId: 'f'.repeat(64) }),
    );
    const routes = store.routes();
    return {
      store,
      routes: {
        ...routes,
        [`GET /tenants/${TENANT_ID}/store`]: () => {
          const answer = routes[`GET /tenants/${TENANT_ID}/store`];
          const given = typeof answer === 'function' ? answer(undefined) : answer;
          const body = given?.body !== null && typeof given?.body === 'object' ? given.body : {};
          const choice =
            'choice' in body && body.choice !== null && typeof body.choice === 'object'
              ? body.choice
              : {};
          return {
            body: {
              ...body,
              refused,
              choice: { ...choice, solana: { rpcUrl: OWN } },
              waitingChoice: waiting === null ? null : { ...choice, ...waiting },
            },
          };
        },
        ...extra,
      },
    };
  }
  const refusal: Answer = { status: 422, body: { error: 'store_refused', detail: REFUSED } };

  it('in Settings: Use ours after the refusal leaves the refusal said as it was', async () => {
    const { routes } = ownEndpointStore({ [`POST /tenants/${TENANT_ID}/store`]: refusal });
    const { host } = await admin(routes);
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(host, () => host.querySelector('input#store-name') !== null);
    await click(host, 'Save settings');
    const shown = () =>
      host.querySelector('#page-settings [data-problem-field="solana"] span')?.textContent;
    await eventually(host, () => shown() === SAID);
    await click(host, 'Use ours');
    expect(shown()).toBe(SAID);
  });

  it('in Settings: an edit refused as it ran is said of its own endpoint', async () => {
    const { routes } = ownEndpointStore({}, [REFUSED]);
    const { host } = await admin(routes);
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(
      host,
      () => host.textContent?.includes('refused when it was applied') === true,
    );
    expect(host.querySelector('#page-settings')?.textContent).toContain(SAID);
  });

  const OURS = 'Solana is not available on our side yet';

  it('in Settings: Use ours after an applied refusal leaves it said as it was', async () => {
    const { routes } = ownEndpointStore({}, [REFUSED]);
    const { host } = await admin(routes);
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(
      host,
      () => host.textContent?.includes('refused when it was applied') === true,
    );
    const applied = () =>
      host.querySelector('#page-settings [data-problem-field="solana"] span')?.textContent;
    expect(applied()).toBe(SAID);
    await click(host, 'Use ours');
    expect(applied()).toBe(SAID);
  });

  it('in Settings: an applied refusal is said of the waiting edit, not the kept one', async () => {
    // Kept with its own endpoint; the edit waiting dropped it: the refusal is of ours.
    const { routes } = ownEndpointStore({}, [REFUSED], { solana: {} });
    const { host } = await admin(routes);
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Settings');
    await eventually(
      host,
      () => host.textContent?.includes('refused when it was applied') === true,
    );
    const settings = host.querySelector('#page-settings')?.textContent ?? '';
    expect(settings).toContain(OURS);
    expect(settings).not.toContain(SAID);
  });

  it('in the payouts: a refusal is said of the waiting edit, not the kept one', async () => {
    const { routes } = ownEndpointStore({ [`POST /tenants/${TENANT_ID}/store`]: refusal }, null, {
      solana: {},
    });
    const { host } = await admin(routes);
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Payouts');
    await eventually(host, () => hasButton(host, 'Sign and save payouts'));
    await addSolanaPayout(host);
    await fill(host, 'select#payout-asset', BASE_USDC);
    await fill(host, 'input#payout-address', `0x${'ab'.repeat(20)}`);
    await click(host, 'Add');
    await click(host, 'Sign and save payouts');
    await eventually(
      host,
      () => host.querySelector('#page-payouts')?.textContent?.includes(OURS) === true,
    );
    expect(host.querySelector('#page-payouts')?.textContent).not.toContain(SAID);
  });

  it('in the name step: a refusal is said of the waiting edit, not the kept one', async () => {
    const store = new FakeStore(storeState({ paid: true }));
    const routes = store.routes();
    const { host } = await admin({
      ...routes,
      [`GET /tenants/${TENANT_ID}/store`]: () => {
        const answer = routes[`GET /tenants/${TENANT_ID}/store`];
        const given = typeof answer === 'function' ? answer(undefined) : answer;
        const body = given?.body !== null && typeof given?.body === 'object' ? given.body : {};
        // Kept with no own endpoint; the edit waiting names one: the refusal is of theirs.
        return {
          body: {
            ...body,
            choice: { name: '', solana: {} },
            waitingChoice: { name: '', solana: { rpcUrl: OWN } },
          },
        };
      },
      [`POST /tenants/${TENANT_ID}/store`]: refusal,
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('input#setup-store-name') !== null);
    await fill(host, 'input#setup-store-name', 'My shop');
    await click(host, 'Save and continue');
    await eventually(
      host,
      () => host.querySelector('#step-body-name')?.textContent?.includes(SAID) === true,
    );
  });

  it('in the name step: a rename refused for its own endpoint says to use ours', async () => {
    const store = new FakeStore(storeState({ paid: true }));
    const routes = store.routes();
    const { host } = await admin({
      ...routes,
      [`GET /tenants/${TENANT_ID}/store`]: () => {
        const answer = routes[`GET /tenants/${TENANT_ID}/store`];
        const given = typeof answer === 'function' ? answer(undefined) : answer;
        const body = given?.body !== null && typeof given?.body === 'object' ? given.body : {};
        return { body: { ...body, choice: { name: '', solana: { rpcUrl: OWN } } } };
      },
      [`POST /tenants/${TENANT_ID}/store`]: refusal,
    });
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('input#setup-store-name') !== null);
    await fill(host, 'input#setup-store-name', 'My shop');
    await click(host, 'Save and continue');
    await eventually(
      host,
      () => host.querySelector('#step-body-name')?.textContent?.includes(SAID) === true,
    );
  });

  it('in the payouts: a network turned on for a payout, refused for its own endpoint, says to use ours', async () => {
    const { routes } = ownEndpointStore({ [`POST /tenants/${TENANT_ID}/store`]: refusal });
    const { host } = await admin(routes);
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Payouts');
    await eventually(host, () => hasButton(host, 'Sign and save payouts'));
    await addSolanaPayout(host);
    await fill(host, 'select#payout-asset', BASE_USDC);
    await fill(host, 'input#payout-address', `0x${'ab'.repeat(20)}`);
    await click(host, 'Add');
    await click(host, 'Sign and save payouts');
    await eventually(
      host,
      () => host.querySelector('#page-payouts')?.textContent?.includes(SAID) === true,
    );
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

describe('the products page', () => {
  /** A ready store with `course`, on its Products page. */
  async function productsPage(routes?: (store: FakeStore) => Record<string, Answer>) {
    const store = new FakeStore(readyState());
    const { host, calls } = await admin(routes === undefined ? store.routes() : routes(store));
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Products');
    await eventually(host, () => host.querySelector('[aria-label="Edit Course"]') !== null);
    return { host, calls, store };
  }

  const dialog = (host: HTMLElement) => host.querySelector<HTMLElement>('[role="dialog"]');
  const editButton = (host: HTMLElement, label: string) => {
    const found = host.querySelector<HTMLButtonElement>(`[aria-label="Edit ${label}"]`);
    if (found === null) {
      throw new Error(`no Edit ${label}`);
    }
    return found;
  };
  const productPosts = (calls: { method: string; path: string; body: unknown }[]) =>
    calls.filter((call) => call.method === 'POST' && call.path.endsWith('/products'));
  async function closeSheet(host: HTMLElement) {
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')?.click(),
    );
  }
  /** Sets a textarea as a person would. */
  async function fillArea(host: HTMLElement, selector: string, value: string) {
    const area = host.querySelector(selector);
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error(`no ${selector}`);
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(area, value);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function press(target: Element, key: string, shiftKey = false) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
    });
  }

  it('lists each product with its price and on sale, and opens one in a modal sheet named by it', async () => {
    const { host } = await productsPage();
    const row = host.querySelector('li[data-product="course"]');
    expect(row?.textContent).toContain('Course');
    expect(row?.textContent).toContain('$10');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Course on sale"]')?.checked).toBe(
      true,
    );
    const opener = editButton(host, 'Course');
    await act(async () => {
      opener.focus();
      opener.click();
    });
    const sheet = dialog(host);
    expect(sheet?.getAttribute('aria-modal')).toBe('true');
    const labelledBy = sheet?.getAttribute('aria-labelledby') ?? '';
    expect(host.querySelector(`#${labelledBy}`)?.textContent).toBe('Course');
    // Focus starts in the sheet; the page behind it and the sidebar are inert.
    expect(sheet?.contains(document.activeElement)).toBe(true);
    expect(opener.closest('[inert]')).not.toBeNull();
    expect(host.querySelector('#store-sidebar')?.closest('[inert]')).not.toBeNull();
    expect(sheet?.closest('[inert]')).toBeNull();
    // No size counter.
    expect(sheet?.textContent).not.toContain('bytes');
  });

  it('keeps the focus inside the sheet: Tab from the last goes to the first, Shift+Tab back', async () => {
    const { host } = await productsPage();
    await act(async () => editButton(host, 'Course').click());
    const sheet = dialog(host);
    if (sheet === null) {
      throw new Error('no sheet');
    }
    const focusable = [
      ...sheet.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea'),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    last?.focus();
    await press(sheet, 'Tab');
    expect(document.activeElement).toBe(first);
    await press(sheet, 'Tab', true);
    expect(document.activeElement).toBe(last);
  });

  it('Escape with nothing changed closes it and gives the focus back to the row', async () => {
    const { host } = await productsPage();
    const opener = editButton(host, 'Course');
    await act(async () => {
      opener.focus();
      opener.click();
    });
    await press(dialog(host) as HTMLElement, 'Escape');
    expect(dialog(host)).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(editButton(host, 'Course'));
    expect(host.querySelector('[inert]')).toBeNull();
  });

  it('closing with a change asks first: Keep editing stays, Discard puts it back as it was', async () => {
    const { host, calls } = await productsPage();
    await act(async () => editButton(host, 'Course').click());
    const id = host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '';
    await fill(host, `input#${id}`, 'Course two');
    await closeSheet(host);
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Throw away your changes to this product?',
    );
    expect(document.activeElement?.textContent).toBe('Keep editing');
    await click(host, 'Keep editing');
    expect(dialog(host)).not.toBeNull();
    // Back in the sheet, on its first field: never on the page.
    expect(document.activeElement).toBe(host.querySelector(`input#${id}`));
    expect(host.querySelector<HTMLInputElement>(`input#${id}`)?.value).toBe('Course two');
    // Escape on the question is "keep editing" too.
    await press(dialog(host) as HTMLElement, 'Escape');
    await press(dialog(host) as HTMLElement, 'Escape');
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(dialog(host)?.contains(document.activeElement)).toBe(true);
    await press(dialog(host) as HTMLElement, 'Escape');
    await click(host, 'Discard changes');
    expect(dialog(host)).toBeNull();
    expect(host.querySelector('li[data-product="course"]')?.textContent).toContain('Course');
    expect(host.textContent).not.toContain('unsaved change');
    expect(productPosts(calls)).toEqual([]);
  });

  it('a new product left blank closes without asking, and is gone', async () => {
    const { host } = await productsPage();
    await click(host, 'Add product');
    expect(dialog(host)?.textContent).toContain('New product');
    await closeSheet(host);
    expect(dialog(host)).toBeNull();
    expect(host.querySelectorAll('li[data-product]')).toHaveLength(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement?.textContent).toBe('Add product');
  });

  it('a button id follows the title: product-N when the title has no Latin letter, -2 on a clash; changeable before the first save', async () => {
    const { host } = await productsPage();
    await click(host, 'Add product');
    const id = (host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '').replace(
      /-title$/,
      '',
    );
    await fill(host, `input#${id}-title`, 'Кофе');
    expect(host.querySelector(`#${id}-name-line`)?.textContent).toContain('Button id: product-1');
    await fill(host, `input#${id}-title`, 'Course');
    expect(host.querySelector(`#${id}-name-line`)?.textContent).toContain('Button id: course-2');
    expect(host.querySelector(`input#${id}-name`)).toBeNull();
    await click(host, 'Change');
    expect(document.activeElement).toBe(host.querySelector(`input#${id}-name`));
    await fill(host, `input#${id}-name`, 'my-course');
    expect(host.querySelector(`#${id}-name-line`)?.textContent).toContain('Button id: my-course');
  });

  it('a kept product shows its fixed button id, with no way to change it', async () => {
    const { host } = await productsPage();
    await act(async () => editButton(host, 'Course').click());
    const line = host.querySelector('[role="dialog"] [id$="-name-line"]');
    expect(line?.textContent).toContain('Button id: course');
    expect(line?.textContent).toContain('fixed once saved');
    expect(hasButton(host, 'Change')).toBe(false);
  });

  it("a new product given a kept product's id by hand is the one told to change it", async () => {
    const { host, calls } = await productsPage();
    await click(host, 'Add product');
    const id = (host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '').replace(
      /-title$/,
      '',
    );
    await fill(host, `input#${id}-title`, 'Mug');
    await fill(host, `input#${id}-price`, '5');
    await click(host, 'Change');
    await fill(host, `input#${id}-name`, 'course');
    expect(host.querySelector(`#${id}-name-error`)?.textContent).toBe(
      'Another product has the button id course.',
    );
    await click(host, 'Save product');
    expect(productPosts(calls)).toEqual([]);
    // The kept Course is not the one at fault: the sheet stays on the new one.
    expect(host.textContent).toContain('Fix this product first: Mug.');
    expect(host.querySelector(`input#${id}-name`)).not.toBeNull();
  });

  it('says what is wrong at the field, and sends nothing until it is fixed', async () => {
    const { host, calls } = await productsPage();
    await click(host, 'Add product');
    const id = (host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '').replace(
      /-title$/,
      '',
    );
    await fill(host, `input#${id}-title`, 'Mug');
    await fill(host, `input#${id}-price`, '0');
    const price = host.querySelector<HTMLInputElement>(`input#${id}-price`);
    expect(price?.getAttribute('aria-invalid')).toBe('true');
    expect(price?.getAttribute('aria-describedby')).toContain(`${id}-price-error`);
    expect(host.querySelector(`#${id}-price-error`)?.textContent).toContain(
      'A price in USD above 0',
    );
    await click(host, 'Save product');
    expect(productPosts(calls)).toEqual([]);
    expect(host.textContent).toContain('Fix this product first: Mug.');
    await fill(host, `input#${id}-price`, '5');
    expect(host.querySelector(`#${id}-price-error`)).toBeNull();
  });

  it("the store's refusal of one product is said at that product, in words", async () => {
    const { host } = await productsPage((store) => ({
      ...store.routes(),
      [`POST /tenants/${TENANT_ID}/products`]: () => ({
        status: 422,
        body: { error: 'store_refused', detail: 'products/course: price must be a decimal' },
      }),
    }));
    await act(async () => editButton(host, 'Course').click());
    const id = host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '';
    await fill(host, `input#${id}`, 'Course two');
    await click(host, 'Save product');
    await eventually(
      host,
      () => dialog(host)?.textContent?.includes('The product "course"') === true,
    );
    expect(dialog(host)?.textContent).toContain('check its title, price and description');
    expect(host.querySelector('li[data-product="course"]')?.textContent).toContain(
      'The product "course"',
    );
  });

  it('near the size limit says the room left; past it, the description is too long and nothing is sent', async () => {
    const { host, calls } = await productsPage();
    await act(async () => editButton(host, 'Course').click());
    const id = (host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '').replace(
      /-title$/,
      '',
    );
    const area = host.querySelector<HTMLTextAreaElement>(`textarea#${id}-description`);
    expect(host.querySelector(`#${id}-room`)).toBeNull();
    await fillArea(host, `textarea#${id}-description`, 'x'.repeat(3800));
    expect(host.querySelector(`#${id}-room`)?.textContent).toMatch(
      /^Almost full: room for about [\d,]+ more characters like these\.$/,
    );
    await fillArea(host, `textarea#${id}-description`, 'x'.repeat(4200));
    expect(host.querySelector(`#${id}-description-error`)?.textContent).toContain(
      'Too long: shorten the description.',
    );
    expect(area?.getAttribute('aria-invalid')).toBe('true');
    await click(host, 'Save product');
    expect(productPosts(calls)).toEqual([]);
  });

  it('turns a product off sale from the list, saved with the whole set', async () => {
    const { host, calls } = await productsPage();
    const toggle = host.querySelector<HTMLInputElement>('[aria-label="Course on sale"]');
    await act(async () => toggle?.click());
    expect(host.textContent).toContain('1 unsaved change');
    await click(host, 'Save 1 change');
    const body = productPosts(calls)[0]?.body;
    const products =
      body !== null && typeof body === 'object' && 'products' in body ? body.products : undefined;
    expect(JSON.stringify(products)).toContain('onSale: false');
  });

  it('Save product saves that product alone: a toggle in the list waits for its own save', async () => {
    const { host, calls } = await productsPage();
    await act(async () =>
      host.querySelector<HTMLInputElement>('[aria-label="Course on sale"]')?.click(),
    );
    await click(host, 'Add product');
    const id = (host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '').replace(
      /-title$/,
      '',
    );
    await fill(host, `input#${id}-title`, 'Mug');
    await fill(host, `input#${id}-price`, '5');
    await click(host, 'Save product');
    await eventually(host, () => productPosts(calls).length === 1);
    const body = productPosts(calls)[0]?.body;
    const products: Record<string, string> =
      body !== null && typeof body === 'object' && 'products' in body
        ? (body.products as Record<string, string>)
        : {};
    expect(Object.keys(products).sort()).toEqual(['course', 'mug']);
    // Course went as it is kept: still on sale.
    expect(products.course).not.toContain('onSale: false');
    await eventually(host, () => dialog(host) === null);
    expect(host.textContent).toContain('1 unsaved change');
  });

  it('Save product with nothing changed sends nothing and closes', async () => {
    const { host, calls } = await productsPage();
    await act(async () => editButton(host, 'Course').click());
    await click(host, 'Save product');
    await eventually(host, () => dialog(host) === null);
    expect(productPosts(calls)).toEqual([]);
  });

  it("a waiting product renamed to a kept product's id is a clash at its field, and nothing is sent", async () => {
    const text = '---\ntitle: "Course"\npriceUsd: "10"\n---\n\nA course.\n';
    const waiting = '---\ntitle: "Waiting"\npriceUsd: "3"\n---\n\nSoon.\n';
    const { host, calls } = await productsPage((store) => ({
      ...store.routes(),
      [`GET /tenants/${TENANT_ID}/store`]: () => ({
        body: {
          ...store.storeRead(),
          products: {},
          productNames: ['course'],
          waitingProducts: { course: text, waiting },
        },
      }),
    }));
    await act(async () => editButton(host, 'Waiting').click());
    const id = (host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '').replace(
      /-title$/,
      '',
    );
    // A product still waiting is not kept yet: its id can change.
    await click(host, 'Change');
    await fill(host, `input#${id}-name`, 'course');
    expect(host.querySelector(`#${id}-name-error`)?.textContent).toBe(
      'Another product has the button id course.',
    );
    await click(host, 'Save product');
    expect(productPosts(calls)).toEqual([]);
    expect(host.textContent).toContain('Fix this product first: Waiting.');
  });

  it('a new product given the id of one removed but not yet saved is a clash: saving it would overwrite that one', async () => {
    const { host, calls } = await productsPage();
    await act(async () => editButton(host, 'Course').click());
    await click(host, 'Remove course');
    await click(host, 'Add product');
    const id = (host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '').replace(
      /-title$/,
      '',
    );
    await fill(host, `input#${id}-title`, 'Mug');
    await fill(host, `input#${id}-price`, '5');
    await click(host, 'Change');
    await fill(host, `input#${id}-name`, 'course');
    await click(host, 'Save product');
    expect(productPosts(calls)).toEqual([]);
    expect(host.textContent).toContain('Fix this product first: Mug.');
  });

  it('a new product titled like one removed but still saved takes another id, and its typed clash shows at the id', async () => {
    const { host, calls } = await productsPage();
    await act(async () => editButton(host, 'Course').click());
    await click(host, 'Remove course');
    await click(host, 'Add product');
    const id = (host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '').replace(
      /-title$/,
      '',
    );
    await fill(host, `input#${id}-title`, 'Course');
    expect(host.querySelector(`#${id}-name-line`)?.textContent).toContain('Button id: course-2');
    await click(host, 'Change');
    await fill(host, `input#${id}-name`, 'course');
    expect(host.querySelector(`#${id}-name-error`)?.textContent).toBe(
      'Another product has the button id course.',
    );
    expect(productPosts(calls)).toEqual([]);
  });

  /** A launched store whose waiting set leaves out `old`, a product it published. */
  const leavesOutPublished = (store: FakeStore): Record<string, Answer> => ({
    ...store.routes(),
    [`GET /tenants/${TENANT_ID}/store`]: () => ({
      body: {
        ...store.storeRead(),
        products: {},
        productNames: ['course', 'old'],
        waitingProducts: { course: '---\ntitle: "Course"\npriceUsd: "10"\n---\n\nA course.\n' },
      },
    }),
  });

  it('a save that would leave out a published product is refused up front: from the list', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host, calls } = await admin(leavesOutPublished(store));
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Products');
    await eventually(host, () => host.querySelector('[aria-label="Course on sale"]') !== null);
    await act(async () =>
      host.querySelector<HTMLInputElement>('[aria-label="Course on sale"]')?.click(),
    );
    await click(host, 'Save 1 change');
    expect(host.textContent).toContain(
      'old is published: take it off sale instead of removing it.',
    );
    expect(productPosts(calls)).toEqual([]);
  });

  it('a save that would leave out a published product is refused up front: from the sheet', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host, calls } = await admin(leavesOutPublished(store));
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Products');
    await eventually(host, () => host.querySelector('[aria-label="Edit Course"]') !== null);
    await act(async () => editButton(host, 'Course').click());
    const id = host.querySelector('[role="dialog"] input[id$="-price"]')?.id ?? '';
    await fill(host, `input#${id}`, '12');
    await click(host, 'Save product');
    expect(dialog(host)?.textContent).toContain(
      'old is published: take it off sale instead of removing it.',
    );
    expect(productPosts(calls)).toEqual([]);
  });

  it('a waiting product given a free id is saved under it alone: its old id is gone', async () => {
    const text = '---\ntitle: "Course"\npriceUsd: "10"\n---\n\nA course.\n';
    const waiting = '---\ntitle: "Waiting"\npriceUsd: "3"\n---\n\nSoon.\n';
    const { host, calls } = await productsPage((store) => ({
      ...store.routes(),
      [`GET /tenants/${TENANT_ID}/store`]: () => ({
        body: {
          ...store.storeRead(),
          products: {},
          productNames: ['course'],
          waitingProducts: { course: text, waiting },
        },
      }),
    }));
    await act(async () => editButton(host, 'Waiting').click());
    const id = (host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '').replace(
      /-title$/,
      '',
    );
    await click(host, 'Change');
    await fill(host, `input#${id}-name`, 'soon');
    await click(host, 'Save product');
    await eventually(host, () => productPosts(calls).length === 1);
    const body = productPosts(calls)[0]?.body;
    const products =
      body !== null && typeof body === 'object' && 'products' in body ? body.products : {};
    expect(Object.keys(products ?? {}).sort()).toEqual(['course', 'soon']);
  });

  it('a waiting product opens with no clash on its own id', async () => {
    const text = '---\ntitle: "Course"\npriceUsd: "10"\n---\n\nA course.\n';
    const waiting = '---\ntitle: "Waiting"\npriceUsd: "3"\n---\n\nSoon.\n';
    const { host } = await productsPage((store) => ({
      ...store.routes(),
      [`GET /tenants/${TENANT_ID}/store`]: () => ({
        body: {
          ...store.storeRead(),
          products: {},
          productNames: ['course'],
          waitingProducts: { course: text, waiting },
        },
      }),
    }));
    await act(async () => editButton(host, 'Waiting').click());
    const id = (host.querySelector('[role="dialog"] input[id$="-title"]')?.id ?? '').replace(
      /-title$/,
      '',
    );
    expect(host.querySelector(`#${id}-name-line`)?.textContent).toContain('Button id: waiting');
    expect(host.querySelector(`#${id}-name-error`)).toBeNull();
    expect(host.querySelector(`input#${id}-name`)).toBeNull();
  });

  it('on a store not launched, a kept product removed is saved away, with no published line', async () => {
    const course = '---\ntitle: "Course"\npriceUsd: "10"\n---\n\nA course.\n';
    const mug = '---\ntitle: "Mug"\npriceUsd: "5"\n---\n\nA mug.\n';
    const store = new FakeStore(readyState({ products: { course, mug } }));
    const { host, calls } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Products');
    await eventually(host, () => host.querySelector('[aria-label="Edit Mug"]') !== null);
    await act(async () => editButton(host, 'Mug').click());
    await click(host, 'Remove mug');
    await click(host, 'Save 1 change');
    await eventually(host, () => productPosts(calls).length === 1);
    const body = productPosts(calls)[0]?.body;
    const products =
      body !== null && typeof body === 'object' && 'products' in body ? body.products : {};
    expect(Object.keys(products ?? {})).toEqual(['course']);
    expect(host.textContent).not.toContain('is published');
  });

  it('a launched store never offers to remove a published product', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live' }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await openPage(host, 'Products');
    await eventually(host, () => host.querySelector('[aria-label="Edit Course"]') !== null);
    await act(async () => editButton(host, 'Course').click());
    expect(dialog(host)?.textContent).toContain('Published: take it off sale to stop selling.');
    expect(hasButton(host, 'Remove course')).toBe(false);
  });

  it('offers a prompt for an agent to add many products: the whole set back, and what it holds', async () => {
    const { host } = await productsPage();
    const callout = host.querySelector('[aria-labelledby="products-agent-title"]');
    expect(callout?.textContent).toContain('Adding many products? Let your AI agent do it');
    expect(callout?.textContent).toContain('reads your access key file, so it can do anything');
    const prompt = callout?.querySelector('code')?.textContent ?? '';
    expect(prompt).toContain(
      'https://docs.elisym.network/commerce/cloud-agents#7-add-the-products',
    );
    expect(prompt).toContain('Read my current products first');
    expect(prompt).toContain('the call replaces every product');
  });
});

describe('the payouts form', () => {
  const PROVED_STORE = () =>
    new FakeStore(
      storeState({ paid: true, name: 'Shop', rails: ['solana'], payoutListId: 'f'.repeat(64) }),
    );

  /** The owner's list on the relays: USDC on Solana to a wallet that proved it agreed. */
  function provedList(owner: OwnerKey) {
    const secret = ed25519.utils.randomSecretKey();
    const address = base58.encode(ed25519.getPublicKey(secret));
    const signature = base58.encode(
      ed25519.sign(new TextEncoder().encode(paytoProofMessage(owner.pubkey, USDC)), secret),
    );
    const list = owner.sign({
      kind: 10133,
      created_at: Math.floor(Date.now() / 1000) - 3600,
      tags: [['accept', USDC, address, signature]],
      content: '',
    });
    return { list, address, signature };
  }

  function signedAccepts(calls: { method: string; path: string; body: unknown }[]): string[][] {
    const posted = calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/owner-events'),
    );
    const body = posted.at(-1)?.body;
    const list =
      body !== null && typeof body === 'object' && 'payoutList' in body
        ? (body.payoutList as NostrEvent)
        : undefined;
    return (list?.tags ?? []).filter((tag) => tag[0] === 'accept');
  }

  function assetOptions(host: HTMLElement): string[] {
    return [...host.querySelectorAll<HTMLOptionElement>('select#payout-asset option')]
      .map((option) => option.value)
      .filter((value) => value !== '');
  }

  it('offers only the coins with no payout yet, and says what a store needs', async () => {
    const owner = OwnerKey.create();
    const { list } = provedList(owner);
    const { host } = await admin(PROVED_STORE().routes(), { relays: [list] });
    await signIn(host, owner);
    await openPage(host, 'Payouts');
    await eventually(host, () => host.querySelector(`[data-payout="${USDC}"]`) !== null);
    expect(assetOptions(host)).not.toContain(USDC);
    expect(assetOptions(host).length).toBeGreaterThan(0);
    expect(host.textContent).toContain('A store needs a Solana or a Tempo payout');
    // An address added for another coin takes that coin out of the list too.
    await fill(host, 'select#payout-asset', BASE_USDC);
    await fill(host, 'input#payout-address', `0x${'ab'.repeat(20)}`);
    await click(host, 'Add');
    expect(assetOptions(host)).not.toContain(BASE_USDC);
    expect(host.querySelector(`[data-payout="${BASE_USDC}"]`)).not.toBeNull();
  });

  it('asks no wallet for anything: no proof buttons, no proof words', async () => {
    const owner = OwnerKey.create();
    const { list } = provedList(owner);
    const { host } = await admin(PROVED_STORE().routes(), { relays: [list] });
    await signIn(host, owner);
    await openPage(host, 'Payouts');
    await eventually(host, () => host.querySelector(`[data-payout="${USDC}"]`) !== null);
    const text = host.textContent ?? '';
    expect(text).not.toContain('with its wallet');
    expect(text).not.toContain('Prove with my wallet');
    expect(text).not.toContain('Add without the wallet');
    expect(text).not.toContain('verified by the wallet');
  });

  it('signs a row left as it was with its proof again', async () => {
    const owner = OwnerKey.create();
    const { list, address, signature } = provedList(owner);
    const { host, calls } = await admin(PROVED_STORE().routes(), { relays: [list] });
    await signIn(host, owner);
    await openPage(host, 'Payouts');
    await eventually(host, () => host.querySelector(`[data-payout="${USDC}"]`) !== null);
    await click(host, 'Sign and save payouts');
    await eventually(host, () => signedAccepts(calls).length > 0);
    expect(signedAccepts(calls)).toEqual([['accept', USDC, address, signature]]);
  });

  it('Replace leaves one row for the coin, with the new address and no proof', async () => {
    const owner = OwnerKey.create();
    const { list } = provedList(owner);
    const { host, calls } = await admin(PROVED_STORE().routes(), { relays: [list] });
    await signIn(host, owner);
    await openPage(host, 'Payouts');
    await eventually(host, () => host.querySelector(`[data-payout="${USDC}"]`) !== null);
    await click(host, 'Replace USDC on Solana');
    // The coin waits for its new address, which has the focus.
    expect(host.querySelector<HTMLSelectElement>('select#payout-asset')?.value).toBe(USDC);
    expect(document.activeElement?.id).toBe('payout-address');
    const fresh = base58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
    await fill(host, 'input#payout-address', fresh);
    await click(host, 'Replace USDC on Solana');
    expect(host.querySelectorAll(`[data-payout="${USDC}"]`)).toHaveLength(1);
    await click(host, 'Sign and save payouts');
    await eventually(host, () => signedAccepts(calls).length > 0);
    expect(signedAccepts(calls)).toEqual([['accept', USDC, fresh]]);
  });

  it('a coin with a payout cannot be added twice', async () => {
    const owner = OwnerKey.create();
    const { list } = provedList(owner);
    const { host } = await admin(PROVED_STORE().routes(), { relays: [list] });
    await signIn(host, owner);
    await openPage(host, 'Payouts');
    await eventually(host, () => host.querySelector(`[data-payout="${USDC}"]`) !== null);
    // Forced past the select, as a stale form could: refused in words.
    const select = host.querySelector<HTMLSelectElement>('select#payout-asset');
    const option = document.createElement('option');
    option.value = USDC;
    select?.append(option);
    await fill(host, 'select#payout-asset', USDC);
    await fill(host, 'input#payout-address', base58.encode(new Uint8Array(32).fill(7)));
    await click(host, 'Add');
    expect(host.textContent).toContain('There is already a payout in USDC on Solana: use Replace.');
    expect(host.querySelectorAll(`[data-payout="${USDC}"]`)).toHaveLength(1);
  });
});

describe('the payouts form, its review fixes', () => {
  const STORE = () =>
    new FakeStore(
      storeState({ paid: true, name: 'Shop', rails: ['solana'], payoutListId: 'f'.repeat(64) }),
    );
  const ALL = new Set(['solana', 'tempo', 'ethereum', 'arbitrum', 'base']);
  const LSM =
    payoutAssets('mainnet', ALL).find((asset) => asset.label === 'LSM on Solana')?.caip19 ?? '';
  const solanaAddress = () => base58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));

  function proved(owner: OwnerKey, caip19: string) {
    const secret = ed25519.utils.randomSecretKey();
    const address = base58.encode(ed25519.getPublicKey(secret));
    const signature = base58.encode(
      ed25519.sign(new TextEncoder().encode(paytoProofMessage(owner.pubkey, caip19)), secret),
    );
    return { address, signature };
  }

  function listOf(owner: OwnerKey, accepts: string[][]) {
    return owner.sign({
      kind: 10133,
      created_at: Math.floor(Date.now() / 1000) - 3600,
      tags: accepts.map((accept) => ['accept', ...accept]),
      content: '',
    });
  }

  function signedAccepts(calls: { method: string; path: string; body: unknown }[]): string[][] {
    const body = calls
      .filter((call) => call.method === 'POST' && call.path.endsWith('/owner-events'))
      .at(-1)?.body;
    const list =
      body !== null && typeof body === 'object' && 'payoutList' in body
        ? (body.payoutList as NostrEvent)
        : undefined;
    return (list?.tags ?? []).filter((tag) => tag[0] === 'accept');
  }

  const posts = (calls: { method: string; path: string }[]) =>
    calls.filter((call) => call.method === 'POST' && call.path.endsWith('/owner-events')).length;

  async function opened(owner: OwnerKey, relays: NostrEvent[] = []) {
    const opened = await admin(STORE().routes(), { relays });
    await signIn(opened.host, owner);
    await openPage(opened.host, 'Payouts');
    await eventually(opened.host, () => hasButton(opened.host, 'Sign and save payouts'));
    return opened;
  }

  it('a mixed-case EVM address with a wrong checksum is refused at the field; a right one is taken', async () => {
    const { host } = await opened(OwnerKey.create());
    await fill(host, 'select#payout-asset', BASE_USDC);
    // EIP-55's own example, one letter's case changed.
    await fill(host, 'input#payout-address', '0x5aAeb6053f3E94C9b9A09f33669435E7Ef1BeAed');
    await click(host, 'Add');
    const field = host.querySelector('input#payout-address');
    expect(host.querySelector('#payout-address-problem')?.textContent).toContain('has a typo');
    expect(field?.getAttribute('aria-invalid')).toBe('true');
    expect(field?.getAttribute('aria-describedby')).toBe('payout-address-problem');
    expect(host.querySelector(`[data-payout="${BASE_USDC}"]`)).toBeNull();
    await fill(host, 'input#payout-address', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    expect(host.querySelector('#payout-address-problem')).toBeNull();
    await click(host, 'Add');
    expect(host.querySelector(`[data-payout="${BASE_USDC}"]`)?.textContent).toContain(
      '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
    );
  });

  it('Replace waits in place: the old address shown, Cancel brings it back, signing waits', async () => {
    const owner = OwnerKey.create();
    const usdc = solanaAddress();
    const { host, calls } = await opened(owner, [listOf(owner, [[USDC, usdc]])]);
    await fill(host, 'input#payout-address', 'typed before');
    await click(host, 'Replace USDC on Solana');
    // What was typed for another payout is not carried into the new address.
    expect(host.querySelector<HTMLInputElement>('input#payout-address')?.value).toBe('');
    expect(host.querySelector(`[data-payout="${USDC}"]`)?.textContent).toContain(
      `Replacing: ${usdc}`,
    );
    await click(host, 'Sign and save payouts');
    expect(host.textContent).toContain('Finish replacing USDC on Solana, or cancel it');
    expect(posts(calls)).toBe(0);
    await click(host, 'Cancel replacing USDC on Solana');
    expect(host.querySelector(`[data-payout="${USDC}"]`)?.textContent).not.toContain('Replacing');
    expect(host.querySelector<HTMLSelectElement>('select#payout-asset')?.value).toBe('');
    await click(host, 'Sign and save payouts');
    await eventually(host, () => posts(calls) === 1);
    expect(signedAccepts(calls)).toEqual([['accept', USDC, usdc]]);
  });

  it('Replace on one row keeps the other, its proof and its place', async () => {
    const owner = OwnerKey.create();
    const first = proved(owner, USDC);
    const second = proved(owner, LSM);
    const { host, calls } = await opened(owner, [
      listOf(owner, [
        [USDC, first.address, first.signature],
        [LSM, second.address, second.signature],
      ]),
    ]);
    await click(host, 'Replace USDC on Solana');
    const fresh = solanaAddress();
    await fill(host, 'input#payout-address', fresh);
    await click(host, 'Replace USDC on Solana');
    await click(host, 'Sign and save payouts');
    await eventually(host, () => posts(calls) === 1);
    expect(signedAccepts(calls)).toEqual([
      ['accept', USDC, fresh],
      ['accept', LSM, second.address, second.signature],
    ]);
  });

  it('a list with no Solana or Tempo payout is not signed', async () => {
    const { host, calls } = await opened(OwnerKey.create());
    await fill(host, 'select#payout-asset', BASE_USDC);
    await fill(host, 'input#payout-address', `0x${'ab'.repeat(20)}`);
    await click(host, 'Add');
    await click(host, 'Sign and save payouts');
    expect(host.textContent).toContain('A store needs a Solana or a Tempo payout: add one');
    expect(posts(calls)).toBe(0);
  });

  it('signs Solana and Tempo payouts ahead of the EVM ones; after Add the coin choice resets', async () => {
    const { host, calls } = await opened(OwnerKey.create());
    await fill(host, 'select#payout-asset', BASE_USDC);
    await fill(host, 'input#payout-address', `0x${'ab'.repeat(20)}`);
    await click(host, 'Add');
    expect(host.querySelector<HTMLSelectElement>('select#payout-asset')?.value).toBe('');
    // Nothing chosen is nothing chosen: the last coin added is not taken again.
    await fill(host, 'input#payout-address', solanaAddress());
    await click(host, 'Add');
    expect(host.textContent).toContain('Choose what the payout is paid in.');
    const usdc = solanaAddress();
    await fill(host, 'select#payout-asset', USDC);
    await fill(host, 'input#payout-address', usdc);
    await click(host, 'Add');
    await click(host, 'Sign and save payouts');
    await eventually(host, () => posts(calls) === 1);
    expect(signedAccepts(calls).map((tag) => tag[1])).toEqual([USDC, BASE_USDC]);
  });

  it('every coin with a payout: no form, and how to change one', async () => {
    const owner = OwnerKey.create();
    const accepts = payoutAssets('mainnet', ALL).map((asset, index) => [
      asset.caip19,
      asset.caip19.startsWith('solana:')
        ? solanaAddress()
        : `0x${(index + 1).toString(16).padStart(40, '0')}`,
    ]);
    const { host } = await opened(owner, [listOf(owner, accepts)]);
    expect(host.querySelector('select#payout-asset')).toBeNull();
    expect(host.textContent).toContain('Every coin has a payout: use Replace to change one.');
  });

  it('the "signed and saved" line goes once the list is edited again', async () => {
    const owner = OwnerKey.create();
    const { host, calls } = await opened(owner, [listOf(owner, [[USDC, solanaAddress()]])]);
    await click(host, 'Sign and save payouts');
    await eventually(host, () => posts(calls) === 1);
    await eventually(host, () => host.textContent?.includes('Signed and saved') === true);
    await fill(host, 'select#payout-asset', LSM);
    await fill(host, 'input#payout-address', solanaAddress());
    await click(host, 'Add');
    expect(host.textContent).not.toContain('Signed and saved');
  });

  it('a Tempo payout alone is enough to sign', async () => {
    const tempo =
      payoutAssets('mainnet', ALL).find((asset) => asset.label === 'pathUSD on Tempo')?.caip19 ??
      '';
    const { host, calls } = await opened(OwnerKey.create());
    const address = `0x${'cd'.repeat(20)}`;
    await fill(host, 'select#payout-asset', tempo);
    await fill(host, 'input#payout-address', address);
    await click(host, 'Add');
    await click(host, 'Sign and save payouts');
    await eventually(host, () => posts(calls) === 1);
    expect(signedAccepts(calls)).toEqual([['accept', tempo, address]]);
    expect(host.textContent).not.toContain('A store needs a Solana or a Tempo payout: add one');
  });

  it('while a replace waits, the coin and every Remove are held; a stale "signed and saved" goes', async () => {
    const owner = OwnerKey.create();
    const { host, calls } = await opened(owner, [
      listOf(owner, [
        [USDC, solanaAddress()],
        [LSM, solanaAddress()],
      ]),
    ]);
    await click(host, 'Sign and save payouts');
    await eventually(host, () => posts(calls) === 1);
    await eventually(host, () => host.textContent?.includes('Signed and saved') === true);
    await click(host, 'Replace USDC on Solana');
    expect(host.textContent).not.toContain('Signed and saved');
    expect(host.querySelector<HTMLSelectElement>('select#payout-asset')?.disabled).toBe(true);
    expect(button(host, 'Remove LSM on Solana').disabled).toBe(true);
    await click(host, 'Cancel replacing USDC on Solana');
    expect(host.querySelector<HTMLSelectElement>('select#payout-asset')?.disabled).toBe(false);
    expect(button(host, 'Remove LSM on Solana').disabled).toBe(false);
  });

  it('what is not an address at all is said so, not called a typo', async () => {
    const { host } = await opened(OwnerKey.create());
    await fill(host, 'select#payout-asset', BASE_USDC);
    await fill(host, 'input#payout-address', 'Hello World');
    await click(host, 'Add');
    expect(host.querySelector('#payout-address-problem')?.textContent).toBe(
      'That is not an address USDC on Base can be paid to.',
    );
  });
});

/**
 * The cloud screens' words (plan `admin-onboarding.md` 2.10): none of these
 * reaches a merchant. Exceptions, stripped before the scan: the command a
 * self-hoster runs (the "I run it myself" answer). The sign-in page is shared
 * with self-hosted stores and keeps their words, so it is not scanned.
 */
const JARGON =
  /\b(owner keys?|tenants?|nsec|npub|nodes?|rails?|chains?|payout address(es)?|payout lists?|relays?|RPCs?|mainnet|devnet)\b/i;
const SELF_HOST_COMMANDS = /npx @elisym\/merchant-node [a-z-]+/g;
/** The snippet the merchant pastes is code: its attribute names the network as the widget reads it. */
const SNIPPET_NETWORK = /network="(mainnet|devnet)"/g;

function jargonIn(host: HTMLElement): string | undefined {
  // Each text node apart: textContent runs blocks together ("tenantOn"), hiding a word's end.
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    parts.push(node.textContent ?? '');
  }
  const text = parts.join(' ').replace(SELF_HOST_COMMANDS, '').replace(SNIPPET_NETWORK, '');
  const found = JARGON.exec(text);
  // The word with its surroundings, so a failure says where it is.
  return found === null ? undefined : text.slice(Math.max(0, found.index - 50), found.index + 50);
}

function expectNoJargon(host: HTMLElement) {
  const found = jargonIn(host);
  if (found !== undefined) {
    throw new Error(`jargon on screen: "${found}"`);
  }
}

describe('the words a merchant reads', () => {
  it('a text that is no key: the cloud names the key file, a self-hosted build the store key', async () => {
    const cloud = await admin({});
    await signIn(cloud.host, 'not a key');
    expect(cloud.host.querySelector('#store-key-error')?.textContent).toBe(
      'That is not a key: paste the line of your key file that starts with nsec1, or 64 hex characters.',
    );
    await unmount();
    const alone = await admin({}, { cloud: false });
    const field = alone.host.querySelector('input#store-key');
    if (!(field instanceof HTMLInputElement)) {
      throw new Error('no key field');
    }
    field.value = 'not a key';
    await click(alone.host, 'Open store');
    expect(alone.host.querySelector('#store-key-error')?.textContent).toBe(
      'That is not a secret key: paste an nsec or 64 hex characters.',
    );
  });

  it('the front page and the create flow use none of the jargon', async () => {
    const { host } = await admin({
      'GET /owner': { body: { tenantId: null, termsVersion: 't1' } },
    });
    await eventually(host, () => host.textContent?.includes('How it works') === true);
    expectNoJargon(host);
    await click(host, 'Create a store');
    await eventually(host, () => host.querySelector('button[data-tier="starter"]') !== null);
    expectNoJargon(host);
    await toKeyStep(host);
    expectNoJargon(host);
    await makeAndSaveKey(host);
    await eventually(host, () => hasButton(host, 'Create my store'));
    expectNoJargon(host);
  });

  it('a key with no store, a store not paid and a store set up use none of it', async () => {
    const none = await admin({ 'GET /owner': { body: { tenantId: null, termsVersion: 't1' } } });
    await signIn(none.host, OwnerKey.create());
    await eventually(none.host, () => none.host.textContent?.includes('Have an invite') === true);
    expectNoJargon(none.host);
    await unmount();

    const unpaid = new FakeStore(storeState());
    const first = await admin(unpaid.routes());
    await signIn(first.host, OwnerKey.create());
    await eventually(
      first.host,
      () => first.host.textContent?.includes('Getting started') === true,
    );
    expectNoJargon(first.host);
    await unmount();

    const ready = new FakeStore(readyState());
    const second = await admin(ready.routes());
    await signIn(second.host, OwnerKey.create());
    await eventually(
      second.host,
      () => second.host.textContent?.includes('Getting started') === true,
    );
    for (const page of ['Products', 'Payouts', 'Install', 'Settings', 'Plan & billing', 'Help']) {
      await openPage(second.host, page);
    }
    expectNoJargon(second.host);
  });

  it('a live store, on every page, uses none of it', async () => {
    const store = new FakeStore(readyState({ activated: true, runState: 'live', paidOrders: 3 }));
    const { host } = await admin(store.routes());
    await signIn(host, OwnerKey.create());
    await eventually(host, () => host.querySelector('[data-run-state="live"]') !== null);
    for (const page of [
      'Orders',
      'Products',
      'Payouts',
      'Install',
      'Settings',
      'Plan & billing',
      'Help',
      'Overview',
    ]) {
      await openPage(host, page);
    }
    expectNoJargon(host);
  });

  it('a store on test payments, set up and live, uses none of it', async () => {
    for (const activated of [false, true]) {
      const store = new FakeStore(
        readyState({ network: 'devnet', activated, runState: activated ? 'live' : 'not_launched' }),
      );
      const { host } = await admin(store.routes());
      await signIn(host, OwnerKey.create());
      await eventually(host, () => host.textContent?.includes('Test payments') === true);
      expectNoJargon(host);
      await unmount();
    }
  });

  it('the texts behind the confirmations, refusals and warnings use none of it', () => {
    const sale = Object.values(SALE).flatMap((value) =>
      typeof value === 'string' ? [value] : typeof value === 'object' ? Object.values(value) : [],
    );
    const refusals = Object.keys(EXPLAINED).flatMap((code) => [
      EXPLAINED[code] ?? '',
      cardRefusalText({ code, from: 1_900_000_000 }),
      cryptoRefusalText({ code }),
    ]);
    const decisions = [
      decisionText({ kind: 'wait', what: 'payout list', until: 1_900_000_000 }),
      decisionText({ kind: 'ahead', what: 'payout list', date: 1_900_000_000 }),
      decisionText({ kind: 'wait', what: 'revocation', until: 1_900_000_000 }),
      decisionText({ kind: 'ahead', what: 'revocation', date: 1_900_000_000 }),
    ];
    const problems = [
      'solana.rpcUrl: resolves to a private address',
      'solana.rpcUrl: the cloud has no RPC configured: name your own',
      'products/course: is 5000 bytes, over 4096',
      'name: Required',
    ].map((line) => problemText(line).text);
    const warning = renderToStaticMarkup(<KeyInUseWarning />);
    for (const text of [
      ...sale,
      ...refusals,
      ...decisions,
      ...problems,
      warning,
      READING_PAYOUTS,
      NETWORKS_NOT_ON,
    ]) {
      expect(JARGON.exec(String(text))?.[0], String(text)).toBeUndefined();
    }
  });

  it('an invited store, a store with an EVM network on, and the partner view use none of it', async () => {
    const invited = new FakeStore(readyState({ launch: 'operator' }));
    const first = await admin(invited.routes());
    await signIn(first.host, OwnerKey.create());
    await eventually(
      first.host,
      () => first.host.textContent?.includes('We launch this store') === true,
    );
    expectNoJargon(first.host);
    await unmount();

    const evm = new FakeStore(readyState({ rails: ['solana', 'base'] }));
    const second = await admin(evm.routes());
    await signIn(second.host, OwnerKey.create());
    await openPage(second.host, 'Settings');
    await eventually(second.host, () => second.host.querySelector('select') !== null);
    expectNoJargon(second.host);
    await unmount();

    const partner = await admin({
      'GET /owner': { status: 403, body: { error: 'forbidden' } },
      'GET /partner': {
        body: {
          partnerId: 'p000000000001',
          paidUntil: 1_900_000_000,
          volumeSince: 1_897_408_000,
          volume: { orders: 2, paid: { [USDC]: '3500000' } },
          merchants: [
            {
              tenantId: 'aaaaaaaaaaaa',
              tier: 'starter',
              tierName: 'Starter',
              network: 'mainnet',
              status: 'on_sale',
              activatedAt: 1_800_000_000,
              paidUntil: null,
              volume: { orders: 2, paid: { [USDC]: '3500000' } },
            },
            {
              tenantId: 'cccccccccccc',
              tier: 'starter',
              tierName: 'Starter',
              network: 'devnet',
              status: 'invited',
              activatedAt: null,
              paidUntil: null,
              volume: null,
            },
          ],
        },
      },
    });
    await signIn(partner.host, OwnerKey.create());
    // Both merchant rows are drawn, with their words.
    await eventually(
      partner.host,
      () => partner.host.textContent?.includes('cccccccccccc') === true,
    );
    expect(partner.host.textContent).toContain('aaaaaaaaaaaa');
    expectNoJargon(partner.host);
  });
});
