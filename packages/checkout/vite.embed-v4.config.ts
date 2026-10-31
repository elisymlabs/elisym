import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { V4_ORIGIN_PLACEHOLDER } from './scripts/loader-hosts';

/**
 * `v4/embed.js`'s template: built like v3, but with an origin placeholder in
 * place of the checkout origin. Each hostname's copy substitutes its own
 * (`scripts/loader-hosts.ts`), so one source serves every brand.
 */
export default defineConfig({
  define: { __CHECKOUT_ORIGIN__: JSON.stringify(V4_ORIGIN_PLACEHOLDER) },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    write: false,
    target: ['chrome90', 'edge90', 'firefox90', 'safari14.1'],
    lib: {
      entry: fileURLToPath(new URL('./src/embed/v4/entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'ElisymEmbedV4',
      fileName: () => 'v4/embed.js',
    },
  },
});
