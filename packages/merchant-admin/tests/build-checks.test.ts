// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  chunkProblems,
  cspOfEveryPath,
  cspProblems,
  headerProblems,
  htmlProblems,
  parseCsp,
} from '../scripts/build-checks';
import { duplicatePackages } from '../scripts/one-copy';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

describe('build checks', () => {
  it('the admin CSP on every path forbids framing, other scripts and any connection but wss', () => {
    const csp = parseCsp(cspOfEveryPath(vercel) ?? '');
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('connect-src')).toEqual(['wss:']);
    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.get('worker-src')).toEqual(["'none'"]);
  });

  it('every path cuts the opener handle, the referrer and sniffing', () => {
    expect(
      headerProblems(vercel, {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      }),
    ).toEqual([]);
    expect(
      headerProblems({ headers: [] }, { 'Cross-Origin-Opener-Policy': 'same-origin' }),
    ).toHaveLength(1);
    const weakened = {
      headers: [
        {
          source: '/(.*)',
          headers: [{ key: 'Cross-Origin-Opener-Policy', value: 'unsafe-none' }],
        },
      ],
    };
    expect(headerProblems(weakened, { 'Cross-Origin-Opener-Policy': 'same-origin' })).toHaveLength(
      1,
    );
  });

  it('cache rules never overlap: no-store off /assets, immutable on it', () => {
    const sources = (vercel.headers as { source: string; headers: { key: string }[] }[])
      .filter((rule) => rule.headers.some((header) => header.key === 'Cache-Control'))
      .map((rule) => rule.source);
    expect(sources).toEqual(['/((?!assets/).*)', '/assets/(.*)']);
    expect(headerProblems(vercel, { 'Cache-Control': 'no-store' }, '/((?!assets/).*)')).toEqual([]);
    expect(
      headerProblems(
        vercel,
        { 'Cache-Control': 'public, max-age=31536000, immutable' },
        '/assets/(.*)',
      ),
    ).toEqual([]);
  });

  it('cspProblems names a weakened directive', () => {
    expect(
      cspProblems("script-src 'self' https://evil.example", { 'script-src': ["'self'"] }),
    ).toHaveLength(1);
    expect(cspProblems(undefined, {})).toEqual(['no Content-Security-Policy on /(.*)']);
  });

  it('htmlProblems refuses inline scripts and other origins', () => {
    expect(htmlProblems('<script type="module" src="/assets/a.js"></script>')).toEqual([]);
    expect(htmlProblems('<script>alert(1)</script>')).toHaveLength(1);
    expect(htmlProblems('<script src="https://cdn.example/x.js"></script>')).toHaveLength(1);
    expect(htmlProblems('<link rel="stylesheet" href="//fonts.example/a.css">')).toHaveLength(1);
  });

  it('chunkProblems finds the checkout origin and Node built-ins', () => {
    expect(
      chunkProblems('a.js', 'x("https://pay.elisym.network/v3")', ['pay.elisym.network']),
    ).toHaveLength(1);
    expect(chunkProblems('a.js', 'import fs from "node:fs"', [])).toHaveLength(1);
    expect(chunkProblems('a.js', 'const fs = await import("node:fs")', [])).toHaveLength(1);
    expect(chunkProblems('a.js', 'const a = 1', ['pay.elisym.network'])).toEqual([]);
  });

  it('duplicatePackages reports a package bundled from two directories', () => {
    expect(
      duplicatePackages([
        { name: 'nostr-tools', dir: '/a' },
        { name: 'nostr-tools', dir: '/a' },
        { name: 'react', dir: '/r' },
      ]).size,
    ).toBe(0);
    expect(
      duplicatePackages([
        { name: 'nostr-tools', dir: '/a' },
        { name: 'nostr-tools', dir: '/b' },
      ]).get('nostr-tools'),
    ).toEqual(['/a', '/b']);
  });
});
