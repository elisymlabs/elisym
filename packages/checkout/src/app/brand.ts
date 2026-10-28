/**
 * Who the checkout presents itself as. One deployment serves every hostname, so
 * the brand is picked by the Host the page was loaded from: a white-label
 * hostname shows its partner's name, and only there may "by Elisym" go (C5).
 * The fee line is the same in every brand ("network fee", `feeLine`).
 */
export interface Brand {
  /** The product name in the page title: "<name> checkout". */
  name: string;
  /** The footer says "Checkout by Elisym" (false only on a paid white-label hostname). */
  poweredBy: boolean;
}

/** pay.elisym.network, and any host not in the registry (previews, localhost). */
export const DEFAULT_BRAND: Brand = { name: 'Pay Core', poweredBy: true };

/** Hostname (lowercase) -> brand. Adding a partner adds its hostname here. */
export const BRANDS: ReadonlyMap<string, Brand> = new Map([['pay.elisym.network', DEFAULT_BRAND]]);

/** The brand of the hostname the checkout was loaded from. */
export function brandForHost(hostname: string, brands: ReadonlyMap<string, Brand> = BRANDS): Brand {
  return brands.get(hostname.toLowerCase()) ?? DEFAULT_BRAND;
}

/** The page title: "Pay Core checkout". */
export function checkoutTitle(brand: Brand): string {
  return `${brand.name} checkout`;
}

/** The footer line: who runs the checkout (when shown), and where the money goes. */
export function footerText(brand: Brand): string {
  return brand.poweredBy
    ? 'Checkout by Elisym · payments go straight to the store'
    : 'Payments go straight to the store';
}
