// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { ChatClient } from '../src/client';
import { defineAskrElement } from '../src/ui/element';
import { FakeGateway, FakeRelay, MemoryStorage, makeStore, publishStore } from './fixtures';

// A file of its own: the element is defined once per window, with the first factory given, so
// that factory reads the relay and gateway each test sets here.

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

const current: { relay: FakeRelay; gateway: FakeGateway | undefined; client?: ChatClient } = {
  relay: new FakeRelay(),
  gateway: undefined,
};
const owners: string[] = [];

defineAskrElement(window, (owner) => {
  const gateway = current.gateway;
  if (gateway === undefined) {
    throw new Error('no gateway set');
  }
  owners.push(owner);
  current.client = new ChatClient({
    owner,
    connect: current.relay.connect,
    gateway,
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    pageUrl: () => 'https://shop.example/',
  });
  return current.client;
});

afterEach(() => {
  document.body.replaceChildren();
  owners.splice(0);
});

function open(owner: string): HTMLElement {
  const widget = document.createElement('askr-chat');
  widget.setAttribute('store', owner);
  document.body.append(widget);
  widget.shadowRoot?.querySelector<HTMLButtonElement>('.launcher')?.click();
  return widget;
}

describe('<askr-chat> after a move (K21)', () => {
  it('starts over as the store it moved to, keeping the panel open', async () => {
    const store = makeStore();
    const moved = makeStore({ assistant: store.assistant.pubkey });
    current.relay = new FakeRelay();
    publishStore(current.relay, store);
    publishStore(current.relay, moved);
    const gateway = new FakeGateway(store.gatewayKey, store.assistant.pubkey);
    gateway.movedTo = moved.owner.pubkey;
    current.gateway = gateway;
    const widget = open(store.owner.pubkey);
    await waitFor(() => current.client?.snapshot().phase === 'ready');
    expect(owners).toEqual([store.owner.pubkey, moved.owner.pubkey]);
    expect(gateway.sessions.map((session) => session.store)).toEqual([
      store.owner.pubkey,
      moved.owner.pubkey,
    ]);
    expect(widget.hasAttribute('open')).toBe(true);
  });

  it('follows one move per page at most', async () => {
    const store = makeStore();
    const second = makeStore({ assistant: store.assistant.pubkey });
    const third = makeStore({ assistant: store.assistant.pubkey });
    current.relay = new FakeRelay();
    for (const each of [store, second, third]) {
      publishStore(current.relay, each);
    }
    const gateway = new FakeGateway(store.gatewayKey, store.assistant.pubkey);
    gateway.moves.set(store.owner.pubkey, second.owner.pubkey);
    gateway.moves.set(second.owner.pubkey, third.owner.pubkey);
    current.gateway = gateway;
    open(store.owner.pubkey);
    await waitFor(() => owners.length === 2 && current.client?.snapshot().phase === 'moved');
    expect(owners).toEqual([store.owner.pubkey, second.owner.pubkey]);
  });
});
