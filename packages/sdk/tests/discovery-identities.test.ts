import { finalizeEvent, type Event } from 'nostr-tools';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULTS, KIND_EXTERNAL_IDENTITIES, LIMITS } from '../src/constants';
import { ElisymIdentity } from '../src/primitives/identity';
import { DiscoveryService, parseExternalIdentityEvent } from '../src/services/discovery';
import type { NostrPool } from '../src/transport/pool';
import type { Agent, SubCloser } from '../src/types';

const GIST_ID = '9721ce4ee4fceb91c9711ca2a6c9a5ab';
const TWEET_ID = '1893471190424121782';

function createMockPool(): NostrPool & { published: Event[] } {
  const published: Event[] = [];
  return {
    published,
    querySync: vi.fn().mockResolvedValue([]),
    queryBatched: vi.fn().mockResolvedValue([]),
    queryBatchedByTag: vi.fn().mockResolvedValue([]),
    queryByIds: vi.fn().mockResolvedValue([]),
    publish: vi.fn(async (event: Event) => {
      published.push(event);
    }),
    publishAll: vi.fn(async (event: Event) => {
      published.push(event);
    }),
    subscribe: vi.fn((): SubCloser => ({ close: vi.fn() })),
    subscribeAndWait: vi.fn(async (): Promise<SubCloser> => ({ close: vi.fn() })),
    probe: vi.fn().mockResolvedValue(true),
    reset: vi.fn(),
    getRelays: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as any;
}

function makeIdentityEvent(
  identity: ElisymIdentity,
  tags: string[][],
  createdAt = Math.floor(Date.now() / 1000),
): Event {
  return finalizeEvent(
    {
      kind: KIND_EXTERNAL_IDENTITIES,
      created_at: createdAt,
      tags,
      content: '',
    },
    identity.secretKey,
  );
}

function makeProfileEvent(
  identity: ElisymIdentity,
  content: Record<string, unknown>,
  createdAt = Math.floor(Date.now() / 1000),
): Event {
  return finalizeEvent(
    {
      kind: 0,
      created_at: createdAt,
      tags: [],
      content: JSON.stringify(content),
    },
    identity.secretKey,
  );
}

function bareAgent(identity: ElisymIdentity): Agent {
  return {
    pubkey: identity.publicKey,
    npub: identity.npub,
    cards: [],
    eventId: '',
    supportedKinds: [],
    lastSeen: 0,
  };
}

// --- parseExternalIdentityEvent ---

describe('parseExternalIdentityEvent', () => {
  it('parses github + twitter tags into claims (x is the SDK-facing platform name)', () => {
    const identity = ElisymIdentity.generate();
    const event = makeIdentityEvent(identity, [
      ['i', 'github:alice', GIST_ID],
      ['i', 'twitter:alice_ai', TWEET_ID],
    ]);
    expect(parseExternalIdentityEvent(event)).toEqual([
      {
        platform: 'github',
        handle: 'alice',
        proofUrl: `https://gist.github.com/alice/${GIST_ID}`,
      },
      {
        platform: 'x',
        handle: 'alice_ai',
        proofUrl: `https://x.com/alice_ai/status/${TWEET_ID}`,
      },
    ]);
  });

  it('ignores non-whitelisted platforms', () => {
    const identity = ElisymIdentity.generate();
    const event = makeIdentityEvent(identity, [
      ['i', 'mastodon:alice@server.social', 'proof'],
      ['i', 'telegram:12345', 'proof'],
      ['i', 'github:alice', GIST_ID],
    ]);
    const claims = parseExternalIdentityEvent(event);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.platform).toBe('github');
  });

  it('drops hostile handles and proof ids (URL-injection charset guard)', () => {
    const identity = ElisymIdentity.generate();
    const event = makeIdentityEvent(identity, [
      ['i', 'github:../../../etc/passwd', GIST_ID],
      ['i', 'github:alice/evil', GIST_ID],
      ['i', 'github:alice?x=1', GIST_ID],
      ['i', 'twitter:alice_ai', '123;DROP TABLE'],
      ['i', 'twitter:a b', TWEET_ID],
      ['i', 'github:alice', 'ABCDEF'], // uppercase hex not allowed
    ]);
    expect(parseExternalIdentityEvent(event)).toEqual([]);
  });

  it('drops oversize handles and proof ids', () => {
    const identity = ElisymIdentity.generate();
    const event = makeIdentityEvent(identity, [
      ['i', `github:${'a'.repeat(LIMITS.MAX_IDENTITY_HANDLE_LENGTH + 1)}`, GIST_ID],
      ['i', `twitter:alice_ai`, '1'.repeat(LIMITS.MAX_IDENTITY_PROOF_ID_LENGTH + 1)],
    ]);
    expect(parseExternalIdentityEvent(event)).toEqual([]);
  });

  it('drops tweet ids that are not pure digits and gist ids that are not hex', () => {
    const identity = ElisymIdentity.generate();
    const event = makeIdentityEvent(identity, [
      ['i', 'twitter:alice_ai', '1.8934711904241218e18'],
      ['i', 'github:alice', 'not-hex-id!'],
    ]);
    expect(parseExternalIdentityEvent(event)).toEqual([]);
  });

  it('accepts i tags with more than 2 values (params 1-2 read, extras ignored)', () => {
    const identity = ElisymIdentity.generate();
    const event = makeIdentityEvent(identity, [
      ['i', 'github:alice', GIST_ID, 'wss://relay.example', 'extra'],
    ]);
    const claims = parseExternalIdentityEvent(event);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.proofUrl).toBe(`https://gist.github.com/alice/${GIST_ID}`);
  });

  it('drops tags without a proof id', () => {
    const identity = ElisymIdentity.generate();
    const event = makeIdentityEvent(identity, [['i', 'github:alice']]);
    expect(parseExternalIdentityEvent(event)).toEqual([]);
  });

  it('first valid claim per platform wins', () => {
    const identity = ElisymIdentity.generate();
    const event = makeIdentityEvent(identity, [
      ['i', 'github:first', GIST_ID],
      ['i', 'github:second', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ]);
    const claims = parseExternalIdentityEvent(event);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.handle).toBe('first');
  });

  it('caps the scan at MAX_IDENTITY_TAGS counted AFTER the whitelist filter', () => {
    const identity = ElisymIdentity.generate();
    // Non-whitelisted platforms ahead of the github tag must NOT consume the cap.
    const foreignTags = Array.from({ length: LIMITS.MAX_IDENTITY_TAGS }, (_value, index) => [
      'i',
      `mastodon:user${index}@server.social`,
      'proof',
    ]);
    const survives = makeIdentityEvent(identity, [...foreignTags, ['i', 'github:alice', GIST_ID]]);
    expect(parseExternalIdentityEvent(survives)).toHaveLength(1);

    // Whitelisted (even invalid) tags DO consume the cap.
    const whitelistedJunk = Array.from({ length: LIMITS.MAX_IDENTITY_TAGS }, () => [
      'i',
      'twitter:bad handle',
      TWEET_ID,
    ]);
    const capped = makeIdentityEvent(identity, [
      ...whitelistedJunk,
      ['i', 'github:alice', GIST_ID],
    ]);
    expect(parseExternalIdentityEvent(capped)).toEqual([]);
  });

  it('rejects a tampered event (signature check)', () => {
    const identity = ElisymIdentity.generate();
    const event = makeIdentityEvent(identity, [['i', 'github:alice', GIST_ID]]);
    // JSON round-trip drops nostr-tools' memoized verification symbol, so the
    // tampered copy is actually re-verified.
    const tampered = JSON.parse(JSON.stringify(event)) as Event;
    tampered.tags = [['i', 'github:mallory', GIST_ID]];
    expect(parseExternalIdentityEvent(tampered)).toEqual([]);
  });

  it('rejects a far-future event (clock-skew gate)', () => {
    const identity = ElisymIdentity.generate();
    const event = makeIdentityEvent(
      identity,
      [['i', 'github:alice', GIST_ID]],
      Math.floor(Date.now() / 1000) + 3600,
    );
    expect(parseExternalIdentityEvent(event)).toEqual([]);
  });
});

