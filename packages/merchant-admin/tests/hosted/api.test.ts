import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { ApiError, createHostedApi, parseMeta, serverOffset } from '../../src/hosted/lib/api';
import { KIND_HTTP_AUTH, nip98Header, sha256Hex } from '../../src/hosted/lib/nip98';
import { secretKeySigner } from '../../src/hosted/lib/signer';

const BASE = 'https://api.paycore.example';
const OPERATOR = 'paycore.example';
const secretKey = generateSecretKey();
const OWNER = getPublicKey(secretKey);
/** Local time in these tests, seconds. */
const LOCAL_NOW = 1_800_000_000;

const META = {
  publicBase: BASE,
  operator: OPERATOR,
  networks: { mainnet: { coins: ['solana:5eykt/token:EPj'] }, devnet: { coins: [] } },
  inboxRelays: ['wss://relay.example'],
  pendingMaxProducts: 20,
};

function eventOf(header: string | null): NostrEvent {
  const match = /^Nostr ([A-Za-z0-9+/=]+)$/.exec(header ?? '');
  if (match?.[1] === undefined) {
    throw new Error(`not a NIP-98 header: ${header}`);
  }
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0)),
  );
  return JSON.parse(json);
}

function tag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((entry) => entry[0] === name)?.[1];
}

/** The date header a server `offset` seconds ahead of local time sends. */
function dateAhead(offset: number): string {
  return new Date((LOCAL_NOW + offset) * 1000).toUTCString();
}

interface Seen {
  url: string;
  init: RequestInit;
  event: NostrEvent | undefined;
}

