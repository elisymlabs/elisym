import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { checkoutOrigin } from './scripts/build-env';

/** Where the checkout is served. Fixed at build time: the merchant page never chooses it. */
const CHECKOUT_ORIGIN = checkoutOrigin(process.env);

/**
 * `v4/embed.js`, v3 plus the `PayCore` global: built like v1 (lib mode takes one IIFE
 * entry, hence a config of its own), at its own immutable path.
 */
export default defineConfig({
  // Fields are assigned in the constructor, not declared one by one: the same
  // behavior for this code (no field shadows an accessor), and under the size budget.
  esbuild: { tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } } },
  define: { __CHECKOUT_ORIGIN__: JSON.stringify(CHECKOUT_ORIGIN) },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    target: ['chrome90', 'edge90', 'firefox90', 'safari14.1'],
    lib: {
      entry: fileURLToPath(new URL('./src/embed/v4/entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'ElisymEmbedV4',
      fileName: () => 'v4/embed.js',
    },
  },
});
