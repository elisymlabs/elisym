import { KIND_INBOX_RELAYS } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import * as nip19 from 'nostr-tools/nip19';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UNWRAPS_PER_LOAD } from '../../merchant-node/src/admin/reader';
import {
  D,
  T0,
  USDC_DEVNET_CAIP19,
  TX1,
  TX2,
  deliveredBody,
  key,
  message,
  orderBody,
  receiptBody,
} from '../../merchant-node/tests/admin/fixtures';
import { App } from '../src/App';
import { TxLink } from '../src/components/TxLink';
import { AdminSession, short } from '../src/lib/core';
import type { SessionDeps } from '../src/lib/core';
import { csvFileName } from '../src/lib/csv';
import { claimWindow } from '../src/lib/own-tab';
import { INBOX, fakeDeps, listing, relayClient, storeEvents } from './fakes';
import { type Mounted, buttonNamed, byId, mount, settle } from './mount';

const HOSTILE = '<img src=x onerror=alert(1)>';

let mounted: Mounted | undefined;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function keyInput(container: HTMLElement): HTMLInputElement {
  const input = byId(container, 'store-key');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('#store-key is not an input');
  }
  return input;
}

async function signIn(container: HTMLElement, value: string) {
  keyInput(container).value = value;
  await act(async () => buttonNamed(container, 'Open').click());
}

function statusText(container: HTMLElement): string {
  return container.querySelector('[role="status"]')?.textContent ?? '';
}

describe('sign in', () => {
  it('takes the key in a masked text field outside any form', async () => {
    mounted = await mount(
      <App
        ownTab
        createDeps={() =>
          fakeDeps(
            relayClient(() => []),
            [],
          )
        }
        leave={() => undefined}
      />,
    );
    const input = keyInput(mounted.container);
    expect(input.type).toBe('text');
    expect(input.className).toContain('masked');
    expect(input.closest('form')).toBeNull();
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });

  it('refuses what is not a key, and opens nothing', async () => {
    const createDeps = vi.fn(() =>
      fakeDeps(
        relayClient(() => []),
        [],
      ),
    );
    mounted = await mount(<App ownTab createDeps={createDeps} leave={() => undefined} />);
    await signIn(mounted.container, 'not a key');
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toMatch(
      /not a secret key/,
    );
    expect(keyInput(mounted.container).value).toBe('');
    expect(createDeps).not.toHaveBeenCalled();
  });

  it('shows no key field in a tab another page opened or framed', async () => {
    mounted = await mount(
      <App
        ownTab={false}
        createDeps={() =>
          fakeDeps(
            relayClient(() => []),
            [],
          )
        }
        leave={() => undefined}
      />,
    );
    expect(mounted.container.querySelector('#store-key')).toBeNull();
    expect(mounted.container.textContent).toMatch(/Open this page in its own tab/);
  });

  it('claims the window: clears its name, and refuses an opened or framed one', () => {
    const own = { name: 'from-another-page', opener: null } as unknown as Window;
    Object.assign(own, { top: own });
    expect(claimWindow(own)).toBe(true);
    expect(own.name).toBe('');
    const opened = { name: '', opener: {} } as unknown as Window;
    Object.assign(opened, { top: opened });
    expect(claimWindow(opened)).toBe(false);
    const framed = { name: '', opener: null, top: {} } as unknown as Window;
    expect(claimWindow(framed)).toBe(false);
  });
});

