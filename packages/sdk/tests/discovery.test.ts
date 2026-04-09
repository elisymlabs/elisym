import { finalizeEvent, type Event, type Filter } from 'nostr-tools';
import { describe, it, expect, vi } from 'vitest';
import { KIND_APP_HANDLER, KIND_JOB_REQUEST, LIMITS } from '../src/constants';
import { ElisymIdentity } from '../src/primitives/identity';
import { DiscoveryService, toDTag } from '../src/services/discovery';
import type { NostrPool } from '../src/transport/pool';
import type { CapabilityCard, SubCloser } from '../src/types';

function createMockPool(): NostrPool & { published: Event[] } {
  const published: Event[] = [];
  return {
    published,
    querySync: vi.fn().mockResolvedValue([]),
    queryBatched: vi.fn().mockResolvedValue([]),
    queryBatchedByTag: vi.fn().mockResolvedValue([]),
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

function makeCard(overrides: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    name: 'test-agent',
    description: 'A test agent',
    capabilities: ['text-gen'],
    payment: { chain: 'solana', network: 'devnet', address: '11111111111111111111111111111111' },
    ...overrides,
  };
}

function makeCapabilityEvent(
  identity: ElisymIdentity,
  card: CapabilityCard,
  opts: { createdAt?: number; dTag?: string; kinds?: number[] } = {},
): Event {
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000);
  const dTag = opts.dTag ?? toDTag(card.name);
  const kinds = opts.kinds ?? [KIND_JOB_REQUEST];
  return finalizeEvent(
    {
      kind: KIND_APP_HANDLER,
      created_at: createdAt,
      tags: [
        ['d', dTag],
        ['t', 'elisym'],
        ...card.capabilities.map((c) => ['t', c]),
        ...kinds.map((k) => ['k', String(k)]),
      ],
      content: JSON.stringify(card),
    },
    identity.secretKey,
  );
}

// --- toDTag ---

describe('toDTag', () => {
  it('converts name to lowercase hyphenated d-tag', () => {
    expect(toDTag('My Agent')).toBe('my-agent');
    expect(toDTag('hello world')).toBe('hello-world');
  });

  it('escapes non-ASCII characters', () => {
    const tag = toDTag('cafe\u0301');
    expect(tag).toContain('_');
  });

  it('strips leading/trailing hyphens', () => {
    expect(toDTag(' hello ')).toBe('hello');
  });

  it('throws on empty name', () => {
    expect(() => toDTag('')).toThrow('at least one ASCII alphanumeric');
  });
});

// --- fetchAgentsPage ---

