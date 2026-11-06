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
import { readFileSync, realpathSync } from 'node:fs';
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
      fs: {
        allow: [
          fileURLToPath(new URL('..', import.meta.url)),
          // Bun hoists the gallery's bundled font outside the checkout package.
          realpathSync(
            fileURLToPath(
              new URL('../node_modules/@fontsource-variable/manrope', import.meta.url),
            ),
          ),
        ],
      },
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

/** Local design workspace: V3 Modal, with an explicit light or dark theme. */
function page(search: URLSearchParams): string {
  const theme = search.get('theme') === 'dark' ? 'dark' : 'light';
  const loader = 'v3';
  const display = ' display="modal"';
  // Shown on a local page only; still never written into the HTML unchecked.
  const ref = search.get('ref');
  const customerRef =
    ref !== null && /^[A-Za-z0-9._:@-]{0,128}$/.test(ref) ? ` customer-ref="${ref}"` : '';
  return `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>PayCore · V3 Modal</title>
    <style>
      .theme-toggle{display:inline-flex;gap:4px;padding:4px;margin:0;border:1px solid #8884;border-radius:999px;background:#8881;vertical-align:middle}
      .theme-toggle button{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:8px 16px;border:0;border-radius:999px;background:transparent;color:inherit;font:500 14px system-ui;cursor:pointer;transition:background 160ms,color 160ms}
      .theme-toggle button:hover{background:#8882}
      .theme-toggle button[aria-pressed=true]{background:#c6f432;color:#111418;box-shadow:0 1px 4px #0001}
      .theme-toggle button:focus-visible{outline:2px solid #7a9b16;outline-offset:2px}
    </style></head>
  <body style="font-family: system-ui; max-width: 480px; margin: 40px auto; padding: 0 20px; background: ${theme === 'dark' ? '#09090b' : '#ffffff'}; color: ${theme === 'dark' ? '#eef1f4' : '#111418'}; color-scheme: ${theme}">
    <h2>PayCore · V3 Modal</h2>
    <!-- Temporary design control; outside the shipped widget. -->
    <div class="preview-controls" style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
    <div id="theme-toggle" class="theme-toggle" role="group" aria-label="Preview theme">
      <button type="button" data-theme="light" aria-pressed="${theme === 'light'}"><span aria-hidden="true">☀</span> Light</button>
      <button type="button" data-theme="dark" aria-pressed="${theme === 'dark'}"><span aria-hidden="true">☾</span> Dark</button>
    </div>
    <elisym-buy product="${naddr}" network="${network}" theme="${theme}"${display}${customerRef}></elisym-buy>
    </div>
    <pre id="status"></pre>
    <script src="/${loader}/embed.js"></script>
    <script>
      customElements.whenDefined('elisym-buy').then(() => {
        const buy = document.querySelector('elisym-buy').shadowRoot?.querySelector('.buy');
        if (buy) Object.assign(buy.style, { background: '#c6f432', color: '#0b0b0f' });
      });
      // Preview the close-button color without altering the published, pinned V3 loader.
      document.addEventListener('elisym-open', () => {
        const widget = document.querySelector('elisym-buy');
        const root = widget.shadowRoot;
        if (root && !root.querySelector('#preview-chrome-palette')) {
          const style = document.createElement('style');
          style.id = 'preview-chrome-palette';
          style.textContent = 'dialog{background:#ffffff!important;border-radius:28px!important}dialog[data-theme=dark]{background:#1b1d22!important;box-shadow:0 24px 64px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.08)}';
          root.appendChild(style);
        }
        const close = root?.querySelector('.close');
        if (close) {
          Object.assign(close.parentElement.style, { height: '0', padding: '0', position: 'relative', zIndex: '2', boxSizing: 'border-box' });
          Object.assign(close.style, { position: 'absolute', top: '10px', right: '12px', color: '#858995', display: 'grid', placeItems: 'center', lineHeight: '0', width: '32px', height: '32px', minHeight: '32px', padding: '0', margin: '0', flex: 'none', borderRadius: '50%' });
          close.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
        }
      });
      document.getElementById('theme-toggle').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-theme]');
        if (!button) return;
        const theme = button.dataset.theme;
        for (const option of document.querySelectorAll('#theme-toggle button')) {
          option.setAttribute('aria-pressed', String(option.dataset.theme === theme));
        }
        document.body.style.background = theme === 'dark' ? '#09090b' : '#ffffff';
        document.body.style.color = theme === 'dark' ? '#eef1f4' : '#111418';
        document.body.style.colorScheme = theme;
        document.querySelector('elisym-buy').setAttribute('theme', theme);
        const url = new URL(location.href);
        url.searchParams.set('theme', theme);
        history.replaceState(null, '', url);
        for (const link of document.querySelectorAll('a')) {
          const target = new URL(link.href);
          target.searchParams.set('theme', theme);
          link.href = target.href;
        }
      });
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
