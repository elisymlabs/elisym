import { describe, expect, it } from 'vitest';
import {
  FetchGuardError,
  type FetchGuardErrorCode,
  type TransportResponse,
  checkUrl,
  guardedFetch,
  isPublicAddress,
} from '../../src/connectors/fetch-guard';
import { FakeWeb, PUBLIC_IP } from './helpers';

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
    '198.18.0.1',
    '::',
    '::1',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd00:ec2::254',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    '2001:db8::1',
    'ff02::1',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::6810:84e5'])(
    'allows %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
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
