/**
 * `embed.js`: the only code that runs on the merchant's page. It frames the
 * checkout and relays a state name; every check, the order and the payment live
 * in the iframe on the checkout's own origin, where a compromised page script
 * cannot reach them.
 *
 *   <elisym-buy product="naddr1..." network="devnet" strict-origin theme="auto"></elisym-buy>
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
 * is pointless. Counted from the frame's `load`, which fires after its entry
 * script registered its listener - never from when the element was connected,
 * or a slow load would outlast it.
 */
const HELLO_FOR_MS = 10_000;
const INITIAL_HEIGHT = 360;

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
  };
}

export class ElisymBuy extends HTMLElement {
  static readonly observedAttributes = ['product', 'network', 'strict-origin', 'theme'];

  private frame: HTMLIFrameElement | undefined;
  /** The parameters the current frame was built with. */
  private framed: string | undefined;
  private helloTimer: ReturnType<typeof setInterval> | undefined;
  private readonly onMessage = (event: MessageEvent) => this.receive(event);

  /**
   * A framework may set or change attributes after inserting the element: frame
   * it anew whenever what the checkout receives changes (`strict-origin` must
   * never be lost to the order the attributes arrive in), and never otherwise -
   * a reload would drop a checkout in progress.
   */
  attributeChangedCallback(): void {
    if (!this.isConnected) {
      return;
    }
    this.forgetDetachedFrame();
    const params = paramsOf(this);
    const wanted = params === undefined ? undefined : encodeCheckoutParams(params);
    if (wanted === this.framed) {
      return;
    }
    this.disconnectedCallback();
    this.connectedCallback();
  }

  connectedCallback(): void {
    this.forgetDetachedFrame();
    const params = paramsOf(this);
    if (params === undefined || this.frame !== undefined) {
      return;
    }
    const frame = document.createElement('iframe');
    this.framed = encodeCheckoutParams(params);
    frame.src = `${CHECKOUT_ORIGIN}/checkout#${this.framed}`;
    frame.title = 'elisym checkout';
    frame.style.border = '0';
    frame.style.width = '100%';
    frame.style.height = `${INITIAL_HEIGHT}px`;
    frame.style.colorScheme = 'normal';
    this.frame = frame;
    window.addEventListener('message', this.onMessage);
    // Every load of the checkout document (a reload too) starts its own handshake.
    // A frame this element dropped (page code may re-insert it) never touches the current one.
    frame.addEventListener('load', () => {
      if (this.frame === frame) {
        this.startHello(frame);
      }
    });
    this.appendChild(frame);
    this.startHello(frame);
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

  /** Page code or a framework may clear the element's children: a frame it removed is gone. */
  private forgetDetachedFrame(): void {
    if (this.frame !== undefined && this.frame.parentNode !== this) {
      this.disconnectedCallback();
    }
  }

  disconnectedCallback(): void {
    this.stopHello();
    window.removeEventListener('message', this.onMessage);
    this.frame?.remove();
    this.frame = undefined;
    this.framed = undefined;
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
      }
    } else if (message.type === 'status' && isCheckoutState(message.state)) {
      this.dispatchEvent(
        new CustomEvent('elisym-status', { detail: { state: message.state }, bubbles: true }),
      );
    }
  }
}

if (typeof customElements !== 'undefined' && customElements.get('elisym-buy') === undefined) {
  customElements.define('elisym-buy', ElisymBuy);
}
