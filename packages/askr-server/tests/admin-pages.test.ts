import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adminCsp, createAdminPages, loadAdminFiles } from '../src/admin/pages';

const RELAY = 'wss://relay.elisym.network';

function build(): string {
  const dir = mkdtempSync(join(tmpdir(), 'askr-admin-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Askr admin</title>');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'assets', 'index-abc123.css'), 'body{}');
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
  writeFileSync(join(dir, 'notes.exe'), 'MZ');
  return dir;
}

function get(path: string, method = 'GET') {
  const pages = createAdminPages(loadAdminFiles(build()), RELAY);
  return pages({
    request: new Request(`http://localhost${path}`, { method }),
    clientAddress: '127.0.0.1',
  });
}

describe('the admin pages', () => {
  it('serves a built file with its type and the strict headers', async () => {
    const script = get('/admin/assets/index-abc123.js');
    expect(script?.status).toBe(200);
    expect(script?.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script?.headers.get('cache-control')).toContain('immutable');
    expect(script?.headers.get('content-security-policy')).toBe(adminCsp(RELAY));
    expect(script?.headers.get('x-frame-options')).toBe('DENY');
    expect(await script?.text()).toBe('console.log(1)');
    const icon = get('/admin/favicon.svg');
    expect(icon?.headers.get('cache-control')).toBe('no-cache');
  });

  it('answers the app routes with index.html, never a cached copy', async () => {
    for (const path of ['/admin/', '/admin/settings', '/admin/products/edit']) {
      const page = get(path);
      expect(page?.status).toBe(200);
      expect(page?.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(page?.headers.get('cache-control')).toBe('no-cache');
      expect(await page?.text()).toContain('Askr admin');
    }
    expect(get('/admin')?.status).toBe(308);
    expect(get('/admin')?.headers.get('location')).toBe('/admin/');
  });

  it('serves nothing it did not load: a missing file, another type, a way out of the directory', () => {
    expect(get('/admin/assets/missing.js')?.status).toBe(404);
    expect(get('/admin/notes.exe')?.status).toBe(404);
    expect(get('/admin/../package.json')).toBeUndefined();
    // Dot segments, also percent-encoded, resolve before routing: they leave /admin/ altogether.
    expect(get('/admin/%2e%2e/%2e%2e/etc/passwd.txt')).toBeUndefined();
    expect(get('/admin/assets/..%2f..%2findex.html')?.status).toBe(404);
    expect(get('/admin/x', 'POST')?.status).toBe(405);
  });

  it('leaves every other path to the API and the gateway', () => {
    for (const path of ['/v1/session', '/widget.js', '/administrator', '/v1/admin/store']) {
      expect(get(path)).toBeUndefined();
    }
  });

  it('a HEAD has the headers and no body', async () => {
    const head = get('/admin/', 'HEAD');
    expect(head?.status).toBe(200);
    expect(await head?.text()).toBe('');
  });

  it('refuses a directory that is not the admin build', () => {
    const empty = mkdtempSync(join(tmpdir(), 'askr-admin-empty-'));
    expect(() => loadAdminFiles(empty)).toThrow(/index.html/);
  });

  it('lets the page reach only this origin and the relay', () => {
    const csp = adminCsp(RELAY);
    expect(csp).toContain("connect-src 'self' wss://relay.elisym.network");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe');
  });
});
