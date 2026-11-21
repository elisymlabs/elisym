import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';
import { LLMS_TXT_PATH, renderLlmsTxt } from './src/llms-txt';

/** The site's pages: every HTML file at the package root, each its own page in `dist/`. */
const PAGES = readdirSync(fileURLToPath(new URL('.', import.meta.url))).filter((file) =>
  file.endsWith('.html'),
);

/** Writes `dist/llms.txt` from the page's constants, and serves it in dev. */
function llmsTxt(): Plugin {
  return {
    name: 'askr-llms-txt',
    configureServer(server) {
      server.middlewares.use(LLMS_TXT_PATH, (_request, response) => {
        response.setHeader('content-type', 'text/markdown; charset=utf-8');
        response.end(renderLlmsTxt());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: LLMS_TXT_PATH.slice(1), source: renderLlmsTxt() });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), llmsTxt()],
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
