import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { oneCopyOfEach } from './scripts/one-copy';

/** merchant-node's admin modules, shared as source with the local admin page. */
export const ADMIN_CORE_DIR = fileURLToPath(new URL('../merchant-node/src/admin', import.meta.url));

/** merchant-node's product rules (a leaf module: no `node:*`, no `yaml`), shared with hosted mode. */
export const PRODUCT_RULES_FILE = fileURLToPath(
  new URL('../merchant-node/src/product-rules.ts', import.meta.url),
);

/** The source aliases, for the build and the tests alike. */
export const ALIASES = {
  '@merchant-admin-core': ADMIN_CORE_DIR,
  '@merchant-product-rules': PRODUCT_RULES_FILE,
};

/** Packages both this app and the shared source import: one copy each in the bundle. */
export const DEDUPE = [
  '@elisym/commerce',
  '@elisym/pay-core',
  '@solana/kit',
  'decimal.js-light',
  'nostr-tools',
  'react',
  'react-dom',
  'zod',
];

export default defineConfig({
  plugins: [react(), tailwindcss(), oneCopyOfEach()],
  resolve: {
    alias: ALIASES,
    dedupe: DEDUPE,
  },
  server: { fs: { allow: ['..', '../merchant-node'] } },
  build: {
    target: 'es2022',
    sourcemap: false,
    // No inline `<script>` or data: modules: the CSP is `script-src 'self'`.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    // Two pages: `/` (self-host, the store key) and `/hosted/` (the owner key, PayCore's server).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        hosted: fileURLToPath(new URL('./hosted/index.html', import.meta.url)),
      },
    },
  },
});
