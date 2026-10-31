// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { UNREACHABLE, createConsoleApi, errorCode, serverOffset } from '../../src/cloud/lib/api';
import { OwnerKey } from '../../src/cloud/lib/owner-key';

const ORIGIN = 'https://api.cloud.example';
const SERVER_NOW = 1_800_000_000;

// That cloud-api takes what this client signs is a contract test in the cloud repo.
describe('the client, against stub answers', () => {
  it('signs again only for a stale answer that brought a Date, and only once', async () => {
    const answers = [
      { status: 401, body: { error: 'stale' }, date: null },
      { status: 401, body: { error: 'bad_signature' }, date: new Date(0).toUTCString() },
      { status: 401, body: { error: 'stale' }, date: new Date(SERVER_NOW * 1000).toUTCString() },
    ];
    for (const answer of answers) {
      let calls = 0;
      const client = createConsoleApi({
        apiOrigin: ORIGIN,
        signer: OwnerKey.create(),
        fetcher: async () => {
          calls += 1;
          return Response.json(answer.body, {
            status: answer.status,
            headers: answer.date === null ? {} : { date: answer.date },
          });
        },
        localNow: () => SERVER_NOW,
      });
      expect(await client.request('GET', '/tenants/zzzzzzzzzzzz')).toEqual({
        status: 401,
        body: answer.body,
      });
      expect(calls, JSON.stringify(answer)).toBe(
        errorCode(answer.body) === 'stale' && answer.date !== null ? 2 : 1,
      );
    }
  });

  it('dates each request by the offset the last answer brought', async () => {
    const dates: number[] = [];
    let server = SERVER_NOW + 500;
    const client = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async (request) => {
        const header = request.headers.get('authorization') ?? '';
        dates.push(JSON.parse(atob(header.slice('Nostr '.length))).created_at);
        return Response.json({}, { headers: { date: new Date(server * 1000).toUTCString() } });
      },
      localNow: () => SERVER_NOW,
    });
    await client.request('GET', '/tenants/zzzzzzzzzzzz');
    await client.request('GET', '/tenants/zzzzzzzzzzzz');
    server = SERVER_NOW - 20;
    await client.request('GET', '/tenants/zzzzzzzzzzzz');
    await client.request('GET', '/tenants/zzzzzzzzzzzz');
    expect(dates).toEqual([SERVER_NOW, SERVER_NOW + 500, SERVER_NOW + 500, SERVER_NOW - 20]);
  });

  it('keeps a non-JSON answer as text, and refuses a path that is not one', async () => {
    const client = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async () => new Response('down', { status: 502 }),
    });
    expect(await client.request('GET', '/x')).toEqual({ status: 502, body: 'down' });
    for (const path of ['x', '//evil.example/x', '']) {
      await expect(client.request('GET', path), path).rejects.toThrow('one /');
    }
    // Past the first checks, but resolved to another host: never sent there.
    await expect(client.request('GET', '/\\evil.example/x')).rejects.toThrow('stays on its origin');
  });

  it('reads a file as its bytes (never decoded), signed again once when stale; a refusal keeps its JSON', async () => {
    const file = new Uint8Array([0x1f, 0x8b, 0xff, 0xfe, 0x00, 0xc3]);
    const methods: string[] = [];
    let first = true;
    const client = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async (request) => {
        methods.push(request.method);
        const date = new Date(SERVER_NOW * 1000).toUTCString();
        if (first) {
          first = false;
          return Response.json({ error: 'stale' }, { status: 401, headers: { date } });
        }
        return new Response(file, { headers: { date } });
      },
      localNow: () => SERVER_NOW - 600,
    });
    const answer = await client.requestBytes('/tenants/zzzzzzzzzzzz/export/archive');
    expect(answer.status).toBe(200);
    expect(answer.bytes).toEqual(file);
    // Never decoded into a second copy as text.
    expect(answer.body).toBeUndefined();
    expect(methods).toEqual(['GET', 'GET']);

    const refusing = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async () => Response.json({ error: 'archive_missing' }, { status: 404 }),
    });
    const refused = await refusing.requestBytes('/tenants/zzzzzzzzzzzz/export/archive');
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: 'archive_missing' });
    await expect(refusing.requestBytes('x')).rejects.toThrow('one /');

    const offline = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const unreachable = await offline.requestBytes('/x');
    expect(unreachable.status).toBe(0);
    expect(unreachable.body).toEqual({ error: 'unreachable' });
    expect(unreachable.bytes.length).toBe(0);
  });

  it('never takes an answer from the browser cache: a cached Date would skew the clock offset', async () => {
    const caches: RequestCache[] = [];
    const client = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async (request) => {
        caches.push(request.cache);
        return Response.json({});
      },
    });
    await client.request('GET', '/tenants/zzzzzzzzzzzz');
    await client.requestBytes('/tenants/zzzzzzzzzzzz/export/archive');
    expect(caches).toEqual(['no-store', 'no-store']);
  });
});

