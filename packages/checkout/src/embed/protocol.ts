/**
 * The messages between the merchant page (`embed.js`) and the checkout iframe.
 * The page learns a state name only - never the delivery link, the buyer key or
 * the order id: a scam page framing a real store must not get the buyer's access.
 */

/** Page -> iframe: re-sent until acknowledged. */
export interface HelloMessage {
  type: 'hello';
}

/** Iframe -> page. */
export type FrameMessage =
  | { type: 'ack' }
  /** The height the iframe's content needs, in CSS pixels. */
  | { type: 'resize'; height: number }
  | { type: 'status'; state: CheckoutState };

/** What the page may learn about the purchase. */
export const CHECKOUT_STATES = [
  'ready',
  'ordered',
  'paying',
  'paid',
  'completed',
  'refunded',
  'ended',
  'refused',
] as const;

export type CheckoutState = (typeof CHECKOUT_STATES)[number];

/** The iframe is never shorter or taller than this. */
export const MIN_FRAME_HEIGHT = 120;
export const MAX_FRAME_HEIGHT = 2000;

export function isCheckoutState(value: unknown): value is CheckoutState {
  return typeof value === 'string' && (CHECKOUT_STATES as readonly string[]).includes(value);
}

/** The iframe's parameters, carried in the URL fragment (never sent to a server). */
export interface CheckoutParams {
  naddr: string;
  /** Only payouts on this network are offered. */
  network?: 'mainnet' | 'devnet';
  /** Refuse a store at levels B and C too, not only an off-domain level A one. */
  strictOrigin: boolean;
  theme: 'auto' | 'light' | 'dark';
  /** The merchant asks for the buyer's email (optional for the buyer). */
  collectEmail: boolean;
}

export function encodeCheckoutParams(params: CheckoutParams): string {
  const search = new URLSearchParams({ naddr: params.naddr });
  if (params.network !== undefined) {
    search.set('network', params.network);
  }
  if (params.strictOrigin) {
    search.set('strict', '1');
  }
  if (params.theme !== 'auto') {
    search.set('theme', params.theme);
  }
  if (params.collectEmail) {
    search.set('email', '1');
  }
  return search.toString();
}

/** Parse the fragment; `undefined` when it names no product. */
export function decodeCheckoutParams(fragment: string): CheckoutParams | undefined {
  const search = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  const naddr = search.get('naddr');
  if (naddr === null || !naddr.startsWith('naddr1')) {
    return undefined;
  }
  const network = search.get('network');
  const theme = search.get('theme');
  return {
    naddr,
    ...(network === 'mainnet' || network === 'devnet' ? { network } : {}),
    strictOrigin: search.get('strict') === '1',
    theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
    collectEmail: search.get('email') === '1',
  };
}
