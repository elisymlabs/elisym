/**
 * The page frame: the landing's width and gutters, so the logo holds its place
 * between the landing, the sign-in page and the dashboard.
 */
export const PAGE_FRAME = 'mx-auto w-full max-w-1160 px-16 sm:px-24';

/** The product's name, everywhere the admin names it. */
export const PRODUCT_NAME = 'Pay Core';

/** Prints the store key (nsec) on the merchant's machine. */
export const STORE_KEY_COMMAND = 'npx @elisym/merchant-node store-key';

/** Serves the same admin on the merchant's own machine. */
export const LOCAL_ADMIN_COMMAND = 'npx @elisym/merchant-node admin';

/** The Pay Core landing: its own origin, never this one. */
export const LANDING_URL = 'https://paycore.elisym.network';

export const QUICKSTART_URL = 'https://docs.elisym.network/commerce/quickstart';