describe('DiscoveryService.fetchAgentsPage', () => {
  it('returns agents from capability events', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const card = makeCard();
    const ev = makeCapabilityEvent(agent, card);

    (pool.querySync as any).mockResolvedValue([ev]);
    const svc = new DiscoveryService(pool as any);

    const { agents } = await svc.fetchAgentsPage('devnet');
    expect(agents.length).toBe(1);
    expect(agents[0]!.pubkey).toBe(agent.publicKey);
    expect(agents[0]!.cards[0]!.name).toBe('test-agent');
  });

  it('filters by network - excludes mainnet agents from devnet query', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const devnetCard = makeCard({
      payment: { chain: 'solana', network: 'devnet', address: '11111111111111111111111111111111' },
    });
    const mainnetCard = makeCard({
      name: 'mainnet-agent',
      payment: { chain: 'solana', network: 'mainnet', address: '22222222222222222222222222222222' },
    });

    const ev1 = makeCapabilityEvent(agent, devnetCard);
    const agent2 = ElisymIdentity.generate();
    const ev2 = makeCapabilityEvent(agent2, mainnetCard);

    (pool.querySync as any).mockResolvedValue([ev1, ev2]);
    const svc = new DiscoveryService(pool as any);

    const { agents: devnetAgents } = await svc.fetchAgentsPage('devnet');
    expect(devnetAgents.length).toBe(1);
    expect(devnetAgents[0]!.pubkey).toBe(agent.publicKey);

    const { agents: mainnetAgents } = await svc.fetchAgentsPage('mainnet');
    expect(mainnetAgents.length).toBe(1);
    expect(mainnetAgents[0]!.pubkey).toBe(agent2.publicKey);
  });

  it('agents without payment default to devnet', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const card = makeCard({ payment: undefined });
    const ev = makeCapabilityEvent(agent, card);

    (pool.querySync as any).mockResolvedValue([ev]);
    const svc = new DiscoveryService(pool as any);

    const { agents: devnet } = await svc.fetchAgentsPage('devnet');
    expect(devnet.length).toBe(1);

    const { agents: mainnet } = await svc.fetchAgentsPage('mainnet');
    expect(mainnet.length).toBe(0);
  });

  it('deduplicates by (pubkey, d-tag) keeping newest', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const card = makeCard();
    const now = Math.floor(Date.now() / 1000);

    const older = makeCapabilityEvent(agent, card, { createdAt: now - 100 });
    const newer = makeCapabilityEvent(
      agent,
      { ...card, description: 'updated' },
      { createdAt: now },
    );

    (pool.querySync as any).mockResolvedValue([older, newer]);
    const svc = new DiscoveryService(pool as any);

    const { agents } = await svc.fetchAgentsPage('devnet');
    expect(agents.length).toBe(1);
    expect(agents[0]!.cards[0]!.description).toBe('updated');
  });

  it('deduplicates by card name within same agent', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const now = Math.floor(Date.now() / 1000);

    const card1 = makeCard({ description: 'old version' });
    const card2 = makeCard({ description: 'new version' });
    // Same card name but different d-tags (simulating republish)
    const ev1 = makeCapabilityEvent(agent, card1, { createdAt: now - 100, dTag: 'test-agent-v1' });
    const ev2 = makeCapabilityEvent(agent, card2, { createdAt: now, dTag: 'test-agent-v2' });

    (pool.querySync as any).mockResolvedValue([ev1, ev2]);
    const svc = new DiscoveryService(pool as any);

    const { agents } = await svc.fetchAgentsPage('devnet');
    expect(agents.length).toBe(1);
    expect(agents[0]!.cards.length).toBe(1);
    expect(agents[0]!.cards[0]!.description).toBe('new version');
  });

  it('skips events with deleted: true', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const ev = finalizeEvent(
      {
        kind: KIND_APP_HANDLER,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'test'],
          ['t', 'elisym'],
        ],
        content: JSON.stringify({ ...makeCard(), deleted: true }),
      },
      agent.secretKey,
    );

    (pool.querySync as any).mockResolvedValue([ev]);
    const svc = new DiscoveryService(pool as any);

    const { agents } = await svc.fetchAgentsPage('devnet');
    expect(agents.length).toBe(0);
  });

  it('skips events with invalid JSON content', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const ev = finalizeEvent(
      {
        kind: KIND_APP_HANDLER,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'test'],
          ['t', 'elisym'],
        ],
        content: 'not json',
      },
      agent.secretKey,
    );

    (pool.querySync as any).mockResolvedValue([ev]);
    const svc = new DiscoveryService(pool as any);

    const { agents } = await svc.fetchAgentsPage('devnet');
    expect(agents.length).toBe(0);
  });

  it('skips events missing required card fields', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    // Missing 'capabilities' field
    const ev = finalizeEvent(
      {
        kind: KIND_APP_HANDLER,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'test'],
          ['t', 'elisym'],
        ],
        content: JSON.stringify({ name: 'test', description: 'desc' }),
      },
      agent.secretKey,
    );

    (pool.querySync as any).mockResolvedValue([ev]);
    const svc = new DiscoveryService(pool as any);

    const { agents } = await svc.fetchAgentsPage('devnet');
    expect(agents.length).toBe(0);
  });

  it('returns empty for no events', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);

    const { agents } = await svc.fetchAgentsPage('devnet');
    expect(agents.length).toBe(0);
  });

  it('returns pagination cursor from oldest event', async () => {
    const pool = createMockPool();
    const a1 = ElisymIdentity.generate();
    const a2 = ElisymIdentity.generate();
    const now = Math.floor(Date.now() / 1000);

    const ev1 = makeCapabilityEvent(a1, makeCard(), { createdAt: now - 200 });
    const ev2 = makeCapabilityEvent(a2, makeCard({ name: 'other' }), { createdAt: now - 100 });

    (pool.querySync as any).mockResolvedValue([ev1, ev2]);
    const svc = new DiscoveryService(pool as any);

    const { oldestCreatedAt } = await svc.fetchAgentsPage('devnet');
    expect(oldestCreatedAt).toBe(now - 200);
  });

  it('collects supportedKinds from k tags', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const card = makeCard();
    const ev = makeCapabilityEvent(agent, card, { kinds: [5100, 5200] });

    (pool.querySync as any).mockResolvedValue([ev]);
    const svc = new DiscoveryService(pool as any);

    const { agents } = await svc.fetchAgentsPage('devnet');
    expect(agents[0]!.supportedKinds).toContain(5100);
    expect(agents[0]!.supportedKinds).toContain(5200);
  });
});

// --- enrichWithMetadata ---

