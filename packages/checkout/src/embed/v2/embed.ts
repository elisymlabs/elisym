/**
 * `v2/embed.js`: the only code that runs on the merchant's page. It frames the
 * checkout, by default behind a button in a modal dialog, and relays a state
 * name; every check, the order and the payment live in the iframe on the
 * checkout's own origin, where a compromised page script cannot reach them.
 *
 *   <elisym-buy product="naddr1..." network="devnet" label="Buy course"></elisym-buy>
 *   <elisym-buy product="naddr1..." display="inline"></elisym-buy>
 *
 * Frozen once `v2.sri` is published: a change ships as a new loader (`/v3/`).
 */
import {
  type CheckoutParams,
  MAX_FRAME_HEIGHT,
  MIN_FRAME_HEIGHT,
  encodeCheckoutParams,
  isCheckoutState,
} from './protocol';

declare const __CHECKOUT_ORIGIN__: string;

/** Where the checkout is served; fixed at build time, never taken from the page. */
const CHECKOUT_ORIGIN = __CHECKOUT_ORIGIN__;
const HELLO_EVERY_MS = 250;
/**
 * How long hello is repeated after each load of the checkout document: the
 * iframe refuses by itself 5 s after it starts without a hello, so past that it
 * is pointless. Counted from the frame's `load`, never from when the element
 * was connected, or a slow load would outlast it.
 */
const HELLO_FOR_MS = 10_000;
const INITIAL_HEIGHT = 360;
/** The loader's own strip above the frame, holding the close button. */
const CHROME_HEIGHT = 44;
/** The longest a shown frame stays transparent, waiting for its first height. */
const REVEAL_WITHIN_MS = 300;
const DEFAULT_LABEL = 'Buy';
const PHONE_QUERY = '(max-width: 639px)';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const LIGHT_COLORS = { background: '#ffffff', text: '#111418' };
const DARK_COLORS = { background: '#121417', text: '#eef1f4' };

/**
 * The loader's look, adopted by its shadow root (constructable stylesheets are
 * not gated by the page's `style-src`, unlike a `<style>` element, which is
 * never used).
 */
const STYLES = `
[hidden]{display:none!important}
.buy{font:inherit;font-weight:600;padding:10px 20px;border:0;border-radius:10px;background:#3b5bdb;color:#fff;cursor:pointer}
.buy:focus-visible{outline:2px solid #3b5bdb;outline-offset:2px}
dialog{box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-width:none;max-height:90vh;max-height:90dvh;padding:0;border:0;border-radius:16px;overflow:hidden;background:${LIGHT_COLORS.background};color:${LIGHT_COLORS.text};box-shadow:0 24px 64px rgba(0,0,0,.28)}
dialog::backdrop{background:rgba(10,12,16,.55)}
dialog[data-theme=dark]{background:${DARK_COLORS.background};color:${DARK_COLORS.text}}
@media ${DARK_QUERY}{dialog[data-theme=auto]{background:${DARK_COLORS.background};color:${DARK_COLORS.text}}}
.chrome{display:flex;align-items:center;justify-content:flex-end;height:${CHROME_HEIGHT}px;padding:0 6px;box-sizing:border-box}
.close{width:32px;height:32px;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;font:20px/1 system-ui,sans-serif;cursor:pointer}
.close:hover{background:rgba(127,127,127,.16)}
.close:focus-visible{outline:2px solid #3b5bdb;outline-offset:-2px}
iframe{display:block;width:100%;border:0;max-height:calc(90vh - ${CHROME_HEIGHT}px);max-height:calc(90dvh - ${CHROME_HEIGHT}px)}
@media ${PHONE_QUERY}{dialog{width:100vw;max-height:92vh;max-height:92dvh;margin:auto 0 0;border-radius:16px 16px 0 0}iframe{max-height:calc(92vh - ${CHROME_HEIGHT}px);max-height:calc(92dvh - ${CHROME_HEIGHT}px)}}
`;

/** The loader's own parts, in its shadow root (made the first time the element is a modal). */
interface Chrome {
  button: HTMLButtonElement;
  dialog: HTMLDialogElement;
  /** Only where `showModal` is missing: a fixed overlay around the dialog. */
  overlay: HTMLDivElement | undefined;
  /** Styled through CSSOM, where constructable stylesheets are missing. */
  byHand: boolean;
}

