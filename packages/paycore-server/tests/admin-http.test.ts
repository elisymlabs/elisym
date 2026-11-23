import { describe, expect, it } from 'vitest';
import { WindowLimiter, bodyLimitOf, clientAddressOf, ipKey } from '../src/gateway/http';

describe('admin HTTP', () => {
  it('never reads an admin body without a NIP-98 header', () => {
    expect(bodyLimitOf('/v1/admin/store', undefined)).toBe('unauthorized');
    expect(bodyLimitOf('/v1/admin/store', 'Bearer x')).toBe('unauthorized');
    expect(bodyLimitOf('/v1/admin/store', 'Nostr abc=')).toBe(256 * 1024);
    expect(bodyLimitOf('/health', undefined)).toBe(16 * 1024);
  });

  it('takes the proxy-appended hop only behind the proxy', () => {
    const request = {
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
      socket: { remoteAddress: '10.0.0.2' },
    };
    expect(clientAddressOf(request, true)).toBe('2.2.2.2');
    expect(clientAddressOf(request, false)).toBe('10.0.0.2');
  });

  it('counts IPv6 by /64 and limits per window', () => {
    expect(ipKey('2001:db8:0:1::5')).toBe(ipKey('2001:db8:0:1:ffff::1'));
    expect(ipKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    const limiter = new WindowLimiter(2, 1_000);
    expect([limiter.hit('a', 0), limiter.hit('a', 1), limiter.hit('a', 2)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.hit('a', 1_000)).toBe(true);
  });
});
