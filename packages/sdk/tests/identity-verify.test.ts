import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, LIMITS } from '../src/constants';
import { ElisymIdentity } from '../src/primitives/identity';
import {
  clearIdentityVerifyCache,
  isPrivateAddress,
  normalizeNip05Identifier,
  splitNip05Identifier,
  verifyAgentIdentities,
} from '../src/services/identity-verify';
import type { AgentExternalIdentity } from '../src/types';

const agent = ElisymIdentity.generate();
const otherAgent = ElisymIdentity.generate();

const GITHUB_CLAIM: AgentExternalIdentity = {
  platform: 'github',
  handle: 'alice',
  proofUrl: 'https://gist.github.com/alice/9721ce4ee4fceb91c9711ca2a6c9a5ab',
};
const X_CLAIM: AgentExternalIdentity = {
  platform: 'x',
  handle: 'alice_ai',
  proofUrl: 'https://x.com/alice_ai/status/1893471190424121782',
};
const WEBSITE_CLAIM: AgentExternalIdentity = {
  platform: 'website',
  handle: 'agent@example.com',
  proofUrl: 'https://example.com',
};

const PUBLIC_ADDRESS = '93.184.216.34';

function textFetch(body: string, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(new Response(body, { status })) as unknown as typeof fetch;
}

function githubProofBody(npub: string): string {
  return `Verifying that I control the following Nostr public key: ${npub}`;
}

/**
 * Verbatim shape of a live publish.x.com oEmbed payload (matches jack's
 * canonical NIP-39 tweet): quotes arrive entity-encoded as `&quot;`, line
 * breaks as `<br><br>` tags, never as whitespace.
 */
function oembedPayload(npub: string, authorHandle: string, htmlOverride?: string): string {
  const html =
    htmlOverride ??
    `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Verifying my account on nostr<br><br>My Public Key: &quot;${npub}&quot;</p>&mdash; alice (@${authorHandle}) <a href="https://twitter.com/${authorHandle}/status/1893471190424121782">February 22, 2025</a></blockquote>\n<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>\n`;
  return JSON.stringify({
    url: `https://twitter.com/${authorHandle}/status/1893471190424121782`,
    author_name: 'alice',
    author_url: `https://twitter.com/${authorHandle}`,
    width: 550,
    height: null,
    type: 'rich',
    cache_age: '3153600000',
    provider_name: 'Twitter',
    provider_url: 'https://twitter.com',
    version: '1.0',
    html,
  });
}

function nostrJson(names: Record<string, string>): string {
  return JSON.stringify({ names });
}

const publicResolver = vi.fn().mockResolvedValue([PUBLIC_ADDRESS]);

