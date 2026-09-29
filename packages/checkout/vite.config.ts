import { fileURLToPath } from 'node:url';
import { type Plugin, type UserConfig, defineConfig, loadEnv } from 'vite';
import { buildEnvProblems } from './scripts/build-env';

const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url));

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

const CONFIG: UserConfig = {
  plugins: [checkoutRoute],
  root: fileURLToPath(new URL('./src/app', import.meta.url)),
  envDir: PACKAGE_DIR,
  base: '/',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
};

export default defineConfig(({ mode }) => {
  // `.env` files and the process env both reach `import.meta.env`: check what the bundle gets.
  const problems = buildEnvProblems({ ...process.env, ...loadEnv(mode, PACKAGE_DIR, 'VITE_') });
  if (problems.length > 0) {
    throw new Error(`the checkout build environment is wrong:\n- ${problems.join('\n- ')}`);
  }
  return CONFIG;
});
