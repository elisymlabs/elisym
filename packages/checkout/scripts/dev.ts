/**
 * Local demo: a merchant page on http://localhost:5173 embedding the checkout
 * served by Vite on http://127.0.0.1:5174 - two origins, as in production.
 *
 *   bun scripts/dev.ts <naddr> [devnet|mainnet]
 *
 * Or every checkout state side by side (canned, nothing paid), for the visual pass:
 *
 *   bun scripts/dev.ts fixtures
 */
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';

const APP_ORIGIN = 'http://127.0.0.1:5174';
const PAGE_PORT = 5173;
const FIXTURES_PORT = 5175;

if (process.argv[2] === 'fixtures') {
  const fixtures = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('./fixtures', import.meta.url)),
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    server: {
      host: '127.0.0.1',
      port: FIXTURES_PORT,
      strictPort: true,
      fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
    },
  });
  await fixtures.listen();
  console.log(`Open http://127.0.0.1:${FIXTURES_PORT} (canned states, nothing is paid).`);
  await new Promise(() => undefined);
}

const naddr = process.argv[2];
const network = process.argv[3] ?? 'devnet';
// Both go into the demo page's HTML: accept only what they can be.
if (
  naddr === undefined ||
  !/^naddr1[a-z0-9]+$/.test(naddr) ||
  (network !== 'devnet' && network !== 'mainnet')
) {
  throw new Error('usage: bun scripts/dev.ts <naddr> [devnet|mainnet]');
}
const DEV_DIR = fileURLToPath(new URL('../.dev', import.meta.url));

// The loader, built for the local checkout origin (never the pinned v1 file).
process.env.CHECKOUT_ORIGIN = APP_ORIGIN;
await build({
  configFile: fileURLToPath(new URL('../vite.embed.config.ts', import.meta.url)),
  build: { outDir: DEV_DIR, emptyOutDir: true },
  logLevel: 'warn',
});

const app = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
await app.listen();

const page = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Demo store</title></head>
  <body style="font-family: system-ui; max-width: 480px; margin: 40px auto">
    <h2>Demo store page</h2>
    <elisym-buy product="${naddr}" network="${network}"></elisym-buy>
    <pre id="status"></pre>
    <script src="/v1/embed.js"></script>
    <script>
      document.addEventListener('elisym-status', (event) => {
        document.getElementById('status').textContent += 'status: ' + event.detail.state + '\\n';
      });
    </script>
  </body>
</html>`;

createHttpServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://localhost:${PAGE_PORT}`).pathname;
  if (path === '/v1/embed.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(readFileSync(`${DEV_DIR}/v1/embed.js`));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(page);
}).listen(PAGE_PORT, 'localhost');
console.log(`Open http://localhost:${PAGE_PORT} (the checkout runs on ${APP_ORIGIN}).`);
