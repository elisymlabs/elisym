import { fileURLToPath } from 'node:url';
import { type Plugin, defineConfig } from 'vite';

/** The checkout iframe app: `dist/index.html`, served at `/checkout`. */
/** In development, serve the app at `/checkout` as the deployment does. */
const checkoutRoute: Plugin = {
  name: 'checkout-route',
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (request.url === '/checkout' || request.url?.startsWith('/checkout?') === true) {
        request.url = '/index.html';
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [checkoutRoute],
  root: fileURLToPath(new URL('./src/app', import.meta.url)),
  base: '/',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
