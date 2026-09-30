// Serves the demo store on http://localhost:5190 (PORT to change it). The
// checkout itself comes from pay.elisym.network: this only serves the page.

const PORT = Number(process.env.PORT ?? 5190);
const ROOT = new URL('./', import.meta.url);
const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/store.js': { file: 'store.js', type: 'text/javascript; charset=utf-8' },
  '/store.css': { file: 'store.css', type: 'text/css; charset=utf-8' },
};

const server = Bun.serve({
  hostname: 'localhost',
  port: PORT,
  fetch(request) {
    const entry = FILES[new URL(request.url).pathname];
    if (entry === undefined) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(Bun.file(new URL(entry.file, ROOT)), {
      headers: { 'content-type': entry.type, 'cache-control': 'no-store' },
    });
  },
});

console.log(`demo store on ${server.url}`);