describe('a request with a time limit', () => {
  it('is unreachable once the limit passes with no answer; an answer in time is kept', async () => {
    const hanging = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: () => new Promise<Response>(() => undefined),
      timeoutMs: 30,
    });
    expect(await hanging.request('GET', '/owner')).toEqual(UNREACHABLE);
    const quick = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async () => Response.json({ tenantId: null }),
      timeoutMs: 1000,
    });
    expect(await quick.request('GET', '/owner')).toEqual({ status: 200, body: { tenantId: null } });
  });

  it('asks the browser to drop the request at the limit', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const client = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async (request) => {
        signals.push(request.signal);
        return Response.json({});
      },
      timeoutMs: 1000,
    });
    await client.request('GET', '/owner');
    expect(signals[0]?.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(signals[0]?.aborted).toBe(true);
  });

  it('is held to its limit where the browser has no AbortSignal.timeout', async () => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    try {
      const hanging = createConsoleApi({
        apiOrigin: ORIGIN,
        signer: OwnerKey.create(),
        fetcher: () => new Promise<Response>(() => undefined),
        timeoutMs: 30,
      });
      expect(await hanging.request('GET', '/owner')).toEqual(UNREACHABLE);
    } finally {
      if (original !== undefined) {
        Object.defineProperty(AbortSignal, 'timeout', original);
      }
    }
  });

  it('holds its one retry to what is left of the same limit', async () => {
    let calls = 0;
    const client = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async () => {
        calls += 1;
        if (calls > 1) {
          return new Promise<Response>(() => undefined);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        return Response.json(
          { error: 'stale' },
          { status: 401, headers: { date: new Date(SERVER_NOW * 1000).toUTCString() } },
        );
      },
      localNow: () => SERVER_NOW,
      timeoutMs: 250,
    });
    const started = Date.now();
    expect(await client.request('GET', '/owner')).toEqual(UNREACHABLE);
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('is unreachable without a retry when the limit passed with the stale answer', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const client = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async () => {
        calls += 1;
        clock += 600;
        return Response.json(
          { error: 'stale' },
          { status: 401, headers: { date: new Date(SERVER_NOW * 1000).toUTCString() } },
        );
      },
      localNow: () => SERVER_NOW,
      timeoutMs: 500,
    });
    expect(await client.request('GET', '/owner')).toEqual(UNREACHABLE);
    expect(calls).toBe(1);
    now.mockRestore();
  });

  it('clears its timer once the answer is in', async () => {
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const client = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async () => Response.json({ tenantId: null }),
      timeoutMs: 1000,
    });
    await client.request('GET', '/owner');
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
  });
});

describe("the client's clock", () => {
  it("reads the server's offset from a Date header", () => {
    expect(serverOffset(new Date(SERVER_NOW * 1000).toUTCString(), SERVER_NOW - 30)).toBe(30);
    expect(serverOffset(null, SERVER_NOW)).toBeUndefined();
    expect(serverOffset('not a date', SERVER_NOW)).toBeUndefined();
  });
});

describe('a request that reaches no server', () => {
  it('is an answer, not a throw: status 0, unreachable', async () => {
    const client = createConsoleApi({
      apiOrigin: ORIGIN,
      signer: OwnerKey.create(),
      fetcher: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await client.request('POST', '/redeem', { invite: 'x' })).toEqual(UNREACHABLE);
    expect(UNREACHABLE).toEqual({ status: 0, body: { error: 'unreachable' } });
  });
});
