// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatClient } from '../src/client';
import type { StoreCheck } from '../src/store-check';
import { HIDDEN_NOTICE, defineAskrElement } from '../src/ui/element';
import { FakeGateway, FakeRelay, MemoryStorage, makeStore, publishStore } from './fixtures';

// A file of its own: the element is defined once per window, here with a store check.

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

const current: {
  relay: FakeRelay;
  gateway: FakeGateway | undefined;
  visibility: Promise<StoreCheck>;
  client?: ChatClient;
} = {
  relay: new FakeRelay(),
  gateway: undefined,
  visibility: Promise.resolve({ visibility: 'show' }),
};
const checked: string[] = [];

defineAskrElement(
  window,
  (owner) => {
    const gateway = current.gateway;
    if (gateway === undefined) {
      throw new Error('no gateway set');
    }
    current.client = new ChatClient({
      owner,
      connect: current.relay.connect,
      gateway,
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      pageUrl: () => 'https://shop.example/',
    });
    return current.client;
  },
  (owner) => {
    checked.push(owner);
    return current.visibility;
  },
);

afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
  checked.splice(0);
  vi.restoreAllMocks();
});

function mount(owner: string): HTMLElement {
  const widget = document.createElement('askr-chat');
  widget.setAttribute('store', owner);
  document.body.append(widget);
  return widget;
}

const launcherOf = (widget: HTMLElement) =>
  widget.shadowRoot?.querySelector<HTMLButtonElement>('.launcher') ?? null;

describe('<askr-chat> for a store that is not active (B)', () => {
  it('shows nothing until the check answers, then the launcher for a live store', async () => {
    const store = makeStore();
    let answer: (check: StoreCheck) => void = () => undefined;
    current.visibility = new Promise((resolve) => {
      answer = resolve;
    });
    const widget = mount(store.owner.pubkey);
    expect(checked).toEqual([store.owner.pubkey]);
    expect(launcherOf(widget)).toBeNull();
    answer({ visibility: 'show' });
    await waitFor(() => launcherOf(widget) !== null);
  });

  it("puts the store's launcher text on before the launcher appears, with no chat client", async () => {
    let answer: (check: StoreCheck) => void = () => undefined;
    current.visibility = new Promise((resolve) => {
      answer = resolve;
    });
    current.client = undefined;
    const widget = mount(makeStore().owner.pubkey);
    const shadow = widget.shadowRoot;
    if (!shadow) {
      throw new Error('no shadow root');
    }
    const labelsAtReveal: Array<string | null | undefined> = [];
    const replace = shadow.replaceChildren.bind(shadow);
    vi.spyOn(shadow, 'replaceChildren').mockImplementation((...nodes) => {
      for (const node of nodes) {
        if (node instanceof HTMLElement && node.classList.contains('launcher')) {
          labelsAtReveal.push(node.querySelector('.launcher-label')?.textContent);
        }
      }
      replace(...nodes);
    });
    answer({ visibility: 'show', launcherText: 'Ask our stylist' });
    await waitFor(() => launcherOf(widget) !== null);
    expect(labelsAtReveal).toEqual(['Ask our stylist']);
    expect(launcherOf(widget)?.querySelector('.launcher-label')?.textContent).toBe(
      'Ask our stylist',
    );
    expect(current.client).toBeUndefined();
  });

  it('a pending store shows no launcher and no panel, and says so once in the console', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    current.visibility = Promise.resolve({ visibility: 'hide' });
    const widget = mount(makeStore().owner.pubkey);
    await waitFor(() => info.mock.calls.length > 0);
    expect(widget.shadowRoot?.childNodes).toHaveLength(0);
    expect(info.mock.calls).toEqual([[HIDDEN_NOTICE]]);
  });

  it('a check that fails shows the launcher: a transient error never hides a live store', async () => {
    current.visibility = Promise.reject(new Error('offline'));
    const widget = mount(makeStore().owner.pubkey);
    await waitFor(() => launcherOf(widget) !== null);
  });

  it('a store the opened chat finds not set up hides everything instead of a dead panel', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const store = makeStore();
    current.relay = new FakeRelay();
    const gateway = new FakeGateway(store.gatewayKey, store.assistant.pubkey);
    gateway.mode = 'unavailable';
    current.gateway = gateway;
    current.visibility = Promise.resolve({ visibility: 'show' });
    const widget = mount(store.owner.pubkey);
    await waitFor(() => launcherOf(widget) !== null);
    launcherOf(widget)?.click();
    await waitFor(() => info.mock.calls.length > 0);
    expect(widget.shadowRoot?.childNodes).toHaveLength(0);
    expect(widget.hasAttribute('open')).toBe(false);
    expect(widget.shadowRoot?.textContent ?? '').not.toContain('not set up');
  });

  it('an element taken off the page before the check answers renders nothing', async () => {
    let answer: (check: StoreCheck) => void = () => undefined;
    current.visibility = new Promise((resolve) => {
      answer = resolve;
    });
    const widget = mount(makeStore().owner.pubkey);
    widget.remove();
    answer({ visibility: 'show' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(widget.shadowRoot?.childNodes).toHaveLength(0);
  });

  it('says so in the console once, however often the element is hidden', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    current.visibility = Promise.resolve({ visibility: 'hide' });
    const widget = mount(makeStore().owner.pubkey);
    await waitFor(() => info.mock.calls.length > 0);
    widget.remove();
    document.body.append(widget);
    await waitFor(() => checked.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(widget.shadowRoot?.childNodes).toHaveLength(0);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('a hidden store forgets that its panel was left open in this tab', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const owner = makeStore().owner.pubkey;
    sessionStorage.setItem(`askr:open:${owner}`, '1');
    current.visibility = Promise.resolve({ visibility: 'hide' });
    mount(owner);
    await waitFor(() => sessionStorage.getItem(`askr:open:${owner}`) === null);
  });

  it('focus in a panel that goes away returns to what had it before the panel opened', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const store = makeStore();
    current.relay = new FakeRelay();
    const gateway = new FakeGateway(store.gatewayKey, store.assistant.pubkey);
    gateway.mode = 'unavailable';
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = gateway.openSession.bind(gateway);
    gateway.openSession = async (owner, visitor) => {
      await held;
      return open(owner, visitor);
    };
    current.gateway = gateway;
    current.visibility = Promise.resolve({ visibility: 'show' });
    const search = document.createElement('input');
    document.body.append(search);
    search.focus();
    const widget = mount(store.owner.pubkey);
    await waitFor(() => launcherOf(widget) !== null);
    launcherOf(widget)?.click();
    widget.shadowRoot?.querySelector<HTMLButtonElement>('.close')?.focus();
    expect(widget.shadowRoot?.activeElement).not.toBeNull();
    release();
    await waitFor(() => widget.shadowRoot?.childNodes.length === 0);
    expect(document.activeElement).toBe(search);
  });

  it('a live store opens and answers as before', async () => {
    const store = makeStore();
    current.relay = new FakeRelay();
    publishStore(current.relay, store);
    current.gateway = new FakeGateway(store.gatewayKey, store.assistant.pubkey);
    current.visibility = Promise.resolve({ visibility: 'show' });
    const widget = mount(store.owner.pubkey);
    await waitFor(() => launcherOf(widget) !== null);
    launcherOf(widget)?.click();
    await waitFor(() => current.client?.snapshot().phase === 'ready');
    expect(widget.hasAttribute('open')).toBe(true);
  });
});
