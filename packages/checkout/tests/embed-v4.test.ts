// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeCheckoutParams } from '../src/embed/protocol';
import { encodeCheckoutParams as encodeV1 } from '../src/embed/v1/protocol';
import { ElisymBuy as ElisymBuyV4, PAY_CORE, type ElisymBuy } from '../src/embed/v4/embed';

const ORIGIN = 'https://pay.test';
const NADDR = 'naddr1qqtestproduct';

beforeAll(async () => {
  await import('../src/embed/v4/embed');
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
  const created = Document.prototype.createElement.bind(document);
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
  it('a v4 element always writes display, modal by default', () => {
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

describe('<elisym-buy> v4, modal', () => {
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

  it('another v4 copy finding <elisym-buy> defined by v4 stays silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    await import('../src/embed/v4/embed');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('<elisym-buy> v4, inline', () => {
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

describe('<elisym-buy> v4, without showModal', () => {
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

describe('<elisym-buy> v4, styled by hand (no adopted stylesheets)', () => {
  it('follows the theme and the screen while open, as a sheet on phones', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
    Reflect.deleteProperty(ShadowRoot.prototype, 'adoptedStyleSheets');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // A fresh copy of the module: its stylesheet is made on first use, and now cannot be.
      vi.resetModules();
      const fresh = await import('../src/embed/v4/embed');
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

/** An element that may draw nothing at all (no button, no frame). */
function mountBare(attributes: Record<string, string>): ElisymBuy {
  standInWindows();
  const element = document.createElement('elisym-buy') as ElisymBuy;
  element.setAttribute('product', NADDR);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.appendChild(element);
  return element;
}

/** No frame anywhere: in the light DOM or in the shadow root's dialog. */
function framesNothing(element: ElisymBuy): boolean {
  return (
    element.querySelector('iframe') === null &&
    (element.shadowRoot === null || element.shadowRoot.querySelector('iframe') === null)
  );
}

/** The frame's checkout parameters, as the checkout app reads them. */
function framedParams(frame: HTMLIFrameElement) {
  return decodeCheckoutParams(new URL(frame.src).hash);
}

/** What the loader told the page through `console.error` (happy-dom logs its own there too). */
function errorsLogged(): { told: () => string[] } {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return {
    told: () =>
      spy.mock.calls
        .map((call) => call[0])
        .filter(
          (first): first is string => typeof first === 'string' && first.startsWith('elisym:'),
        ),
  };
}

describe('<elisym-buy> v4, customer-ref', () => {
  it('names itself v4, for a page or a wrapper to tell it from an older loader', () => {
    expect(ElisymBuyV4.loader).toBe('v4');
    expect(customElements.get('elisym-buy')).toBe(ElisymBuyV4);
  });

  it('carries the reference to the checkout, always in strict origin', () => {
    const mounted = mount({ 'customer-ref': 'user_42' });
    const params = framedParams(frameOf(mounted));
    expect(params?.customerRef).toBe('user_42');
    // Never asked for by the page: a reference forces it.
    expect(params?.strictOrigin).toBe(true);
    expect(mounted.button.getAttribute('aria-disabled')).toBeNull();
  });

  it('without a reference writes none: the frame is exactly a v2 one', () => {
    const mounted = mount();
    const params = framedParams(frameOf(mounted));
    expect(params?.customerRef).toBeUndefined();
    expect(params?.strictOrigin).toBe(false);
    expect(new URL(frameOf(mounted).src).hash).not.toContain('ref=');
  });

  it('a polluted prototype never adds a reference or a network to the frame', () => {
    const prototype = Object.prototype as Record<string, unknown>;
    prototype.customerRef = 'attacker';
    prototype.network = 'mainnet';
    try {
      const search = new URLSearchParams(new URL(frameOf(mount()).src).hash.slice(1));
      expect([...search.keys()]).toEqual(['naddr', 'display']);
    } finally {
      delete prototype.customerRef;
      delete prototype.network;
    }
  });

  it('reloads the frame when the reference changes', () => {
    const mounted = mount({ 'customer-ref': 'user_42' });
    const first = frameOf(mounted);
    mounted.element.setAttribute('customer-ref', 'user_43');
    const second = frameOf(mounted);
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(framedParams(second)?.customerRef).toBe('user_43');
  });

  it('frames nothing for an invalid reference, and says so once', () => {
    const errors = errorsLogged();
    const element = mountBare({ 'customer-ref': 'user 42' });
    expect(framesNothing(element)).toBe(true);
    element.setAttribute('label', 'Deposit');
    element.setAttribute('theme', 'dark');
    expect(errors.told()).toHaveLength(1);
    expect(errors.told()[0]).toContain('customer-ref');
    // A valid one frames.
    element.setAttribute('customer-ref', 'user_42');
    const dialog = element.shadowRoot?.querySelector('dialog');
    expect(
      dialog === null || dialog === undefined ? undefined : framedParams(frameOf({ dialog })),
    ).toMatchObject({ customerRef: 'user_42' });
  });

  it('an empty reference waits: a disabled button, no frame, framed once it is set', () => {
    const mounted = mount({ 'customer-ref': '' });
    expect(mounted.button.hidden).toBe(false);
    expect(mounted.button.getAttribute('aria-disabled')).toBe('true');
    expect(mounted.dialog.querySelector('iframe')).toBeNull();
    mounted.button.click();
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.events).toEqual([]);
    mounted.element.setAttribute('customer-ref', 'user_42');
    expect(mounted.button.getAttribute('aria-disabled')).toBeNull();
    expect(framedParams(frameOf(mounted))?.customerRef).toBe('user_42');
    mounted.button.click();
    expect(mounted.dialog.open).toBe(true);
  });

  it('an empty reference inline frames nothing either', () => {
    const element = mountBare({ 'customer-ref': '', display: 'inline' });
    expect(framesNothing(element)).toBe(true);
    element.setAttribute('customer-ref', 'user_42');
    expect(element.querySelector('iframe')).not.toBeNull();
  });

  it('a reference emptied while open drops the frame, closes the dialog, disables the button', async () => {
    const mounted = mount({ 'customer-ref': 'user_42' });
    mounted.button.click();
    expect(mounted.dialog.open).toBe(true);
    mounted.element.setAttribute('customer-ref', '');
    await aTaskLater();
    expect(mounted.dialog.open).toBe(false);
    expect(mounted.dialog.querySelector('iframe')).toBeNull();
    expect(mounted.button.getAttribute('aria-disabled')).toBe('true');
    expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
  });

  it('inside another frame, a reference frames nothing and says so', () => {
    const errors = errorsLogged();
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    const element = mountBare({ 'customer-ref': 'user_42' });
    expect(framesNothing(element)).toBe(true);
    // An empty one does not wait there either: it is refused the same way.
    element.setAttribute('customer-ref', '');
    expect(framesNothing(element)).toBe(true);
    expect(errors.told()).toHaveLength(1);
    expect(errors.told()[0]).toContain('top-level');
  });

  it('inside another frame, an element with no reference still frames (as v2 does)', () => {
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    const mounted = mount();
    expect(framedParams(frameOf(mounted))?.naddr).toBe(NADDR);
  });

  it('loaded twice, it says nothing: the first v4 already reads customer-ref', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = errorsLogged();
    mount({ 'customer-ref': 'user_42' });
    vi.resetModules();
    await import('../src/embed/v4/embed');
    expect(warnings).not.toHaveBeenCalled();
    expect(errors.told()).toEqual([]);
  });
});

describe('<elisym-buy> v4, a button waiting for its reference', () => {
  it('looks disabled in the adopted stylesheet', () => {
    const mounted = mount({ 'customer-ref': '' });
    const rules = mounted.shadow.adoptedStyleSheets
      .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
      .join('\n');
    expect(rules).toMatch(
      /\.buy\[aria-disabled="?true"?\]\s*\{[^}]*opacity:\s*0?\.5[^}]*cursor:\s*not-allowed/,
    );
  });

  it('looks disabled styled by hand too, and enabled once the reference is set', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
    Reflect.deleteProperty(ShadowRoot.prototype, 'adoptedStyleSheets');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.resetModules();
      const fresh = await import('../src/embed/v4/embed');
      customElements.define('elisym-buy-waiting', fresh.ElisymBuy);
      standInWindows();
      const element = document.createElement('elisym-buy-waiting');
      element.setAttribute('product', NADDR);
      element.setAttribute('customer-ref', '');
      document.body.appendChild(element);
      const button = element.shadowRoot?.querySelector<HTMLButtonElement>('button[part="button"]');
      expect(Number(button?.style.opacity)).toBe(0.5);
      expect(button?.style.cursor).toBe('not-allowed');
      element.setAttribute('customer-ref', 'user_42');
      expect(button?.style.opacity).toBe('');
      expect(button?.style.cursor).toBe('pointer');
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', descriptor);
      }
    }
  });
});

type Handle = ReturnType<typeof PAY_CORE.open>;

interface Opened {
  handle: Handle;
  host: HTMLElement;
  root: ShadowRoot;
  dialog: HTMLDialogElement;
  closeButton: HTMLButtonElement;
  frame: HTMLIFrameElement;
  target: FakeFrameWindow;
  /** The handle's events, in order: `status:<state>`, `error:<reason>`, `close`. */
  events: string[];
}

function hostsOnPage(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('elisym-checkout')];
}

function partsOfHost(host: HTMLElement): Omit<Opened, 'handle' | 'events'> {
  const root = host.shadowRoot;
  const dialog = root?.querySelector('dialog');
  const closeButton = root?.querySelector<HTMLButtonElement>('button.close');
  const frame = root?.querySelector('iframe');
  if (
    root === null ||
    root === undefined ||
    dialog === null ||
    dialog === undefined ||
    closeButton === null ||
    closeButton === undefined ||
    frame === null ||
    frame === undefined
  ) {
    throw new Error('missing host parts');
  }
  return { host, root, dialog, closeButton, frame, target: targetOf(frame) };
}

function openCheckout(options: Record<string, unknown> = {}): Opened {
  standInWindows();
  const handle = PAY_CORE.open({ product: NADDR, ...options });
  const hosts = hostsOnPage();
  const host = hosts[hosts.length - 1];
  if (host === undefined) {
    throw new Error('no host');
  }
  const events: string[] = [];
  handle.addEventListener('status', (event) => {
    events.push(`status:${(event as CustomEvent<{ state: string }>).detail.state}`);
  });
  handle.addEventListener('error', (event) => {
    events.push(`error:${(event as CustomEvent<{ reason: string }>).detail.reason}`);
  });
  handle.addEventListener('close', () => events.push('close'));
  return { handle, events, ...partsOfHost(host) };
}

/** Every `message` listener added on `window` from now on, and whether it was removed. */
function watchListeners(): { added: () => unknown[]; stillListening: () => unknown[] } {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const added = () =>
    add.mock.calls.filter(([type]) => type === 'message').map(([, listener]) => listener);
  return {
    added,
    stillListening: () =>
      added().filter(
        (listener) =>
          !remove.mock.calls.some(([type, removed]) => type === 'message' && removed === listener),
      ),
  };
}

/** What a closed programmatic checkout must leave: no host, no listener, no timer, no observer. */
function leftNothing(watch: ReturnType<typeof watchListeners>, disconnect: { mock: object }): void {
  expect(hostsOnPage()).toEqual([]);
  expect(watch.added().length).toBeGreaterThan(0);
  expect(watch.stillListening()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  expect(disconnect).toHaveBeenCalled();
}

async function settled(handle: Handle): Promise<boolean> {
  let done = false;
  void handle.closed.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

afterEach(() => {
  for (const host of hostsOnPage()) {
    host.remove();
  }
});

describe('PayCore.open options', () => {
  const rejected: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a string', NADDR],
    ['a number', 42],
    ['a function', () => ({ product: NADDR })],
    ['no product', {}],
    ['an unknown option', { product: NADDR, label: 'Buy' }],
    ['an unknown option spelled like an attribute', { product: NADDR, 'customer-ref': 'u' }],
    ['a product that is not an naddr', { product: 'npub1qqtest' }],
    ['an empty naddr', { product: 'naddr1' }],
    ['an naddr with other characters', { product: 'naddr1qq test' }],
    ['an uppercase naddr', { product: 'naddr1QQTEST' }],
    ['a product that is not a string', { product: 42 }],
    ['an unknown network', { product: NADDR, network: 'testnet' }],
    ['an unknown theme', { product: NADDR, theme: 'neon' }],
    ['a strictOrigin that is not a boolean', { product: NADDR, strictOrigin: 'yes' }],
    ['a collectEmail that is not a boolean', { product: NADDR, collectEmail: 1 }],
    ['an invalid customerRef', { product: NADDR, customerRef: 'user 42' }],
    ['an empty customerRef', { product: NADDR, customerRef: '' }],
    ['a customerRef that is not a string', { product: NADDR, customerRef: 42 }],
    [
      'a customerRef with strictOrigin false',
      { product: NADDR, customerRef: 'u', strictOrigin: false },
    ],
  ];

  it.each(rejected)('refuses %s with a TypeError, appending nothing', (_name, options) => {
    standInWindows();
    expect(() => PAY_CORE.open(options as Parameters<typeof PAY_CORE.open>[0])).toThrow(TypeError);
    expect(() => PAY_CORE.open(options as Parameters<typeof PAY_CORE.open>[0])).toThrow(
      /^elisym: /,
    );
    expect(hostsOnPage()).toEqual([]);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('names what is wrong', () => {
    const messages: [unknown, string][] = [
      [null, 'elisym: PayCore.open needs an options object'],
      ['naddr1qq', 'elisym: PayCore.open needs an options object'],
      [{ product: NADDR, label: 'x' }, 'elisym: unknown option label'],
      [{ product: 'x' }, 'elisym: option product must be an naddr1 address'],
      [{ product: NADDR, network: 'x' }, 'elisym: option network must be mainnet or devnet'],
      [{ product: NADDR, customerRef: 'a b' }, 'elisym: option customerRef is not a valid'],
      [
        { product: NADDR, customerRef: 'a', strictOrigin: false },
        'elisym: customerRef needs strictOrigin',
      ],
    ];
    for (const [options, message] of messages) {
      expect(() => PAY_CORE.open(options as Parameters<typeof PAY_CORE.open>[0])).toThrow(message);
    }
  });

  it('never runs a getter: the option is refused', () => {
    const getter = vi.fn(() => NADDR);
    const options = {};
    Object.defineProperty(options, 'product', { get: getter, enumerable: true });
    expect(() => PAY_CORE.open(options)).toThrow('elisym: option product is not a plain value');
    expect(getter).not.toHaveBeenCalled();
    expect(hostsOnPage()).toEqual([]);
  });

  it('reads own properties only: an inherited or hidden product is no product', () => {
    expect(() => PAY_CORE.open(Object.create({ product: NADDR }))).toThrow(TypeError);
    const hidden = {};
    Object.defineProperty(hidden, 'product', { value: NADDR, enumerable: false });
    expect(() => PAY_CORE.open(hidden)).toThrow(TypeError);
    expect(hostsOnPage()).toEqual([]);
  });

  it('ignores a polluted prototype', () => {
    const prototype = Object.prototype as Record<string, unknown>;
    prototype.customerRef = 'attacker';
    prototype.theme = 'neon';
    try {
      const opened = openCheckout();
      // Read from the fragment itself: the decoded object would see the polluted prototype too.
      const search = new URLSearchParams(new URL(opened.frame.src).hash.slice(1));
      expect([...search.keys()]).toEqual(['naddr', 'display']);
    } finally {
      delete prototype.customerRef;
      delete prototype.theme;
    }
  });

  it('a framed page cannot pass a customerRef, and appends nothing', () => {
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    standInWindows();
    expect(() => PAY_CORE.open({ product: NADDR, customerRef: 'user_42' })).toThrow(
      /top-level page/,
    );
    expect(hostsOnPage()).toEqual([]);
    // Without a reference a framed page opens as it would with the element.
    expect(framedParams(openCheckout().frame)?.naddr).toBe(NADDR);
  });

  it('frames a modal, in strict origin whenever a customerRef is given', () => {
    const withRef = openCheckout({ customerRef: 'user_42', strictOrigin: true });
    expect(framedParams(withRef.frame)).toEqual({
      naddr: NADDR,
      strictOrigin: true,
      theme: 'auto',
      collectEmail: false,
      display: 'modal',
      customerRef: 'user_42',
    });
    withRef.handle.close();
    const forced = openCheckout({ customerRef: 'user_42' });
    expect(framedParams(forced.frame)).toMatchObject({ strictOrigin: true, display: 'modal' });
    forced.handle.close();
    const every = openCheckout({
      network: 'devnet',
      theme: 'dark',
      collectEmail: true,
      strictOrigin: true,
    });
    expect(framedParams(every.frame)).toEqual({
      naddr: NADDR,
      network: 'devnet',
      strictOrigin: true,
      theme: 'dark',
      collectEmail: true,
      display: 'modal',
    });
    expect(new URL(every.frame.src).origin).toBe(ORIGIN);
    expect(every.dialog.dataset.theme).toBe('dark');
    every.handle.close();
    const plain = openCheckout({
      network: undefined,
      theme: 'light',
      strictOrigin: false,
      collectEmail: false,
    });
    expect(framedParams(plain.frame)).toEqual({
      naddr: NADDR,
      strictOrigin: false,
      theme: 'light',
      collectEmail: false,
      display: 'modal',
    });
  });
});

describe('PayCore.open', () => {
  it('names itself v4 and is frozen', () => {
    expect(PAY_CORE.version).toBe('v4');
    expect(Object.isFrozen(PAY_CORE)).toBe(true);
  });

  it('opens a modal in its own host on the page, and the frame takes focus', () => {
    standInWindows();
    const focus = vi.spyOn(HTMLIFrameElement.prototype, 'focus');
    const opened = openCheckout();
    expect(opened.host.parentNode).toBe(document.body);
    expect(opened.dialog.open).toBe(true);
    expect(opened.dialog.getAttribute('aria-label')).toBe('Checkout');
    expect(opened.frame.getAttribute('allow')).toBe('clipboard-write');
    expect(focus).toHaveBeenCalled();
    expect(opened.handle.state).toBeUndefined();
    expect(opened.target.posted[0]).toEqual([{ type: 'hello' }, ORIGIN]);
    // Nothing else lands in the page's light DOM.
    expect(document.body.querySelector('iframe')).toBeNull();
  });

  it('keeps the frame transparent until its first height, or 300 ms', () => {
    vi.useFakeTimers();
    const opened = openCheckout();
    expect(opened.frame.style.opacity).toBe('0');
    deliver({ type: 'resize', height: 500 }, ORIGIN, opened.target);
    expect(opened.frame.style.opacity).toBe('');
    expect(opened.frame.style.height).toBe('500px');
    opened.handle.close();
    const again = openCheckout();
    expect(again.frame.style.opacity).toBe('0');
    vi.advanceTimersByTime(300);
    expect(again.frame.style.opacity).toBe('');
  });

  it('appends to <html> when <body> does not exist yet (a script in the head)', () => {
    const body = vi.spyOn(document, 'body', 'get').mockReturnValue(null as unknown as HTMLElement);
    try {
      const opened = openCheckout();
      expect(opened.host.parentNode).toBe(document.documentElement);
      opened.handle.close();
      expect(opened.host.isConnected).toBe(false);
    } finally {
      body.mockRestore();
    }
  });

  it('relays known states from its own frame only, and keeps the last one', () => {
    const opened = openCheckout();
    deliver({ type: 'status', state: 'ready' }, ORIGIN, opened.target);
    deliver({ type: 'status', state: 'paid' }, 'https://evil.example', opened.target);
    deliver({ type: 'status', state: 'paid' }, ORIGIN, window);
    deliver({ type: 'status', state: 'paid' }, ORIGIN, null);
    deliver({ type: 'status', state: 'https://secret.link' }, ORIGIN, opened.target);
    deliver('status', ORIGIN, opened.target);
    deliver(null, ORIGIN, opened.target);
    expect(opened.events).toEqual(['status:ready']);
    expect(opened.handle.state).toBe('ready');
    deliver({ type: 'status', state: 'ordered' }, ORIGIN, opened.target);
    expect(opened.handle.state).toBe('ordered');
    expect(opened.events).toEqual(['status:ready', 'status:ordered']);
  });

  it('closed settles with the last state, and close fires once', async () => {
    const opened = openCheckout();
    deliver({ type: 'status', state: 'completed' }, ORIGIN, opened.target);
    opened.handle.close();
    opened.handle.close();
    await expect(opened.handle.closed).resolves.toBe('completed');
    expect(opened.events).toEqual(['status:completed', 'close']);
    // Nothing is heard once closed.
    deliver({ type: 'status', state: 'refunded' }, ORIGIN, opened.target);
    expect(opened.handle.state).toBe('completed');
  });

  it('tells only its handle: the page hears no elisym-open, elisym-status or elisym-close', async () => {
    const heard: string[] = [];
    const listener = (event: Event) => heard.push(event.type);
    for (const type of ['elisym-open', 'elisym-status', 'elisym-close']) {
      document.addEventListener(type, listener);
    }
    try {
      const opened = openCheckout();
      deliver({ type: 'status', state: 'ready' }, ORIGIN, opened.target);
      deliver({ type: 'close' }, ORIGIN, opened.target);
      await opened.handle.closed;
      expect(opened.events).toEqual(['status:ready', 'close']);
      expect(heard).toEqual([]);
    } finally {
      for (const type of ['elisym-open', 'elisym-status', 'elisym-close']) {
        document.removeEventListener(type, listener);
      }
    }
  });

  it('closed settles with undefined when the checkout said nothing', async () => {
    const opened = openCheckout();
    opened.handle.close();
    await expect(opened.handle.closed).resolves.toBeUndefined();
  });
});

describe('PayCore.open, every close path', () => {
  function watched(): {
    watch: ReturnType<typeof watchListeners>;
    disconnect: ReturnType<typeof vi.spyOn>;
  } {
    vi.useFakeTimers();
    return {
      watch: watchListeners(),
      disconnect: vi.spyOn(MutationObserver.prototype, 'disconnect'),
    };
  }

  it('close()', async () => {
    const { watch, disconnect } = watched();
    const opened = openCheckout();
    opened.handle.close();
    expect(await settled(opened.handle)).toBe(true);
    expect(opened.dialog.open).toBe(false);
    leftNothing(watch, disconnect);
  });

  it('Escape (the dialog cancels and closes)', async () => {
    const { watch, disconnect } = watched();
    const opened = openCheckout();
    opened.dialog.dispatchEvent(new Event('cancel'));
    opened.dialog.close();
    opened.dialog.dispatchEvent(new Event('close'));
    expect(await settled(opened.handle)).toBe(true);
    expect(opened.events).toEqual(['close']);
    leftNothing(watch, disconnect);
  });

  it('the close button', async () => {
    const { watch, disconnect } = watched();
    const opened = openCheckout();
    opened.closeButton.click();
    expect(await settled(opened.handle)).toBe(true);
    leftNothing(watch, disconnect);
  });

  it('a click on the backdrop, never one pressed on the card', async () => {
    const { watch, disconnect } = watched();
    const opened = openCheckout();
    stubRect(opened.dialog);
    click(opened.dialog, 300, 120);
    press(opened.closeButton, 120, 110);
    opened.dialog.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 50 }),
    );
    expect(await settled(opened.handle)).toBe(false);
    click(opened.dialog, 50, 50);
    expect(await settled(opened.handle)).toBe(true);
    leftNothing(watch, disconnect);
  });

  it('a close message from its own frame on the checkout origin only', async () => {
    const { watch, disconnect } = watched();
    const opened = openCheckout();
    deliver({ type: 'close' }, 'https://evil.example', opened.target);
    deliver({ type: 'close' }, ORIGIN, window);
    expect(await settled(opened.handle)).toBe(false);
    deliver({ type: 'close' }, ORIGIN, opened.target);
    expect(await settled(opened.handle)).toBe(true);
    leftNothing(watch, disconnect);
  });

  it('replaced by another open', async () => {
    const { watch, disconnect } = watched();
    const first = openCheckout();
    deliver({ type: 'status', state: 'ready' }, ORIGIN, first.target);
    const second = openCheckout();
    await expect(first.handle.closed).resolves.toBe('ready');
    expect(first.events).toEqual(['status:ready', 'close']);
    expect(hostsOnPage()).toEqual([second.host]);
    expect(second.dialog.open).toBe(true);
    second.handle.close();
    leftNothing(watch, disconnect);
  });

  it('its host removed by page code', async () => {
    const { watch, disconnect } = watched();
    const opened = openCheckout();
    opened.host.remove();
    expect(await settled(opened.handle)).toBe(true);
    expect(opened.events).toEqual(['close']);
    leftNothing(watch, disconnect);
  });

  it('<body> replaced while open (a framework re-rendering the page)', async () => {
    const { watch, disconnect } = watched();
    const opened = openCheckout();
    const body = document.body;
    document.documentElement.replaceChild(document.createElement('body'), body);
    try {
      expect(await settled(opened.handle)).toBe(true);
      leftNothing(watch, disconnect);
    } finally {
      document.documentElement.replaceChild(body, document.body);
    }
  });

  it('an unrelated change on the page leaves it open', async () => {
    const opened = openCheckout();
    document.body.appendChild(document.createElement('div'));
    document.body.lastElementChild?.remove();
    expect(await settled(opened.handle)).toBe(false);
    expect(opened.dialog.open).toBe(true);
  });

  it('showModal throwing: open throws, and nothing stays', () => {
    const { watch, disconnect } = watched();
    standInWindows();
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {
      throw new DOMException('not allowed', 'InvalidStateError');
    });
    expect(() => PAY_CORE.open({ product: NADDR })).toThrow('not allowed');
    leftNothing(watch, disconnect);
    vi.restoreAllMocks();
    // The failed one is not the open checkout: the next opens.
    expect(openCheckout().dialog.open).toBe(true);
  });

  it('gives focus back where it was, inside a shadow root too, if still on the page', () => {
    const outer = document.createElement('div');
    const shadow = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('button');
    shadow.appendChild(inner);
    document.body.appendChild(outer);
    inner.focus();
    const opened = openCheckout();
    const focus = vi.spyOn(inner, 'focus');
    opened.handle.close();
    expect(focus).toHaveBeenCalledTimes(1);
    // Gone from the page meanwhile: focus is not given to it.
    inner.focus();
    const again = openCheckout();
    inner.remove();
    focus.mockClear();
    again.handle.close();
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('PayCore.open, one at a time', () => {
  it.each(['ordered', 'paying'])('refuses to replace a checkout %s', (state) => {
    const first = openCheckout();
    deliver({ type: 'status', state }, ORIGIN, first.target);
    let thrown: unknown;
    try {
      PAY_CORE.open({ product: NADDR });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as { code?: unknown }).code).toBe('busy');
    expect(hostsOnPage()).toEqual([first.host]);
    expect(first.dialog.open).toBe(true);
    expect(first.events).toEqual([`status:${state}`]);
  });

  it.each(['ready', 'paid', 'completed', 'refunded', 'ended', 'refused'])(
    'replaces a checkout %s',
    async (state) => {
      const first = openCheckout();
      deliver({ type: 'status', state }, ORIGIN, first.target);
      const second = openCheckout();
      await expect(first.handle.closed).resolves.toBe(state);
      expect(hostsOnPage()).toEqual([second.host]);
    },
  );

  it('a closed checkout never blocks, whatever its last state', () => {
    const first = openCheckout();
    deliver({ type: 'status', state: 'paying' }, ORIGIN, first.target);
    first.handle.close();
    expect(openCheckout().dialog.open).toBe(true);
  });

  it('a checkout back to ready after paying may be replaced', () => {
    const first = openCheckout();
    deliver({ type: 'status', state: 'paying' }, ORIGIN, first.target);
    deliver({ type: 'status', state: 'ready' }, ORIGIN, first.target);
    expect(() => openCheckout()).not.toThrow();
  });

  it('an invalid second open leaves the first open', () => {
    const first = openCheckout();
    expect(() => PAY_CORE.open({ product: 'bad' })).toThrow(TypeError);
    expect(first.dialog.open).toBe(true);
  });

  it('element modals are independent of it', () => {
    const mounted = mount();
    mounted.button.click();
    const opened = openCheckout();
    deliver({ type: 'status', state: 'paying' }, ORIGIN, opened.target);
    expect(mounted.dialog.open).toBe(true);
    opened.handle.close();
    expect(mounted.dialog.open).toBe(true);
  });
});

describe('PayCore.open, when the checkout never answers', () => {
  it('says error once, unavailable, and stays open', () => {
    vi.useFakeTimers();
    const opened = openCheckout();
    vi.advanceTimersByTime(9_900);
    expect(opened.events).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(opened.events).toEqual(['error:unavailable']);
    expect(opened.dialog.open).toBe(true);
    // Hello has stopped: nothing more is posted.
    const posted = opened.target.posted.length;
    vi.advanceTimersByTime(1_000);
    expect(opened.target.posted).toHaveLength(posted);
    // A reload that fails again does not say it twice.
    opened.frame.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(11_000);
    expect(opened.events).toEqual(['error:unavailable']);
  });

  it('an answered handshake says nothing; a reload that then fails says error once', () => {
    vi.useFakeTimers();
    const opened = openCheckout();
    deliver({ type: 'ack' }, ORIGIN, opened.target);
    deliver({ type: 'status', state: 'ready' }, ORIGIN, opened.target);
    const posted = opened.target.posted.length;
    vi.advanceTimersByTime(11_000);
    expect(opened.target.posted).toHaveLength(posted);
    expect(opened.events).toEqual(['status:ready']);
    opened.frame.dispatchEvent(new Event('load'));
    expect(opened.target.posted).toHaveLength(posted + 1);
    vi.advanceTimersByTime(11_000);
    expect(opened.events).toEqual(['status:ready', 'error:unavailable']);
    expect(opened.handle.state).toBe('ready');
    opened.frame.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(11_000);
    expect(opened.events).toEqual(['status:ready', 'error:unavailable']);
  });

  it('an ack from elsewhere does not stop the hello', () => {
    vi.useFakeTimers();
    const opened = openCheckout();
    deliver({ type: 'ack' }, 'https://evil.example', opened.target);
    deliver({ type: 'ack' }, ORIGIN, window);
    vi.advanceTimersByTime(10_500);
    expect(opened.events).toEqual(['error:unavailable']);
  });

  it('a closed checkout never says error', () => {
    vi.useFakeTimers();
    const opened = openCheckout();
    opened.handle.close();
    opened.frame.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(11_000);
    expect(opened.events).toEqual(['close']);
  });
});

describe('PayCore.open, held against page CSS', () => {
  it('its host sheet holds display and every inherited property with !important, scoped to the host', () => {
    const opened = openCheckout();
    const sheets = opened.root.adoptedStyleSheets.map((sheet) =>
      [...sheet.cssRules].map((rule) => rule.cssText).join('\n'),
    );
    expect(sheets).toHaveLength(2);
    expect(sheets[0]).toMatch(/^:host\(elisym-checkout\)\s*\{/);
    expect(sheets[0]).toMatch(/all:\s*initial\s*!important/);
    expect(sheets[0]).toMatch(/display:\s*contents\s*!important/);
    // The dialog's own look is the element's sheet, the same object.
    const mounted = mount();
    expect(opened.root.adoptedStyleSheets[1]).toBe(mounted.shadow.adoptedStyleSheets[0]);
    // <elisym-buy> does not take the host's rules: it inherits the page's font as before.
    expect(mounted.shadow.adoptedStyleSheets).toHaveLength(1);
    expect(sheets[1]).not.toContain(':host');
    expect(opened.host.getAttribute('style')).toBeNull();
  });

  it('<elisym-buy> shows as v3 does: same display and font', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const v3 = await import('../src/embed/v3/embed');
    customElements.define('elisym-buy-v3', v3.ElisymBuy);
    document.body.style.font = '17px Georgia';
    try {
      const v4Element = mount().element;
      const v3Element = document.createElement('elisym-buy-v3');
      v3Element.setAttribute('product', NADDR);
      document.body.appendChild(v3Element);
      for (const property of ['display', 'font-family', 'font-size']) {
        expect(getComputedStyle(v4Element).getPropertyValue(property)).toBe(
          getComputedStyle(v3Element).getPropertyValue(property),
        );
      }
      const v4Rules = mount()
        .shadow.adoptedStyleSheets.flatMap((sheet) =>
          [...sheet.cssRules].map((rule) => rule.cssText),
        )
        .join('\n');
      const v3Rules = (v3Element.shadowRoot?.adoptedStyleSheets ?? [])
        .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
        .join('\n');
      expect(v4Rules).toBe(v3Rules);
    } finally {
      document.body.style.font = '';
    }
  });

  it('styled by hand (no adopted stylesheets), the host holds display:contents inline, !important', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
    Reflect.deleteProperty(ShadowRoot.prototype, 'adoptedStyleSheets');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.resetModules();
      const fresh = await import('../src/embed/v4/embed');
      standInWindows();
      const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
      const handle = fresh.PAY_CORE.open({ product: NADDR, theme: 'dark' });
      const host = hostsOnPage()[0];
      expect(setProperty).toHaveBeenCalledWith('display', 'contents', 'important');
      expect(host?.style.getPropertyValue('display')).toBe('contents');
      expect(host?.style.getPropertyPriority('display')).toBe('important');
      const dialog = host?.shadowRoot?.querySelector('dialog');
      // The dialog is laid out by hand too, in its theme.
      expect(dialog?.style.background).not.toBe('');
      expect(dialog?.style.borderRadius).toBe('16px');
      handle.close();
      expect(hostsOnPage()).toEqual([]);
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', descriptor);
      }
    }
  });

  it('without showModal, opens an overlay that Escape closes', async () => {
    const showModal = HTMLDialogElement.prototype.showModal;
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: undefined,
      configurable: true,
    });
    try {
      document.documentElement.style.overflow = 'scroll';
      const opened = openCheckout();
      const overlay = opened.dialog.parentElement;
      expect(overlay?.hidden).toBe(false);
      expect(overlay?.style.position).toBe('fixed');
      expect(document.documentElement.style.overflow).toBe('hidden');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(await settled(opened.handle)).toBe(true);
      expect(document.documentElement.style.overflow).toBe('scroll');
      const again = openCheckout();
      again.dialog.parentElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(await settled(again.handle)).toBe(true);
    } finally {
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
        value: showModal,
        configurable: true,
      });
      document.documentElement.style.overflow = '';
    }
  });

  it('the host cannot be made: open throws a clear Error and appends nothing', () => {
    const first = openCheckout();
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(() => {
      throw new DOMException('no', 'NotSupportedError');
    });
    expect(() => PAY_CORE.open({ product: NADDR })).toThrow(/elisym-checkout/);
    // The open one is left as it was.
    expect(hostsOnPage()).toEqual([first.host]);
    expect(first.dialog.open).toBe(true);
  });
});

