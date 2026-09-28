import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Where the checkout is served. Fixed at build time: the merchant page never chooses it. */
const CHECKOUT_ORIGIN = process.env.CHECKOUT_ORIGIN ?? 'https://pay.elisym.network';

/**
 * `embed.js`, the loader merchants include: one self-contained file at a
 * versioned, immutable path (`/v1/embed.js`) so it can carry an SRI hash.
 */
export default defineConfig({
  define: { __CHECKOUT_ORIGIN__: JSON.stringify(new URL(CHECKOUT_ORIGIN).origin) },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    // The oldest engines the loader must run in (wallet webviews included). Newer
    // syntax is lowered inline or through helpers scoped inside the IIFE; the
    // build's check guards the page's global scope, not what gets lowered.
    target: ['chrome90', 'edge90', 'firefox90', 'safari14.1'],
    lib: {
      entry: fileURLToPath(new URL('./src/embed/entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'ElisymEmbed',
      fileName: () => 'v1/embed.js',
    },
  },
});
