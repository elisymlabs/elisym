import { describe, it, expect } from 'vitest';
import { assertHostAllowed, SsrfError } from '../../src/lib/ssrfGuard';

describe('assertHostAllowed', () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/',
    'http://0.0.0.0/',
    'http://localhost/',
    'http://224.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'ftp://example.com/',
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(() => assertHostAllowed(url)).toThrow(SsrfError);
    });
  }

  it('allows a public host', () => {
    expect(() => assertHostAllowed('https://api.example.com/foo')).not.toThrow();
  });

  it('enforces an allowlist when provided', () => {
    expect(() => assertHostAllowed('https://evil.com/', ['api.example.com'])).toThrow(/allowlist/);
    expect(() => assertHostAllowed('https://api.example.com/', ['api.example.com'])).not.toThrow();
  });

  it('rejects non-http protocols', () => {
    expect(() => assertHostAllowed('file:///etc/passwd')).toThrow(SsrfError);
  });

  it('allows public IPv4 addresses', () => {
    expect(() => assertHostAllowed('http://8.8.8.8/')).not.toThrow();
  });
});
