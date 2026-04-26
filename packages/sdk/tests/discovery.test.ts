import { finalizeEvent, type Event, type Filter } from 'nostr-tools';
import { describe, it, expect, vi } from 'vitest';
import {
  KIND_APP_HANDLER,
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
  LIMITS,
} from '../src/constants';
import { ElisymIdentity } from '../src/primitives/identity';
import {
  DiscoveryService,
  compareAgentsByRank,
  computeRankKey,
  toDTag,
} from '../src/services/discovery';
import type { NostrPool } from '../src/transport/pool';
import type { Agent, CapabilityCard, SubCloser } from '../src/types';

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

// --- fetchAgents ranking ---

const SOL_ADDRESS_A = 'So11111111111111111111111111111111111111112';
const SOL_ADDRESS_B = 'So11111111111111111111111111111111111111113';
const SOL_ADDRESS_C = 'So11111111111111111111111111111111111111114';

function makeFeedbackEvent(
  customer: ElisymIdentity,
  targetPubkey: string,
  opts: {
    createdAt: number;
    rating?: '0' | '1';
    status?: string;
    txSignature?: string;
    jobEventId?: string;
  },
): Event {
  const tags: string[][] = [['p', targetPubkey]];
  if (opts.jobEventId) {
    tags.push(['e', opts.jobEventId]);
  }
  if (opts.rating !== undefined) {
    tags.push(['rating', opts.rating]);
  }
  if (opts.status) {
    tags.push(['status', opts.status]);
  }
  if (opts.txSignature) {
    tags.push(['tx', opts.txSignature, 'solana']);
  }
  return finalizeEvent(
    {
      kind: KIND_JOB_FEEDBACK,
      created_at: opts.createdAt,
      tags,
      content: '',
    },
    customer.secretKey,
  );
}

function makeResultEvent(
  agent: ElisymIdentity,
  opts: {
    createdAt: number;
    kind?: number;
    jobEventId?: string;
  } = { createdAt: Math.floor(Date.now() / 1000) },
): Event {
  const tags: string[][] = [];
  if (opts.jobEventId) {
    tags.push(['e', opts.jobEventId]);
  }
  return finalizeEvent(
    {
      kind: opts.kind ?? KIND_JOB_RESULT,
      created_at: opts.createdAt,
      tags,
      content: 'result-payload',
    },
    agent.secretKey,
  );
}

interface RoutedPool extends NostrPool {
  published: Event[];
}

function setupRoutedPool(opts: {
  capabilityEvents: Event[];
  resultEvents: Event[];
  feedbackEvents: Event[];
  metaEvents?: Event[];
}): RoutedPool {
  const pool = createMockPool();
  (pool.querySync as any).mockImplementation((filter: Filter) => {
    if (filter.kinds?.includes(KIND_APP_HANDLER)) {
      return Promise.resolve(opts.capabilityEvents);
    }
    return Promise.resolve([]);
  });
  (pool.queryBatched as any).mockImplementation((filter: Omit<Filter, 'authors'>) => {
    if (filter.kinds?.includes(0)) {
      return Promise.resolve(opts.metaEvents ?? []);
    }
    // Result kinds (6xxx) - the discovery service uses queryBatched for result events.
    return Promise.resolve(opts.resultEvents);
  });
  (pool.queryBatchedByTag as any).mockImplementation((filter: Filter, tagName: string) => {
    if (tagName === 'p' && filter.kinds?.includes(KIND_JOB_FEEDBACK)) {
      return Promise.resolve(opts.feedbackEvents);
    }
    return Promise.resolve([]);
  });
  return pool as RoutedPool;
}