// --- enrichWithMetadata (two-kind query) ---

describe('DiscoveryService.enrichWithMetadata identities', () => {
  it('splits newest-wins per (pubkey, kind) - an older kind is not dropped by a newer one', async () => {
    const pool = createMockPool();
    const identity = ElisymIdentity.generate();
    const now = Math.floor(Date.now() / 1000);
    // kind 0 older than kind 10011: a pubkey-keyed newest-wins would drop the profile.
    const profileEvent = makeProfileEvent(identity, { name: 'Alice', about: 'Hello' }, now - 100);
    const identityEvent = makeIdentityEvent(identity, [['i', 'github:alice', GIST_ID]], now);
    (pool.queryBatched as any).mockResolvedValue([profileEvent, identityEvent]);

    const svc = new DiscoveryService(pool as any);
    const agents = [bareAgent(identity)];
    await svc.enrichWithMetadata(agents);

    expect(agents[0]!.name).toBe('Alice');
    expect(agents[0]!.identities).toEqual([
      { platform: 'github', handle: 'alice', proofUrl: `https://gist.github.com/alice/${GIST_ID}` },
    ]);
  });

  it('queries both kinds with a halved batch size', async () => {
    const pool = createMockPool();
    const identity = ElisymIdentity.generate();
    const svc = new DiscoveryService(pool as any);
    await svc.enrichWithMetadata([bareAgent(identity)]);
    expect(pool.queryBatched).toHaveBeenCalledWith(
      { kinds: [0, KIND_EXTERNAL_IDENTITIES] },
      [identity.publicKey],
      Math.floor(DEFAULTS.BATCH_SIZE / 2),
    );
  });

  it('keeps only the newest kind-10011 per pubkey (replaceable overwrite)', async () => {
    const pool = createMockPool();
    const identity = ElisymIdentity.generate();
    const now = Math.floor(Date.now() / 1000);
    const older = makeIdentityEvent(identity, [['i', 'github:oldname', GIST_ID]], now - 100);
    const newer = makeIdentityEvent(identity, [['i', 'github:newname', GIST_ID]], now);
    (pool.queryBatched as any).mockResolvedValue([older, newer]);

    const svc = new DiscoveryService(pool as any);
    const agents = [bareAgent(identity)];
    await svc.enrichWithMetadata(agents);
    expect(agents[0]!.identities).toHaveLength(1);
    expect(agents[0]!.identities![0]!.handle).toBe('newname');
  });

  it('derives a website claim from a valid kind-0 nip05 (bare domain normalized)', async () => {
    const pool = createMockPool();
    const identity = ElisymIdentity.generate();
    const profileEvent = makeProfileEvent(identity, { name: 'Alice', nip05: 'Example.com' });
    (pool.queryBatched as any).mockResolvedValue([profileEvent]);

    const svc = new DiscoveryService(pool as any);
    const agents = [bareAgent(identity)];
    await svc.enrichWithMetadata(agents);
    expect(agents[0]!.identities).toEqual([
      { platform: 'website', handle: '_@example.com', proofUrl: 'https://example.com' },
    ]);
  });

  it('drops an invalid nip05 (IP literal / Unicode host) without dropping the profile', async () => {
    const pool = createMockPool();
    const identity = ElisymIdentity.generate();
    const profileEvent = makeProfileEvent(identity, { name: 'Alice', nip05: 'agent@192.168.1.1' });
    (pool.queryBatched as any).mockResolvedValue([profileEvent]);

    const svc = new DiscoveryService(pool as any);
    const agents = [bareAgent(identity)];
    await svc.enrichWithMetadata(agents);
    expect(agents[0]!.name).toBe('Alice');
    expect(agents[0]!.identities).toEqual([]);
  });

  it('an empty-tag kind 10011 (unlink) yields a DEFINED empty claim set', async () => {
    const pool = createMockPool();
    const identity = ElisymIdentity.generate();
    (pool.queryBatched as any).mockResolvedValue([makeIdentityEvent(identity, [])]);

    const svc = new DiscoveryService(pool as any);
    const agents = [bareAgent(identity)];
    await svc.enrichWithMetadata(agents);
    // Defined-but-empty, not undefined: spread-merging consumers
    // ({...cached, ...fresh}) must see the retraction, not keep stale claims.
    expect(agents[0]!.identities).toEqual([]);
  });

  it('a full relay miss (neither kind returned) leaves identities undefined', async () => {
    const pool = createMockPool();
    const identity = ElisymIdentity.generate();
    (pool.queryBatched as any).mockResolvedValue([]);

    const svc = new DiscoveryService(pool as any);
    const agents = [bareAgent(identity)];
    await svc.enrichWithMetadata(agents);
    // A timed-out or event-less query is not a retraction: the key stays
    // absent so {...cached, ...fresh} consumers keep previously seen claims.
    expect(agents[0]!.identities).toBeUndefined();
  });
});

