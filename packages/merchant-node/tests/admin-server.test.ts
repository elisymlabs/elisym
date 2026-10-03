import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN_FILES,
  ADMIN_HEADERS,
  ADMIN_HOST,
  adminHandler,
  isAdminPort,
  startAdminServer,
} from '../src/admin-server';

const ADMIN_SOURCE = new URL('../src/admin/', import.meta.url);

/** A built admin in a temporary directory, each file holding its own name. */
function fakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'elisym-admin-'));
  for (const { name } of Object.values(ADMIN_FILES)) {
    writeFileSync(join(root, name), `contents of ${name}`);
  }
  return root;
}

const servers: { close(): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

async function serve(): Promise<number> {
  // Port 0 is refused by the CLI; here the OS picks a free one through `listen`.
  const server = await startAdminServer(fakeRoot(), 0).catch(() => undefined);
  if (server !== undefined) {
    throw new Error('port 0 must be refused');
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    try {
      const started = await startAdminServer(fakeRoot(), port);
      servers.push(started);
      const address = started.address();
      expect(typeof address === 'object' && address !== null ? address.address : address).toBe(
        ADMIN_HOST,
      );
      return port;
    } catch {
      // In use: try another.
    }
  }
  throw new Error('no free port');
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A request with any `Host` header (fetch would replace it with the real one). */
function get(port: number, path: string, host: string, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: ADMIN_HOST, port, path, method, headers: { host } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('the admin server', () => {
  it('serves its files to its own address, with the security headers', async () => {
    const port = await serve();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const response = await get(port, '/', host);
      expect(response.status).toBe(200);
      expect(response.body).toBe('contents of index.html');
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'self'; connect-src wss: https:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const app = await get(port, '/app.js?v=1', `127.0.0.1:${port}`);
    expect(app.body).toBe('contents of app.js');
    expect(app.headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('refuses any other Host: a rebound DNS name reaches it with its own', async () => {
    const port = await serve();
    for (const host of [
      `evil.example:${port}`,
      `127.0.0.1:${port + 1}`,
      '127.0.0.1',
      `localhost.evil.example:${port}`,
      `rebind.127.0.0.1:${port}`,
      `evil-localhost:${port}`,
      `127.0.0.1:${port}.evil.example`,
    ]) {
      const response = await get(port, '/', host);
      expect(response.status).toBe(403);
      expect(response.body).not.toContain('contents of');
      expect(response.headers['content-security-policy']).toBe(
        ADMIN_HEADERS['Content-Security-Policy'],
      );
    }
  });

  it('on port 80 also takes the bare names browsers send', () => {
    const files = new Map([['/', { body: Buffer.from('page'), type: 'text/html' }]]);
    const statusFor = (port: number, host: string): number => {
      let status = 0;
      const response = {
        writeHead(code: number) {
          status = code;
        },
        end() {},
      };
      const request = { headers: { host }, method: 'GET', url: '/' };
      adminHandler(files, port)(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
      );
      return status;
    };
    expect(statusFor(80, '127.0.0.1')).toBe(200);
    expect(statusFor(80, 'localhost')).toBe(200);
    expect(statusFor(80, 'evil.example')).toBe(403);
    expect(statusFor(8080, '127.0.0.1')).toBe(403);
  });

  it('serves nothing outside its file map, and only reads', async () => {
    const port = await serve();
    const host = `127.0.0.1:${port}`;
    for (const path of ['/index.html', '/../package.json', '/keys.json', '/app.js.map']) {
      expect((await get(port, path, host)).status).toBe(404);
    }
    expect((await get(port, '/', host, 'POST')).status).toBe(405);
    const head = await get(port, '/', host, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('takes only a real port', () => {
    expect(isAdminPort(5199)).toBe(true);
    expect(isAdminPort(65_535)).toBe(true);
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(isAdminPort(port)).toBe(false);
    }
  });

  it('refuses to start without its built files', async () => {
    await expect(
      startAdminServer(mkdtempSync(join(tmpdir(), 'elisym-admin-empty-')), 5199),
    ).rejects.toThrow();
  });
});

describe('the admin page source', () => {
  it('loads only files the server serves', () => {
    const html = readFileSync(new URL('index.html', ADMIN_SOURCE), 'utf8');
    const loaded = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    expect(loaded.sort()).toEqual(['/admin.css', '/app.js']);
    expect(Object.keys(ADMIN_FILES).sort()).toEqual(['/', '/admin.css', '/app.js']);
  });

  it('masks the key field with CSS, never with type=password', () => {
    const html = readFileSync(new URL('index.html', ADMIN_SOURCE), 'utf8');
    const css = readFileSync(new URL('admin.css', ADMIN_SOURCE), 'utf8');
    expect(html).not.toMatch(/type="password"/);
    expect(html).not.toMatch(/<form/);
    expect(css).toMatch(/\.masked\s*\{[^}]*-webkit-text-security:\s*disc/);
  });
});