describe('DiscoveryService.enrichWithMetadata', () => {
  it('applies name, picture, about from kind:0', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();

    const metaEvent = finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({
          name: 'Alice',
          picture: 'https://img.example/a.png',
          about: 'Hello',
        }),
      },
      agent.secretKey,
    );
    (pool.queryBatched as any).mockResolvedValue([metaEvent]);

    const svc = new DiscoveryService(pool as any);
    const agents = [
      {
        pubkey: agent.publicKey,
        npub: agent.npub,
        cards: [],
        eventId: '',
        supportedKinds: [],
        lastSeen: 0,
      },
    ];
    await svc.enrichWithMetadata(agents as any);

    expect(agents[0]!.name).toBe('Alice');
    expect(agents[0]!.picture).toBe('https://img.example/a.png');
    expect(agents[0]!.about).toBe('Hello');
  });

  it('handles empty agent list', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const result = await svc.enrichWithMetadata([]);
    expect(result).toEqual([]);
    expect(pool.queryBatched).not.toHaveBeenCalled();
  });

  it('handles malformed metadata gracefully', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();

    const metaEvent = finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'not json',
      },
      agent.secretKey,
    );
    (pool.queryBatched as any).mockResolvedValue([metaEvent]);

    const svc = new DiscoveryService(pool as any);
    const agents = [
      {
        pubkey: agent.publicKey,
        npub: agent.npub,
        cards: [],
        eventId: '',
        supportedKinds: [],
        lastSeen: 0,
      },
    ];
    // Should not throw
    await svc.enrichWithMetadata(agents as any);
    expect(agents[0]!.name).toBeUndefined();
  });
});

// --- publishCapability ---

describe('DiscoveryService.publishCapability', () => {
  it('publishes valid capability card', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();
    const card = makeCard();

    const eventId = await svc.publishCapability(identity, card);
    expect(eventId).toBeTruthy();
    expect(pool.published.length).toBe(1);

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_APP_HANDLER);
    expect(ev.tags.find((t) => t[0] === 'd')?.[1]).toBe('test-agent');
    expect(ev.tags.find((t) => t[0] === 't' && t[1] === 'elisym')).toBeTruthy();

    const content = JSON.parse(ev.content);
    expect(content.name).toBe('test-agent');
  });

  it('rejects missing payment address', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();
    const card = makeCard({ payment: undefined });

    await expect(svc.publishCapability(identity, card)).rejects.toThrow('payment address');
  });

  it('rejects invalid Solana address format', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();
    const card = makeCard({
      payment: { chain: 'solana', network: 'devnet', address: 'invalid!!!' },
    });

    await expect(svc.publishCapability(identity, card)).rejects.toThrow('Invalid Solana address');
  });

  it('rejects too long name', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();
    const card = makeCard({ name: 'a'.repeat(LIMITS.MAX_AGENT_NAME_LENGTH + 1) });

    await expect(svc.publishCapability(identity, card)).rejects.toThrow('name too long');
  });

  it('rejects too long description', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();
    const card = makeCard({ description: 'a'.repeat(LIMITS.MAX_DESCRIPTION_LENGTH + 1) });

    await expect(svc.publishCapability(identity, card)).rejects.toThrow('Description too long');
  });

  it('rejects too many capabilities', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();
    const caps = Array.from({ length: LIMITS.MAX_CAPABILITIES + 1 }, (_, i) => `cap-${i}`);
    const card = makeCard({ capabilities: caps });

    await expect(svc.publishCapability(identity, card)).rejects.toThrow('Too many capabilities');
  });

  it('rejects too long capability name', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();
    const card = makeCard({ capabilities: ['a'.repeat(LIMITS.MAX_CAPABILITY_LENGTH + 1)] });

    await expect(svc.publishCapability(identity, card)).rejects.toThrow('Capability name too long');
  });
});

// --- deleteCapability ---

describe('DiscoveryService.deleteCapability', () => {
  it('publishes tombstone event', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();

    await svc.deleteCapability(identity, 'test-agent');
    expect(pool.published.length).toBe(1);

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_APP_HANDLER);
    expect(ev.tags.find((t) => t[0] === 'd')?.[1]).toBe('test-agent');
    const content = JSON.parse(ev.content);
    expect(content.deleted).toBe(true);
  });
});

// --- publishProfile ---

describe('DiscoveryService.publishProfile', () => {
  it('publishes kind:0 profile event', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();

    await svc.publishProfile(identity, 'Alice', 'Hello world', 'https://img.example/a.png');
    expect(pool.published.length).toBe(1);

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(0);
    const content = JSON.parse(ev.content);
    expect(content.name).toBe('Alice');
    expect(content.about).toBe('Hello world');
    expect(content.picture).toBe('https://img.example/a.png');
  });

  it('rejects too long name', async () => {
    const pool = createMockPool();
    const svc = new DiscoveryService(pool as any);
    const identity = ElisymIdentity.generate();

    await expect(
      svc.publishProfile(identity, 'a'.repeat(LIMITS.MAX_AGENT_NAME_LENGTH + 1), 'about'),
    ).rejects.toThrow('name too long');
  });
});
