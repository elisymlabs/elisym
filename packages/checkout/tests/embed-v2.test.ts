// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeCheckoutParams } from '../src/embed/protocol';
import { encodeCheckoutParams as encodeV1 } from '../src/embed/v1/protocol';
import type { ElisymBuy } from '../src/embed/v2/embed';

const ORIGIN = 'https://pay.test';
const NADDR = 'naddr1qqtestproduct';

beforeAll(async () => {
  await import('../src/embed/v2/embed');
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface FakeFrameWindow {
  postMessage: (message: unknown, origin: string) => void;
  posted: [unknown, string][];
}

function fakeFrameWindow(): FakeFrameWindow {
  const posted: [unknown, string][] = [];
  return { posted, postMessage: (message, origin) => posted.push([message, origin]) };
}

/** Every iframe made from now on gets a stand-in window, kept in `windows` by frame. */
const windows = new Map<HTMLIFrameElement, FakeFrameWindow>();

function standInWindows(): void {
  const created = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const made = created(tag);
    if (tag === 'iframe') {
      const target = fakeFrameWindow();
      windows.set(made as HTMLIFrameElement, target);
      Object.defineProperty(made, 'contentWindow', { get: () => target, configurable: true });
    }
    return made;
  }) as typeof document.createElement);
}

interface Mounted {
  element: ElisymBuy;
  shadow: ShadowRoot;
  button: HTMLButtonElement;
  dialog: HTMLDialogElement;
  closeButton: HTMLButtonElement;
  events: string[];
}

function mount(attributes: Record<string, string> = {}): Mounted {
  standInWindows();
  const element = document.createElement('elisym-buy') as ElisymBuy;
  element.setAttribute('product', NADDR);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  const events: string[] = [];
  for (const type of ['elisym-open', 'elisym-close']) {
    element.addEventListener(type, () => events.push(type));
  }
  document.body.appendChild(element);
  const shadow = element.shadowRoot;
  if (shadow === null) {
    throw new Error('no shadow root');
  }
  return { element, shadow, ...partsOf(shadow), events };
}

function partsOf(shadow: ShadowRoot): {
  button: HTMLButtonElement;
  dialog: HTMLDialogElement;
  closeButton: HTMLButtonElement;
} {
  const button = shadow.querySelector<HTMLButtonElement>('button[part="button"]');
  const dialog = shadow.querySelector('dialog');
  const closeButton = shadow.querySelector<HTMLButtonElement>('button.close');
  if (button === null || dialog === null || closeButton === null) {
    throw new Error('missing chrome');
  }
  return { button, dialog, closeButton };
}

function frameOf(mounted: { dialog: HTMLDialogElement }): HTMLIFrameElement {
  const frame = mounted.dialog.querySelector('iframe');
  if (frame === null) {
    throw new Error('no iframe in the dialog');
  }
  return frame;
}

function targetOf(frame: HTMLIFrameElement): FakeFrameWindow {
  const target = windows.get(frame);
  if (target === undefined) {
    throw new Error('no stand-in window');
  }
  return target;
}

function deliver(data: unknown, origin: string, source: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', { data, origin, source: source as MessageEventSource }),
  );
}

/** happy-dom fires `close` synchronously; browsers queue it: either way, a task later. */
async function aTaskLater(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function stubRect(dialog: HTMLDialogElement): void {
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 100,
    right: 500,
    bottom: 600,
    width: 400,
    height: 500,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
}

function press(target: EventTarget, clientX: number, clientY: number): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX, clientY }));
}

/** A press and its release at one point: the click lands where both were. */
function click(target: EventTarget, clientX: number, clientY: number): void {
  press(target, clientX, clientY);
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
}