beforeEach(() => {
  clearIdentityVerifyCache();
  publicResolver.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --- normalizeNip05Identifier ---

describe('normalizeNip05Identifier', () => {
  it('accepts name@domain unchanged', () => {
    expect(normalizeNip05Identifier('agent@example.com')).toBe('agent@example.com');
  });

  it('normalizes a bare domain to the _@domain root identifier', () => {
    expect(normalizeNip05Identifier('example.com')).toBe('_@example.com');
  });

  it('lowercases the identifier', () => {
    expect(normalizeNip05Identifier('Agent@EXAMPLE.Com')).toBe('agent@example.com');
    expect(normalizeNip05Identifier('Example.COM')).toBe('_@example.com');
  });

  it('permits xn-- punycode labels but rejects raw Unicode (IDN homograph guard)', () => {
    expect(normalizeNip05Identifier('agent@xn--80ak6aa92e.com')).toBe('agent@xn--80ak6aa92e.com');
    expect(normalizeNip05Identifier('agent@exämple.com')).toBeNull();
  });

  it('rejects IP literals (dotted-decimal and bracketed IPv6)', () => {
    expect(normalizeNip05Identifier('192.168.1.1')).toBeNull();
    expect(normalizeNip05Identifier('agent@10.0.0.1')).toBeNull();
    expect(normalizeNip05Identifier('agent@[::1]')).toBeNull();
  });

  it('rejects bad local parts, multiple @, empty input, and oversize input', () => {
    expect(normalizeNip05Identifier('bad char!@example.com')).toBeNull();
    expect(normalizeNip05Identifier('a@b@example.com')).toBeNull();
    expect(normalizeNip05Identifier('@example.com')).toBeNull();
    expect(normalizeNip05Identifier('')).toBeNull();
    expect(
      normalizeNip05Identifier(`agent@${'a'.repeat(LIMITS.MAX_IDENTITY_NIP05_LENGTH)}.com`),
    ).toBeNull();
  });

  it('rejects hostname labels with leading/trailing hyphens or empty labels', () => {
    expect(normalizeNip05Identifier('agent@-bad.com')).toBeNull();
    expect(normalizeNip05Identifier('agent@bad-.com')).toBeNull();
    expect(normalizeNip05Identifier('agent@bad..com')).toBeNull();
  });

  it('splitNip05Identifier splits a normalized identifier and throws otherwise', () => {
    expect(splitNip05Identifier('agent@example.com')).toEqual({
      local: 'agent',
      domain: 'example.com',
    });
    expect(() => splitNip05Identifier('example.com')).toThrow('NIP-05');
  });
});

// --- isPrivateAddress ---

describe('isPrivateAddress', () => {
  it('flags private / loopback / link-local / ULA ranges', () => {
    for (const addr of [
      '10.0.0.1',
      '127.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.0.10',
      'not-an-ip',
      '0::1',
      '0:0:0:0:0:0:0:1',
      '0:0:0:0:0:0:0:0',
      'fec0::1',
      '0:0:0:0:0:ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:0:8.8.8.8',
      'fe80::1%eth0',
      '::10.0.0.1',
      '::127.0.0.1',
      '::c0a8:1',
      '::8.8.8.8',
    ]) {
      expect(isPrivateAddress(addr), addr).toBe(true);
    }
  });

  it('passes public addresses', () => {
    for (const addr of [
      '8.8.8.8',
      '93.184.216.34',
      '172.32.0.1',
      '2606:4700::1111',
      '2606:4700:0:0:0:0:0:1111',
      '::ffff:8.8.8.8',
    ]) {
      expect(isPrivateAddress(addr), addr).toBe(false);
    }
  });
});

// --- pubkey validation ---

describe('verifyAgentIdentities input validation', () => {
  it('throws on a non-hex pubkey', async () => {
    await expect(verifyAgentIdentities('not-a-pubkey', [GITHUB_CLAIM])).rejects.toThrow(
      'hex agent pubkey',
    );
  });
});

describe('default fetch binding', () => {
  it('never invokes the global fetch with a foreign `this` (browser Illegal invocation)', async () => {
    // Browser `window.fetch` brand-checks `this`; a stub reproducing that
    // catches the regression where the verifier stored the bare global on its
    // context object and called it as a method.
    function brandCheckedFetch(
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(new Response(githubProofBody(agent.npub), { status: 200 }));
    }
    vi.stubGlobal('fetch', brandCheckedFetch);
    const [result] = await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], {
      bypassCache: true,
    });
    expect(result!.status).toBe('verified');
  });
});

// --- GitHub verifier ---

