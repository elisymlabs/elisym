import { isPageOrigin } from '../core/offer';
import type { CheckoutState, FrameMessage } from '../embed/protocol';

/** No acceptable hello within this long: the widget refuses to show a Buy button. */
export const HELLO_TIMEOUT_MS = 5000;

export type HandshakeRefusal =
  /** The checkout is not inside a frame (opened directly). */
  | 'not_framed'
  /** No hello from the framing page in time (or only from an unusable origin). */
  | 'no_hello';

/** The part of `window` the handshake uses, so tests can stand in for it. */
export interface HandshakeWindow {
  parent: unknown;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Handshake {
  /** Post to the accepted page only (never `'*'`); a no-op before a hello is taken. */
  post(message: FrameMessage): void;
  status(state: CheckoutState): void;
  close(): void;
}

interface ParentWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * Take the page's hello - registered synchronously from the entry script, so a
 * slow load never misses one. Only a hello whose source is the framing window
 * (`window.parent`, in a frame) and whose origin is a real http(s) origin counts,
 * and only the first: its origin is the page origin `verifyOffer` checks, and
 * every later message goes there alone. MetaMask's content script posts into
 * the frame with the frame's own origin, which is why the source rule is not
 * optional. A hello repeated by the same page is acknowledged again (the page
 * keeps saying hello until it hears the ack).
 */
export function acceptHandshake(
  self: HandshakeWindow,
  onAccepted: (pageOrigin: string) => void,
  onRefused: (reason: HandshakeRefusal) => void,
): Handshake {
  const parent = self.parent as ParentWindow | undefined;
  let pageOrigin: string | undefined;
  let settled = false;
  const post = (message: FrameMessage) => {
    if (pageOrigin !== undefined && parent !== undefined) {
      parent.postMessage(message, pageOrigin);
    }
  };
  const listener = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      event.source === null ||
      event.source !== self.parent ||
      data === null ||
      typeof data !== 'object' ||
      (data as { type?: unknown }).type !== 'hello'
    ) {
      return;
    }
    if (pageOrigin !== undefined) {
      if (event.origin === pageOrigin) {
        post({ type: 'ack' });
      }
      return;
    }
    if (settled || !isPageOrigin(event.origin)) {
      return;
    }
    settled = true;
    self.clearTimeout(timer);
    pageOrigin = event.origin;
    post({ type: 'ack' });
    onAccepted(pageOrigin);
  };
  if (parent === undefined || self.parent === self) {
    settled = true;
    onRefused('not_framed');
    return { post: () => undefined, status: () => undefined, close: () => undefined };
  }
  self.addEventListener('message', listener);
  const timer = self.setTimeout(() => {
    if (!settled) {
      settled = true;
      self.removeEventListener('message', listener);
      onRefused('no_hello');
    }
  }, HELLO_TIMEOUT_MS);
  return {
    post,
    status: (state) => post({ type: 'status', state }),
    close: () => {
      self.clearTimeout(timer);
      self.removeEventListener('message', listener);
    },
  };
}