describe('the checkout parameters', () => {
  it('a v2 element always writes display, modal by default', () => {
    const mounted = mount();
    const hash = new URL(frameOf(mounted).src).hash;
    expect(new URLSearchParams(hash.slice(1)).get('display')).toBe('modal');
    expect(decodeCheckoutParams(hash)?.display).toBe('modal');
  });

  it('without display the frame is inline: a v1 loader never gets modal chrome', () => {
    expect(decodeCheckoutParams(`#naddr=${NADDR}`)?.display).toBe('inline');
    // The frozen v1 encoder's own output, read by the live decoder.
    const fromV1 = encodeV1({
      naddr: NADDR,
      strictOrigin: true,
      theme: 'dark',
      collectEmail: true,
    });
    expect(decodeCheckoutParams(fromV1)).toEqual({
      naddr: NADDR,
      strictOrigin: true,
      theme: 'dark',
      collectEmail: true,
      display: 'inline',
    });
    expect(decodeCheckoutParams(`#naddr=${NADDR}&display=popup`)?.display).toBe('inline');
  });
});

describe('<elisym-buy> v2, modal', () => {
  it('renders a button, and preloads the frame in the closed dialog', () => {
    const mounted = mount({ label: 'Buy course' });
    expect(mounted.button.textContent).toBe('Buy course');
    expect(mounted.button.hidden).toBe(false);
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.dialog.getAttribute('aria-label')).toBe('Checkout');
    const frame = frameOf(mounted);
    expect(frame.getAttribute('allow')).toBe('clipboard-write');
    expect(new URL(frame.src).origin).toBe(ORIGIN);
    // The frame lives in the dialog, never in the page's light DOM.
    expect(mounted.element.querySelector('iframe')).toBeNull();
    // The handshake runs while closed.
    expect(targetOf(frame).posted[0]).toEqual([{ type: 'hello' }, ORIGIN]);
  });

  it('opens on a click: the dialog is modal, the frame has focus, the page hears elisym-open', () => {
    const mounted = mount();
    const frame = frameOf(mounted);
    const focus = vi.spyOn(frame, 'focus');
    mounted.button.click();
    expect(mounted.dialog.open).toBe(true);
    expect(focus).toHaveBeenCalled();
    expect(mounted.events).toEqual(['elisym-open']);
  });

  it('keeps the shown frame transparent until its first height, or 300 ms', () => {
    vi.useFakeTimers();
    const mounted = mount();
    const frame = frameOf(mounted);
    mounted.button.click();
    expect(frame.style.opacity).toBe('0');
    deliver({ type: 'resize', height: 500 }, ORIGIN, targetOf(frame));
    expect(frame.style.opacity).toBe('');
    mounted.closeButton.click();
    mounted.button.click();
    expect(frame.style.opacity).toBe('0');
    vi.advanceTimersByTime(300);
    expect(frame.style.opacity).toBe('');
  });

  it('closes from its own close button, returns focus to the button, once', async () => {
    const mounted = mount();
    let heardOnPage = 0;
    const onClose = () => {
      heardOnPage += 1;
    };
    document.addEventListener('elisym-close', onClose);
    mounted.button.click();
    const focus = vi.spyOn(mounted.button, 'focus');
    mounted.closeButton.click();
    await aTaskLater();
    document.removeEventListener('elisym-close', onClose);
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
    expect(heardOnPage).toBe(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click (outside the box) only', async () => {
    const mounted = mount();
    stubRect(mounted.dialog);
    mounted.button.click();
    // Inside the box (on the dialog's padding or strip): nothing.
    click(mounted.dialog, 300, 120);
    // On the strip itself: nothing.
    click(mounted.closeButton.parentElement ?? mounted.dialog, 50, 50);
    expect(mounted.dialog.open).toBe(true);
    // Pressed on the strip, released on the backdrop: the click goes to the dialog. Nothing.
    press(mounted.closeButton, 120, 110);
    mounted.dialog.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 50 }),
    );
    expect(mounted.dialog.open).toBe(true);
    click(mounted.dialog, 50, 50);
    await aTaskLater();
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
  });

  it('put back by page code answering elisym-close, it frames and listens again', async () => {
    const mounted = mount();
    mounted.element.addEventListener(
      'elisym-close',
      () => {
        document.body.appendChild(mounted.element);
      },
      { once: true },
    );
    mounted.button.click();
    mounted.element.remove();
    await aTaskLater();
    expect(mounted.element.isConnected).toBe(true);
    const frame = frameOf(mounted);
    mounted.button.click();
    expect(mounted.dialog.open).toBe(true);
    deliver({ type: 'close' }, ORIGIN, targetOf(frame));
    await aTaskLater();
    expect(mounted.dialog.open).toBe(false);
  });

  it('closes on cancel and close (Escape), with the bookkeeping once', async () => {
    const mounted = mount();
    mounted.button.click();
    mounted.dialog.dispatchEvent(new Event('cancel'));
    mounted.dialog.close();
    // A second close event (a repeated Escape) does nothing more.
    mounted.dialog.dispatchEvent(new Event('close'));
    await aTaskLater();
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
  });

  it('closes on a close message from its own frame on the checkout origin only', async () => {
    const mounted = mount();
    const frame = frameOf(mounted);
    mounted.button.click();
    deliver({ type: 'close' }, 'https://evil.example', targetOf(frame));
    deliver({ type: 'close' }, ORIGIN, window);
    deliver({ type: 'close' }, ORIGIN, null);
    expect(mounted.dialog.open).toBe(true);
    deliver({ type: 'close' }, ORIGIN, targetOf(frame));
    await aTaskLater();
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
    // A close message while closed does nothing.
    deliver({ type: 'close' }, ORIGIN, targetOf(frame));
    await aTaskLater();
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
  });

  it('relays a known state from its own frame only', () => {
    const mounted = mount();
    const frame = frameOf(mounted);
    const states: unknown[] = [];
    mounted.element.addEventListener('elisym-status', (event) => {
      states.push((event as CustomEvent<{ state: string }>).detail);
    });
    deliver({ type: 'status', state: 'paid' }, ORIGIN, targetOf(frame));
    deliver({ type: 'status', state: 'paid' }, 'https://evil.example', targetOf(frame));
    deliver({ type: 'status', state: 'https://secret.link' }, ORIGIN, targetOf(frame));
    expect(states).toEqual([{ state: 'paid' }]);
  });

  it('changes the label without reloading the frame', () => {
    const mounted = mount();
    const frame = frameOf(mounted);
    mounted.element.setAttribute('label', 'Get it');
    expect(mounted.button.textContent).toBe('Get it');
    expect(frameOf(mounted)).toBe(frame);
    mounted.element.removeAttribute('label');
    expect(mounted.button.textContent).toBe('Buy');
    expect(frameOf(mounted)).toBe(frame);
  });

  it('an empty label falls back to the default: the button keeps a name', () => {
    const mounted = mount({ label: '' });
    expect(mounted.button.textContent).toBe('Buy');
    mounted.element.setAttribute('label', '   ');
    expect(mounted.button.textContent).toBe('Buy');
  });

  it('page code removing the element on elisym-close leaves nothing running', async () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    const mounted = mount();
    mounted.element.addEventListener('elisym-close', () => mounted.element.remove());
    mounted.button.click();
    mounted.element.setAttribute('display', 'inline');
    await aTaskLater();
    expect(mounted.element.isConnected).toBe(false);
    expect(mounted.element.querySelector('iframe')).toBeNull();
    expect(mounted.dialog.querySelector('iframe')).toBeNull();
    expect(removed.mock.calls.some(([type]) => type === 'message')).toBe(true);
  });

  it('page code removing the element on elisym-close: the page hears it once', async () => {
    const mounted = mount();
    const heard: EventTarget[] = [];
    const onClose = (event: Event) => {
      if (event.target !== null) {
        heard.push(event.target);
      }
      mounted.element.remove();
    };
    document.addEventListener('elisym-close', onClose);
    mounted.button.click();
    mounted.closeButton.click();
    await aTaskLater();
    document.removeEventListener('elisym-close', onClose);
    expect(heard).toEqual([mounted.element]);
  });

  it('page code setting modal again on elisym-close keeps a modal frame', async () => {
    const mounted = mount();
    mounted.element.addEventListener('elisym-close', () =>
      mounted.element.setAttribute('display', 'modal'),
    );
    mounted.button.click();
    mounted.element.setAttribute('display', 'inline');
    await aTaskLater();
    expect(mounted.element.querySelector('iframe')).toBeNull();
    expect(decodeCheckoutParams(new URL(frameOf(mounted).src).hash)?.display).toBe('modal');
  });

  it('a theme change while open reloads the frame in place and stays open', async () => {
    vi.useFakeTimers();
    const mounted = mount();
    const old = frameOf(mounted);
    mounted.button.click();
    mounted.element.setAttribute('theme', 'dark');
    const fresh = frameOf(mounted);
    expect(fresh).not.toBe(old);
    expect(old.isConnected).toBe(false);
    expect(decodeCheckoutParams(new URL(fresh.src).hash)?.theme).toBe('dark');
    expect(mounted.dialog.open).toBe(true);
    expect(mounted.dialog.dataset.theme).toBe('dark');
    // Shown like on open, then focused once it appears.
    expect(fresh.style.opacity).toBe('0');
    const focus = vi.spyOn(fresh, 'focus');
    vi.advanceTimersByTime(300);
    expect(fresh.style.opacity).toBe('');
    expect(focus).toHaveBeenCalled();
    vi.useRealTimers();
    await aTaskLater();
    expect(mounted.events).toEqual(['elisym-open']);
  });

  it('strict-origin, network and product set after connect each reach a new frame', () => {
    const mounted = mount();
    const first = frameOf(mounted);
    mounted.element.setAttribute('strict-origin', '');
    const strict = frameOf(mounted);
    expect(strict).not.toBe(first);
    expect(new URL(strict.src).hash).toContain('strict=1');
    mounted.element.setAttribute('network', 'devnet');
    expect(decodeCheckoutParams(new URL(frameOf(mounted).src).hash)).toMatchObject({
      strictOrigin: true,
      network: 'devnet',
    });
    mounted.element.setAttribute('product', 'naddr1other');
    expect(decodeCheckoutParams(new URL(frameOf(mounted).src).hash)?.naddr).toBe('naddr1other');
    expect(mounted.dialog.querySelectorAll('iframe')).toHaveLength(1);
    // The same value again, or an unknown theme: the same frame.
    const same = frameOf(mounted);
    mounted.element.setAttribute('theme', 'neon');
    expect(frameOf(mounted)).toBe(same);
  });

  it('modal to inline while open: closes once, shows the inline frame and focuses it', async () => {
    const mounted = mount();
    mounted.button.click();
    mounted.element.setAttribute('display', 'inline');
    await aTaskLater();
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.button.hidden).toBe(true);
    expect(mounted.dialog.hidden).toBe(true);
    expect(mounted.dialog.querySelector('iframe')).toBeNull();
    const inline = mounted.element.querySelector('iframe');
    expect(inline).not.toBeNull();
    expect(decodeCheckoutParams(new URL(inline?.src ?? '').hash)?.display).toBe('inline');
    expect(
      document.activeElement === inline || mounted.element.contains(document.activeElement),
    ).toBe(true);
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
  });

  it('removing the product while open: closed, no button, no frame', async () => {
    const mounted = mount();
    mounted.button.click();
    mounted.element.removeAttribute('product');
    await aTaskLater();
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.button.hidden).toBe(true);
    expect(mounted.shadow.querySelector('iframe')).toBeNull();
    expect(mounted.element.querySelector('iframe')).toBeNull();
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
  });

  it('removed while open: the bookkeeping runs at once, once, and focus stays put', async () => {
    const mounted = mount();
    const heard: unknown[] = [];
    const onClose = (event: Event) => {
      heard.push(event instanceof CustomEvent ? event.detail?.element : undefined);
    };
    document.addEventListener('elisym-close', onClose);
    mounted.button.click();
    const focus = vi.spyOn(mounted.button, 'focus');
    mounted.element.remove();
    document.removeEventListener('elisym-close', onClose);
    // The page hears it once, though the element has left it.
    expect(heard).toEqual([mounted.element]);
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
    await aTaskLater();
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
    expect(focus).not.toHaveBeenCalled();
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.shadow.querySelector('iframe')).toBeNull();
  });

  it('moved while open: ends closed with exactly one elisym-close, and frames again', async () => {
    const mounted = mount();
    mounted.button.click();
    const other = document.createElement('div');
    document.body.appendChild(other);
    other.appendChild(mounted.element);
    await aTaskLater();
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
    expect(mounted.dialog.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('stops listening once removed', () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    const mounted = mount();
    mounted.element.remove();
    expect(removed.mock.calls.some(([type]) => type === 'message')).toBe(true);
  });

  it('a hidden button stays hidden against page CSS, and its click does nothing', () => {
    const mounted = mount();
    mounted.element.setAttribute('display', 'inline');
    const button = mounted.shadow.querySelector<HTMLButtonElement>('button[part="button"]');
    expect(button?.hidden).toBe(true);
    // The adopted sheet makes [hidden] win over `::part(button){display:inline-flex}`.
    const rules = mounted.shadow.adoptedStyleSheets.flatMap((sheet) =>
      [...sheet.cssRules].map((rule) => rule.cssText),
    );
    expect(rules.join('\n')).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    button?.click();
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.events).toEqual([]);
  });

  it('logs once when <elisym-buy> was already defined by another loader', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    await import('../src/embed/v2/embed');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('<elisym-buy> v2, inline', () => {
  it('keeps the iframe a light-DOM child, with no button and no dialog shown', () => {
    standInWindows();
    const element = document.createElement('elisym-buy');
    element.setAttribute('product', NADDR);
    element.setAttribute('display', 'inline');
    document.body.appendChild(element);
    const frame = element.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(decodeCheckoutParams(new URL(frame?.src ?? '').hash)?.display).toBe('inline');
    // No shadow root until a modal is first used.
    expect(element.shadowRoot).toBeNull();
  });

  it('on upgrade, attributes reported before connecting frame nothing by halves', () => {
    standInWindows();
    const element = document.createElement('elisym-buy') as ElisymBuy;
    element.setAttribute('product', NADDR);
    element.setAttribute('display', 'inline');
    // An upgrade reports each attribute while connected, before connectedCallback.
    Object.defineProperty(element, 'isConnected', { get: () => true, configurable: true });
    element.attributeChangedCallback('product');
    expect(element.shadowRoot).toBeNull();
    expect(element.querySelector('iframe')).toBeNull();
    Reflect.deleteProperty(element, 'isConnected');
    document.body.appendChild(element);
    expect(element.shadowRoot).toBeNull();
    expect(element.querySelector('iframe')).not.toBeNull();
  });

  it('a modal element turned inline still renders its light-DOM iframe through the slot', () => {
    const mounted = mount();
    mounted.element.setAttribute('display', 'inline');
    expect(mounted.shadow.querySelector('slot')).not.toBeNull();
    expect(mounted.element.querySelector('iframe')).not.toBeNull();
  });

  it('frames again after page code cleared its children', () => {
    standInWindows();
    const element = document.createElement('elisym-buy');
    element.setAttribute('product', NADDR);
    element.setAttribute('display', 'inline');
    document.body.appendChild(element);
    element.innerHTML = '';
    element.setAttribute('product', 'naddr1other');
    expect(element.querySelectorAll('iframe')).toHaveLength(1);
  });
});

describe('<elisym-buy> v2, without showModal', () => {
  it('opens a fixed overlay, locks the scroll, and restores it on close', async () => {
    const showModal = HTMLDialogElement.prototype.showModal;
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: undefined,
      configurable: true,
    });
    try {
      document.documentElement.style.overflow = 'scroll';
      const mounted = mount();
      const overlay = mounted.dialog.parentElement;
      expect(overlay?.hidden).toBe(true);
      mounted.button.click();
      expect(overlay?.hidden).toBe(false);
      expect(overlay?.style.position).toBe('fixed');
      expect(document.documentElement.style.overflow).toBe('hidden');
      expect(mounted.events).toEqual(['elisym-open']);
      // Escape on the page closes it.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(overlay?.hidden).toBe(true);
      expect(document.documentElement.style.overflow).toBe('scroll');
      expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
      // A click on the overlay itself (the backdrop) closes too.
      mounted.button.click();
      overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(overlay?.hidden).toBe(true);
      await aTaskLater();
      expect(mounted.events).toEqual([
        'elisym-open',
        'elisym-close',
        'elisym-open',
        'elisym-close',
      ]);
    } finally {
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
        value: showModal,
        configurable: true,
      });
      document.documentElement.style.overflow = '';
    }
  });

  it('two overlays open at once: one Escape closes both and gives the scroll back', () => {
    const showModal = HTMLDialogElement.prototype.showModal;
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: undefined,
      configurable: true,
    });
    try {
      document.documentElement.style.overflow = 'scroll';
      const first = mount();
      const second = mount();
      first.button.click();
      second.button.click();
      expect(document.documentElement.style.overflow).toBe('hidden');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(first.dialog.parentElement?.hidden).toBe(true);
      expect(second.dialog.parentElement?.hidden).toBe(true);
      expect(document.documentElement.style.overflow).toBe('scroll');
    } finally {
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
        value: showModal,
        configurable: true,
      });
      document.documentElement.style.overflow = '';
    }
  });
});

