import { buildTicket } from '@elisym/comcore';
import { describe, expect, it } from 'vitest';
import { httpGateway } from '../src/gateway';
import { localSecs, sign, testKey } from './fixtures';

const BASE = 'https://api.test';

function fakeFetch(respond: () => Response): {
  fetch: typeof fetch;
  requests: { url: string; init: RequestInit | undefined }[];
} {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return respond();
  };
  return { fetch: fetchImpl, requests };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function grantBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const visitor = testKey();
  const store = testKey();
  const ticket = sign(
    buildTicket({ visitor: visitor.pubkey, store: store.pubkey, now: localSecs() }),
    testKey(),
  );
  return { ticket, assistant: testKey().pubkey, ...extra };
}

async function open(respond: () => Response) {
  const fake = fakeFetch(respond);
  const result = await httpGateway(BASE, fake.fetch).openSession('a'.repeat(64), 'b'.repeat(64));
  return { result, requests: fake.requests };
}

describe('httpGateway.openSession', () => {
  it('a 403 is the unavailable state', async () => {
    expect((await open(() => json(403, { error: 'origin not allowed' }))).result).toEqual({
      kind: 'unavailable',
    });
    expect((await open(() => new Response('forbidden', { status: 403 }))).result).toEqual({
      kind: 'unavailable',
    });
  });

  it('a 503 saying unavailable is the unavailable state', async () => {
    expect((await open(() => json(503, { unavailable: true }))).result).toEqual({
      kind: 'unavailable',
    });
  });

  it('a plain 503 and a 429 are errors to retry later', async () => {
    expect((await open(() => json(503, { error: 'down' }))).result).toEqual({ kind: 'error' });
    expect((await open(() => json(429, { error: 'rate limited' }))).result).toEqual({
      kind: 'error',
    });
  });

  it('a network failure is an error', async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError('network');
    };
    expect(await httpGateway(BASE, failing).openSession('a'.repeat(64), 'b'.repeat(64))).toEqual({
      kind: 'error',
    });
  });

  it('a 200 grant: branding shown unless the gateway says false', async () => {
    const body = grantBody();
    const { result, requests } = await open(() => json(200, body));
    expect(result).toEqual({
      kind: 'granted',
      grant: {
        ticket: JSON.parse(JSON.stringify(body.ticket)),
        assistant: body.assistant,
        branding: true,
      },
    });
    expect(requests[0]?.url).toBe(`${BASE}/v1/session`);
    expect(requests[0]?.init?.credentials).toBe('omit');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      store: 'a'.repeat(64),
      visitor: 'b'.repeat(64),
    });
    const hidden = await open(() => json(200, grantBody({ branding: false })));
    expect(hidden.result.kind === 'granted' && hidden.result.grant.branding).toBe(false);
    const shown = await open(() => json(200, grantBody({ branding: true })));
    expect(shown.result.kind === 'granted' && shown.result.grant.branding).toBe(true);
  });

  it('a 200 with a malformed grant, or a grant body on a non-2xx, is an error', async () => {
    expect((await open(() => json(200, { ticket: 'nope', assistant: 'x' }))).result).toEqual({
      kind: 'error',
    });
    expect((await open(() => new Response('not json', { status: 200 }))).result).toEqual({
      kind: 'error',
    });
    expect((await open(() => json(500, grantBody()))).result).toEqual({ kind: 'error' });
  });
});

describe('httpGateway.reportClick', () => {
  it('posts the ticket and address and swallows failures', async () => {
    const fake = fakeFetch(() => json(204, {}));
    const ticket = sign(
      buildTicket({ visitor: 'b'.repeat(64), store: 'a'.repeat(64), now: localSecs() }),
      testKey(),
    );
    await httpGateway(BASE, fake.fetch).reportClick(ticket, '30402:x:y');
    expect(fake.requests[0]?.url).toBe(`${BASE}/v1/click`);
    const failing: typeof fetch = async () => {
      throw new TypeError('network');
    };
    await expect(httpGateway(BASE, failing).reportClick(ticket, '30402:x:y')).resolves.toBe(
      undefined,
    );
  });
});
