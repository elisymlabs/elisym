import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { checkNip98, sha256Hex as serverSha256Hex } from '../../askr-server/src/admin/nip98';
import { AdminApi } from '../src/lib/api';
import { KIND_HTTP_AUTH, nip98Header, sha256Hex } from '../src/lib/nip98';
import { secretKeySigner } from '../src/lib/signer';

const BASE = 'https://api.askr.example';
const secretKey = generateSecretKey();
const signer = secretKeySigner(secretKey);

function decode(header: string) {
  const match = /^Nostr ([A-Za-z0-9+/=]+)$/.exec(header);
  if (match?.[1] === undefined) {
    throw new Error(`not a Nostr header: ${header}`);
  }
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

function tag(event: { tags: string[][] }, name: string): string | undefined {
  return event.tags.find((entry) => entry[0] === name)?.[1];
}

describe('the NIP-98 authorization', () => {
  it('is a kind 27235 event by O with u, method, payload and a nonce', async () => {
    const body = JSON.stringify({ items: [], dryRun: true });
    const now = 1_800_000_000;
    const event = decode(
      await nip98Header({ signer, url: `${BASE}/v1/admin/catalog`, method: 'post', body, now }),
    );
    expect(event.kind).toBe(KIND_HTTP_AUTH);
    expect(event.pubkey).toBe(getPublicKey(secretKey));
    expect(event.created_at).toBe(now);
    expect(verifyEvent(event)).toBe(true);
    expect(tag(event, 'u')).toBe(`${BASE}/v1/admin/catalog`);
    expect(tag(event, 'method')).toBe('POST');
    expect(tag(event, 'payload')).toBe(serverSha256Hex(body));
    expect(tag(event, 'nonce')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashes the body exactly as the server does, including non-ASCII text', async () => {
    const body = JSON.stringify({ title: 'Café, 東京 ✓' });
    expect(await sha256Hex(body)).toBe(serverSha256Hex(body));
  });

  it('carries no payload tag for an empty body', async () => {
    const event = decode(
      await nip98Header({ signer, url: `${BASE}/v1/admin/store`, method: 'GET', body: '' }),
    );
    expect(tag(event, 'payload')).toBeUndefined();
  });

  it('gets a new nonce and so a new event id every time, even in the same second', async () => {
    const input = {
      signer,
      url: `${BASE}/v1/admin/store`,
      method: 'GET',
      body: '',
      now: 1_800_000_000,
    };
    const first = decode(await nip98Header(input));
    const second = decode(await nip98Header(input));
    expect(tag(first, 'nonce')).not.toBe(tag(second, 'nonce'));
    expect(first.id).not.toBe(second.id);
  });

  it("passes the server's own check, and fails it on another body, URL or method", async () => {
    const now = Math.floor(Date.now() / 1000);
    const url = `${BASE}/v1/admin/policies/returns`;
    const body = JSON.stringify({ title: 'Returns', body: '30 days' });
    const header = await nip98Header({ signer, url, method: 'PUT', body, now });
    const check = (overrides: Partial<Parameters<typeof checkNip98>[0]>) =>
      checkNip98({ header, method: 'PUT', publicUrl: url, body, now, ...overrides });
    expect(check({})).toMatchObject({ ok: true, pubkey: getPublicKey(secretKey) });
    expect(check({ body: `${body} ` })).toEqual({ ok: false, reason: 'payload' });
    expect(check({ publicUrl: `${url}x` })).toEqual({ ok: false, reason: 'url' });
    expect(check({ method: 'DELETE' })).toEqual({ ok: false, reason: 'method' });
    expect(check({ now: now + 120 })).toEqual({ ok: false, reason: 'stale' });
  });

  it('passes the server check for a bodiless POST, as the server reads it (an empty body)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const url = `${BASE}/v1/admin/store/assistant/rotate`;
    const header = await nip98Header({ signer, url, method: 'POST', body: '', now });
    expect(checkNip98({ header, method: 'POST', publicUrl: url, body: '', now }).ok).toBe(true);
  });
});

describe('the API client', () => {
  it('signs every call over the exact body and URL it sends, reads included', async () => {
    const seen: { method: string; url: string; ok: boolean; cache: RequestCache | undefined }[] =
      [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : '';
      const header = new Headers(init?.headers).get('authorization');
      const result = checkNip98({
        header,
        method,
        publicUrl: url,
        body,
        now: Math.floor(Date.now() / 1000),
      });
      seen.push({ method, url, ok: result.ok, cache: init?.cache });
      return new Response(
        JSON.stringify({ diff: { created: [], updated: [], hidden: [], unchanged: [] } }),
        {
          status: 200,
        },
      );
    };
    const api = new AdminApi({ signer, base: BASE, fetch: fakeFetch });
    await api.store();
    await api.catalog([{ d: 'a', title: 'A', price: { amount: '1', currency: 'USD' } }], true);
    await api.deletePolicy('returns');
    await api.rotateAssistant();
    expect(seen).toEqual([
      // Never answered from a cache: every read is the store as it is now.
      { method: 'GET', url: `${BASE}/v1/admin/store`, ok: true, cache: 'no-store' },
      { method: 'POST', url: `${BASE}/v1/admin/catalog`, ok: true, cache: 'no-store' },
      { method: 'DELETE', url: `${BASE}/v1/admin/policies/returns`, ok: true, cache: 'no-store' },
      {
        method: 'POST',
        url: `${BASE}/v1/admin/store/assistant/rotate`,
        ok: true,
        cache: 'no-store',
      },
    ]);
  });

  it('turns a refusal into its code and detail, and no answer into network', async () => {
    const refusing = new AdminApi({
      signer,
      base: BASE,
      fetch: async () =>
        new Response(JSON.stringify({ error: 'too_many_products', max: 50 }), { status: 400 }),
    });
    await expect(refusing.store()).rejects.toMatchObject({
      code: 'too_many_products',
      status: 400,
      detail: { max: 50 },
    });
    const offline = new AdminApi({
      signer,
      base: BASE,
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(offline.store()).rejects.toMatchObject({ code: 'network', status: 0 });
  });
});
