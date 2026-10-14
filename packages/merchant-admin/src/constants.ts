/**
 * The page frame: the landing's width and gutters, so the logo holds its place
 * between the landing, the sign-in page and the dashboard.
 */
export const PAGE_FRAME = 'mx-auto w-full max-w-1160 px-16 sm:px-24';

/**
 * The landing's header, class for class, so landing and admin share one bar: a
 * structure test reads the landing's source and pins each of these.
 */
export const HEADER_BAR = 'border-line/60 bg-bg/80 sticky top-0 z-20 border-b backdrop-blur-md';
export const HEADER_ROW = `${PAGE_FRAME} flex h-64 items-center justify-between gap-16`;
export const HEADER_NAV = 'text-14 flex items-center gap-4';
export const HEADER_LINK = 'text-text-2 hover:text-text rounded-8 hidden px-12 py-8 md:inline';
export const HEADER_DOCS_LINK = 'text-text-2 hover:text-text rounded-8 hidden px-12 py-8 sm:inline';

/** The landing's sections its header links to, by id. */
export const LANDING_SECTIONS: readonly { id: string; label: string }[] = [
  { id: 'demo', label: 'Integration' },
  { id: 'how', label: 'How it works' },
  { id: 'faq', label: 'FAQ' },
];

/** The product's name, everywhere the admin names it. */
export const PRODUCT_NAME = 'Pay Core';

/** Prints the store key (nsec) on the merchant's machine. */
export const STORE_KEY_COMMAND = 'npx @elisym/merchant-node store-key';

/** Serves the same admin on the merchant's own machine. */
export const LOCAL_ADMIN_COMMAND = 'npx @elisym/merchant-node admin';

/** The Pay Core landing: its own origin, never this one. */
export const LANDING_URL = 'https://paycore.elisym.network';

export const QUICKSTART_URL = 'https://docs.elisym.network/commerce/quickstart';
