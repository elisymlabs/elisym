// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ElisymBuy } from '../src/embed/v1/embed';
import { decodeCheckoutParams, encodeCheckoutParams } from '../src/embed/v1/protocol';

const ORIGIN = 'https://pay.test';
const NADDR = 'naddr1qqtestproduct';

beforeAll(async () => {
  await import('../src/embed/v1/embed');
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** The framed checkout's window, as the page sees it: something to post to. */
interface FakeFrameWindow {
  postMessage: (message: unknown, origin: string) => void;
  posted: [unknown, string][];
}

function fakeFrameWindow(): FakeFrameWindow {
  const posted: [unknown, string][] = [];
  return { posted, postMessage: (message, origin) => posted.push([message, origin]) };
}

function mount(attributes: Record<string, string> = {}): {
  element: HTMLElement;
  frame: HTMLIFrameElement;
  target: FakeFrameWindow;
} {
  const target = fakeFrameWindow();
  // The iframe is not loaded in tests: its window is a stand-in the element posts to.
  const created = document.createElement.bind(document);
  const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const made = created(tag);
    if (tag === 'iframe') {
      Object.defineProperty(made, 'contentWindow', { get: () => target, configurable: true });
    }
    return made;
  }) as typeof document.createElement);
  const element = document.createElement('elisym-buy');
  element.setAttribute('product', NADDR);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.appendChild(element);
  spy.mockRestore();
  const frame = element.querySelector('iframe');
  if (frame === null) {
    throw new Error('no iframe');
  }
  return { element, frame, target };
}

/** A message as the page would receive it from `source` at `origin`. */
function deliver(data: unknown, origin: string, source: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', { data, origin, source: source as MessageEventSource }),
  );
}

describe('the checkout parameters', () => {
  it('round-trip through the fragment, and a fragment without a product is nothing', () => {
    const params = {
      naddr: NADDR,
      network: 'devnet' as const,
      strictOrigin: true,
      theme: 'dark' as const,
      collectEmail: true,
    };
    expect(decodeCheckoutParams(`#${encodeCheckoutParams(params)}`)).toEqual(params);
    expect(decodeCheckoutParams('#naddr=npub1x')).toBeUndefined();
    expect(decodeCheckoutParams('#network=devnet')).toBeUndefined();
    // Anything unknown falls back to the defaults.
    expect(decodeCheckoutParams(`naddr=${NADDR}&network=moon&theme=neon&strict=yes`)).toEqual({
      naddr: NADDR,
      strictOrigin: false,
      theme: 'auto',
      collectEmail: false,
    });
  });
});

