import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { authIdExpiry, recordAuthId, sweepAuthIds } from '../src/admin/auth-ids';
import { AUTH_WINDOW_SECS, KIND_HTTP_AUTH, checkNip98, sha256Hex } from '../src/admin/nip98';
import { freshDb } from './pglite-db';

const NOW = 1_790_000_000;
const BASE = 'https://paycore.example';

function authHeader(input: {
  secret: Uint8Array;
  method: string;
  url: string;
  body?: string;
  createdAt?: number;
}): string {
  const tags = [
    ['u', input.url],
    ['method', input.method],
    ...(input.body ? [['payload', sha256Hex(input.body)]] : []),
    // Two calls in one second would otherwise sign the same id, which the replay check refuses.
    ['nonce', Buffer.from(generateSecretKey()).toString('hex')],
  ];
  const event = finalizeEvent(
    { kind: KIND_HTTP_AUTH, created_at: input.createdAt ?? NOW, tags, content: '' },
    input.secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

describe('NIP-98 check', () => {
  const secret = generateSecretKey();
  const url = `${BASE}/v1/admin/store`;
  const check = (
    header: string | null,
    overrides: { method?: string; body?: string; now?: number } = {},
  ) =>
    checkNip98({
      header,
      method: overrides.method ?? 'POST',
      publicUrl: url,
      body: overrides.body ?? '',
      now: overrides.now ?? NOW,
    });

  it('accepts a fresh, signed authorization for this URL and method', () => {
    expect(check(authHeader({ secret, method: 'POST', url }))).toMatchObject({
      ok: true,
      pubkey: getPublicKey(secret),
    });
    expect(
      check(authHeader({ secret, method: 'POST', url, body: '{"a":1}' }), { body: '{"a":1}' }),
    ).toMatchObject({ ok: true });
  });

  it('refuses each broken part', () => {
    expect(check(null)).toEqual({ ok: false, reason: 'missing' });
    expect(check('Bearer abc')).toEqual({ ok: false, reason: 'malformed' });
    expect(check(`Nostr ${Buffer.from('{}').toString('base64')}`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const valid = authHeader({ secret, method: 'POST', url });
    const event = JSON.parse(Buffer.from(valid.slice(6), 'base64').toString('utf8'));
    const forged = `Nostr ${Buffer.from(JSON.stringify({ ...event, content: 'x' })).toString('base64')}`;
    expect(check(forged)).toEqual({ ok: false, reason: 'signature' });
    expect(check(authHeader({ secret, method: 'POST', url, createdAt: NOW - 61 }))).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(check(authHeader({ secret, method: 'POST', url, createdAt: NOW + 61 }))).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(check(authHeader({ secret, method: 'POST', url, createdAt: NOW - 60 }))).toMatchObject({
      ok: true,
    });
    expect(
      check(authHeader({ secret, method: 'POST', url: 'http://internal:8787/v1/admin/store' })),
    ).toEqual({ ok: false, reason: 'url' });
    expect(check(authHeader({ secret, method: 'GET', url }))).toEqual({
      ok: false,
      reason: 'method',
    });
    expect(check(authHeader({ secret, method: 'POST', url, body: 'a' }), { body: 'b' })).toEqual({
      ok: false,
      reason: 'payload',
    });
    expect(check(authHeader({ secret, method: 'POST', url }), { body: 'b' })).toEqual({
      ok: false,
      reason: 'payload',
    });
  });
});

describe('authorization replay', () => {
  it('an id is accepted once, and kept until past the last second it is valid in', async () => {
    const db = await freshDb();
    const expiry = authIdExpiry(NOW, NOW);
    expect(expiry).toBe(NOW + 2 * AUTH_WINDOW_SECS + 1);
    // A clock behind the event's: kept from the later of the two.
    expect(authIdExpiry(NOW + 5, NOW)).toBe(NOW + 5 + 2 * AUTH_WINDOW_SECS + 1);
    expect(await recordAuthId(db, 'id-1', expiry)).toBe(true);
    expect(await recordAuthId(db, 'id-1', expiry)).toBe(false);
    // Still refused right up to the end of its validity (created_at + window), across a sweep.
    await sweepAuthIds(db, NOW + AUTH_WINDOW_SECS);
    expect(await recordAuthId(db, 'id-1', expiry)).toBe(false);
    await sweepAuthIds(db, expiry - 1);
    expect(await recordAuthId(db, 'id-1', expiry)).toBe(false);
    await sweepAuthIds(db, expiry);
    expect(await db.query('select id from admin_auth_ids')).toEqual([]);
  });

  it('the sweep forgets expired ids only', async () => {
    const db = await freshDb();
    await recordAuthId(db, 'old', NOW);
    await recordAuthId(db, 'new', NOW + 1);
    await sweepAuthIds(db, NOW);
    expect(await db.query('select id from admin_auth_ids')).toEqual([{ id: 'new' }]);
  });
});
