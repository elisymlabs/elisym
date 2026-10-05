/**
 * The messages between the merchant page (`embed.js`) and the checkout iframe.
 * The page learns a state name, the content's height and when to close - never
 * the buyer key, the order id or the email: a scam page framing a real store
 * must not get the buyer's access.
 *
 * The loaders keep frozen copies of this file (`v1/`, `v2/`, `v3/`): a change here
 * reaches the checkout app only. A change the page must see ships as a new loader.
 */
import { isCustomerRef } from '@elisym/commerce';

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
  /** In a modal only: the buyer is done (Escape, or Done after a finished purchase). */
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
  /**
   * The merchant's own id of the account to credit (v3 only): honoured only
   * for a level-A store on this page's verified domain, in the top window.
   */
  customerRef?: string;
  /** The fragment carried a `ref` that is not a valid reference: the page is refused. */
  badCustomerRef?: true;
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

/** A merchant bug must never become an order nobody credits: a bad reference refuses. */
function refOf(ref: string | null): Pick<CheckoutParams, 'customerRef' | 'badCustomerRef'> {
  if (ref === null) {
    return {};
  }
  return isCustomerRef(ref) ? { customerRef: ref } : { badCustomerRef: true };
}