function paramsOf(element: HTMLElement): CheckoutParams | undefined {
  const naddr = element.getAttribute('product');
  if (naddr === null || !naddr.startsWith('naddr1')) {
    return undefined;
  }
  const network = element.getAttribute('network');
  const theme = element.getAttribute('theme');
  return {
    naddr,
    ...(network === 'mainnet' || network === 'devnet' ? { network } : {}),
    strictOrigin: element.hasAttribute('strict-origin'),
    theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
    collectEmail: element.hasAttribute('collect-email'),
    display: element.getAttribute('display') === 'inline' ? 'inline' : 'modal',
  };
}

function labelOf(element: HTMLElement): string {
  // An empty label would leave a blank button with no accessible name.
  const label = element.getAttribute('label')?.trim();
  return label === undefined || label === '' ? DEFAULT_LABEL : label;
}

let sharedSheet: CSSStyleSheet | undefined;

/** The adopted stylesheet, made once and on first use; none where it is unsupported. */
function adoptedSheet(): CSSStyleSheet | undefined {
  if (sharedSheet !== undefined) {
    return sharedSheet;
  }
  try {
    if (typeof ShadowRoot === 'undefined' || !('adoptedStyleSheets' in ShadowRoot.prototype)) {
      return undefined;
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    sharedSheet = sheet;
    return sheet;
  } catch {
    return undefined;
  }
}

/** Open fallback overlays: the page's scroll is locked by the first and given back by the last. */
let scrollLocks = 0;
let pageOverflow = '';

function lockPageScroll(): void {
  if (scrollLocks === 0) {
    pageOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  }
  scrollLocks += 1;
}

function unlockPageScroll(): void {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) {
    document.documentElement.style.overflow = pageOverflow;
  }
}

function matches(query: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(query).matches;
}

/** `hidden`, made to hold against page CSS on the CSSOM path too. */
function setHidden(node: HTMLElement, hidden: boolean, byHand: boolean): void {
  node.hidden = hidden;
  if (byHand) {
    if (hidden) {
      node.style.setProperty('display', 'none', 'important');
    } else {
      node.style.removeProperty('display');
    }
  }
}

function colorSchemeOf(theme: CheckoutParams['theme']): string {
  return theme === 'auto' ? 'light dark' : theme;
}

export class ElisymBuy extends HTMLElement {
  static readonly observedAttributes = [
    'product',
    'network',
    'strict-origin',
    'theme',
    'collect-email',
    'display',
    'label',
  ];

