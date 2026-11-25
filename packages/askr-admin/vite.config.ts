import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The Askr server serves this build at `https://app.askr.elisym.network/admin/` (7.3). */
export const ADMIN_BASE = '/admin/';

export default defineConfig({
  base: ADMIN_BASE,
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    sourcemap: false,
    // No inline `<script>` or data: modules: the server's CSP is `script-src 'self'`.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    // The standalone admin, and the Shopify app's embedded admin (served at /shopify/).
    rollupOptions: {
      input: {
        admin: fileURLToPath(new URL('index.html', import.meta.url)),
        shopify: fileURLToPath(new URL('shopify/index.html', import.meta.url)),
      },
    },
  },
});
