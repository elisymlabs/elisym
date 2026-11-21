import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The site's pages: every HTML file at the package root, each its own page in `dist/`. */
const PAGES = readdirSync(fileURLToPath(new URL('.', import.meta.url))).filter((file) =>
  file.endsWith('.html'),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    target: 'es2022',
    sourcemap: false,
    // No inline `<script>` or data: modules: the CSP is `script-src 'self'`.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: {
      input: Object.fromEntries(
        PAGES.map((file) => [
          file.replace(/\.html$/, ''),
          fileURLToPath(new URL(file, import.meta.url)),
        ]),
      ),
    },
  },
});