  private frame: HTMLIFrameElement | undefined;
  /** The parameters the current frame was built with. */
  private framed: CheckoutParams | undefined;
  private helloTimer: ReturnType<typeof setInterval> | undefined;
  private listening = false;
  private chrome: Chrome | undefined;
  /** Set on open, cleared by the one close that runs the bookkeeping. */
  private isOpen = false;
  /** The press of the current click began on the backdrop (a drag from the card never closes). */
  private pressedOnBackdrop = false;
  /**
   * Set once connected: on upgrade, attributes are reported before the
   * element is connected-called, and would otherwise frame it by half its
   * attributes (a modal chrome for an inline element).
   */
  private connectedOnce = false;
  /** A shown frame kept transparent until its first height (or a short while). */
  private gated: { frame: HTMLIFrameElement; focus: boolean } | undefined;
  private revealTimer: ReturnType<typeof setTimeout> | undefined;
  /** While open on the by-hand path: stops following the screen and the OS theme. */
  private stopRestyling: (() => void) | undefined;
  private readonly onMessage = (event: MessageEvent) => this.receive(event);
  private readonly onPageKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.close();
    }
  };

  /**
   * A framework may set or change attributes after inserting the element: frame
   * it anew whenever what the checkout receives changes (`strict-origin` must
   * never be lost to the order the attributes arrive in), and never otherwise -
   * a reload would drop a checkout in progress. `label` never reloads.
   */
  attributeChangedCallback(name: string): void {
    if (name === 'label') {
      if (this.chrome !== undefined) {
        this.chrome.button.textContent = labelOf(this);
      }
      return;
    }
    if (!this.isConnected || !this.connectedOnce) {
      return;
    }
    this.forgetDetachedFrame();
    if (!this.paramsChanged()) {
      return;
    }
    const wasOpen = this.isOpen;
    if (wasOpen && paramsOf(this)?.display !== 'modal') {
      this.shut();
      // Page code answering `elisym-close` may have removed or changed the element.
      if (!this.isConnected || !this.paramsChanged()) {
        return;
      }
    }
    this.frameFor(paramsOf(this));
    const frame = this.frame;
    if (frame === undefined || !wasOpen) {
      return;
    }
    if (this.isOpen) {
      // Reloaded while open: the new frame shows like the first one did, then takes focus.
      // Styled by hand, the dialog takes the new theme now, not at the next open.
      if (this.chrome?.byHand === true && this.framed !== undefined) {
        styleDialogByHand(this.chrome, frame, this.framed.theme);
      }
      this.gate(frame, true);
    } else {
      frame.focus();
    }
  }

  /** Whether what the checkout would receive differs from the current frame's. */
  private paramsChanged(): boolean {
    const params = paramsOf(this);
    const wanted = params === undefined ? undefined : encodeCheckoutParams(params);
    const framed = this.framed === undefined ? undefined : encodeCheckoutParams(this.framed);
    return wanted !== framed;
  }

  connectedCallback(): void {
    this.connectedOnce = true;
    this.forgetDetachedFrame();
    if (this.frame === undefined) {
      this.frameFor(paramsOf(this));
    }
  }

  disconnectedCallback(): void {
    // Removed from the page: the bookkeeping runs now and once, and focus stays put.
    this.shut();
    // Page code answering `elisym-close` put it back: connectedCallback has run.
    if (this.isConnected) {
      return;
    }
    this.dropFrame();
    if (this.listening) {
      window.removeEventListener('message', this.onMessage);
      this.listening = false;
    }
  }

  /**
   * Build a frame for `params` where its display puts it (the element itself
   * when inline, the dialog when modal), replacing any current one in place,
   * and show or hide the button and the dialog to match.
   */
  private frameFor(params: CheckoutParams | undefined): void {
    const modal = params?.display === 'modal';
    const chrome = modal ? this.ensureChrome() : this.chrome;
    if (chrome !== undefined) {
      setHidden(chrome.button, !modal, chrome.byHand);
      setHidden(chrome.dialog, !modal, chrome.byHand);
      if (params !== undefined) {
        chrome.dialog.dataset.theme = params.theme;
      }
    }
    const old = this.frame;
    this.dropFrame(false);
    if (params === undefined) {
      old?.remove();
      return;
    }
    const frame = document.createElement('iframe');
    frame.src = `${CHECKOUT_ORIGIN}/checkout#${encodeCheckoutParams(params)}`;
    frame.title = 'elisym checkout';
    frame.setAttribute('allow', 'clipboard-write');
    frame.style.border = '0';
    frame.style.width = '100%';
    frame.style.height = `${INITIAL_HEIGHT}px`;
    frame.style.colorScheme = colorSchemeOf(params.theme);
    this.frame = frame;
    this.framed = params;
    if (!this.listening) {
      window.addEventListener('message', this.onMessage);
      this.listening = true;
    }
    // Every load of the checkout document (a reload too) starts its own handshake.
    // A frame this element dropped (page code may re-insert it) never touches the current one.
    frame.addEventListener('load', () => {
      if (this.frame === frame) {
        this.startHello(frame);
      }
    });
    if (modal && chrome !== undefined) {
      frame.style.display = 'block';
      if (chrome.byHand) {
        frame.style.maxHeight = `calc(90vh - ${CHROME_HEIGHT}px)`;
      }
      chrome.dialog.appendChild(frame);
    } else if (old !== undefined && old.parentNode === this) {
      this.insertBefore(frame, old);
    } else {
      this.appendChild(frame);
    }
    old?.remove();
    this.startHello(frame);
  }

  /** Forget the current frame: its handshake stops, and (unless kept for a swap) it goes. */
  private dropFrame(remove = true): void {
    this.stopHello();
    if (this.gated !== undefined && this.gated.frame === this.frame) {
      this.reveal();
    }
    if (remove) {
      this.frame?.remove();
    }
    this.frame = undefined;
    this.framed = undefined;
  }

  /** Page code or a framework may clear the element's children: a frame it removed is gone. */
  private forgetDetachedFrame(): void {
    const frame = this.frame;
    if (frame === undefined) {
      return;
    }
    const home = this.framed?.display === 'modal' ? this.chrome?.dialog : this;
    if (frame.parentNode !== home) {
      this.dropFrame();
    }
  }

  private ensureChrome(): Chrome {
    if (this.chrome !== undefined) {
      return this.chrome;
    }
    const root = this.attachShadow({ mode: 'open' });
    // The default slot keeps the light DOM (an inline frame) rendered.
    root.appendChild(document.createElement('slot'));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'buy';
    button.setAttribute('part', 'button');
    button.textContent = labelOf(this);
    button.addEventListener('click', () => this.open());
    const dialog = document.createElement('dialog');
    dialog.setAttribute('part', 'dialog');
    dialog.setAttribute('aria-label', 'Checkout');
    const strip = document.createElement('div');
    strip.className = 'chrome';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => this.close());
    strip.appendChild(close);
    dialog.appendChild(strip);
    dialog.addEventListener('close', () => {
      if (this.isOpen && !dialog.open) {
        this.finishClose(true);
      }
    });
    dialog.addEventListener('pointerdown', (event) => {
      this.pressedOnBackdrop = this.onBackdrop(event);
    });
    dialog.addEventListener('click', (event) => this.backdropClick(event));
    let overlay: HTMLDivElement | undefined;
    root.appendChild(button);
    if (typeof dialog.showModal === 'function') {
      root.appendChild(dialog);
    } else {
      overlay = document.createElement('div');
      overlay.hidden = true;
      overlay.style.setProperty('display', 'none', 'important');
      overlay.appendChild(dialog);
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
          this.close();
        }
      });
      root.appendChild(overlay);
    }
    const sheet = adoptedSheet();
    if (sheet !== undefined) {
      root.adoptedStyleSheets = [sheet];
    }
    this.chrome = { button, dialog, overlay, byHand: sheet === undefined };
    if (sheet === undefined) {
      styleByHand(button, strip, close);
    }
    return this.chrome;
  }

  private open(): void {
    const chrome = this.chrome;
    const frame = this.frame;
    if (
      chrome === undefined ||
      frame === undefined ||
      this.isOpen ||
      this.framed?.display !== 'modal'
    ) {
      return;
    }
    if (chrome.byHand) {
      styleDialogByHand(chrome, frame, this.framed.theme);
    }
    if (chrome.overlay !== undefined) {
      styleOverlay(chrome.overlay, chrome.dialog);
    }
    if (chrome.overlay === undefined) {
      try {
        chrome.dialog.showModal();
      } catch {
        return;
      }
    } else {
      setHidden(chrome.overlay, false, false);
      chrome.overlay.style.removeProperty('display');
      chrome.overlay.style.display = 'flex';
      lockPageScroll();
      document.addEventListener('keydown', this.onPageKeydown);
    }
    if (chrome.byHand) {
      this.followScreen(chrome);
    }
    this.isOpen = true;
    this.gate(frame, false);
    frame.focus();
    this.dispatchEvent(new CustomEvent('elisym-open', { bubbles: true }));
  }

  /**
   * Styled by hand, the dialog follows the screen (phone or not) and the OS
   * theme while open, as the stylesheet does on its own.
   */
  private followScreen(chrome: Chrome): void {
    if (typeof matchMedia !== 'function') {
      return;
    }
    const restyle = () => {
      const frame = this.frame;
      if (frame === undefined || this.framed === undefined) {
        return;
      }
      styleDialogByHand(chrome, frame, this.framed.theme);
      if (chrome.overlay !== undefined) {
        styleOverlay(chrome.overlay, chrome.dialog);
      }
    };
    const queries = [matchMedia(PHONE_QUERY), matchMedia(DARK_QUERY)];
    for (const query of queries) {
      query.addEventListener('change', restyle);
    }
    this.stopRestyling = () => {
      for (const query of queries) {
        query.removeEventListener('change', restyle);
      }
    };
  }

  /** The buyer closes: every path ends in the dialog's own close, which does the bookkeeping. */
  private close(): void {
    const chrome = this.chrome;
    if (chrome === undefined || !this.isOpen) {
      return;
    }
    if (chrome.overlay === undefined) {
      chrome.dialog.close();
    } else {
      this.finishClose(true);
    }
  }

  /** The element closes for its own reasons (removal, a display change): bookkeeping now, focus stays. */
  private shut(): void {
    const chrome = this.chrome;
    if (chrome === undefined || !this.isOpen) {
      return;
    }
    this.finishClose(false);
    // Its `close` event finds the bookkeeping done.
    if (chrome.overlay === undefined && chrome.dialog.open) {
      chrome.dialog.close();
    }
  }

  /** The bookkeeping of a close, once per open. */
  private finishClose(returnFocus: boolean): void {
    const chrome = this.chrome;
    if (chrome === undefined || !this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.reveal();
    if (chrome.overlay !== undefined) {
      setHidden(chrome.overlay, true, true);
      unlockPageScroll();
      document.removeEventListener('keydown', this.onPageKeydown);
    }
    this.stopRestyling?.();
    this.stopRestyling = undefined;
    const detail = { element: this };
    // Taken first: a listener removing the element must not make the page hear it twice.
    const reachesPage = this.isConnected;
    this.dispatchEvent(new CustomEvent('elisym-close', { bubbles: true, detail }));
    if (!reachesPage) {
      // Removed from the page, the element no longer bubbles to it: the page hears it once anyway.
      document.dispatchEvent(new CustomEvent('elisym-close', { bubbles: true, detail }));
    }
    if (returnFocus && !chrome.button.hidden) {
      chrome.button.focus();
    }
  }

  /** On the backdrop: on the dialog itself, outside its box (never on the strip). */
  private onBackdrop(event: MouseEvent): boolean {
    const dialog = this.chrome?.dialog;
    if (dialog === undefined || event.target !== dialog) {
      return false;
    }
    const box = dialog.getBoundingClientRect();
    return (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    );
  }

  /** A click pressed and released on the backdrop closes; one pressed on the card never does. */
  private backdropClick(event: MouseEvent): void {
    const pressed = this.pressedOnBackdrop;
    this.pressedOnBackdrop = false;
    if (pressed && this.onBackdrop(event)) {
      this.close();
    }
  }

  /** Keep a shown frame transparent until its first height, or `REVEAL_WITHIN_MS`. */
  private gate(frame: HTMLIFrameElement, focus: boolean): void {
    this.reveal();
    frame.style.opacity = '0';
    this.gated = { frame, focus };
    this.revealTimer = setTimeout(() => this.reveal(), REVEAL_WITHIN_MS);
  }

  private reveal(): void {
    if (this.revealTimer !== undefined) {
      clearTimeout(this.revealTimer);
      this.revealTimer = undefined;
    }
    const gated = this.gated;
    if (gated === undefined) {
      return;
    }
    this.gated = undefined;
    gated.frame.style.removeProperty('opacity');
    if (gated.focus && this.isOpen && gated.frame === this.frame) {
      gated.frame.focus();
    }
  }

  /** Say hello to the checkout origin until it acknowledges, for a while after each start. */
  private startHello(frame: HTMLIFrameElement): void {
    this.stopHello();
    const started = Date.now();
    const hello = () => {
      if (Date.now() - started > HELLO_FOR_MS) {
        this.stopHello();
        return;
      }
      frame.contentWindow?.postMessage({ type: 'hello' }, CHECKOUT_ORIGIN);
    };
    this.helloTimer = setInterval(hello, HELLO_EVERY_MS);
    hello();
  }

  private stopHello(): void {
    if (this.helloTimer !== undefined) {
      clearInterval(this.helloTimer);
      this.helloTimer = undefined;
    }
  }

  /** Only the checkout's own origin AND this element's own iframe are heard. */
  private receive(event: MessageEvent): void {
    const frame = this.frame;
    if (
      frame === undefined ||
      event.origin !== CHECKOUT_ORIGIN ||
      event.source === null ||
      event.source !== frame.contentWindow
    ) {
      return;
    }
    const data: unknown = event.data;
    if (data === null || typeof data !== 'object') {
      return;
    }
    const message = data as { type?: unknown; height?: unknown; state?: unknown };
    if (message.type === 'ack') {
      this.stopHello();
    } else if (message.type === 'resize' && typeof message.height === 'number') {
      if (Number.isFinite(message.height)) {
        const height = Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, message.height));
        frame.style.height = `${Math.ceil(height)}px`;
        if (this.gated?.frame === frame) {
          this.reveal();
        }
      }
    } else if (message.type === 'status' && isCheckoutState(message.state)) {
      this.dispatchEvent(
        new CustomEvent('elisym-status', { detail: { state: message.state }, bubbles: true }),
      );
    } else if (message.type === 'close') {
      this.close();
    }
  }
}