describe('DiscoveryService.fetchAgents ranking', () => {
  it('sorts agents in the same minute bucket by positive rate DESC', async () => {
    // Pin `now` to second :50 of the current minute so `now - 10` (=:40) and
    // `now - 15` (=:35) deterministically share a 60s bucket. Using a raw
    // wall-clock `now` made this test flake when `now % 60` was in [10, 14],
    // since `now - 15` crossed into the previous minute.
    const realNow = Math.floor(Date.now() / 1000);
    const now = Math.floor(realNow / 60) * 60 + 50;
    const a1 = ElisymIdentity.generate();
    const a2 = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const cap1 = makeCapabilityEvent(
      a1,
      makeCard({
        name: 'agent-low-rate',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_A },
      }),
    );
    const cap2 = makeCapabilityEvent(
      a2,
      makeCard({
        name: 'agent-high-rate',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_B },
      }),
    );

    const jobA1 = 'job-a1';
    const jobA2 = 'job-a2';
    const feedbacks = [
      makeFeedbackEvent(customer, a1.publicKey, {
        createdAt: now - 10,
        status: 'payment-completed',
        txSignature: 'sig-a1',
        jobEventId: jobA1,
      }),
      makeFeedbackEvent(customer, a1.publicKey, { createdAt: now - 50, rating: '1' }),
      makeFeedbackEvent(customer, a1.publicKey, { createdAt: now - 51, rating: '0' }),
      makeFeedbackEvent(customer, a1.publicKey, { createdAt: now - 52, rating: '0' }),
      makeFeedbackEvent(customer, a2.publicKey, {
        createdAt: now - 15,
        status: 'payment-completed',
        txSignature: 'sig-a2',
        jobEventId: jobA2,
      }),
      makeFeedbackEvent(customer, a2.publicKey, { createdAt: now - 60, rating: '1' }),
      makeFeedbackEvent(customer, a2.publicKey, { createdAt: now - 61, rating: '1' }),
    ];
    const results = [
      makeResultEvent(a1, { createdAt: now - 11, jobEventId: jobA1 }),
      makeResultEvent(a2, { createdAt: now - 16, jobEventId: jobA2 }),
    ];

    const pool = setupRoutedPool({
      capabilityEvents: [cap1, cap2],
      resultEvents: results,
      feedbackEvents: feedbacks,
    });

    const svc = new DiscoveryService(pool as any);
    const agents = await svc.fetchAgents('devnet');

    expect(agents.length).toBe(2);
    expect(agents[0]!.pubkey).toBe(a2.publicKey);
    expect(agents[0]!.positiveCount).toBe(2);
    expect(agents[0]!.totalRatingCount).toBe(2);
    expect(agents[1]!.pubkey).toBe(a1.publicKey);
    expect(agents[1]!.positiveCount).toBe(1);
    expect(agents[1]!.totalRatingCount).toBe(3);
  });

  it('ranks newer paid bucket above older bucket regardless of rate', async () => {
    const now = Math.floor(Date.now() / 1000);
    const aFresh = ElisymIdentity.generate();
    const aStale = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const capFresh = makeCapabilityEvent(
      aFresh,
      makeCard({
        name: 'fresh',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_A },
      }),
    );
    const capStale = makeCapabilityEvent(
      aStale,
      makeCard({
        name: 'stale',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_B },
      }),
    );

    const jobFresh = 'job-fresh';
    const jobStale = 'job-stale';
    const feedbacks = [
      // fresh: paid 30s ago, no ratings
      makeFeedbackEvent(customer, aFresh.publicKey, {
        createdAt: now - 30,
        status: 'payment-completed',
        txSignature: 'sig-fresh',
        jobEventId: jobFresh,
      }),
      // stale: paid 10 minutes ago, perfect rating
      makeFeedbackEvent(customer, aStale.publicKey, {
        createdAt: now - 600,
        status: 'payment-completed',
        txSignature: 'sig-stale',
        jobEventId: jobStale,
      }),
      makeFeedbackEvent(customer, aStale.publicKey, { createdAt: now - 601, rating: '1' }),
      makeFeedbackEvent(customer, aStale.publicKey, { createdAt: now - 602, rating: '1' }),
    ];
    const results = [
      makeResultEvent(aFresh, { createdAt: now - 31, jobEventId: jobFresh }),
      makeResultEvent(aStale, { createdAt: now - 601, jobEventId: jobStale }),
    ];

    const pool = setupRoutedPool({
      capabilityEvents: [capFresh, capStale],
      resultEvents: results,
      feedbackEvents: feedbacks,
    });

    const svc = new DiscoveryService(pool as any);
    const agents = await svc.fetchAgents('devnet');

    expect(agents.length).toBe(2);
    expect(agents[0]!.pubkey).toBe(aFresh.publicKey);
    expect(agents[1]!.pubkey).toBe(aStale.publicKey);
  });

  it('places agents without verified paid jobs in cold-start bucket below paid agents', async () => {
    const now = Math.floor(Date.now() / 1000);
    const aPaid = ElisymIdentity.generate();
    const aColdNew = ElisymIdentity.generate();
    const aColdOld = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const capPaid = makeCapabilityEvent(
      aPaid,
      makeCard({
        name: 'paid',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_A },
      }),
      { createdAt: now - 1000 },
    );
    const capColdNew = makeCapabilityEvent(
      aColdNew,
      makeCard({
        name: 'cold-new',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_B },
      }),
      { createdAt: now - 100 },
    );
    const capColdOld = makeCapabilityEvent(
      aColdOld,
      makeCard({
        name: 'cold-old',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_C },
      }),
      { createdAt: now - 5000 },
    );

    const jobPaid = 'job-paid';
    const feedbacks = [
      makeFeedbackEvent(customer, aPaid.publicKey, {
        createdAt: now - 200,
        status: 'payment-completed',
        txSignature: 'sig-paid',
        jobEventId: jobPaid,
      }),
    ];
    const results = [makeResultEvent(aPaid, { createdAt: now - 201, jobEventId: jobPaid })];

    const pool = setupRoutedPool({
      capabilityEvents: [capPaid, capColdNew, capColdOld],
      resultEvents: results,
      feedbackEvents: feedbacks,
    });

    const svc = new DiscoveryService(pool as any);
    const agents = await svc.fetchAgents('devnet');

    expect(agents.length).toBe(3);
    expect(agents[0]!.pubkey).toBe(aPaid.publicKey);
    expect(agents[0]!.lastPaidJobAt).toBeGreaterThan(0);
    // Cold start agents follow, ordered by lastSeen DESC (newer NIP-89 first).
    expect(agents[1]!.pubkey).toBe(aColdNew.publicKey);
    expect(agents[2]!.pubkey).toBe(aColdOld.publicKey);
    expect(agents[1]!.lastPaidJobAt).toBeUndefined();
    expect(agents[2]!.lastPaidJobAt).toBeUndefined();
  });

  it('counts feedback by p-tag (customer-authored), not by event author', async () => {
    const now = Math.floor(Date.now() / 1000);
    const agent = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const cap = makeCapabilityEvent(
      agent,
      makeCard({
        name: 'rated',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_A },
      }),
    );
    // Customer authors all feedback events tagging the agent.
    const feedbacks = [
      makeFeedbackEvent(customer, agent.publicKey, { createdAt: now - 10, rating: '1' }),
      makeFeedbackEvent(customer, agent.publicKey, { createdAt: now - 20, rating: '1' }),
      makeFeedbackEvent(customer, agent.publicKey, { createdAt: now - 30, rating: '0' }),
    ];

    const pool = setupRoutedPool({
      capabilityEvents: [cap],
      resultEvents: [],
      feedbackEvents: feedbacks,
    });

    const svc = new DiscoveryService(pool as any);
    const agents = await svc.fetchAgents('devnet');

    expect(agents.length).toBe(1);
    expect(agents[0]!.totalRatingCount).toBe(3);
    expect(agents[0]!.positiveCount).toBe(2);
  });

  it('orders cold-start agents by lastSeen DESC when no payment-completed feedback exists', async () => {
    const now = Math.floor(Date.now() / 1000);
    const aOld = ElisymIdentity.generate();
    const aNew = ElisymIdentity.generate();

    const capOlder = makeCapabilityEvent(
      aOld,
      makeCard({
        name: 'older',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_A },
      }),
      { createdAt: now - 200 },
    );
    const capNewer = makeCapabilityEvent(
      aNew,
      makeCard({
        name: 'newer',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_B },
      }),
      { createdAt: now - 50 },
    );

    const pool = setupRoutedPool({
      capabilityEvents: [capOlder, capNewer],
      resultEvents: [],
      feedbackEvents: [],
    });

    // No payment-completed feedback for either agent, so both land in the
    // cold-start (-Infinity) bucket and are tiebroken by lastSeen.
    const svc = new DiscoveryService(pool as any);
    const agents = await svc.fetchAgents('devnet');

    expect(agents.length).toBe(2);
    expect(agents.every((a) => a.lastPaidJobAt === undefined)).toBe(true);
    // newer NIP-89 first (lastSeen tiebreak)
    expect(agents[0]!.pubkey).toBe(aNew.publicKey);
    expect(agents[1]!.pubkey).toBe(aOld.publicKey);
  });

  it('ignores payment-completed feedback without a matching kind:6xxx result', async () => {
    // A customer can publish a `payment-completed` feedback unilaterally
    // (immediately on payment, before the result arrives, or to game the
    // ranking with a fake `tx`). Without a matching result event signed by
    // the provider on the same `e` job id, we treat it as unverified and do
    // not set `lastPaidJobAt`.
    const now = Math.floor(Date.now() / 1000);
    const orphanAgent = ElisymIdentity.generate();
    const verifiedAgent = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const capOrphan = makeCapabilityEvent(
      orphanAgent,
      makeCard({
        name: 'orphan',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_A },
      }),
      { createdAt: now - 30 },
    );
    const capVerified = makeCapabilityEvent(
      verifiedAgent,
      makeCard({
        name: 'verified',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_B },
      }),
      { createdAt: now - 30 },
    );

    const jobVerified = 'job-verified';
    const feedbacks = [
      // Orphan: payment-completed with no matching result event.
      makeFeedbackEvent(customer, orphanAgent.publicKey, {
        createdAt: now - 60,
        status: 'payment-completed',
        txSignature: 'sig-orphan',
        jobEventId: 'job-orphan',
      }),
      // Verified: payment-completed paired with a real result event below.
      makeFeedbackEvent(customer, verifiedAgent.publicKey, {
        createdAt: now - 600,
        status: 'payment-completed',
        txSignature: 'sig-verified',
        jobEventId: jobVerified,
      }),
    ];
    const results = [
      makeResultEvent(verifiedAgent, { createdAt: now - 601, jobEventId: jobVerified }),
    ];

    const pool = setupRoutedPool({
      capabilityEvents: [capOrphan, capVerified],
      resultEvents: results,
      feedbackEvents: feedbacks,
    });

    const svc = new DiscoveryService(pool as any);
    const agents = await svc.fetchAgents('devnet');

    expect(agents.length).toBe(2);
    const orphan = agents.find((a) => a.pubkey === orphanAgent.publicKey)!;
    const verified = agents.find((a) => a.pubkey === verifiedAgent.publicKey)!;
    expect(orphan.lastPaidJobAt).toBeUndefined();
    expect(orphan.lastPaidJobTx).toBeUndefined();
    expect(verified.lastPaidJobAt).toBe(now - 600);
    expect(verified.lastPaidJobTx).toBe('sig-verified');
    // Verified ranks above orphan despite orphan's "newer" feedback timestamp.
    expect(agents[0]!.pubkey).toBe(verifiedAgent.publicKey);
    expect(agents[1]!.pubkey).toBe(orphanAgent.publicKey);
  });

  it('result events update lastSeen even when there is no paid job', async () => {
    const now = Math.floor(Date.now() / 1000);
    const agent = ElisymIdentity.generate();

    const cap = makeCapabilityEvent(
      agent,
      makeCard({
        name: 'free-only',
        payment: { chain: 'solana', network: 'devnet', address: SOL_ADDRESS_A },
      }),
      { createdAt: now - 500 },
    );
    const result = makeResultEvent(agent, { createdAt: now - 60 });

    const pool = setupRoutedPool({
      capabilityEvents: [cap],
      resultEvents: [result],
      feedbackEvents: [],
    });

    const svc = new DiscoveryService(pool as any);
    const agents = await svc.fetchAgents('devnet');

    expect(agents.length).toBe(1);
    expect(agents[0]!.lastSeen).toBe(now - 60);
    expect(agents[0]!.lastPaidJobAt).toBeUndefined();
  });
});