describe('<elisym-buy>', () => {
  it('frames the checkout on its own origin, with the product in the fragment only', () => {
    const { frame } = mount({ network: 'devnet', 'strict-origin': '' });
    const url = new URL(frame.src);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe('/checkout');
    expect(url.search).toBe('');
    expect(decodeCheckoutParams(url.hash)).toMatchObject({
      naddr: NADDR,
      network: 'devnet',
      strictOrigin: true,
    });
  });

  it('frames nothing without a product naddr', () => {
    const element = document.createElement('elisym-buy');
    element.setAttribute('product', 'npub1notaproduct');
    document.body.appendChild(element);
    expect(element.querySelector('iframe')).toBeNull();
  });

  it('says hello to the checkout origin until it hears the ack', () => {
    vi.useFakeTimers();
    const { target } = mount();
    const posted = target.posted;
    vi.advanceTimersByTime(1000);
    expect(posted.length).toBeGreaterThan(1);
    expect(
      posted.every(
        ([message, origin]) => origin === ORIGIN && (message as { type: string }).type === 'hello',
      ),
    ).toBe(true);
    deliver({ type: 'ack' }, ORIGIN, target);
    const count = posted.length;
    vi.advanceTimersByTime(2000);
    expect(posted).toHaveLength(count);
  });

  it('hears only its own frame on the checkout origin, and relays a known state only', () => {
    const { element, target } = mount();
    const states: unknown[] = [];
    element.addEventListener('elisym-status', (event) => {
      states.push((event as CustomEvent<{ state: string }>).detail);
    });
    deliver({ type: 'status', state: 'paid' }, ORIGIN, target);
    // Another origin, another window, an unknown state, a smuggled field: nothing.
    deliver({ type: 'status', state: 'completed' }, 'https://evil.example', target);
    deliver({ type: 'status', state: 'completed' }, ORIGIN, window);
    deliver({ type: 'status', state: 'https://secret.link' }, ORIGIN, target);
    deliver(
      { type: 'status', state: 'completed', delivery: 'https://secret.link' },
      ORIGIN,
      target,
    );
    expect(states).toEqual([{ state: 'paid' }, { state: 'completed' }]);
  });

  it('resizes within bounds', () => {
    const { frame, target } = mount();
    deliver({ type: 'resize', height: 480.2 }, ORIGIN, target);
    expect(frame.style.height).toBe('481px');
    deliver({ type: 'resize', height: 1e9 }, ORIGIN, target);
    expect(frame.style.height).toBe('2000px');
    deliver({ type: 'resize', height: -5 }, ORIGIN, target);
    expect(frame.style.height).toBe('120px');
    deliver({ type: 'resize', height: Number.NaN }, ORIGIN, target);
    expect(frame.style.height).toBe('120px');
  });

  it('stops listening once removed', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const { element } = mount();
    const listener = added.mock.calls.find(([type]) => type === 'message')?.[1];
    element.remove();
    const removedIt = removed.mock.calls.some(
      ([type, handler]) => type === 'message' && handler === listener,
    );
    added.mockRestore();
    removed.mockRestore();
    expect(listener).toBeDefined();
    // The very listener it added is the one it removed.
    expect(removedIt).toBe(true);
    expect(element.querySelector('iframe')).toBeNull();
  });

  it('ignores a message with no source, even while its frame has no window', () => {
    const { element, frame } = mount();
    const states: unknown[] = [];
    element.addEventListener('elisym-status', () => states.push('heard'));
    // A detached frame has no window: null must not match null.
    Object.defineProperty(frame, 'contentWindow', { get: () => null });
    deliver({ type: 'status', state: 'paid' }, ORIGIN, null);
    expect(states).toEqual([]);
  });

  it('frames the product once it is set after insertion', () => {
    const element = document.createElement('elisym-buy');
    document.body.appendChild(element);
    expect(element.querySelector('iframe')).toBeNull();
    element.setAttribute('product', NADDR);
    expect(element.querySelector('iframe')).not.toBeNull();
    // A changed product replaces the frame (an app reusing the element).
    element.setAttribute('product', 'naddr1other');
    const frames = element.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(decodeCheckoutParams(new URL(frames[0]?.src ?? '').hash)?.naddr).toBe('naddr1other');
  });

  it('frames anew when what the checkout receives changes, and only then', () => {
    const element = document.createElement('elisym-buy');
    document.body.appendChild(element);
    element.setAttribute('product', NADDR);
    // Set after the product: strict-origin must still reach the checkout.
    element.setAttribute('strict-origin', '');
    element.setAttribute('network', 'devnet');
    const frame = element.querySelector('iframe');
    expect(decodeCheckoutParams(new URL(frame?.src ?? '').hash)).toMatchObject({
      strictOrigin: true,
      network: 'devnet',
    });
    // The same value again, or an unknown theme that changes nothing: the same frame.
    element.setAttribute('product', NADDR);
    element.setAttribute('theme', 'neon');
    expect(element.querySelector('iframe')).toBe(frame);
    // No product: no frame. The same product back: a frame again.
    element.removeAttribute('product');
    expect(element.querySelector('iframe')).toBeNull();
    element.setAttribute('product', NADDR);
    expect(element.querySelector('iframe')).not.toBeNull();
  });

  it('frames again after page code cleared its children', () => {
    const { element } = mount();
    element.innerHTML = '';
    element.setAttribute('product', NADDR);
    expect(element.querySelectorAll('iframe')).toHaveLength(1);
  });

  it("never lets a dropped frame's load stop the current frame's hello", () => {
    vi.useFakeTimers();
    const { element, frame: old } = mount();
    element.innerHTML = '';
    element.setAttribute('product', 'naddr1other');
    const current = element.querySelector('iframe');
    if (current === null) {
      throw new Error('no iframe');
    }
    const hellos: string[] = [];
    Object.defineProperty(current, 'contentWindow', {
      get: () => ({ postMessage: () => hellos.push('hello') }),
      configurable: true,
    });
    // Page code re-inserts the old frame elsewhere, and it loads.
    document.body.appendChild(old);
    old.dispatchEvent(new Event('load'));
    const before = hellos.length;
    vi.advanceTimersByTime(1_000);
    expect(hellos.length).toBeGreaterThan(before);
  });

  it('frames once when upgrading an element already in the page', async () => {
    const element = document.createElement('elisym-buy-late');
    element.setAttribute('product', NADDR);
    document.body.appendChild(element);
    const { ElisymBuy } = await import('../src/embed/v1/embed');
    customElements.define('elisym-buy-late', class extends (ElisymBuy as typeof ElisymBuy) {});
    expect(element.querySelectorAll('iframe')).toHaveLength(1);
    expect((element as ElisymBuy).isConnected).toBe(true);
  });

  it('says hello again after each load of the checkout, however late', () => {
    vi.useFakeTimers();
    const { frame, target } = mount();
    // Long past the first window, the checkout document finally loads.
    vi.advanceTimersByTime(30_000);
    const before = target.posted.length;
    vi.advanceTimersByTime(1_000);
    expect(target.posted).toHaveLength(before);
    frame.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(1_000);
    expect(target.posted.length).toBeGreaterThan(before);
  });
});