/** A `matchMedia` whose answers the test sets, telling its listeners as a browser does. */
function fakeMatchMedia(initial: Record<string, boolean>) {
  const state = new Map(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return state.get(query) ?? false;
    },
    addEventListener: (_type: string, listener: () => void) => {
      const set = listeners.get(query) ?? new Set();
      set.add(listener);
      listeners.set(query, set);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.get(query)?.delete(listener);
    },
  }));
  return {
    change(query: string, value: boolean) {
      state.set(query, value);
      for (const listener of listeners.get(query) ?? []) {
        listener();
      }
    },
    listening: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
  };
}

describe('<elisym-buy> v2, styled by hand (no adopted stylesheets)', () => {
  it('follows the theme and the screen while open, as a sheet on phones', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
    Reflect.deleteProperty(ShadowRoot.prototype, 'adoptedStyleSheets');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // A fresh copy of the module: its stylesheet is made on first use, and now cannot be.
      vi.resetModules();
      const fresh = await import('../src/embed/v2/embed');
      customElements.define('elisym-buy-by-hand', fresh.ElisymBuy);
      standInWindows();
      const element = document.createElement('elisym-buy-by-hand');
      element.setAttribute('product', NADDR);
      element.setAttribute('theme', 'light');
      document.body.appendChild(element);
      const shadow = element.shadowRoot;
      if (shadow === null) {
        throw new Error('no shadow root');
      }
      const { button, dialog } = partsOf(shadow);
      // A phone in light mode: a sheet at the bottom.
      const media = fakeMatchMedia({ '(max-width: 639px)': true });
      button.click();
      expect(dialog.style.margin).toBe('auto 0px 0px');
      const light = dialog.style.background;
      element.setAttribute('theme', 'dark');
      expect(dialog.open).toBe(true);
      expect(dialog.style.background).not.toBe(light);
      // Back to auto, then the OS turns dark and the screen widens while open.
      element.setAttribute('theme', 'auto');
      const autoLight = dialog.style.background;
      media.change('(prefers-color-scheme: dark)', true);
      expect(dialog.style.background).not.toBe(autoLight);
      media.change('(max-width: 639px)', false);
      expect(dialog.style.margin).toBe('auto');
      // Closed: it stops following.
      dialog.close();
      expect(media.listening()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      if (descriptor !== undefined) {
        Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', descriptor);
      }
    }
  });
});
