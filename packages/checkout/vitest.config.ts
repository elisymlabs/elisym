import { defineConfig } from 'vitest/config';

/** The checkout origin `embed.js` is built with; tests use a stand-in. */
export const TEST_CHECKOUT_ORIGIN = 'https://pay.test';

export default defineConfig({
  define: {
    __CHECKOUT_ORIGIN__: JSON.stringify(TEST_CHECKOUT_ORIGIN),
  },
  // The checkout's screens are Preact: `.test.tsx` files render them (happy-dom, per file).
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    environment: 'node',
    // The embed tests frame the checkout: happy-dom must not load it over the network.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableIframePageLoading: true,
          disableJavaScriptFileLoading: true,
        },
      },
    },
    include: ['tests/**/*.test.{ts,tsx}'],
    // Several tests seal and gift-wrap orders and statuses (NIP-44, Schnorr):
    // quick locally, but a CI runner shared with other packages needs longer.
    testTimeout: 30_000,
  },
});
