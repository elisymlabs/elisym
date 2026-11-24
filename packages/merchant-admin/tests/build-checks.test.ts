// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_HEADERS,
  HOSTED_SOURCE,
  SELF_HOST_SOURCE,
  V3_LOADER_URL,
  vercelProblems,
} from '../scripts/admin-checks';
import {
  chunkProblems,
  cspOf,
  cspOfEveryPath,
  cspProblems,
  cspSources,
  headerProblems,
  htmlProblems,
  parseCsp,
} from '../scripts/build-checks';
import { duplicatePackages } from '../scripts/one-copy';
import { PAYCORE_API_BASE, PAYCORE_OPERATOR } from '../src/hosted/config';
import { hostedConnectSrc, readHostedConfig } from '../src/hosted/lib/hosted-config';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

const HOSTED = readHostedConfig(PAYCORE_API_BASE, PAYCORE_OPERATOR);

describe('build checks', () => {
  it('vercel.json passes every admin check as committed', () => {
    expect(HOSTED.kind).not.toBe('invalid');
    expect(vercelProblems(vercel, hostedConnectSrc(HOSTED))).toEqual([]);
  });

  it('the self-host CSP forbids framing, other scripts and any connection but wss', () => {
    const csp = parseCsp(cspOf(vercel, SELF_HOST_SOURCE) ?? '');
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('connect-src')).toEqual(['wss:']);
    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.get('worker-src')).toEqual(["'none'"]);
  });

  it('the hosted CSP is the same but connects only to the committed API origin, or nowhere', () => {
    const self = parseCsp(cspOf(vercel, SELF_HOST_SOURCE) ?? '');
    const hosted = parseCsp(cspOf(vercel, HOSTED_SOURCE) ?? '');
    expect(hosted.get('connect-src')).toEqual(
      HOSTED.kind === 'configured' ? [new URL(HOSTED.config.apiBase).origin] : ["'none'"],
    );
    self.delete('connect-src');
    hosted.delete('connect-src');
    expect([...hosted]).toEqual([...self]);
  });

  it('while unset, the hosted page may connect nowhere; once set, only to the API origin', () => {
    expect(hostedConnectSrc({ kind: 'unset' })).toEqual(["'none'"]);
    expect(hostedConnectSrc({ kind: 'invalid', problem: 'x' })).toEqual(["'none'"]);
    const configured = readHostedConfig('https://api.paycore.example', 'paycore.example');
    expect(hostedConnectSrc(configured)).toEqual(['https://api.paycore.example']);
    // The committed vercel.json follows the committed config: another config fails it.
    const other = HOSTED.kind === 'configured' ? ["'none'"] : ['https://api.paycore.example'];
    expect(vercelProblems(vercel, other)).toHaveLength(1);
  });

  it('exactly two disjoint sources set a CSP: a third would add a second enforced policy', () => {
    expect(cspSources(vercel).sort()).toEqual([HOSTED_SOURCE, SELF_HOST_SOURCE].sort());
    const third = {
      ...vercel,
      headers: [
        ...vercel.headers,
        { source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: 'default-src *' }] },
      ],
    };
    expect(vercelProblems(third, hostedConnectSrc(HOSTED))).toEqual([
      expect.stringContaining('CSP rules are on'),
    ]);
    const self = new RegExp(`^${SELF_HOST_SOURCE.slice(1)}$`);
    const hosted = new RegExp(`^${HOSTED_SOURCE.slice(1)}$`);
    for (const path of [
      '',
      'hosted/',
      'hosted/x',
      'assets/a.js',
      'hostedx',
      'hosted',
      'x/hosted/',
    ]) {
      expect([self.test(path), hosted.test(path)].filter(Boolean), path).toHaveLength(1);
    }
  });

  it('redirects /hosted to /hosted/ and serves the hosted page before the self-host one', () => {
    const without = { ...vercel, redirects: [] };
    expect(vercelProblems(without, hostedConnectSrc(HOSTED))).toEqual([
      expect.stringContaining('/hosted must redirect'),
    ]);
    const reordered = { ...vercel, rewrites: [...vercel.rewrites].reverse() };
    expect(vercelProblems(reordered, hostedConnectSrc(HOSTED))).toEqual([
      expect.stringContaining('the first rewrite'),
    ]);
  });

  it('every path cuts the opener handle, the referrer, sniffing and powerful features', () => {
    expect(headerProblems(vercel, ADMIN_HEADERS)).toEqual([]);
    expect(ADMIN_HEADERS).toMatchObject({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
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

  it('the committed hosted config is empty or a valid https base and operator', () => {
    expect(readHostedConfig('', '')).toEqual({ kind: 'unset' });
    for (const [base, operator] of [
      ['https://api.paycore.example/', 'paycore.example'],
      ['http://api.paycore.example', 'paycore.example'],
      ['https://api.paycore.example?x=1', 'paycore.example'],
      ['https://user@api.paycore.example', 'paycore.example'],
      ['https://API.paycore.example', 'paycore.example'],
      ['https://api.paycore.example', 'PayCore.example'],
      ['https://api.paycore.example', 'a'.repeat(64)],
      ['https://api.paycore.example', ''],
      ['', 'paycore.example'],
    ] as const) {
      expect(readHostedConfig(base, operator).kind, `${base} ${operator}`).toBe('invalid');
    }
    expect(readHostedConfig('https://paycore.example/api', 'paycore.example')).toEqual({
      kind: 'configured',
      config: { apiBase: 'https://paycore.example/api', operator: 'paycore.example' },
    });
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

  it('cspOfEveryPath, which the landing reads, still reads the /(.*) rule only', () => {
    expect(cspOfEveryPath(vercel)).toBeUndefined();
    expect(
      cspOfEveryPath({
        headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: 'x' }] }],
      }),
    ).toBe('x');
    expect(cspProblems(undefined, {}, HOSTED_SOURCE)).toEqual([
      `no Content-Security-Policy on ${HOSTED_SOURCE}`,
    ]);
  });

  it('chunkProblems allows the exact v3 loader URL and nothing else of the checkout origin', () => {
    const forbid = ['pay.elisym.network'];
    expect(V3_LOADER_URL).toBe('https://pay.elisym.network/v3/embed.js');
    expect(
      chunkProblems('a.js', `const src = "${V3_LOADER_URL}";`, forbid, [V3_LOADER_URL]),
    ).toEqual([]);
    expect(chunkProblems('a.js', `"${V3_LOADER_URL}"`, forbid)).toHaveLength(1);
    for (const code of [
      `"${V3_LOADER_URL}2"`,
      `"${V3_LOADER_URL}?x=1"`,
      `"${V3_LOADER_URL}/x"`,
      `"${V3_LOADER_URL}.map"`,
      `"${V3_LOADER_URL}" + "https://pay.elisym.network/v2/embed.js"`,
      `"https://pay.elisym.network/v3/"`,
      `"${V3_LOADER_URL}"; fetch("https://pay.elisym.network/x")`,
    ]) {
      expect(chunkProblems('a.js', code, forbid, [V3_LOADER_URL]), code).toHaveLength(1);
    }
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
