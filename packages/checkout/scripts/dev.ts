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

// The loaders, built for the local checkout origin (never the pinned files).
process.env.CHECKOUT_ORIGIN = APP_ORIGIN;
for (const [index, config] of [
  'vite.embed.config.ts',
  'vite.embed-v2.config.ts',
  'vite.embed-v3.config.ts',
].entries()) {
  await build({
    configFile: fileURLToPath(new URL(`../${config}`, import.meta.url)),
    build: { outDir: DEV_DIR, emptyOutDir: index === 0 },
    logLevel: 'warn',
  });
}

const app = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
await app.listen();

/** The demo page: v2 in a modal by default; `?display=inline`, `?loader=v1`, or `?loader=v3` (with `?ref=`). */
function page(search: URLSearchParams): string {
  const requested = search.get('loader');
  const loader = requested === 'v1' || requested === 'v3' ? requested : 'v2';
  const v1 = loader === 'v1';
  const display = v1 ? '' : ` display="${search.get('display') === 'inline' ? 'inline' : 'modal'}"`;
  // Shown on a local page only; still never written into the HTML unchecked.
  const ref = search.get('ref');
  const customerRef =
    loader === 'v3' && ref !== null && /^[A-Za-z0-9._:@-]{0,128}$/.test(ref)
      ? ` customer-ref="${ref}"`
      : '';
  return `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Demo store</title></head>
  <body style="font-family: system-ui; max-width: 480px; margin: 40px auto">
    <h2>Demo store page</h2>
    <p><a href="/">v2 modal</a> · <a href="/?display=inline">v2 inline</a> · <a href="/?loader=v1">v1</a> · <a href="/?loader=v3&ref=demo_user">v3 with a ref</a></p>
    <elisym-buy product="${naddr}" network="${network}"${display}${customerRef}></elisym-buy>
    <pre id="status"></pre>
    <script src="/${loader}/embed.js"></script>
    <script>
      for (const type of ['elisym-status', 'elisym-open', 'elisym-close']) {
        document.addEventListener(type, (event) => {
          document.getElementById('status').textContent +=
            type + (event.detail?.state ? ': ' + event.detail.state : '') + '\\n';
        });
      }
    </script>
  </body>
</html>`;
}

createHttpServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PAGE_PORT}`);
  if (['/v1/embed.js', '/v2/embed.js', '/v3/embed.js'].includes(url.pathname)) {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(readFileSync(`${DEV_DIR}${url.pathname}`));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(page(url.searchParams));
}).listen(PAGE_PORT, 'localhost');
console.log(`Open http://localhost:${PAGE_PORT} (the checkout runs on ${APP_ORIGIN}).`);