describe('computeRankKey', () => {
  it('places agents without paid jobs in cold-start bucket (-Infinity)', () => {
    const agent: Agent = {
      pubkey: 'pk',
      npub: 'npub',
      cards: [],
      eventId: 'eid',
      supportedKinds: [],
      lastSeen: 1000,
    };
    expect(computeRankKey(agent).bucket).toBe(-Infinity);
    expect(computeRankKey(agent).rate).toBe(0);
  });

  it('floors lastPaidJobAt to the minute', () => {
    const agent: Agent = {
      pubkey: 'pk',
      npub: 'npub',
      cards: [],
      eventId: 'eid',
      supportedKinds: [],
      lastSeen: 0,
      lastPaidJobAt: 1_700_000_037,
    };
    expect(computeRankKey(agent).bucket).toBe(Math.floor(1_700_000_037 / 60) * 60);
  });

  it('rate is positive/total when total > 0', () => {
    const agent: Agent = {
      pubkey: 'pk',
      npub: 'npub',
      cards: [],
      eventId: 'eid',
      supportedKinds: [],
      lastSeen: 0,
      positiveCount: 7,
      totalRatingCount: 10,
    };
    expect(computeRankKey(agent).rate).toBe(0.7);
  });
});

describe('compareAgentsByRank', () => {
  function makeAgent(overrides: Partial<Agent>): Agent {
    return {
      pubkey: 'pk',
      npub: 'npub',
      cards: [],
      eventId: 'eid',
      supportedKinds: [],
      lastSeen: 0,
      ...overrides,
    };
  }

  it('higher bucket wins', () => {
    const high = makeAgent({ lastPaidJobAt: 1_000_000 });
    const low = makeAgent({ lastPaidJobAt: 100 });
    expect(compareAgentsByRank(high, low)).toBeLessThan(0);
  });

  it('within bucket, higher rate wins', () => {
    const a = makeAgent({ lastPaidJobAt: 1_000_000, positiveCount: 5, totalRatingCount: 10 });
    const b = makeAgent({ lastPaidJobAt: 1_000_001, positiveCount: 9, totalRatingCount: 10 });
    expect(compareAgentsByRank(b, a)).toBeLessThan(0);
  });

  it('cold-start agents tiebroken by lastSeen DESC', () => {
    const newer = makeAgent({ lastSeen: 200 });
    const older = makeAgent({ lastSeen: 100 });
    expect(compareAgentsByRank(newer, older)).toBeLessThan(0);
  });
});
