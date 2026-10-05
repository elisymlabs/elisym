import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { checkoutOrigin } from './scripts/build-env';

/** Where the checkout is served. Fixed at build time: the merchant page never chooses it. */
const CHECKOUT_ORIGIN = checkoutOrigin(process.env);

/**
 * `v3/embed.js`, v2 plus `customer-ref`: built like v1 (lib mode takes one IIFE
 * entry, hence a config of its own), at its own immutable path.
 */
export default defineConfig({
  define: { __CHECKOUT_ORIGIN__: JSON.stringify(CHECKOUT_ORIGIN) },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    target: ['chrome90', 'edge90', 'firefox90', 'safari14.1'],
    lib: {
      entry: fileURLToPath(new URL('./src/embed/v3/entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'ElisymEmbedV3',
      fileName: () => 'v3/embed.js',
    },
  },
});