// --- publishExternalIdentities ---

describe('DiscoveryService.publishExternalIdentities', () => {
  it('publishes NIP-39 wire format (on-wire platform name twitter)', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();

    const eventId = await svc.publishExternalIdentities(identity, [
      { platform: 'github', handle: 'alice', proofId: GIST_ID },
      { platform: 'x', handle: 'alice_ai', proofId: TWEET_ID },
    ]);
    expect(eventId).toBeTruthy();
    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_EXTERNAL_IDENTITIES);
    expect(ev.content).toBe('');
    expect(ev.tags).toEqual([
      ['i', 'github:alice', GIST_ID],
      ['i', 'twitter:alice_ai', TWEET_ID],
    ]);
  });

  it('publishes an EMPTY claim set (unlink must propagate via replaceable overwrite)', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();

    await svc.publishExternalIdentities(identity, []);
    expect(pool.published).toHaveLength(1);
    expect(pool.published[0]!.tags).toEqual([]);
  });

  it('rejects invalid handles and proof ids loudly (symmetric with the parser)', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();

    await expect(
      svc.publishExternalIdentities(identity, [
        { platform: 'github', handle: 'bad handle', proofId: GIST_ID },
      ]),
    ).rejects.toThrow('Invalid GitHub username');
    await expect(
      svc.publishExternalIdentities(identity, [
        { platform: 'github', handle: 'alice', proofId: 'UPPERCASE' },
      ]),
    ).rejects.toThrow('Invalid GitHub gist id');
    await expect(
      svc.publishExternalIdentities(identity, [
        { platform: 'x', handle: 'way_too_long_for_x_15', proofId: TWEET_ID },
      ]),
    ).rejects.toThrow('Invalid X username');
    await expect(
      svc.publishExternalIdentities(identity, [
        { platform: 'x', handle: 'alice_ai', proofId: '1.89e18' },
      ]),
    ).rejects.toThrow('Invalid tweet id');
    expect(pool.published).toHaveLength(0);
  });

  it('rejects duplicate platforms and oversized claim sets', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();

    await expect(
      svc.publishExternalIdentities(identity, [
        { platform: 'github', handle: 'alice', proofId: GIST_ID },
        { platform: 'github', handle: 'bob', proofId: GIST_ID },
      ]),
    ).rejects.toThrow('Duplicate identity claim');

    const tooMany = Array.from({ length: LIMITS.MAX_IDENTITY_TAGS + 1 }, () => ({
      platform: 'github' as const,
      handle: 'alice',
      proofId: GIST_ID,
    }));
    await expect(svc.publishExternalIdentities(identity, tooMany)).rejects.toThrow(
      'Too many identity claims',
    );
  });
});