/** A fetch that records each request and answers from `answers` in turn (the last one repeats). */
function recorder(answers: (() => Response)[]) {
  const seen: Seen[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const authorization = new Headers(init.headers).get('authorization');
    seen.push({
      url: String(input),
      init,
      event: authorization === null ? undefined : eventOf(authorization),
    });
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
    if (answer === undefined) {
      throw new Error('no answer');
    }
    return answer();
  };
  return { seen, fetcher };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function api(fetcher: typeof fetch) {
  return createHostedApi({
    base: BASE,
    signer: secretKeySigner(secretKey),
    fetch: fetcher,
    localNow: () => LOCAL_NOW,
  });
}

describe('the NIP-98 header', () => {
  it('is a kind 27235 event by O with u, method, payload and a nonce, empty content', async () => {
    const body = JSON.stringify({ name: 'Tea' });
    const header = await nip98Header({
      signEvent: secretKeySigner(secretKey).signEvent,
      url: `${BASE}/v1/admin/store`,
      method: 'post',
      body,
      createdAt: LOCAL_NOW,
    });
    const event = eventOf(header);
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject({
      kind: KIND_HTTP_AUTH,
      pubkey: OWNER,
      created_at: LOCAL_NOW,
      content: '',
    });
    expect(KIND_HTTP_AUTH).toBe(27235);
    expect(event.tags.map((entry) => entry[0])).toEqual(['u', 'method', 'payload', 'nonce']);
    expect(tag(event, 'u')).toBe(`${BASE}/v1/admin/store`);
    expect(tag(event, 'method')).toBe('POST');
    expect(tag(event, 'payload')).toBe(await sha256Hex(body));
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(tag(event, 'nonce')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('has no payload for no body, and a new nonce (so a new id) every time', async () => {
    const make = () =>
      nip98Header({
        signEvent: secretKeySigner(secretKey).signEvent,
        url: `${BASE}/v1/admin/store`,
        method: 'GET',
        body: '',
        createdAt: LOCAL_NOW,
      });
    const [first, second] = [eventOf(await make()), eventOf(await make())];
    expect(tag(first, 'payload')).toBeUndefined();
    expect(first.tags.map((entry) => entry[0])).toEqual(['u', 'method', 'nonce']);
    expect(tag(first, 'nonce')).not.toBe(tag(second, 'nonce'));
    expect(first.id).not.toBe(second.id);
  });
});

describe('the API client', () => {
  it('signs every call over the exact URL, method and body it sends, reads included', async () => {
    const { seen, fetcher } = recorder([() => json({ ok: true })]);
    const client = api(fetcher);
    await client.store();
    await client.putConfig({
      name: 'Tea',
      payouts: [],
      inboxRelays: ['wss://relay.example'],
      expectedRevision: 3,
    });
    await client.putProduct('tea/green 1', { title: 'Green', description: '', priceUsd: '5' });
    await client.deleteProduct('a.b');
    await client.handAnswer(`${'c'.repeat(64)}:order 7`, { kind: 'complete' });
    await client.request('ab12');
    await client.rotateWebhookSecret();
    expect(seen.map(({ url, init }) => `${init.method} ${url}`)).toEqual([
      `GET ${BASE}/v1/admin/store`,
      `PUT ${BASE}/v1/admin/store/config`,
      `PUT ${BASE}/v1/admin/products/tea%2Fgreen%201`,
      `DELETE ${BASE}/v1/admin/products/a.b`,
      `POST ${BASE}/v1/admin/orders/${'c'.repeat(64)}%3Aorder%207/hand`,
      `GET ${BASE}/v1/admin/requests/ab12`,
      `POST ${BASE}/v1/admin/webhook/secret`,
    ]);
    for (const { url, init, event } of seen) {
      if (event === undefined) {
        throw new Error('unsigned');
      }
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(OWNER);
      expect(tag(event, 'u')).toBe(url);
      expect(tag(event, 'method')).toBe(init.method);
      const body = typeof init.body === 'string' ? init.body : '';
      expect(tag(event, 'payload')).toBe(body === '' ? undefined : await sha256Hex(body));
      expect(new Headers(init.headers).get('content-type')).toBe(
        body === '' ? null : 'application/json',
      );
      // Never from a cache, no cookies, no redirect followed.
      expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' });
    }
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({
      name: 'Tea',
      payouts: [],
      inboxRelays: ['wss://relay.example'],
      expectedRevision: 3,
    });
  });

  it('reads /v1/meta unsigned, and strictly', async () => {
    const { seen, fetcher } = recorder([() => json(META)]);
    expect(await api(fetcher).meta()).toEqual(META);
    expect(seen[0]?.url).toBe(`${BASE}/v1/meta`);
    expect(seen[0]?.event).toBeUndefined();
    expect(new Headers(seen[0]?.init.headers).get('authorization')).toBeNull();
    for (const broken of [
      { ...META, operator: 'PayCore.example' },
      { ...META, operator: 'b'.repeat(64) },
      { ...META, publicBase: 7 },
      { ...META, networks: { testnet: { coins: [] } } },
      { ...META, networks: { mainnet: { coins: [1] } } },
      { ...META, inboxRelays: 'wss://relay.example' },
      { ...META, pendingMaxProducts: 1.5 },
      [META],
    ]) {
      expect(parseMeta(broken)).toBeUndefined();
    }
    await expect(api(recorder([() => json(META, 500)]).fetcher).meta()).rejects.toMatchObject({
      code: 'unexpected',
      status: 500,
    });
  });

  it('turns a refusal into its code and detail, no answer into network, junk into unexpected', async () => {
    const refusing = api(recorder([() => json({ error: 'stale_config' }, 409)]).fetcher);
    await expect(refusing.store()).rejects.toMatchObject({ code: 'stale_config', status: 409 });
    const unauthorized = api(
      recorder([() => json({ error: 'unauthorized', reason: 'url' }, 401)]).fetcher,
    );
    const error = await unauthorized.store().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error instanceof ApiError && error.reason).toBe('url');
    const offline = api(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(offline.store()).rejects.toMatchObject({ code: 'network', status: 0 });
    const junk = api(recorder([() => new Response('<html>', { status: 200 })]).fetcher);
    await expect(junk.store()).rejects.toMatchObject({ code: 'unexpected' });
    const proxy = api(recorder([() => new Response('<html>', { status: 502 })]).fetcher);
    await expect(proxy.store()).rejects.toMatchObject({ code: 'unexpected', status: 502 });
  });

  it('takes a failed request (422 with its request) as an outcome, not a refusal', async () => {
    const failed = { request: { id: 'ab', kind: 'suspend', state: 'failed', result: null } };
    const client = api(recorder([() => json(failed, 422)]).fetcher);
    expect(await client.suspend()).toEqual(failed);
    expect(await client.handAnswer(`${'c'.repeat(64)}:1`, { kind: 'complete' })).toEqual(failed);
    // Elsewhere a 422 is a refusal, and so is one without its request.
    await expect(client.store()).rejects.toMatchObject({ status: 422 });
    const bare = api(recorder([() => json({ error: 'bad_request' }, 422)]).fetcher);
    await expect(bare.suspend()).rejects.toMatchObject({ code: 'bad_request', status: 422 });
  });
});

describe('the clock', () => {
  it('reads the offset from a Date header', () => {
    expect(serverOffset(dateAhead(3600), LOCAL_NOW)).toBe(3600);
    expect(serverOffset(dateAhead(-90), LOCAL_NOW)).toBe(-90);
    expect(serverOffset(null, LOCAL_NOW)).toBeUndefined();
    expect(serverOffset('yesterday', LOCAL_NOW)).toBeUndefined();
  });

  it('dates the next authorization by the server clock of the last answer, meta included', async () => {
    const { seen, fetcher } = recorder([
      () => json(META, 200, { date: dateAhead(3600) }),
      () => json({}, 200, { date: dateAhead(-120) }),
      () => json({}),
    ]);
    const client = api(fetcher);
    await client.meta();
    await client.store();
    await client.store();
    expect(seen[1]?.event?.created_at).toBe(LOCAL_NOW + 3600);
    // An answer without a Date keeps the last offset.
    expect(seen[2]?.event?.created_at).toBe(LOCAL_NOW - 120);
  });

  it('signs again once, with the refusal’s clock, when refused as stale', async () => {
    const { seen, fetcher } = recorder([
      () => json({ error: 'unauthorized', reason: 'stale' }, 401, { date: dateAhead(600) }),
      () => json({ owner: OWNER }),
    ]);
    expect(await api(fetcher).store()).toEqual({ owner: OWNER });
    expect(seen.map((entry) => entry.event?.created_at)).toEqual([LOCAL_NOW, LOCAL_NOW + 600]);
    expect(seen[0]?.event?.id).not.toBe(seen[1]?.event?.id);
  });

  it('retries only once', async () => {
    const { seen, fetcher } = recorder([
      () => json({ error: 'unauthorized', reason: 'stale' }, 401, { date: dateAhead(600) }),
    ]);
    await expect(api(fetcher).store()).rejects.toMatchObject({
      code: 'unauthorized',
      reason: 'stale',
    });
    expect(seen).toHaveLength(2);
  });

  it('does not retry a stale refusal that told no time, nor any other refusal', async () => {
    const noDate = recorder([() => json({ error: 'unauthorized', reason: 'stale' }, 401)]);
    await expect(api(noDate.fetcher).store()).rejects.toMatchObject({ reason: 'stale' });
    expect(noDate.seen).toHaveLength(1);
    const other = recorder([
      () => json({ error: 'unauthorized', reason: 'replay' }, 401, { date: dateAhead(600) }),
    ]);
    await expect(api(other.fetcher).store()).rejects.toMatchObject({ reason: 'replay' });
    expect(other.seen).toHaveLength(1);
  });

  it('never dates by a Date the server did not send in this session', async () => {
    const { seen, fetcher } = recorder([() => json({})]);
    await api(fetcher).store();
    expect(seen[0]?.event?.created_at).toBe(LOCAL_NOW);
  });
});
