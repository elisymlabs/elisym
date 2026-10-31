import * as nip19 from 'nostr-tools/nip19';
import type { NostrEvent } from 'nostr-tools/pure';
import { act } from 'react';
import { type Root as ReactRoot, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { key as makeKey } from '../../../merchant-node/tests/admin/fixtures';
import type { CloudProps } from '../../src/cloud/CloudApp';
import { OwnerKey } from '../../src/cloud/lib/owner-key';
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
  /** What the store-key reads on the relays answer (the sign-in's probe, the self-hosted admin). */
  storeRelays?: NostrEvent[];
  /** Every relay read fails. */
  relaysDown?: boolean;
  /** No relay read ever ends. */
  relaysHang?: boolean;
  /** The relay reads cannot even start. */
  depsThrow?: boolean;
  /** Closing the relay client throws. */
  closeThrows?: boolean;
  /** Each `GET /owner` is answered only once what this gives for it settles. */
  ownerGate?: () => Promise<void>;
}

/** The admin, its cloud part answered by `routes`. */
async function admin(routes: Record<string, Answer>, options: Options = {}) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const cloudApi = fakeCloud({ 'GET /tiers': { body: tiersAnswer() }, ...routes });
  const relays = options.relays ?? [];
  const relayClients = { opened: 0, closed: 0 };
  const { ownerGate } = options;
  const fetcher =
    ownerGate === undefined
      ? cloudApi.fetcher
      : async (request: Request) => {
          if (new URL(request.url).pathname === '/owner') {
            await ownerGate();
          }
          return cloudApi.fetcher(request);
        };
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
    fetcher,
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
          if (options.depsThrow === true) {
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
      />,
    ),
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
  await click(host, 'Sign in to your store');
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

describe('the front door', () => {
  it('offers a cloud store and one sign-in, under one heading', async () => {
    const { host } = await admin({});
    expect(host.querySelector('h1')?.textContent).toBe('Pay Core admin');
    expect([...host.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual([
      'Create a store in our cloud',
      'Sign in',
    ]);
    expect(hasButton(host, 'Create a store')).toBe(true);
    expect(hasButton(host, 'Sign in to your store')).toBe(true);
  });

  it('built with no cloud, it is the self-hosted sign-in alone, and asks no cloud', async () => {
    const { host, calls } = await admin({}, { cloud: false });
    expect(host.textContent).not.toContain('Create a store in our cloud');
    expect(host.querySelector('input#store-key')).not.toBeNull();
    expect(host.textContent).not.toContain('We ask our cloud');
    expect(calls).toEqual([]);
  });

  it('the one sign-in says which key it takes, and Back returns to the front door', async () => {
    const { host } = await admin({});
    await click(host, 'Sign in to your store');
    expect(host.textContent).toContain('For a store in our cloud, paste its owner key');
    expect(host.textContent).toContain('We ask our cloud whether this key runs a store there');
    await click(host, 'Back');
    expect(host.textContent).toContain('Create a store in our cloud');
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
    await click(host, 'Sign in with the key you saved');
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
    await eventually(host, () => host.querySelector('#store-name')?.textContent === 'Shop');
    // The cloud was asked once, by a request the key signed; nothing else of it was used.
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /owner']);
    expect(calls[0]?.signer).toBe(store.pubkey);
  });

  it('a cloud that does not answer leaves a self-hosted store to its relays', async () => {
    const store = makeKey();
    const { host } = await admin(
      { 'GET /owner': { status: 503, body: { error: 'internal' } } },
      { storeRelays: storeEvents(store, makeKey()) },
    );
    await signIn(host, nip19.nsecEncode(store.secretKey));
    await eventually(host, () => host.querySelector('#store-name')?.textContent === 'Shop');
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
    await eventually(host, () => host.textContent?.includes('Redeem an invite') === true);
    expect(host.textContent).toContain('the relays showed nothing for this key');
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
    await click(host, 'Create a new owner key');
    const made = close.mock.calls.length;
    await act(async () => owner.open());
    await eventually(host, () => close.mock.calls.length > made);
    // The route's key was closed; the key just made is still the one on screen.
    expect(host.textContent).toContain('Save your owner key');
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
    await click(host, 'Sign in to your store');
    expect(button(host, 'Open store').getAttribute('aria-disabled')).toBe('false');
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    await act(async () => owner.open());
    await pasteKey(host, OwnerKey.create());
    await eventually(host, () => host.textContent?.includes('Redeem an invite') === true);
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
    await click(host, 'Sign in to your store');
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
    await eventually(host, () => host.textContent?.includes('Redeem an invite') === true);
    expect(host.textContent).toContain('the relays showed nothing');
    await fill(host, 'input#invite', 'invite-1');
    await click(host, 'Redeem');
    await eventually(host, () => host.textContent?.includes('Redeem an invite') === false);
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
    await eventually(host, () => host.textContent?.includes('Redeem an invite') === true);
  });

  it('a relay read that fails counts as no store: with the cloud down, nothing opens', async () => {
    const store = makeKey();
    const { host, relayClients } = await admin(
      { 'GET /owner': { status: 503, body: { error: 'internal' } } },
      { storeRelays: storeEvents(store, makeKey()), relaysDown: true },
    );
    await signIn(host, nip19.nsecEncode(store.secretKey));
    await eventually(host, () => host.textContent?.includes('Our cloud is not answering') === true);
    expect(host.querySelector('#store-name')).toBeNull();
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
    await eventually(host, () => host.querySelector('#store-name')?.textContent === 'Shop');
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
    await click(host, 'Sign in to your store');
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
