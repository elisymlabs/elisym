// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ChatClient } from '../src/client';
import { defineAskrElement } from '../src/ui/element';
import { FakeGateway, FakeRelay, MemoryStorage, makeStore, publishStore } from './fixtures';

// A file of its own: the element is defined once per window, with the first factory given.

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

describe('<askr-chat> after a move', () => {
  it('starts over as the store it moved to, once, keeping the panel open (K20)', async () => {
    const store = makeStore();
    const moved = makeStore({ assistant: store.assistant.pubkey });
    const relay = new FakeRelay();
    publishStore(relay, store);
    publishStore(relay, moved);
    const gateway = new FakeGateway(store.gatewayKey, store.assistant.pubkey);
    gateway.movedTo = moved.owner.pubkey;
    const owners: string[] = [];
    let client: ChatClient | undefined;
    defineAskrElement(window, (owner) => {
      owners.push(owner);
      client = new ChatClient({
        owner,
        connect: relay.connect,
        gateway,
        localStorage: new MemoryStorage(),
        sessionStorage: new MemoryStorage(),
        pageUrl: () => 'https://shop.example/',
      });
      return client;
    });
    const widget = document.createElement('askr-chat');
    widget.setAttribute('store', store.owner.pubkey);
    document.body.append(widget);
    widget.shadowRoot?.querySelector<HTMLButtonElement>('.launcher')?.click();
    await waitFor(() => client?.snapshot().phase === 'ready');
    expect(owners).toEqual([store.owner.pubkey, moved.owner.pubkey]);
    expect(gateway.sessions.map((session) => session.store)).toEqual([
      store.owner.pubkey,
      moved.owner.pubkey,
    ]);
    expect(widget.hasAttribute('open')).toBe(true);
  });
});