/** The CSSOM path's look for the button and the strip (best effort). */
function styleByHand(
  button: HTMLButtonElement,
  strip: HTMLDivElement,
  close: HTMLButtonElement,
): void {
  Object.assign(button.style, {
    font: 'inherit',
    fontWeight: '600',
    padding: '10px 20px',
    border: '0',
    borderRadius: '10px',
    background: '#3b5bdb',
    color: '#fff',
    cursor: 'pointer',
  });
  Object.assign(strip.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    height: `${CHROME_HEIGHT}px`,
    padding: '0 6px',
    boxSizing: 'border-box',
  });
  Object.assign(close.style, {
    width: '32px',
    height: '32px',
    padding: '0',
    border: '0',
    borderRadius: '8px',
    background: 'transparent',
    color: 'inherit',
    font: '20px/1 system-ui, sans-serif',
    cursor: 'pointer',
  });
}

/** The CSSOM path's dialog, laid out for the screen and theme at the moment it opens. */
function styleDialogByHand(
  chrome: Chrome,
  frame: HTMLIFrameElement,
  theme: CheckoutParams['theme'],
): void {
  const phone = matches(PHONE_QUERY);
  const dark = theme === 'dark' || (theme === 'auto' && matches(DARK_QUERY));
  const colors = dark ? DARK_COLORS : LIGHT_COLORS;
  const cap = phone ? 92 : 90;
  Object.assign(chrome.dialog.style, {
    boxSizing: 'border-box',
    // A phone gets a sheet at the bottom, as the stylesheet path does.
    margin: phone ? 'auto 0 0' : 'auto',
    width: phone ? '100vw' : 'min(420px, calc(100vw - 32px))',
    maxWidth: 'none',
    maxHeight: `${cap}vh`,
    padding: '0',
    border: '0',
    borderRadius: phone ? '16px 16px 0 0' : '16px',
    overflow: 'hidden',
    background: colors.background,
    color: colors.text,
    boxShadow: '0 24px 64px rgba(0,0,0,.28)',
  });
  frame.style.maxHeight = `calc(${cap}vh - ${CHROME_HEIGHT}px)`;
}

/**
 * Where `showModal` is missing (so is the dialog element, in practice): a fixed
 * overlay dims the page and holds the dialog, styled through CSSOM only.
 */
function styleOverlay(overlay: HTMLDivElement, dialog: HTMLDialogElement): void {
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    bottom: '0',
    left: '0',
    zIndex: '2147483647',
    alignItems: matches(PHONE_QUERY) ? 'flex-end' : 'center',
    justifyContent: 'center',
    background: 'rgba(10,12,16,.55)',
  });
  Object.assign(dialog.style, { display: 'block', position: 'static', margin: '0' });
}

if (typeof customElements !== 'undefined') {
  if (customElements.get('elisym-buy') === undefined) {
    customElements.define('elisym-buy', ElisymBuy);
  } else {
    // Another loader (v1, or v2 twice) came first and owns every <elisym-buy>.
    console.warn('elisym: <elisym-buy> is already defined; load one embed.js per page');
  }
}
