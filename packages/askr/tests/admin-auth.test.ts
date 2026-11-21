import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { KIND_HTTP_AUTH, nip98Header, sha256Hex } from '../src/admin-auth';

const BASE = 'https://api.askr.example';
const secretKey = generateSecretKey();
const signEvent = async (template: Parameters<typeof finalizeEvent>[0]) =>
  finalizeEvent(template, secretKey);

function nodeSha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

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

describe('the NIP-98 authorization header', () => {
  it('is a kind 27235 event by O with u, method, payload and a nonce', async () => {
    const body = JSON.stringify({ items: [], dryRun: true });
    const now = 1_800_000_000;
    const event = decode(
      await nip98Header({ signEvent, url: `${BASE}/v1/admin/catalog`, method: 'post', body, now }),
    );
    expect(event.kind).toBe(KIND_HTTP_AUTH);
    expect(event.pubkey).toBe(getPublicKey(secretKey));
    expect(event.created_at).toBe(now);
    expect(verifyEvent(event)).toBe(true);
    expect(tag(event, 'u')).toBe(`${BASE}/v1/admin/catalog`);
    expect(tag(event, 'method')).toBe('POST');
    expect(tag(event, 'payload')).toBe(nodeSha256Hex(body));
    expect(tag(event, 'nonce')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashes the exact UTF-8 body with SHA-256, including non-ASCII text', async () => {
    const body = JSON.stringify({ title: 'Café, 東京 ✓' });
    expect(await sha256Hex(body)).toBe(nodeSha256Hex(body));
  });

  it('carries no payload tag for an empty body', async () => {
    const event = decode(
      await nip98Header({ signEvent, url: `${BASE}/v1/admin/store`, method: 'GET', body: '' }),
    );
    expect(tag(event, 'payload')).toBeUndefined();
  });

  it('gets a new nonce and so a new event id every time, even in the same second', async () => {
    const input = {
      signEvent,
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
});
