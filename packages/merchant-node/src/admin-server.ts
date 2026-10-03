/**
 * Serves the admin page on this machine only: a fixed set of bundled files, no
 * API, nothing read from a merchant home. The store key is pasted into the page
 * and never reaches this server.
 */
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { join } from 'node:path';

/** The port `elisym-merchant admin` listens on unless told otherwise. */
export const DEFAULT_ADMIN_PORT = 5199;

/** The only address the admin listens on: a server here is unreachable from other machines. */
export const ADMIN_HOST = '127.0.0.1';

/** The files the admin serves, by request path: nothing else is ever read. */
export const ADMIN_FILES: Readonly<Record<string, { name: string; type: string }>> = {
  '/': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { name: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/admin.css': { name: 'admin.css', type: 'text/css; charset=utf-8' },
};

/** Sent with every answer. The page talks only to relays (`wss:`) and loads only its own files. */
export const ADMIN_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src wss: https:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** Whether `port` is one a server can listen on. */
export function isAdminPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * The request handler: the admin's files from `files` (read once, at start),
 * only for a `Host` naming this server. A page on any other site that resolves
 * its own name to 127.0.0.1 (DNS rebinding) sends its own name, and is refused.
 */
export function adminHandler(
  files: ReadonlyMap<string, { body: Buffer; type: string }>,
  port: number,
): (request: IncomingMessage, response: ServerResponse) => void {
  const allowedHosts = [`${ADMIN_HOST}:${port}`, `localhost:${port}`];
  // Browsers leave the default port out of `Host`.
  if (port === 80) {
    allowedHosts.push(ADMIN_HOST, 'localhost');
  }
  return (request, response) => {
    const answer = (status: number, type: string, body: Buffer | string) => {
      response.writeHead(status, { ...ADMIN_HEADERS, 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (!allowedHosts.includes(request.headers.host ?? '')) {
      answer(403, 'text/plain; charset=utf-8', 'Open this page at its own address.\n');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      answer(405, 'text/plain; charset=utf-8', 'Method not allowed.\n');
      return;
    }
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const file = files.get(path);
    if (file === undefined) {
      answer(404, 'text/plain; charset=utf-8', 'Not found.\n');
      return;
    }
    answer(200, file.type, file.body);
  };
}

/** Read the admin's files from `root` (the built `dist/admin`): every one must be there. */
export function readAdminFiles(root: string): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const [path, { name, type }] of Object.entries(ADMIN_FILES)) {
    files.set(path, { body: readFileSync(join(root, name)), type });
  }
  return files;
}

/** Serve the admin from `root` on `127.0.0.1:<port>`; resolves once it listens. */
export async function startAdminServer(root: string, port: number): Promise<Server> {
  if (!isAdminPort(port)) {
    throw new Error('the admin port is a number from 1 to 65535');
  }
  const server = createServer(adminHandler(readAdminFiles(root), port));
  return new Promise<Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, ADMIN_HOST, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