/** A fresh copy of the loader with no adopted stylesheets: the CSSOM path. */
async function byHandLoader(): Promise<{
  fresh: typeof import('../src/embed/v4/embed');
  restore: () => void;
}> {
  const descriptor = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
  Reflect.deleteProperty(ShadowRoot.prototype, 'adoptedStyleSheets');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.resetModules();
  const fresh = await import('../src/embed/v4/embed');
  return {
    fresh,
    restore: () => {
      if (descriptor !== undefined) {
        Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', descriptor);
      }
    },
  };
}

/** Runs `body` with `showModal` missing, as in the oldest browsers. */
async function withoutShowModal(body: () => Promise<void> | void): Promise<void> {
  const showModal = HTMLDialogElement.prototype.showModal;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    value: undefined,
    configurable: true,
  });
  try {
    await body();
  } finally {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: showModal,
      configurable: true,
    });
    document.documentElement.style.overflow = '';
  }
}

describe('the frame and the dialog, shared by the element and PayCore.open', () => {
  it('the frame and the chrome carry their attributes and first look', () => {
    const opened = openCheckout({ theme: 'dark' });
    expect(opened.frame.title).toBe('elisym checkout');
    expect(opened.frame.style.border).toMatch(/^0(px)?$/);
    expect(opened.frame.style.width).toBe('100%');
    expect(opened.frame.style.height).toBe('360px');
    expect(opened.frame.style.colorScheme).toBe('dark');
    expect(opened.frame.style.display).toBe('block');
    // On the stylesheet path nothing is laid out inline.
    expect(opened.frame.style.maxHeight).toBe('');
    expect(opened.dialog.style.background).toBe('');
    expect(opened.dialog.getAttribute('part')).toBe('dialog');
    expect(opened.closeButton.parentElement?.className).toBe('chrome');
    expect(opened.closeButton.type).toBe('button');
    expect(opened.closeButton.getAttribute('aria-label')).toBe('Close');
    expect(opened.closeButton.textContent).toBe('×');
    opened.handle.close();
    expect(openCheckout({ theme: 'light' }).frame.style.colorScheme).toBe('light');
    expect(openCheckout().frame.style.colorScheme).toBe('light dark');
    const mounted = mount();
    expect(mounted.button.type).toBe('button');
    expect(mounted.button.className).toBe('buy');
  });

  it('a height is clamped and rounded up; anything but a finite number is ignored', () => {
    const opened = openCheckout();
    const heights: unknown[] = [Infinity, Number.NaN, '500', 50, 5000, 400.2];
    const seen = heights.map((height) => {
      deliver({ type: 'resize', height }, ORIGIN, opened.target);
      return opened.frame.style.height;
    });
    expect(seen).toEqual(['360px', '360px', '360px', '120px', '2000px', '401px']);
    // A height on another message is not a resize.
    deliver({ type: 'close', height: 500 }, ORIGIN, opened.target);
    expect(opened.frame.style.height).toBe('401px');
    expect(opened.events).toEqual(['close']);
  });

  it('a reload restarts one hello: one post per tick, and hello gives up exactly after 10 s', () => {
    vi.useFakeTimers();
    const opened = openCheckout();
    opened.frame.dispatchEvent(new Event('load'));
    const posted = opened.target.posted.length;
    vi.advanceTimersByTime(250);
    expect(opened.target.posted).toHaveLength(posted + 1);
    vi.advanceTimersByTime(9_750);
    expect(opened.events).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(opened.events).toEqual(['error:unavailable']);
    // Nothing keeps running once it gave up (the reveal timer is long gone).
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the first focus is given once, not again when the frame shows', () => {
    vi.useFakeTimers();
    const focus = vi.spyOn(HTMLIFrameElement.prototype, 'focus');
    openCheckout();
    vi.advanceTimersByTime(300);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('a close event while the dialog is still open is not a close', async () => {
    const opened = openCheckout();
    opened.dialog.dispatchEvent(new Event('close'));
    expect(await settled(opened.handle)).toBe(false);
    expect(opened.dialog.open).toBe(true);
  });

  it('a first click on the backdrop with no press at all does not close', async () => {
    const opened = openCheckout();
    stubRect(opened.dialog);
    opened.dialog.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 50 }),
    );
    expect(await settled(opened.handle)).toBe(false);
  });

  it('without showModal, the page scroll comes back only when the last overlay closes', async () => {
    await withoutShowModal(() => {
      document.documentElement.style.overflow = 'scroll';
      const first = openCheckout();
      const mounted = mount();
      mounted.button.click();
      expect(document.documentElement.style.overflow).toBe('hidden');
      first.handle.close();
      expect(document.documentElement.style.overflow).toBe('hidden');
      mounted.dialog.parentElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(document.documentElement.style.overflow).toBe('scroll');
    });
  });

  it('a click on the backdrop closes only with its press there too, and only outside the box', async () => {
    const outside: [number, number][] = [
      [50, 300],
      [550, 300],
      [300, 50],
      [300, 650],
    ];
    for (const [clientX, clientY] of outside) {
      const opened = openCheckout();
      stubRect(opened.dialog);
      // On the edge of the box: inside.
      for (const [edgeX, edgeY] of [
        [100, 300],
        [500, 300],
        [300, 100],
        [300, 600],
      ] as const) {
        click(opened.dialog, edgeX, edgeY);
      }
      // A click with no press before it, and a click after a press elsewhere.
      opened.dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
      press(opened.dialog, clientX, clientY);
      opened.dialog.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 300, clientY: 300 }),
      );
      opened.dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
      expect(await settled(opened.handle), `${clientX},${clientY}`).toBe(false);
      click(opened.dialog, clientX, clientY);
      expect(await settled(opened.handle), `${clientX},${clientY}`).toBe(true);
    }
  });

  it('without showModal: the overlay is hidden for real until open, and only the backdrop or Escape closes it', async () => {
    await withoutShowModal(async () => {
      const removed = vi.spyOn(document, 'removeEventListener');
      const mounted = mount();
      const overlay = mounted.dialog.parentElement;
      expect(overlay?.style.getPropertyValue('display')).toBe('none');
      expect(overlay?.style.getPropertyPriority('display')).toBe('important');
      mounted.button.click();
      expect(overlay?.style.display).toBe('flex');
      expect(mounted.dialog.style.position).toBe('static');
      // A click inside the dialog bubbles to the overlay: not a close. Nor another key.
      mounted.dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(overlay?.hidden).toBe(false);
      const focus = vi.spyOn(mounted.button, 'focus');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(overlay?.style.getPropertyValue('display')).toBe('none');
      expect(overlay?.style.getPropertyPriority('display')).toBe('important');
      // A buyer's close: focus goes back to the button, and Escape is no longer listened to.
      expect(focus).toHaveBeenCalledTimes(1);
      expect(removed.mock.calls.some(([type]) => type === 'keydown')).toBe(true);
      expect(mounted.events).toEqual(['elisym-open', 'elisym-close']);
    });
  });

  it('a second gate (a reload while open) waits its own 300 ms', () => {
    vi.useFakeTimers();
    const mounted = mount();
    mounted.button.click();
    vi.advanceTimersByTime(200);
    mounted.element.setAttribute('theme', 'dark');
    const fresh = frameOf(mounted);
    const focus = vi.spyOn(fresh, 'focus');
    vi.advanceTimersByTime(200);
    expect(fresh.style.opacity).toBe('0');
    deliver({ type: 'resize', height: 400 }, ORIGIN, targetOf(fresh));
    expect(fresh.style.opacity).toBe('');
    deliver({ type: 'resize', height: 410 }, ORIGIN, targetOf(fresh));
    vi.advanceTimersByTime(300);
    // Focused once, when it showed.
    expect(focus).toHaveBeenCalledTimes(1);
    // The stylesheet path keeps the dialog's look in the sheet.
    expect(mounted.dialog.style.background).toBe('');
  });
});

