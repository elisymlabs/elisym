import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GatewayRequest } from '../src/gateway/gateway';
import { composeHandler } from '../src/gateway/routes';
import {
  CLI_COMMAND,
  SERVER_LLMS_DOCS_PAGES,
  SERVER_LLMS_TXT_MAX_AGE_SECS,
  createServerLlmsTxt,
  renderServerLlmsTxt,
} from '../src/gateway/server-llms';

const BASE = 'https://app.askr.example';
const IP = '203.0.113.7';
const DOCS_PAGES = join(import.meta.dirname, '..', '..', 'docs', 'pages');

function call(path: string, init: RequestInit = {}): Response | undefined {
  return createServerLlmsTxt(BASE)({
    request: new Request(`${BASE}${path}`, init),
    clientAddress: IP,
  });
}

describe('the server llms.txt', () => {
  const text = renderServerLlmsTxt(BASE);

  it('is in the llms.txt form: one H1, a summary quote, then sections', () => {
    const lines = text.split('\n');
    expect(lines[0]).toBe('# Askr server');
    expect(lines[2]?.startsWith('> ')).toBe(true);
    expect(lines.filter((line) => line.startsWith('# '))).toHaveLength(1);
    for (const section of [
      '## Store files for AI agents',
      '## Widget and admin',
      '## Learn more',
    ]) {
      expect(text).toContain(`\n${section}\n`);
    }
    expect(text.endsWith('\n')).toBe(true);
  });

  it('names the store files, the widget and the admin under the public base', () => {
    expect(text).toContain(`${BASE}/s/npub1.../llms.txt`);
    expect(text).toContain(`${BASE}/s/npub1.../catalog.json`);
    expect(text).toContain(`(${BASE}/widget.js)`);
    expect(text).toContain(`(${BASE}/admin/)`);
    expect(text).toContain(`\`${CLI_COMMAND}\``);
    expect(text).toContain('its npub or its 64-character hex key');
    expect(text).toContain('(https://askr.elisym.network/llms.txt)');
    expect(text).toContain('(https://docs.elisym.network/llms.txt)');
  });

  it('links only docs pages that exist', () => {
    for (const path of Object.values(SERVER_LLMS_DOCS_PAGES)) {
      expect(text).toContain(`(https://docs.elisym.network${path})`);
      expect(existsSync(join(DOCS_PAGES, `${path}.mdx`)), path).toBe(true);
    }
  });

  it('names the CLI the way the agent setup guide runs it', () => {
    const guide = readFileSync(join(DOCS_PAGES, 'askr', 'agent-setup.mdx'), 'utf8');
    expect(CLI_COMMAND).toBe('npx -y @elisym/cli@latest askr <command>');
    expect(guide).toContain(`\`${CLI_COMMAND} ...\``);
  });

  it('has no em dash', () => {
    expect(text).not.toContain('—');
  });
});

describe('GET /llms.txt on the server', () => {
  it('serves the file as Markdown, cached for an hour, open to any origin', async () => {
    const response = call('/llms.txt');
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response?.headers.get('cache-control')).toBe(
      `public, max-age=${SERVER_LLMS_TXT_MAX_AGE_SECS}`,
    );
    expect(SERVER_LLMS_TXT_MAX_AGE_SECS).toBe(3_600);
    expect(response?.headers.get('access-control-allow-origin')).toBe('*');
    expect(response?.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response?.text()).toBe(renderServerLlmsTxt(BASE));
  });

  it('answers HEAD with the headers and no body', async () => {
    const response = call('/llms.txt', { method: 'HEAD' });
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await response?.text()).toBe('');
  });

  it('answers 304 to its own ETag, with the same headers and no body', async () => {
    const etag = call('/llms.txt')?.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/u);
    const response = call('/llms.txt', { headers: { 'if-none-match': etag ?? '' } });
    expect(response?.status).toBe(304);
    expect(response?.headers.get('etag')).toBe(etag);
    expect(response?.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response?.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response?.text()).toBe('');
  });

  it('tags each public base apart', () => {
    const other = createServerLlmsTxt('https://other.example')({
      request: new Request('https://other.example/llms.txt'),
      clientAddress: IP,
    });
    const etag = call('/llms.txt')?.headers.get('etag');
    expect(other?.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/u);
    expect(other?.headers.get('etag')).not.toBe(etag);
  });

  it('answers a CORS preflight and refuses other methods', () => {
    const preflight = call('/llms.txt', { method: 'OPTIONS' });
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    expect(preflight?.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight?.headers.get('access-control-max-age')).toBe('600');
    const post = call('/llms.txt', { method: 'POST', body: 'x' });
    expect(post?.status).toBe(405);
    expect(post?.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(post?.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(post?.headers.get('cache-control')).toBe('no-store');
    expect(post?.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('leaves every other path to the next handler', () => {
    for (const path of ['/', '/llms.txt/', '/LLMS.TXT', '/s/npub1x/llms.txt', '/admin/llms.txt']) {
      expect(call(path), path).toBeUndefined();
    }
  });
});

describe('the server routes', () => {
  /** Each handler answers its own paths with a status that names it. */
  function routed(): (input: GatewayRequest) => Promise<Response> {
    const tagged = (name: string) => new Response(name, { status: 200 });
    return composeHandler({
      publicBase: BASE,
      adminPages: ({ request }) =>
        new URL(request.url).pathname.startsWith('/admin/') ? tagged('admin-pages') : undefined,
      admin: async ({ request }) =>
        new URL(request.url).pathname.startsWith('/v1/admin/') ? tagged('admin-api') : undefined,
      storeDocs: async ({ request }) =>
        new URL(request.url).pathname.startsWith('/s/') ? tagged('store-docs') : undefined,
      gateway: async () => tagged('gateway'),
    });
  }

  async function bodyOf(path: string, init: RequestInit = {}): Promise<string> {
    const response = await routed()({
      request: new Request(`${BASE}${path}`, init),
      clientAddress: IP,
    });
    return response.text();
  }

  it('serves /llms.txt from the public base, before the admin API, the store files and the gateway', async () => {
    expect(await bodyOf('/llms.txt')).toBe(renderServerLlmsTxt(BASE));
    const preflight = await routed()({
      request: new Request(`${BASE}/llms.txt`, { method: 'OPTIONS' }),
      clientAddress: IP,
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-max-age')).toBe('600');
  });

  it('leaves every other path to its own handler', async () => {
    expect(await bodyOf('/admin/')).toBe('admin-pages');
    expect(await bodyOf('/v1/admin/store')).toBe('admin-api');
    expect(await bodyOf('/s/npub1x/llms.txt')).toBe('store-docs');
    expect(await bodyOf('/v1/session', { method: 'POST', body: '{}' })).toBe('gateway');
    expect(await bodyOf('/')).toBe('gateway');
  });

  it('works without the admin pages', async () => {
    const handler = composeHandler({
      publicBase: BASE,
      adminPages: undefined,
      admin: async () => undefined,
      storeDocs: async () => undefined,
      gateway: async () => new Response('gateway'),
    });
    const response = await handler({ request: new Request(`${BASE}/llms.txt`), clientAddress: IP });
    expect(await response.text()).toBe(renderServerLlmsTxt(BASE));
  });
});
