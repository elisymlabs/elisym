import { nip98Header } from '@elisym/askr';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { checkNip98 } from '../../askr-server/src/admin/nip98';
import { AdminApi } from '../src/lib/api';
import { secretKeySigner } from '../src/lib/signer';

const BASE = 'https://api.askr.example';
const secretKey = generateSecretKey();
const signer = secretKeySigner(secretKey);

describe('the NIP-98 authorization', () => {
  it("passes the server's own check, and fails it on another body, URL or method", async () => {
    const now = Math.floor(Date.now() / 1000);
    const url = `${BASE}/v1/admin/policies/returns`;
    const body = JSON.stringify({ title: 'Returns', body: '30 days' });
    const header = await nip98Header({
      signEvent: signer.signEvent,
      url,
      method: 'PUT',
      body,
      now,
    });
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
    const header = await nip98Header({
      signEvent: signer.signEvent,
      url,
      method: 'POST',
      body: '',
      now,
    });
    expect(checkNip98({ header, method: 'POST', publicUrl: url, body: '', now }).ok).toBe(true);
  });
});

describe('the API client', () => {
  it('signs every call over the exact body and URL it sends, reads included', async () => {
    const bodies: unknown[] = [];
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
      if (url.endsWith('/v1/admin/catalog')) {
        bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
      }
      return new Response(
        JSON.stringify({ diff: { created: [], updated: [], hidden: [], unchanged: [] } }),
        {
          status: 200,
        },
      );
    };
    const api = new AdminApi({ signer, base: BASE, fetch: fakeFetch });
    await api.store();
    await api.catalog(
      { items: [{ d: 'a', title: 'A', price: { amount: '1', currency: 'USD' } }], hide: ['b'] },
      true,
    );
    // Only the change goes out, as an upsert.
    expect(bodies).toEqual([
      {
        mode: 'upsert',
        items: [{ d: 'a', title: 'A', price: { amount: '1', currency: 'USD' } }],
        hide: ['b'],
        dryRun: true,
      },
    ]);
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
