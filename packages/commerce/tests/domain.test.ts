import { verifyEvent } from 'nostr-tools';
import * as nip19 from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';
import {
  type FetchLike,
  isPublicHostname,
  readElisymTxt,
  readNostrJson,
  resolveDomainKeys,
  splitNip05,
} from '../src/domain';
import { buildStoreProfileEvent } from '../src/events/store-profile';
import { isGenuineEvent } from '../src/verify';
import { nostrKey, sign } from './fixtures';

const STORE = 'a'.repeat(64);
const OWNER = 'b'.repeat(64);

describe('isGenuineEvent', () => {
  it("is not fooled by nostr-tools' verdict cache on a spread copy", () => {
    const genuine = sign(buildStoreProfileEvent({ name: 'Shop', ownerPubkey: OWNER }), nostrKey());
    expect(verifyEvent(genuine)).toBe(true);
    const tampered = { ...genuine, content: '{"name":"Evil"}' };
    // The footgun this guards against: the spread copied the cached `true`.
    expect(verifyEvent(tampered)).toBe(true);
    expect(isGenuineEvent(tampered)).toBe(false);
    expect(isGenuineEvent(genuine)).toBe(true);
  });
});

describe('hostnames and nip05', () => {
  it('accepts public names only', () => {
    expect(isPublicHostname('shop.example')).toBe(true);
    for (const bad of [
      'localhost',
      '127.0.0.1',
      'shop',
      'Shop.Example',
      'a..b',
      'shop.example:8080',
      '',
    ]) {
      expect(isPublicHostname(bad)).toBe(false);
    }
  });

  it('splits an identifier, a bare domain meaning `_`', () => {
    expect(splitNip05('_@Shop.Example')).toEqual({ local: '_', domain: 'shop.example' });
    expect(splitNip05('shop.example')).toEqual({ local: '_', domain: 'shop.example' });
    expect(splitNip05('bob@10.0.0.1')).toBeUndefined();
  });
});

describe('readNostrJson', () => {
  it('reads the store under its name and the owner under `owner`', () => {
    expect(readNostrJson({ names: { _: STORE, owner: OWNER } }, '_')).toEqual({
      storePubkey: STORE,
      ownerPubkey: OWNER,
    });
  });

  it('ignores anything that is not a lowercase hex key', () => {
    expect(readNostrJson({ names: { _: STORE.toUpperCase(), owner: 42 } }, '_')).toEqual({});
    expect(readNostrJson(null, '_')).toEqual({});
    expect(readNostrJson({ names: 'x' }, '_')).toEqual({});
  });
});

describe('readElisymTxt', () => {
  it('reads npub and hex keys', () => {
    const record = `v=elisym1; owner=${nip19.npubEncode(OWNER)}; store=${STORE}`;
    expect(readElisymTxt(record)).toEqual({ storePubkey: STORE, ownerPubkey: OWNER });
  });

  it('ignores another version or a garbage key', () => {
    expect(readElisymTxt(`v=elisym2; store=${STORE}`)).toEqual({});
    expect(readElisymTxt('v=elisym1; store=npub1garbage')).toEqual({});
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveDomainKeys', () => {
  it('reads nostr.json without following redirects', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(init === undefined ? { url } : { url, init });
      return jsonResponse({ names: { _: STORE, owner: OWNER } });
    };
    const keys = await resolveDomainKeys('_@shop.example', { fetch: fetchImpl });
    expect(keys).toEqual({
      domain: 'shop.example',
      storePubkey: STORE,
      ownerPubkey: OWNER,
      source: 'nostr.json',
    });
    expect(calls[0]?.url).toBe('https://shop.example/.well-known/nostr.json?name=_');
    expect(calls[0]?.init?.redirect).toBe('error');
  });

  it('falls back to the _elisym TXT record over DoH', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.startsWith('https://shop.example/')) {
        return new Response('not found', { status: 404 });
      }
      expect(url).toBe('https://doh.example/q?name=_elisym.shop.example&type=TXT');
      return jsonResponse({
        Answer: [{ type: 16, data: `"v=elisym1; owner=${OWNER}; " "store=${STORE}"` }],
      });
    };
    const keys = await resolveDomainKeys('_@shop.example', {
      fetch: fetchImpl,
      dohEndpoint: 'https://doh.example/q',
    });
    expect(keys).toEqual({
      domain: 'shop.example',
      storePubkey: STORE,
      ownerPubkey: OWNER,
      source: 'dns',
    });
  });

  it('gives up on an oversized document instead of reading it all', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.includes('nostr.json')
        ? new Response(`{"names":{"_":"${STORE}","pad":"${'x'.repeat(100_000)}"}}`)
        : jsonResponse({});
    expect(await resolveDomainKeys('_@shop.example', { fetch: fetchImpl })).toBeUndefined();
  });

  it('is undefined when nothing answers, and never fetches a private host', async () => {
    let called = false;
    const failing: FetchLike = async () => {
      called = true;
      throw new Error('offline');
    };
    expect(await resolveDomainKeys('_@shop.example', { fetch: failing })).toBeUndefined();
    called = false;
    expect(await resolveDomainKeys('_@localhost', { fetch: failing })).toBeUndefined();
    expect(called).toBe(false);
  });
});
