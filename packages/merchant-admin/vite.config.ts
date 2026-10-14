import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { oneCopyOfEach } from './scripts/one-copy';

/** merchant-node's admin modules, shared as source with the local admin page. */
export const ADMIN_CORE_DIR = fileURLToPath(new URL('../merchant-node/src/admin', import.meta.url));

/** Packages both this app and the shared source import: one copy each in the bundle. */
export const DEDUPE = [
  '@elisym/commerce',
  '@elisym/pay-core',
  '@solana/kit',
  'decimal.js-light',
  'nostr-tools',
  'react',
  'react-dom',
];

export default defineConfig({
  plugins: [react(), tailwindcss(), oneCopyOfEach()],
  resolve: {
    alias: { '@merchant-admin-core': ADMIN_CORE_DIR },
    dedupe: DEDUPE,
  },
  server: { fs: { allow: ['..', '../merchant-node'] } },
  build: {
    target: 'es2022',
    sourcemap: false,
    // No inline `<script>` or data: modules: the CSP is `script-src 'self'`.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