describe('GitHub verifier', () => {
  it('verifies the exact NIP-39 gist template', async () => {
    const fetchImpl = textFetch(githubProofBody(agent.npub));
    const [result] = await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], {
      fetchImpl,
      bypassCache: true,
    });
    expect(result!.status).toBe('verified');
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe(
      'https://gist.githubusercontent.com/alice/9721ce4ee4fceb91c9711ca2a6c9a5ab/raw',
    );
    expect(init.redirect).toBe('error');
  });

  it('verifies with case, whitespace, and smart-quote variance', async () => {
    const body = `VERIFYING   that I control\nthe following  Nostr Public Key:\n“${agent.npub}”`;
    const [result] = await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], {
      fetchImpl: textFetch(body),
      bypassCache: true,
    });
    expect(result!.status).toBe('verified');
  });

  it('404 (wrong owner or deleted gist) is broken', async () => {
    const [result] = await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], {
      fetchImpl: textFetch('Not Found', 404),
      bypassCache: true,
    });
    expect(result!.status).toBe('broken');
  });

  it('template stem with a DIFFERENT npub is broken', async () => {
    const [result] = await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], {
      fetchImpl: textFetch(githubProofBody(otherAgent.npub)),
      bypassCache: true,
    });
    expect(result!.status).toBe('broken');
  });

  it('npub present WITHOUT the template stem stays unverifiable (mention is not endorsement)', async () => {
    const body = `warning, scammer: ${agent.npub} stole my funds`;
    const [result] = await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], {
      fetchImpl: textFetch(body),
      bypassCache: true,
    });
    expect(result!.status).toBe('unverifiable');
  });

  it('403 / 429 / 5xx are unverifiable, never broken', async () => {
    for (const status of [403, 429, 500]) {
      const [result] = await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], {
        fetchImpl: textFetch('nope', status),
        bypassCache: true,
      });
      expect(result!.status, String(status)).toBe('unverifiable');
    }
  });

  it('a body exceeding MAX_IDENTITY_PROOF_BYTES is unverifiable (never substring-searched)', async () => {
    const oversized = githubProofBody(agent.npub) + 'x'.repeat(LIMITS.MAX_IDENTITY_PROOF_BYTES);
    const [result] = await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], {
      fetchImpl: textFetch(oversized),
      bypassCache: true,
    });
    expect(result!.status).toBe('unverifiable');
  });

  it('network error (incl. refused redirects) is unverifiable', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError('redirect')) as unknown as typeof fetch;
    const [result] = await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], {
      fetchImpl,
      bypassCache: true,
    });
    expect(result!.status).toBe('unverifiable');
  });

  it('timeout maps to unverifiable', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    ) as unknown as typeof fetch;
    const pending = verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], {
      fetchImpl,
      bypassCache: true,
    });
    await vi.advanceTimersByTimeAsync(DEFAULTS.IDENTITY_PROOF_FETCH_TIMEOUT_MS + 1);
    const [result] = await pending;
    expect(result!.status).toBe('unverifiable');
  });

  it('a malformed claim (proofUrl without a gist id) is unverifiable without fetching', async () => {
    const fetchImpl = textFetch('irrelevant');
    const [result] = await verifyAgentIdentities(
      agent.publicKey,
      [{ platform: 'github', handle: 'alice', proofUrl: 'https://gist.github.com/' }],
      { fetchImpl, bypassCache: true },
    );
    expect(result!.status).toBe('unverifiable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// --- X verifier ---

describe('X verifier', () => {
  it('verifies a verbatim real oEmbed payload (entity-encoded quotes, <br><br> breaks)', async () => {
    const fetchImpl = textFetch(oembedPayload(agent.npub, 'alice_ai'));
    const [result] = await verifyAgentIdentities(agent.publicKey, [X_CLAIM], {
      fetchImpl,
      bypassCache: true,
    });
    expect(result!.status).toBe('verified');
    const [url] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe(
      `https://publish.x.com/oembed?url=${encodeURIComponent('https://x.com/alice_ai/status/1893471190424121782')}`,
    );
  });

  it('compares the canonical author case-insensitively (catches renames, tolerates casing)', async () => {
    const [result] = await verifyAgentIdentities(agent.publicKey, [X_CLAIM], {
      fetchImpl: textFetch(oembedPayload(agent.npub, 'Alice_AI')),
      bypassCache: true,
    });
    expect(result!.status).toBe('verified');
  });

  it('canonical author mismatch is broken', async () => {
    const [result] = await verifyAgentIdentities(agent.publicKey, [X_CLAIM], {
      fetchImpl: textFetch(oembedPayload(agent.npub, 'mallory')),
      bypassCache: true,
    });
    expect(result!.status).toBe('broken');
  });

  it('smart-quoted template html verifies', async () => {
    const html = `<blockquote><p>Verifying my account on nostr<br><br>My Public Key: “${agent.npub}”</p></blockquote>`;
    const [result] = await verifyAgentIdentities(agent.publicKey, [X_CLAIM], {
      fetchImpl: textFetch(oembedPayload(agent.npub, 'alice_ai', html)),
      bypassCache: true,
    });
    expect(result!.status).toBe('verified');
  });

  it('404 (deleted or nonexistent tweet) is broken', async () => {
    const [result] = await verifyAgentIdentities(agent.publicKey, [X_CLAIM], {
      fetchImpl: textFetch('Not Found', 404),
      bypassCache: true,
    });
    expect(result!.status).toBe('broken');
  });

  it('template stem with a different npub is broken', async () => {
    const [result] = await verifyAgentIdentities(agent.publicKey, [X_CLAIM], {
      fetchImpl: textFetch(oembedPayload(otherAgent.npub, 'alice_ai')),
      bypassCache: true,
    });
    expect(result!.status).toBe('broken');
  });

  it('npub in a non-template tweet stays unverifiable', async () => {
    const html = `<blockquote><p>warning, scammer: ${agent.npub}</p></blockquote>`;
    const [result] = await verifyAgentIdentities(agent.publicKey, [X_CLAIM], {
      fetchImpl: textFetch(oembedPayload(agent.npub, 'alice_ai', html)),
      bypassCache: true,
    });
    expect(result!.status).toBe('unverifiable');
  });

  it('unparseable oEmbed JSON is unverifiable', async () => {
    const [result] = await verifyAgentIdentities(agent.publicKey, [X_CLAIM], {
      fetchImpl: textFetch('<html>rate limited</html>'),
      bypassCache: true,
    });
    expect(result!.status).toBe('unverifiable');
  });

  it('in the browser, returns unverifiable WITHOUT fetching', async () => {
    vi.stubGlobal('process', { versions: {} });
    const fetchImpl = textFetch(oembedPayload(agent.npub, 'alice_ai'));
    const [result] = await verifyAgentIdentities(agent.publicKey, [X_CLAIM], {
      fetchImpl,
      bypassCache: true,
    });
    expect(result!.status).toBe('unverifiable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// --- website (NIP-05) verifier ---

describe('website (NIP-05) verifier', () => {
  it('verifies when names[<local>] equals the agent pubkey', async () => {
    const fetchImpl = textFetch(nostrJson({ agent: agent.publicKey }));
    const [result] = await verifyAgentIdentities(agent.publicKey, [WEBSITE_CLAIM], {
      fetchImpl,
      resolveHostAddresses: publicResolver,
      bypassCache: true,
    });
    expect(result!.status).toBe('verified');
    expect(publicResolver).toHaveBeenCalledWith('example.com');
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe('https://example.com/.well-known/nostr.json?name=agent');
    expect(init.redirect).toBe('error');
  });

  it('normalizes a bare-domain handle to the _@domain root identifier', async () => {
    const fetchImpl = textFetch(nostrJson({ _: agent.publicKey }));
    const [result] = await verifyAgentIdentities(
      agent.publicKey,
      [{ platform: 'website', handle: 'example.com', proofUrl: 'https://example.com' }],
      { fetchImpl, resolveHostAddresses: publicResolver, bypassCache: true },
    );
    expect(result!.status).toBe('verified');
    expect((fetchImpl as any).mock.calls[0][0]).toBe(
      'https://example.com/.well-known/nostr.json?name=_',
    );
  });

  it('name missing from a valid response is broken', async () => {
    const [result] = await verifyAgentIdentities(agent.publicKey, [WEBSITE_CLAIM], {
      fetchImpl: textFetch(nostrJson({ somebody: otherAgent.publicKey })),
      resolveHostAddresses: publicResolver,
      bypassCache: true,
    });
    expect(result!.status).toBe('broken');
  });

  it('name mapping to a different pubkey is broken', async () => {
    const [result] = await verifyAgentIdentities(agent.publicKey, [WEBSITE_CLAIM], {
      fetchImpl: textFetch(nostrJson({ agent: otherAgent.publicKey })),
      resolveHostAddresses: publicResolver,
      bypassCache: true,
    });
    expect(result!.status).toBe('broken');
  });

  it('404 is broken; other statuses and bad JSON are unverifiable', async () => {
    const broken = await verifyAgentIdentities(agent.publicKey, [WEBSITE_CLAIM], {
      fetchImpl: textFetch('nope', 404),
      resolveHostAddresses: publicResolver,
      bypassCache: true,
    });
    expect(broken[0]!.status).toBe('broken');

    const rateLimited = await verifyAgentIdentities(agent.publicKey, [WEBSITE_CLAIM], {
      fetchImpl: textFetch('nope', 429),
      resolveHostAddresses: publicResolver,
      bypassCache: true,
    });
    expect(rateLimited[0]!.status).toBe('unverifiable');

    const badJson = await verifyAgentIdentities(agent.publicKey, [WEBSITE_CLAIM], {
      fetchImpl: textFetch('not json'),
      resolveHostAddresses: publicResolver,
      bypassCache: true,
    });
    expect(badJson[0]!.status).toBe('unverifiable');
  });

  it('consults ONLY the exact claimed host - no www twin probe', async () => {
    // A claim on the apex must not fall back to www: the apex refusing is not
    // rescued by a www that happens to serve a valid mapping.
    const fetchImpl = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('https://example.com/')) {
        throw new TypeError('fetch failed: redirect'); // redirect: 'error' refusal
      }
      return new Response(nostrJson({ agent: agent.publicKey }), { status: 200 });
    }) as unknown as typeof fetch;
    const [result] = await verifyAgentIdentities(agent.publicKey, [WEBSITE_CLAIM], {
      fetchImpl,
      resolveHostAddresses: publicResolver,
      bypassCache: true,
    });
    expect(result!.status).toBe('unverifiable');
    // Only the apex was fetched - the www twin is never touched.
    expect((fetchImpl as any).mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
      'https://example.com/.well-known/nostr.json?name=agent',
    ]);
  });

  it('does not let a www-only takeover forge an apex claim (spoofing guard)', async () => {
    // Attacker controls www.victim.com (dangling-CNAME takeover) but NOT the
    // apex. They claim the apex and serve their pubkey at www. The apex, which
    // they do not control, is the only host consulted, so the forgery fails.
    const fetchImpl = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('https://www.')) {
        return new Response(nostrJson({ _: agent.publicKey }), { status: 200 });
      }
      return new Response(nostrJson({}), { status: 200 }); // apex: no mapping
    }) as unknown as typeof fetch;
    const [result] = await verifyAgentIdentities(agent.publicKey, [WEBSITE_CLAIM], {
      fetchImpl,
      resolveHostAddresses: publicResolver,
      bypassCache: true,
    });
    expect(result!.status).toBe('broken');
    expect((fetchImpl as any).mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
      'https://example.com/.well-known/nostr.json?name=agent',
    ]);
  });

  it('a claimed www domain verifies against www only (not the apex)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('https://www.')) {
        return new Response(nostrJson({ _: agent.publicKey }), { status: 200 });
      }
      throw new Error('apex must not be probed for a www claim');
    }) as unknown as typeof fetch;
    const [result] = await verifyAgentIdentities(
      agent.publicKey,
      [{ platform: 'website', handle: 'www.example.com', proofUrl: 'https://www.example.com' }],
      { fetchImpl, resolveHostAddresses: publicResolver, bypassCache: true },
    );
    expect(result!.status).toBe('verified');
    expect((fetchImpl as any).mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
      'https://www.example.com/.well-known/nostr.json?name=_',
    ]);
  });

  it('rejects hosts resolving to private ranges WITHOUT fetching (DNS SSRF guard)', async () => {
    const fetchImpl = textFetch(nostrJson({ agent: agent.publicKey }));
    for (const addresses of [['192.168.1.7'], ['8.8.8.8', '10.0.0.1'], ['fd00::1']]) {
      const [result] = await verifyAgentIdentities(agent.publicKey, [WEBSITE_CLAIM], {
        fetchImpl,
        resolveHostAddresses: vi.fn().mockResolvedValue(addresses),
        bypassCache: true,
      });
      expect(result!.status, addresses.join(',')).toBe('unverifiable');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolver error skips the fetch and maps to unverifiable', async () => {
    const fetchImpl = textFetch(nostrJson({ agent: agent.publicKey }));
    const [result] = await verifyAgentIdentities(agent.publicKey, [WEBSITE_CLAIM], {
      fetchImpl,
      resolveHostAddresses: vi.fn().mockRejectedValue(new Error('ENOTFOUND')),
      bypassCache: true,
    });
    expect(result!.status).toBe('unverifiable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// --- cache behavior ---

describe('verification cache', () => {
  it('serves a cached result within the TTL and refetches after expiry', async () => {
    vi.useFakeTimers();
    const fetchImpl = textFetch(githubProofBody(agent.npub));
    const first = await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], { fetchImpl });
    expect(first[0]!.status).toBe('verified');
    await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DEFAULTS.IDENTITY_VERIFY_CACHE_TTL_MS + 1);
    await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('unverifiable results use the shorter negative TTL', async () => {
    vi.useFakeTimers();
    const fetchImpl = textFetch('rate limited', 429);
    await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], { fetchImpl });
    await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DEFAULTS.IDENTITY_VERIFY_NEGATIVE_CACHE_TTL_MS + 1);
    await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('the key includes the claim set - republished claims are not served stale', async () => {
    const fetchImpl = textFetch(githubProofBody(agent.npub));
    await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], { fetchImpl });
    const newClaim: AgentExternalIdentity = {
      ...GITHUB_CLAIM,
      proofUrl: 'https://gist.github.com/alice/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    await verifyAgentIdentities(agent.publicKey, [newClaim], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bypassCache skips both the read and the write', async () => {
    const fetchImpl = textFetch(githubProofBody(agent.npub));
    await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], { fetchImpl, bypassCache: true });
    await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], { fetchImpl, bypassCache: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Nothing was written: a non-bypass call fetches again.
    await verifyAgentIdentities(agent.publicKey, [GITHUB_CLAIM], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('is bounded: the oldest entry is evicted at the cap', async () => {
    const fetchImpl = textFetch('Not Found', 404); // broken = definitive, cached
    const claimFor = (index: number): AgentExternalIdentity => ({
      platform: 'github',
      handle: `user${index}`,
      proofUrl: `https://gist.github.com/user${index}/9721ce4ee4fceb91c9711ca2a6c9a5ab`,
    });
    for (let i = 0; i < LIMITS.MAX_IDENTITY_VERIFY_CACHE_ENTRIES + 1; i++) {
      await verifyAgentIdentities(agent.publicKey, [claimFor(i)], { fetchImpl });
    }
    const fillCount = LIMITS.MAX_IDENTITY_VERIFY_CACHE_ENTRIES + 1;
    expect(fetchImpl).toHaveBeenCalledTimes(fillCount);
    // The newest entry is still cached...
    await verifyAgentIdentities(
      agent.publicKey,
      [claimFor(LIMITS.MAX_IDENTITY_VERIFY_CACHE_ENTRIES)],
      { fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(fillCount);
    // ...but the oldest was evicted and refetches.
    await verifyAgentIdentities(agent.publicKey, [claimFor(0)], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(fillCount + 1);
  });
});
