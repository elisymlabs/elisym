import { describe, expect, it } from 'vitest';
import { apiOriginFrom, cloudApiOriginOf } from '../../src/cloud/lib/origin';

const API = 'https://api.cloud.example';
const BAD = [
  'api.cloud.example',
  'http://api.cloud.example',
  'https://api.cloud.example/v1',
  'https://api.cloud.example/?x=1',
  'https://api.cloud.example/#x',
  'https://user:pass@api.cloud.example',
  'https://:pass@api.cloud.example',
  'https://user@api.cloud.example',
  'https://*',
  'https://*.cloud.example',
  "https://api.cloud.example;script-src'self'",
  'https://a;b',
  'https://a,b',
  "https://a'b",
  'wss://api.cloud.example',
];

describe("cloud-api's origin", () => {
  it('is https, or http on the loopback, with no path', () => {
    expect(apiOriginFrom('https://api.cloud.example')).toBe(API);
    expect(apiOriginFrom('https://api.cloud.example/')).toBe(API);
    expect(apiOriginFrom('http://127.0.0.1:5200')).toBe('http://127.0.0.1:5200');
    expect(apiOriginFrom('http://localhost:5200')).toBe('http://localhost:5200');
    for (const value of [undefined, '', ...BAD]) {
      expect(() => apiOriginFrom(value), String(value)).toThrow('CLOUD_API_ORIGIN');
    }
  });

  it('may be unset, for an admin of self-hosted stores only; set, it is checked the same', () => {
    expect(cloudApiOriginOf(undefined)).toBeUndefined();
    expect(cloudApiOriginOf('')).toBeUndefined();
    expect(cloudApiOriginOf('https://api.cloud.example/')).toBe(API);
    for (const value of BAD) {
      expect(() => cloudApiOriginOf(value), value).toThrow('CLOUD_API_ORIGIN');
    }
  });
});
