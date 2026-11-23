import { describe, expect, it } from 'vitest';
import {
  type FetchGuardDeps,
  FetchGuardError,
  type FetchGuardErrorCode,
  type ResolvedAddress,
  type TransportRequest,
  type TransportResponse,
  checkUrl,
  guardedFetch,
  isPublicAddress,
} from '../src/connectors/fetch-guard';

const PUBLIC_IP: ResolvedAddress = { address: '93.184.216.34', family: 4 };

interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Split the body into chunks of this many bytes. */
  chunkBytes?: number;
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

/** A fake internet: URL to response, host to addresses; records every request. */
class FakeWeb {
  readonly routes = new Map<string, Route>();
  readonly hosts = new Map<string, ResolvedAddress[]>();
  readonly requests: TransportRequest[] = [];
  discarded = 0;

  route(url: string, route: Route): this {
    this.routes.set(url, route);
    return this;
  }

  get urls(): string[] {
    return this.requests.map((request) => request.url.toString());
  }

  deps(): FetchGuardDeps {
    return {
      resolve: async (hostname) => this.hosts.get(hostname) ?? [PUBLIC_IP],
      transport: async (request): Promise<TransportResponse> => {
        this.requests.push(request);
        const route = this.routes.get(request.url.toString()) ?? { status: 404, body: 'not found' };
        const bytes = new TextEncoder().encode(route.body ?? '');
        return {
          status: route.status ?? 200,
          headers: route.headers ?? {},
          body: chunked(bytes, route.chunkBytes ?? 64 * 1024),
          discard: () => {
            this.discarded += 1;
          },
        };
      },
    };
  }
}

const LIMITS = { maxBytes: 1024, timeoutMs: 2_000 };

async function refusal(promise: Promise<unknown>): Promise<FetchGuardErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchGuardError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.0.9',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '0.0.0.0',
    '0.1.2.3',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.10',
    '192.0.0.8',
    '192.88.99.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.5',
    '::',
    '::1',
    'fe80::1',
    'fe80::1%eth0',
    '2a00:1450::1%eth0',
    'fc00::1',
    'fd00:ec2::254',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    '2001:db8::1',
    '2001::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:2::1',
    '2001:10::1',
    '2001:1f:ffff::1',
    '2001:20::1',
    '2001:2f::1',
    '3fff::1',
    '3fff:fff:ffff::1',
    'ff02::1',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '192.0.1.1',
    '198.20.0.1',
    '2606:4700::6810:84e5',
    '2001:4860:4860::8888',
    '2001:30::1',
    '3fff:1000::1',
  ])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('checkUrl', () => {
  it.each([
    ['http://shop.example/', 'not_https'],
    ['ftp://shop.example/', 'not_https'],
    ['file:///etc/passwd', 'not_https'],
    ['https://shop.example:8443/', 'port_not_allowed'],
    ['https://user:pass@shop.example/', 'credentials_in_url'],
    ['not a url', 'invalid_url'],
  ])('refuses %s', (url, code) => {
    expect(() => checkUrl(url)).toThrow(expect.objectContaining({ code }));
  });

  it('accepts https on the default port', () => {
    expect(checkUrl('https://shop.example:443/a').toString()).toBe('https://shop.example/a');
  });
});