describe('<elisym-buy> v4, details the v3 tests leave open', () => {
  it('a frame replaced by a reload is no longer heard', () => {
    const mounted = mount();
    const old = frameOf(mounted);
    const states: unknown[] = [];
    mounted.element.addEventListener('elisym-status', (event) => {
      states.push((event as CustomEvent<{ state: string }>).detail.state);
    });
    mounted.element.setAttribute('theme', 'dark');
    deliver({ type: 'status', state: 'paid' }, ORIGIN, targetOf(old));
    deliver({ type: 'status', state: 'ready' }, ORIGIN, targetOf(frameOf(mounted)));
    expect(states).toEqual(['ready']);
  });

  it('the page hears elisym-open, elisym-status and elisym-close bubble up', async () => {
    const heard: string[] = [];
    const listener = (event: Event) => heard.push(event.type);
    const types = ['elisym-open', 'elisym-status', 'elisym-close'];
    for (const type of types) {
      document.addEventListener(type, listener);
    }
    try {
      const mounted = mount();
      mounted.button.click();
      mounted.button.click();
      deliver({ type: 'status', state: 'ready' }, ORIGIN, targetOf(frameOf(mounted)));
      mounted.closeButton.click();
      await aTaskLater();
      expect(heard).toEqual(['elisym-open', 'elisym-status', 'elisym-close']);
    } finally {
      for (const type of types) {
        document.removeEventListener(type, listener);
      }
    }
  });

  it('removed while open, the page hears elisym-close on window too', () => {
    const mounted = mount();
    const heard: unknown[] = [];
    const listener = (event: Event) => heard.push(event.type);
    window.addEventListener('elisym-close', listener);
    mounted.button.click();
    mounted.element.remove();
    window.removeEventListener('elisym-close', listener);
    expect(heard).toEqual(['elisym-close']);
  });

  it('an inline reload keeps the frame where it was among the children', () => {
    standInWindows();
    const element = document.createElement('elisym-buy');
    element.setAttribute('product', NADDR);
    element.setAttribute('display', 'inline');
    document.body.appendChild(element);
    const note = document.createElement('span');
    element.appendChild(note);
    element.setAttribute('theme', 'dark');
    const frames = element.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(element.firstElementChild).toBe(frames[0]);
    expect(element.lastElementChild).toBe(note);
  });

  it('a frame the page took out is framed again on any attribute', () => {
    standInWindows();
    const element = document.createElement('elisym-buy');
    element.setAttribute('product', NADDR);
    element.setAttribute('display', 'inline');
    document.body.appendChild(element);
    element.innerHTML = '';
    // Not a change to what the checkout receives: still, the frame is gone, so it comes back.
    element.setAttribute('theme', 'auto');
    expect(element.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('a pending button follows its display: inline hides it, modal shows it again', () => {
    const mounted = mount({ 'customer-ref': '' });
    mounted.element.setAttribute('display', 'inline');
    expect(mounted.button.hidden).toBe(true);
    mounted.element.setAttribute('display', 'modal');
    expect(mounted.button.hidden).toBe(false);
  });

  it('a pending button shows only with a product', () => {
    standInWindows();
    for (const product of [undefined, 'npub1qqtest']) {
      const element = document.createElement('elisym-buy');
      if (product !== undefined) {
        element.setAttribute('product', product);
      }
      element.setAttribute('customer-ref', '');
      document.body.appendChild(element);
      expect(element.shadowRoot, product).toBeNull();
    }
  });

  it('on the stylesheet path, hiding and showing the chrome sets no inline style', () => {
    const mounted = mount();
    mounted.element.setAttribute('display', 'inline');
    expect(mounted.button.hidden).toBe(true);
    expect(mounted.button.style.display).toBe('');
    expect(mounted.dialog.style.display).toBe('');
    expect(mounted.closeButton.parentElement?.style.display).toBe('');
  });

  it('a fresh loader adopts its stylesheet from the very first element', async () => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = await import('../src/embed/v4/embed');
    customElements.define('elisym-buy-first', fresh.ElisymBuy);
    standInWindows();
    const element = document.createElement('elisym-buy-first');
    element.setAttribute('product', NADDR);
    document.body.appendChild(element);
    expect(element.shadowRoot?.adoptedStyleSheets).toHaveLength(1);
  });

  it('a valid reference says nothing; a refusal is told again after a valid one', () => {
    const errors = errorsLogged();
    const element = mountBare({ 'customer-ref': 'user_42' });
    element.setAttribute('theme', 'dark');
    expect(errors.told()).toEqual([]);
    element.setAttribute('customer-ref', 'bad ref');
    // Taken out and put back, twice: the same refusal is not told again.
    for (let round = 0; round < 2; round += 1) {
      element.remove();
      document.body.appendChild(element);
    }
    expect(errors.told()).toHaveLength(1);
    element.setAttribute('customer-ref', 'user_43');
    element.setAttribute('customer-ref', 'bad ref');
    expect(errors.told()).toHaveLength(2);
  });

  it('a waiting button on the stylesheet path is not styled inline', () => {
    const mounted = mount({ 'customer-ref': '' });
    expect(mounted.button.style.opacity).toBe('');
    expect(mounted.button.style.cursor).toBe('');
  });
});

describe('the CSSOM path, details', () => {
  it('styles the button, the strip and the frame by hand, and copes without matchMedia', async () => {
    const { fresh, restore } = await byHandLoader();
    try {
      customElements.define('elisym-buy-details', fresh.ElisymBuy);
      standInWindows();
      const element = document.createElement('elisym-buy-details');
      element.setAttribute('product', NADDR);
      document.body.appendChild(element);
      const shadow = element.shadowRoot;
      if (shadow === null) {
        throw new Error('no shadow root');
      }
      const { button, dialog, closeButton } = partsOf(shadow);
      expect(button.style.borderRadius).toBe('10px');
      expect(closeButton.parentElement?.style.display).toBe('flex');
      expect(closeButton.style.width).toBe('32px');
      // Preloaded, the frame is already capped to the dialog.
      expect(frameOf({ dialog }).style.maxHeight).toBe('calc(90vh - 44px)');
      // Turned inline and back: the hidden button's inline `display` goes again.
      element.setAttribute('display', 'inline');
      expect(button.style.getPropertyPriority('display')).toBe('important');
      element.setAttribute('display', 'modal');
      expect(button.style.display).toBe('');
      vi.stubGlobal('matchMedia', undefined);
      const opens = vi.fn();
      element.addEventListener('elisym-open', opens);
      button.click();
      expect(dialog.open).toBe(true);
      expect(opens).toHaveBeenCalledTimes(1);
      expect(dialog.style.margin).toBe('auto');
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it('on a phone, the frame is capped to 92vh', async () => {
    const { fresh, restore } = await byHandLoader();
    try {
      fakeMatchMedia({ '(max-width: 639px)': true });
      standInWindows();
      fresh.PAY_CORE.open({ product: NADDR });
      const frame = hostsOnPage()[0]?.shadowRoot?.querySelector('iframe');
      expect(frame?.style.maxHeight).toBe('calc(92vh - 44px)');
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it('without showModal, the overlay follows the screen while open', async () => {
    const { fresh, restore } = await byHandLoader();
    try {
      await withoutShowModal(() => {
        const media = fakeMatchMedia({ '(max-width: 639px)': false });
        standInWindows();
        const handle = fresh.PAY_CORE.open({ product: NADDR });
        const overlay = hostsOnPage()[0]?.shadowRoot?.querySelector('dialog')?.parentElement;
        expect(overlay?.style.alignItems).toBe('center');
        media.change('(max-width: 639px)', true);
        expect(overlay?.style.alignItems).toBe('flex-end');
        handle.close();
        expect(media.listening()).toBe(0);
      });
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it('on the stylesheet path, nothing follows the screen', () => {
    const media = fakeMatchMedia({});
    try {
      openCheckout();
      expect(media.listening()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
