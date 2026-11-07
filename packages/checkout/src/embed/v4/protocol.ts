/**
 * The messages between the merchant page (`embed.js`) and the checkout iframe.
 * The page learns a state name, the content's height and when to close - never
 * the delivery link, the buyer key or the order id: a scam page framing a real
 * store must not get the buyer's access.
 *
 * The loaders keep frozen copies of this file (`v1/`, `v2/`, `v3/`): a change here
 * reaches the checkout app only. A change the page must see ships as a new loader.
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
  | { type: 'status'; state: CheckoutState }
  /** In a modal only: the buyer is done (Escape, or Done after a delivery). */
  | { type: 'close' };

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
  /**
   * How the page shows the frame: in a modal dialog (v2's default) or in place.
   * A v1 loader never sends it, so its absence means `inline`.
   */
  display: 'modal' | 'inline';
  /** The merchant's own id of the account to credit: forces strict origin. */
  customerRef?: string;
}

/** The checkout's own rule (`isCustomerRef` in `@elisym/commerce`), kept here so the loader stays small. */
const CUSTOMER_REF_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

export function isCustomerRef(value: unknown): value is string {
  return typeof value === 'string' && CUSTOMER_REF_RE.test(value);
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
  // Always written: the decoder reads its absence as a v1 loader's inline frame.
  search.set('display', params.display);
  if (params.customerRef !== undefined) {
    search.set('ref', params.customerRef);
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
    display: search.get('display') === 'modal' ? 'modal' : 'inline',
    ...refOf(search.get('ref')),
  };
}

function refOf(ref: string | null): Pick<CheckoutParams, 'customerRef'> {
  return ref !== null && isCustomerRef(ref) ? { customerRef: ref } : {};
}