describe('guardedFetch', () => {
  it('connects to the checked address and returns the body', async () => {
    const web = new FakeWeb().route('https://shop.example/a', {
      headers: { 'content-type': 'Text/Plain' },
      body: 'hello',
    });
    const response = await guardedFetch('https://shop.example/a', LIMITS, web.deps());
    expect(response.body).toBe('hello');
    expect(response.contentType).toBe('text/plain');
    expect(web.requests[0]?.address).toEqual(PUBLIC_IP);
  });

  it.each([
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[fd00:ec2::254]/',
    'https://0.0.0.0/',
    'https://100.64.0.1/',
    'https://10.0.0.1/',
  ])('refuses the literal address %s without connecting', async (url) => {
    const web = new FakeWeb();
    expect(await refusal(guardedFetch(url, LIMITS, web.deps()))).toBe('blocked_address');
    expect(web.requests).toHaveLength(0);
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const web = new FakeWeb();
    web.hosts.set('internal.example', [{ address: '10.0.0.5', family: 4 }]);
    expect(await refusal(guardedFetch('https://internal.example/', LIMITS, web.deps()))).toBe(
      'blocked_address',
    );
    expect(web.requests).toHaveLength(0);
  });

  it('refuses when any of several answers is private', async () => {
    const web = new FakeWeb();
    web.hosts.set('mixed.example', [PUBLIC_IP, { address: '::1', family: 6 }]);
    expect(await refusal(guardedFetch('https://mixed.example/', LIMITS, web.deps()))).toBe(
      'blocked_address',
    );
  });

  it('refuses a host with no address or a failing lookup', async () => {
    const web = new FakeWeb();
    web.hosts.set('empty.example', []);
    expect(await refusal(guardedFetch('https://empty.example/', LIMITS, web.deps()))).toBe(
      'dns_failed',
    );
    const failing = {
      ...web.deps(),
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    };
    expect(await refusal(guardedFetch('https://gone.example/', LIMITS, failing))).toBe(
      'dns_failed',
    );
  });

  it('refuses a redirect to a private address, checked on the hop', async () => {
    const web = new FakeWeb()
      .route('https://shop.example/', {
        status: 302,
        headers: { location: 'https://metadata.example/latest' },
      })
      .route('https://metadata.example/latest', { body: 'secret' });
    web.hosts.set('metadata.example', [{ address: '169.254.169.254', family: 4 }]);
    expect(await refusal(guardedFetch('https://shop.example/', LIMITS, web.deps()))).toBe(
      'blocked_address',
    );
    expect(web.urls).toEqual(['https://shop.example/']);
  });

  it('refuses a redirect to a literal loopback or to plain http', async () => {
    const web = new FakeWeb()
      .route('https://a.example/', { status: 301, headers: { location: 'https://127.0.0.1/' } })
      .route('https://b.example/', { status: 307, headers: { location: 'http://b.example/' } });
    expect(await refusal(guardedFetch('https://a.example/', LIMITS, web.deps()))).toBe(
      'blocked_address',
    );
    expect(await refusal(guardedFetch('https://b.example/', LIMITS, web.deps()))).toBe('not_https');
  });

  it('follows up to 3 redirects (relative ones too), not 4', async () => {
    const web = new FakeWeb()
      .route('https://shop.example/1', { status: 301, headers: { location: '/2' } })
      .route('https://shop.example/2', { status: 302, headers: { location: '/3' } })
      .route('https://shop.example/3', { status: 303, headers: { location: '/4' } })
      .route('https://shop.example/4', { status: 308, headers: { location: '/5' } })
      .route('https://shop.example/5', { body: 'end' });
    const third = await guardedFetch('https://shop.example/2', LIMITS, web.deps());
    expect(third.body).toBe('end');
    expect(third.url).toBe('https://shop.example/5');
    expect(await refusal(guardedFetch('https://shop.example/1', LIMITS, web.deps()))).toBe(
      'too_many_redirects',
    );
  });

  it('refuses an oversize body by its declared length', async () => {
    const web = new FakeWeb().route('https://shop.example/big', {
      headers: { 'content-length': '5000' },
      body: 'x',
    });
    expect(await refusal(guardedFetch('https://shop.example/big', LIMITS, web.deps()))).toBe(
      'too_large',
    );
    expect(web.discarded).toBe(1);
  });

  it('aborts a streamed body as soon as it passes the cap', async () => {
    let chunksRead = 0;
    const web = new FakeWeb();
    const deps = {
      ...web.deps(),
      transport: async (): Promise<TransportResponse> => ({
        status: 200,
        headers: {},
        body: {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              chunksRead += 1;
              yield new Uint8Array(300);
            }
          },
        },
        discard: () => {
          web.discarded += 1;
        },
      }),
    };
    expect(await refusal(guardedFetch('https://shop.example/stream', LIMITS, deps))).toBe(
      'too_large',
    );
    expect(chunksRead).toBe(4);
    expect(web.discarded).toBe(1);
  });

  it('gives up at the time cap on a stalled peer or a stalled resolver', async () => {
    const web = new FakeWeb();
    const stalledPeer = {
      ...web.deps(),
      transport: () => new Promise<TransportResponse>(() => undefined),
    };
    expect(
      await refusal(
        guardedFetch('https://slow.example/', { maxBytes: 10, timeoutMs: 50 }, stalledPeer),
      ),
    ).toBe('timeout');
    const stalledDns = { ...web.deps(), resolve: () => new Promise<never>(() => undefined) };
    expect(
      await refusal(
        guardedFetch('https://slow.example/', { maxBytes: 10, timeoutMs: 50 }, stalledDns),
      ),
    ).toBe('timeout');
  });

  it('gives up at the time cap on a body that stops arriving', async () => {
    const web = new FakeWeb();
    const deps = {
      ...web.deps(),
      transport: async (): Promise<TransportResponse> => ({
        status: 200,
        headers: {},
        body: {
          async *[Symbol.asyncIterator]() {
            yield new Uint8Array(1);
            await new Promise(() => undefined);
          },
        },
        discard: () => undefined,
      }),
    };
    expect(
      await refusal(guardedFetch('https://slow.example/', { maxBytes: 10, timeoutMs: 50 }, deps)),
    ).toBe('timeout');
  });

  it('makes no request when the outer signal was already aborted', async () => {
    const web = new FakeWeb().route('https://shop.example/', { body: 'x' });
    const signal = AbortSignal.abort();
    expect(
      await refusal(guardedFetch('https://shop.example/', { ...LIMITS, signal }, web.deps())),
    ).toBe('timeout');
    expect(web.requests).toHaveLength(0);
  });

  it('reports a transport failure as a network error', async () => {
    const web = new FakeWeb();
    const deps = {
      ...web.deps(),
      transport: async (): Promise<TransportResponse> => {
        throw new Error('ECONNRESET');
      },
    };
    expect(await refusal(guardedFetch('https://shop.example/', LIMITS, deps))).toBe('network');
  });
});