describe('the dashboard', () => {
  let storageWrites: string[];

  beforeEach(() => {
    storageWrites = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      vi.spyOn(storage, 'setItem').mockImplementation((name: string) => {
        storageWrites.push(name);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows orders, totals, every product, the store; untrusted text stays text; nothing is stored', async () => {
    const store = key();
    const owner = key();
    const buyer = key();
    const orderId = 'b3a7c2d4-0000-4000-8000-000000000001';
    const messages = [
      message(
        orderBody(store, orderId, { email: HOSTILE, customerRef: HOSTILE }),
        buyer.pubkey,
        store.pubkey,
      ),
      // The buyer also reports a second transaction: the node's credit is what shows.
      message(receiptBody(store, buyer, orderId, TX2), buyer.pubkey, store.pubkey, T0 + 90),
      message(
        deliveredBody(buyer, orderId, { caip19: USDC_DEVNET_CAIP19 }),
        store.pubkey,
        buyer.pubkey,
        T0 + 120,
      ),
    ];
    const events: NostrEvent[] = [
      ...storeEvents(store, owner, HOSTILE),
      listing(store, D, HOSTILE),
      listing(store, 'never-ordered', 'Never ordered'),
      listing(store, 'gone', 'Gone', 'sold-out'),
    ];
    const createDeps = vi.fn(
      (): SessionDeps =>
        fakeDeps(
          relayClient(() => events),
          messages,
        ),
    );
    const leave = vi.fn();
    const close = vi.spyOn(AdminSession.prototype, 'close');
    mounted = await mount(<App ownTab createDeps={createDeps} leave={leave} />);
    const { container } = mounted;
    const field = keyInput(container);
    await signIn(container, nip19.nsecEncode(store.secretKey));
    expect(field.value).toBe('');
    await settle(() => /^Read 3 order messages/.test(statusText(container)));
    expect(container.querySelector('#csv-partial')).toBeNull();

    expect(container.querySelector('img')).toBeNull();
    expect(byId(container, 'store-name').textContent).toBe(HOSTILE);
    const rows = byId(container, 'orders').querySelectorAll('tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain(HOSTILE);
    expect(rows[0]?.textContent).toContain('completed');
    expect(byId(container, 'totals').textContent).toContain('1 USDC');
    expect(byId(container, 'totals').textContent).toContain('Orders loaded1');
    expect(byId(container, 'totals').textContent).not.toContain('nothing credited yet');
    expect(rows[0]?.textContent).toContain(short(TX1));
    expect(rows[0]?.textContent).not.toContain(short(TX2));
    const link = byId(container, 'orders').querySelector('a');
    expect(link?.getAttribute('href')).toMatch(/^https:\/\//);
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');

    // The hosted admin reads every listing: one no order names is listed too.
    expect(byId(container, 'products').textContent).toContain('Never ordered');
    const productItems = [...byId(container, 'products').querySelectorAll('li')];
    const stateOf = (title: string) =>
      productItems.find((item) => item.textContent?.includes(title))?.textContent ?? '';
    expect(stateOf('Never ordered')).toContain('on sale');
    expect(stateOf('Gone')).toContain('sold out');
    expect(container.querySelector('#products-incomplete')).toBeNull();
    const storeInfo = byId(container, 'store').textContent ?? '';
    expect(storeInfo).toContain(INBOX);
    expect(storeInfo).toContain('solana-devnet');
    expect(storeInfo).toContain(HOSTILE);
    expect(storeInfo).not.toContain('no inbox list');

    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (blob instanceof Blob) {
        blobs.push(blob);
      }
      return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function record(this: HTMLAnchorElement) {
        clicked.push(this);
      },
    );
    await act(async () => buttonNamed(container, 'Download CSV').click());
    expect(blobs).toHaveLength(1);
    expect(clicked[0]?.download).toBe(csvFileName(store.pubkey, new Date()));
    expect(await blobs[0]?.text()).toContain(orderId);

    await act(async () => buttonNamed(container, 'Refresh').click());
    await settle(() => !buttonNamed(container, 'Refresh').disabled);
    expect(storageWrites).toEqual([]);
    expect(document.cookie).toBe('');

    await act(async () => buttonNamed(container, 'Log out').click());
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(leave.mock.invocationCallOrder[0] ?? 0);
    expect(leave).toHaveBeenCalledOnce();
  });

  it('says the product list may be incomplete when the relays hold more than it read', async () => {
    const store = key();
    const owner = key();
    const many = Array.from({ length: 300 }, (_, index) => listing(store, `p-${index}`));
    const events = [...storeEvents(store, owner), ...many];
    mounted = await mount(
      <App
        ownTab
        createDeps={() =>
          fakeDeps(
            relayClient(() => events),
            [],
          )
        }
        leave={() => undefined}
      />,
    );
    await signIn(mounted.container, nip19.nsecEncode(store.secretKey));
    await settle(() =>
      /^Read 0 order messages/.test(statusText(mounted?.container ?? document.body)),
    );
    expect(byId(mounted.container, 'products-incomplete').textContent).toMatch(
      /may have more products/,
    );
    expect(buttonNamed(mounted.container, 'Download CSV').disabled).toBe(true);
  });

  it('a transaction with no https explorer page is no link', async () => {
    const store = key();
    const owner = key();
    const buyer = key();
    const orderId = 'b3a7c2d4-0000-4000-8000-000000000002';
    const messages = [
      message(orderBody(store, orderId), buyer.pubkey, store.pubkey),
      message(deliveredBody(buyer, orderId), store.pubkey, buyer.pubkey, T0 + 120),
    ];
    const events = [...storeEvents(store, owner), listing(store, D)];
    mounted = await mount(
      <App
        ownTab
        createDeps={() =>
          fakeDeps(
            relayClient(() => events),
            messages,
          )
        }
        leave={() => undefined}
      />,
    );
    await signIn(mounted.container, nip19.nsecEncode(store.secretKey));
    await settle(() =>
      /^Read 2 order messages/.test(statusText(mounted?.container ?? document.body)),
    );
    expect(byId(mounted.container, 'orders').querySelector('a')).toBeNull();
  });

  it('stays on the dashboard after a failed first open, and Refresh reads again', async () => {
    const store = key();
    const owner = key();
    let failing = true;
    const events = [...storeEvents(store, owner), listing(store, D)];
    mounted = await mount(
      <App
        ownTab
        createDeps={() =>
          fakeDeps(
            relayClient(
              () => events,
              () => failing,
            ),
            [],
          )
        }
        leave={() => undefined}
      />,
    );
    const { container } = mounted;
    await signIn(container, nip19.nsecEncode(store.secretKey));
    await settle(() => statusText(container) === 'Could not read: relay down');
    const refresh = buttonNamed(container, 'Refresh');
    expect(refresh.disabled).toBe(false);
    failing = false;
    await act(async () => refresh.click());
    await settle(() => /^Read 0 order messages/.test(statusText(container)));
    expect(byId(container, 'store-name').textContent).toBe('Shop');
  });

  it('disables Refresh while a read runs, and says the CSV covers loaded orders only while history remains', async () => {
    const store = key();
    const owner = key();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events = [...storeEvents(store, owner), listing(store, D)];
    mounted = await mount(
      <App
        ownTab
        // A relay that ends its page without EOSE leaves history to load.
        createDeps={() =>
          fakeDeps(
            relayClient(() => events),
            [],
            { reason: 'relay closed', hold: () => hold },
          )
        }
        leave={() => undefined}
      />,
    );
    const { container } = mounted;
    await signIn(container, nip19.nsecEncode(store.secretKey));
    await settle(() => statusText(container) === 'Reading orders...');
    expect(buttonNamed(container, 'Refresh').disabled).toBe(true);
    release();
    await settle(() => /^Read 0 order messages/.test(statusText(container)));
    expect(buttonNamed(container, 'Refresh').disabled).toBe(false);
    expect(byId(container, 'csv-partial').textContent).toMatch(/loaded orders only/);
  });

  it('holds Load more history while a read runs', async () => {
    const store = key();
    const owner = key();
    let gate = Promise.resolve();
    let open: () => void = () => undefined;
    const events = [...storeEvents(store, owner), listing(store, D)];
    mounted = await mount(
      <App
        ownTab
        createDeps={() =>
          fakeDeps(
            relayClient(() => events),
            [],
            { reason: 'relay closed', hold: () => gate },
          )
        }
        leave={() => undefined}
      />,
    );
    const { container } = mounted;
    await signIn(container, nip19.nsecEncode(store.secretKey));
    await settle(() => /^Read 0 order messages/.test(statusText(container)));
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await act(async () => buttonNamed(container, 'Load more history').click());
    expect(buttonNamed(container, 'Load more history').disabled).toBe(true);
    expect(buttonNamed(container, 'Refresh').disabled).toBe(true);
    open();
    await settle(() => !buttonNamed(container, 'Load more history').disabled);
  });

  it('links a transaction only to an https explorer page', async () => {
    mounted = await mount(
      <>
        <TxLink tx="tx-a" explorer="javascript:alert(1)" />
        <TxLink tx="tx-b" explorer="http://explorer.example/tx" />
        <TxLink tx="tx-c" explorer="https://explorer.example/tx/c" />
      </>,
    );
    const links = mounted.container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://explorer.example/tx/c');
  });

  it('a Refresh forced while a read runs reads nothing and keeps the buttons held', async () => {
    const store = key();
    const owner = key();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const events = [...storeEvents(store, owner), listing(store, D)];
    const answering = relayClient(() => events);
    const client = {
      ...answering,
      query: (...args: Parameters<typeof answering.query>) => {
        reads += 1;
        return answering.query(...args);
      },
    };
    mounted = await mount(
      <App
        ownTab
        createDeps={() => fakeDeps(client, [], { hold: () => hold })}
        leave={() => undefined}
      />,
    );
    const { container } = mounted;
    await signIn(container, nip19.nsecEncode(store.secretKey));
    await settle(() => statusText(container) === 'Reading orders...');
    const readsBefore = reads;
    const refresh = buttonNamed(container, 'Refresh');
    // The handler React gave the disabled button, called the way a click it refuses never could.
    const propsKey = Object.keys(refresh).find((name) => name.startsWith('__reactProps'));
    const props: unknown = propsKey === undefined ? undefined : Reflect.get(refresh, propsKey);
    const onClick =
      typeof props === 'object' && props !== null ? Reflect.get(props, 'onClick') : undefined;
    if (typeof onClick !== 'function') {
      throw new Error('no React click handler on Refresh');
    }
    await act(async () => {
      onClick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(buttonNamed(container, 'Refresh').disabled).toBe(true);
    // The session answered busy: no store read started.
    expect(reads).toBe(readsBefore);
    release();
    await settle(() => /^Read 0 order messages/.test(statusText(container)));
    expect(buttonNamed(container, 'Refresh').disabled).toBe(false);
  });

  it('keeps what it showed when a Refresh fails, and says the store has no inbox list', async () => {
    const store = key();
    const owner = key();
    const buyer = key();
    const orderId = 'b3a7c2d4-0000-4000-8000-000000000003';
    let failing = false;
    const events = [...storeEvents(store, owner, 'Shop', false), listing(store, D)];
    const messages = [
      message(orderBody(store, orderId), buyer.pubkey, store.pubkey),
      // An order naming a product the store never listed.
      message(
        orderBody(store, 'b3a7c2d4-0000-4000-8000-000000000004', {
          items: [{ product: `30402:${store.pubkey}:unknown`, quantity: 1 }],
        }),
        buyer.pubkey,
        store.pubkey,
      ),
    ];
    mounted = await mount(
      <App
        ownTab
        createDeps={() =>
          fakeDeps(
            relayClient(
              () => events,
              () => failing,
            ),
            messages,
          )
        }
        leave={() => undefined}
      />,
    );
    const { container } = mounted;
    await signIn(container, nip19.nsecEncode(store.secretKey));
    await settle(() => /^Read 2 order messages/.test(statusText(container)));
    expect(byId(container, 'store').textContent).toContain('no inbox list');
    const warnings = byId(container, 'warnings').textContent ?? '';
    expect(warnings).toContain('No inbox list (kind 10050) found');
    expect(warnings).toContain('1 orders name products with no listing found');
    expect(byId(container, 'totals').textContent).toContain('nothing credited yet');
    failing = true;
    await act(async () => buttonNamed(container, 'Refresh').click());
    await settle(() => statusText(container) === 'Could not read: relay down');
    expect(byId(container, 'orders').querySelectorAll('tr')).toHaveLength(1);
  });

  it('loads older history with Load more, and exports it all', async () => {
    const store = key();
    const owner = key();
    const buyer = key();
    const orderIdOf = (index: number) =>
      `b3a7c2d4-0000-4000-8000-${index.toString().padStart(12, '0')}`;
    // One load opens at most MAX_UNWRAPS_PER_LOAD messages: the last order waits for Load more.
    const messages = Array.from({ length: MAX_UNWRAPS_PER_LOAD + 1 }, (_, index) =>
      message(orderBody(store, orderIdOf(index)), buyer.pubkey, store.pubkey),
    );
    const lastId = orderIdOf(MAX_UNWRAPS_PER_LOAD);
    const events = [...storeEvents(store, owner), listing(store, D)];
    const answering = relayClient(() => events);
    let storeReads = 0;
    const client = {
      ...answering,
      query: (...args: Parameters<typeof answering.query>) => {
        if (args[1].some((filter) => filter.kinds?.includes(KIND_INBOX_RELAYS) === true)) {
          storeReads += 1;
        }
        return answering.query(...args);
      },
    };
    mounted = await mount(
      <App ownTab createDeps={() => fakeDeps(client, messages)} leave={() => undefined} />,
    );
    const { container } = mounted;
    await signIn(container, nip19.nsecEncode(store.secretKey));
    await settle(() => /^Read 1000 order messages/.test(statusText(container)));
    expect(byId(container, 'orders').textContent).not.toContain(lastId);
    expect(byId(container, 'csv-partial').textContent).toMatch(/loaded orders only/);

    await act(async () => buttonNamed(container, 'Load more history').click());
    await settle(() => /^Read 1001 order messages/.test(statusText(container)));
    expect(byId(container, 'orders').textContent).toContain(lastId);
    expect(container.querySelector('#csv-partial')).toBeNull();
    // Older history only: the store is read once, at open (a Refresh would read it again).
    expect(storeReads).toBe(1);

    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (blob instanceof Blob) {
        blobs.push(blob);
      }
      return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await act(async () => buttonNamed(container, 'Download CSV').click());
    const csv = (await blobs[0]?.text()) ?? '';
    expect(csv).toContain(orderIdOf(0));
    expect(csv).toContain(lastId);
  });
});