// --- publishProfile nip05 ---

describe('DiscoveryService.publishProfile nip05', () => {
  it('publishes a normalized nip05 (bare domain becomes _@domain)', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();

    await svc.publishProfile(identity, 'Alice', 'about', undefined, undefined, 'Example.com');
    const content = JSON.parse(pool.published[0]!.content);
    expect(content.nip05).toBe('_@example.com');
  });

  it('omits nip05 when not passed', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();

    await svc.publishProfile(identity, 'Alice', 'about');
    const content = JSON.parse(pool.published[0]!.content);
    expect('nip05' in content).toBe(false);
  });

  it('rejects an invalid nip05 loudly', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();

    await expect(
      svc.publishProfile(identity, 'Alice', 'about', undefined, undefined, 'agent@192.168.1.1'),
    ).rejects.toThrow('Invalid nip05');
    expect(pool.published).toHaveLength(0);
  });
});

// --- fetchExternalIdentityClaims ---

describe('DiscoveryService.fetchExternalIdentityClaims', () => {
  it('returns claims plus newest kind-0 profile fields from one author-scoped query', async () => {
    const pool = createMockPool();
    const identity = ElisymIdentity.generate();
    const now = Math.floor(Date.now() / 1000);
    const olderProfile = makeProfileEvent(
      identity,
      { name: 'Old', picture: 'https://img.example/old.png' },
      now - 100,
    );
    const newerProfile = makeProfileEvent(
      identity,
      {
        name: 'Alice',
        picture: 'https://img.example/a.png',
        banner: 'https://img.example/b.png',
        nip05: 'agent@example.com',
      },
      now,
    );
    const identityEvent = makeIdentityEvent(identity, [['i', 'github:alice', GIST_ID]], now - 50);
    (pool.queryBatched as any).mockResolvedValue([olderProfile, newerProfile, identityEvent]);

    const svc = new DiscoveryService(pool as any);
    const result = await svc.fetchExternalIdentityClaims(identity.publicKey);

    expect(pool.queryBatched).toHaveBeenCalledWith({ kinds: [0, KIND_EXTERNAL_IDENTITIES] }, [
      identity.publicKey,
    ]);
    expect(result.profile).toEqual({
      name: 'Alice',
      about: undefined,
      picture: 'https://img.example/a.png',
      banner: 'https://img.example/b.png',
      nip05: 'agent@example.com',
    });
    expect(result.identities).toEqual([
      { platform: 'github', handle: 'alice', proofUrl: `https://gist.github.com/alice/${GIST_ID}` },
      { platform: 'website', handle: 'agent@example.com', proofUrl: 'https://example.com' },
    ]);
  });

  it('ignores events authored by a different pubkey', async () => {
    const pool = createMockPool();
    const identity = ElisymIdentity.generate();
    const impostor = ElisymIdentity.generate();
    (pool.queryBatched as any).mockResolvedValue([
      makeIdentityEvent(impostor, [['i', 'github:mallory', GIST_ID]]),
    ]);

    const svc = new DiscoveryService(pool as any);
    const result = await svc.fetchExternalIdentityClaims(identity.publicKey);
    expect(result.identities).toEqual([]);
  });

  it('works for a pubkey with no capability cards (not card-gated)', async () => {
    const pool = createMockPool();
    const identity = ElisymIdentity.generate();
    (pool.queryBatched as any).mockResolvedValue([
      makeIdentityEvent(identity, [['i', 'twitter:alice_ai', TWEET_ID]]),
    ]);

    const svc = new DiscoveryService(pool as any);
    const result = await svc.fetchExternalIdentityClaims(identity.publicKey);
    expect(result.identities).toEqual([
      { platform: 'x', handle: 'alice_ai', proofUrl: `https://x.com/alice_ai/status/${TWEET_ID}` },
    ]);
    // Only the direct two-kind query - never the card query.
    expect(pool.querySync).not.toHaveBeenCalled();
  });
});