describe('guardedFetch for webhooks: POST, redirects refused, answer cut', () => {
  it('sends the method, the body and the caller headers over the defaults', async () => {
    const web = new FakeWeb().route('https://hooks.example/in', { body: 'ok' });
    await guardedFetch(
      'https://hooks.example/in',
      {
        ...LIMITS,
        method: 'POST',
        body: '{"a":1}',
        headers: { 'User-Agent': 'elisym-merchant-node/test', 'X-Elisym-Event': 'order.paid' },
      },
      web.deps(),
    );
    const sent = web.requests[0];
    expect(sent?.method).toBe('POST');
    expect(new TextDecoder().decode(sent?.body)).toBe('{"a":1}');
    expect(sent?.headers['user-agent']).toBe('elisym-merchant-node/test');
    expect(sent?.headers['x-elisym-event']).toBe('order.paid');
    expect(Object.keys(sent?.headers ?? {}).filter((name) => /user-agent/iu.test(name))).toEqual([
      'user-agent',
    ]);
  });

  it('keeps a caller accept header over the default', async () => {
    const web = new FakeWeb().route('https://hooks.example/in', { body: 'ok' });
    await guardedFetch(
      'https://hooks.example/in',
      { ...LIMITS, method: 'POST', body: '{}', headers: { Accept: 'application/json' } },
      web.deps(),
    );
    expect(web.requests[0]?.headers['accept']).toBe('application/json');
  });

  it('drops the caller framing and routing headers, whatever their case', async () => {
    const web = new FakeWeb().route('https://hooks.example/in', { body: 'ok' });
    await guardedFetch(
      'https://hooks.example/in',
      {
        ...LIMITS,
        method: 'POST',
        body: '{}',
        headers: {
          Host: 'internal.example',
          'Content-Length': '999',
          'TRANSFER-ENCODING': 'chunked',
          connection: 'keep-alive',
          'X-Kept': 'yes',
        },
      },
      web.deps(),
    );
    const sent = web.requests[0]?.headers ?? {};
    expect(Object.keys(sent).sort()).toEqual(['accept', 'accept-encoding', 'user-agent', 'x-kept']);
  });

  it('a GET has no body and keeps the default user agent', async () => {
    const web = new FakeWeb().route('https://shop.example/', { body: 'x' });
    await guardedFetch('https://shop.example/', LIMITS, web.deps());
    expect(web.requests[0]?.method).toBe('GET');
    expect(web.requests[0]?.body).toBeUndefined();
    expect(web.requests[0]?.headers['user-agent']).toMatch(/^PayCoreServer\//u);
  });

  it.each([301, 302, 303, 307, 308])(
    'maxRedirects 0: a %i fails and is never followed',
    async (status) => {
      const web = new FakeWeb()
        .route('https://shop.example/', { status, headers: { location: '/next' } })
        .route('https://shop.example/next', { body: 'end' });
      expect(
        await refusal(
          guardedFetch('https://shop.example/', { ...LIMITS, maxRedirects: 0 }, web.deps()),
        ),
      ).toBe('redirect_refused');
      expect(web.urls).toEqual(['https://shop.example/']);
      expect(web.discarded).toBe(1);
    },
  );

  it('maxRedirects 0: a redirect status without a location still fails', async () => {
    const web = new FakeWeb().route('https://shop.example/', { status: 302 });
    expect(
      await refusal(
        guardedFetch('https://shop.example/', { ...LIMITS, maxRedirects: 0 }, web.deps()),
      ),
    ).toBe('redirect_refused');
  });

  it('a POST never follows a redirect, whatever maxRedirects says', async () => {
    const web = new FakeWeb()
      .route('https://hooks.example/', { status: 307, headers: { location: '/moved' } })
      .route('https://hooks.example/moved', { body: 'ok' });
    expect(
      await refusal(
        guardedFetch(
          'https://hooks.example/',
          { ...LIMITS, method: 'POST', body: 'x', maxRedirects: 3 },
          web.deps(),
        ),
      ),
    ).toBe('redirect_refused');
    expect(web.urls).toEqual(['https://hooks.example/']);
  });

  it('maxRedirects 1 follows one hop, not two', async () => {
    const web = new FakeWeb()
      .route('https://shop.example/1', { status: 301, headers: { location: '/2' } })
      .route('https://shop.example/2', { status: 301, headers: { location: '/3' } })
      .route('https://shop.example/3', { body: 'end' });
    const one = await guardedFetch(
      'https://shop.example/2',
      { ...LIMITS, maxRedirects: 1 },
      web.deps(),
    );
    expect(one.body).toBe('end');
    expect(
      await refusal(
        guardedFetch('https://shop.example/1', { ...LIMITS, maxRedirects: 1 }, web.deps()),
      ),
    ).toBe('too_many_redirects');
  });

  it('overflow truncate keeps exactly maxBytes of an endless body and drops the connection', async () => {
    let chunksRead = 0;
    const web = new FakeWeb();
    const deps = {
      ...web.deps(),
      transport: async (): Promise<TransportResponse> => ({
        status: 200,
        headers: { 'content-length': '999999' },
        body: {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              chunksRead += 1;
              yield new TextEncoder().encode('y'.repeat(300));
            }
          },
        },
        discard: () => {
          web.discarded += 1;
        },
      }),
    };
    const answer = await guardedFetch(
      'https://hooks.example/',
      { ...LIMITS, overflow: 'truncate' },
      deps,
    );
    expect(answer.body).toBe('y'.repeat(1024));
    expect(answer.truncated).toBe(true);
    expect(chunksRead).toBe(4);
    expect(web.discarded).toBe(1);
  });

  it('overflow truncate leaves a body that fits whole', async () => {
    const web = new FakeWeb().route('https://hooks.example/', {
      body: 'z'.repeat(1024),
      chunkBytes: 100,
    });
    const answer = await guardedFetch(
      'https://hooks.example/',
      { ...LIMITS, overflow: 'truncate' },
      web.deps(),
    );
    expect(answer.body).toBe('z'.repeat(1024));
    expect(answer.truncated).toBe(false);
    expect(web.discarded).toBe(0);
  });
});
