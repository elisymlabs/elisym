// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatClient } from '../src/client';
import { WidgetView, defineAskrElement, parseStoreKey } from '../src/ui/element';
import {
  FakeGateway,
  FakeRelay,
  MAIN_RELAY,
  MemoryStorage,
  localSecs,
  makeStore,
  publishItem,
  publishStore,
  wrapFrom,
} from './fixtures';

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

afterEach(() => {
  Reflect.deleteProperty(window, 'Askr');
  document.body.replaceChildren();
});

describe('<askr-chat>', () => {
  it('hides "by Askr" only while the snapshot says the tier drops it', () => {
    const view = new WidgetView(
      document,
      () => undefined,
      () => undefined,
    );
    const footer = view.panel.querySelector<HTMLElement>('.footer');
    view.update({ phase: 'ready', branding: false, turns: [] });
    expect(footer?.hidden).toBe(true);
    view.update({ phase: 'ready', branding: true, turns: [] });
    expect(footer?.hidden).toBe(false);
  });

  it('parses npub and hex store keys', () => {
    const hex = 'a'.repeat(64);
    expect(parseStoreKey(hex)).toBe(hex);
    expect(parseStoreKey('npub1nope')).toBeUndefined();
    expect(parseStoreKey(null)).toBeUndefined();
  });

  it('renders in shadow DOM with adopted styles, the AI label, the name and by Askr, then an answer with a card', async () => {
    const store = makeStore({ displayName: 'Ava', avatar: 'https://cdn.example/ava.png' });
    const relay = new FakeRelay();
    publishStore(relay, store);
    publishItem(relay, store.catalogKey, {
      d: 'scarf',
      title: 'Wool scarf',
      price: { amount: '49.9', currency: 'USD' },
      url: 'https://shop.example/p/scarf',
      sku: 'SC-1',
    });
    const gateway = new FakeGateway(store.gatewayKey, store.assistant.pubkey);
    let client: ChatClient | undefined;
    defineAskrElement(window, (owner) => {
      client = new ChatClient({
        owner,
        connect: relay.connect,
        gateway,
        localStorage: new MemoryStorage(),
        sessionStorage: new MemoryStorage(),
      });
      return client;
    });
    const onAddToCart = vi.fn();
    Reflect.set(window, 'Askr', { onAddToCart });
    const widget = document.createElement('askr-chat');
    widget.setAttribute('store', store.owner.pubkey);
    document.body.append(widget);
    const shadow = widget.shadowRoot;
    if (!shadow) {
      throw new Error('no shadow root');
    }
    expect(shadow.adoptedStyleSheets).toHaveLength(1);
    expect(shadow.querySelector('style')).toBeNull();
    shadow.querySelector<HTMLButtonElement>('.launcher')?.click();
    await waitFor(() => client?.snapshot().phase === 'ready');
    expect(shadow.querySelector('.name')?.textContent).toBe('Ava');
    expect(shadow.querySelector('.ai')?.textContent).toBe('AI assistant');
    expect(shadow.querySelector('.footer')?.textContent).toBe('by Askr');
    expect(shadow.querySelector<HTMLElement>('.footer')?.hidden).toBe(false);
    expect(shadow.querySelector<HTMLImageElement>('.avatar')?.src).toBe(
      'https://cdn.example/ava.png',
    );

    const input = shadow.querySelector('input');
    const form = shadow.querySelector('form');
    if (!input || !form || !client) {
      throw new Error('composer missing');
    }
    input.value = 'a scarf please';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor(() => client?.snapshot().phase === 'waiting');
    expect(input.disabled).toBe(true);
    const askId = client.snapshot().inFlightAskId ?? '';
    relay.accept(
      MAIN_RELAY,
      wrapFrom(store.assistant, client.visitor.pubkey, {
        type: 'answer',
        ask_id: askId,
        session_end: localSecs() + 86_400,
        text: 'Try **this** <b>one</b>',
        components: [
          {
            type: 'products',
            picks: [{ address: `30402:${store.catalogKey.pubkey}:scarf`, reason: 'Warm' }],
          },
        ],
        chips: ['Cheaper?'],
      }),
    );
    await waitFor(() => shadow.querySelector('.card') !== null);
    expect(shadow.querySelector('.theirs strong')?.textContent).toBe('this');
    expect(shadow.querySelector('.theirs b')).toBeNull();
    const title = shadow.querySelector<HTMLAnchorElement>('a.card-title');
    expect(title?.href).toBe('https://shop.example/p/scarf');
    expect(shadow.querySelector('.price')?.textContent).toBe('49.90 USD');
    expect(shadow.querySelector('.chip')?.textContent).toBe('Cheaper?');
    shadow.querySelector<HTMLButtonElement>('.cart')?.click();
    expect(onAddToCart).toHaveBeenCalledWith({ d: 'scarf', sku: 'SC-1' });
    await waitFor(() => gateway.clicks.length === 1);
    client.stop();
  });
});
