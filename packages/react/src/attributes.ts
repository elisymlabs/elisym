/** What the element is told: every value the checkout reads from an attribute. */
export interface ElementOptions {
  /** The product's `naddr1...`, as the node's `setup` printed it. */
  product: string;
  /** Only payouts on this network are offered. */
  network?: 'mainnet' | 'devnet';
  /** The checkout's colors; `auto` follows the buyer's system. */
  theme?: 'auto' | 'light' | 'dark';
  /** `modal` (the default): a Buy button opens the checkout. `inline`: it sits in the page. */
  display?: 'modal' | 'inline';
  /** The Buy button's text. */
  label?: string;
  /** Ask the buyer for an email (optional for them). */
  collectEmail?: boolean;
  /** Also refuse a store no domain vouches for. Always on with a customer reference. */
  strictOrigin?: boolean;
  /**
   * Your own id of the account a payment credits, taken from your server session.
   * Credited only through your node's signed webhook, and only for a level A
   * store on its own domain.
   */
  customerRef?: string;
  /** No reference yet means "not known yet": the button shows disabled and nothing is framed. */
  requireCustomerRef?: boolean;
  /** Set as the element's `class`. */
  className?: string;
}

/**
 * The element's attributes, as strings. A false boolean is left out (an
 * attribute that is present is on, whatever its value), and a reference turns
 * strict origin on, as the loader does.
 */
export function elementAttributes(options: ElementOptions): Record<string, string> {
  const attributes: Record<string, string> = { product: options.product };
  if (options.network !== undefined) {
    attributes.network = options.network;
  }
  if (options.theme !== undefined) {
    attributes.theme = options.theme;
  }
  if (options.display !== undefined) {
    attributes.display = options.display;
  }
  if (options.label !== undefined) {
    attributes.label = options.label;
  }
  const customerRef = options.customerRef ?? '';
  if (customerRef !== '') {
    attributes['customer-ref'] = customerRef;
  } else if (options.requireCustomerRef === true) {
    // Present and empty: the loader waits for the reference and frames nothing.
    attributes['customer-ref'] = '';
  }
  if (options.collectEmail === true) {
    attributes['collect-email'] = '';
  }
  if (options.strictOrigin === true || customerRef !== '') {
    attributes['strict-origin'] = '';
  }
  if (options.className !== undefined && options.className !== '') {
    // `class`, not `className`: React 18 writes `className` on a custom element as is.
    attributes.class = options.className;
  }
  return attributes;
}
