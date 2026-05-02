import { type Event, finalizeEvent } from 'nostr-tools';
import { describe, expect, it, vi } from 'vitest';
import { KIND_LONG_FORM_ARTICLE, POLICY_D_TAG_PREFIX, POLICY_T_TAG } from '../src/constants';
import { ElisymIdentity } from '../src/primitives/identity';
import { PoliciesService } from '../src/services/policies';
import type { NostrPool } from '../src/transport/pool';
import type { SubCloser } from '../src/types';

interface MockPool extends NostrPool {
  published: Event[];
  setEvents: (events: Event[]) => void;
}

function createMockPool(): MockPool {
  const published: Event[] = [];
  let stored: Event[] = [];
  return {
    published,
    setEvents: (events) => {
      stored = events;
    },
    querySync: vi.fn(async () => stored),
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
    onReset: vi.fn().mockReturnValue(() => {}),
  } as unknown as MockPool;
}

function makeIdentity(): ElisymIdentity {
  return ElisymIdentity.generate();
}

function makePolicyEvent(
  identity: ElisymIdentity,
  type: string,
  overrides: { content?: string; createdAt?: number; version?: string; title?: string } = {},
): Event {
  return finalizeEvent(
    {
      kind: KIND_LONG_FORM_ARTICLE,
      created_at: overrides.createdAt ?? Math.floor(Date.now() / 1000),
      tags: [
        ['d', `${POLICY_D_TAG_PREFIX}${type}`],
        ['t', POLICY_T_TAG],
        ['title', overrides.title ?? 'Title'],
        ['policy_type', type],
        ['policy_version', overrides.version ?? '1.0'],
      ],
      content: overrides.content ?? '## Body\n\nDetails.',
    },
    identity.secretKey,
  );
}

describe('PoliciesService.publishPolicy', () => {
  it('publishes a kind-30023 event with required tags and returns naddr', async () => {
    const pool = createMockPool();
    const service = new PoliciesService(pool);
    const identity = makeIdentity();

    const result = await service.publishPolicy(identity, {
      type: 'tos',
      version: '1.0',
      title: 'Terms of Service',
      summary: 'Brief summary',
      content: '# Terms\n\nText.',
    });

    expect(pool.published).toHaveLength(1);
    const event = pool.published[0]!;
    expect(event.kind).toBe(KIND_LONG_FORM_ARTICLE);
    expect(event.tags).toContainEqual(['d', 'elisym-policy-tos']);
    expect(event.tags).toContainEqual(['t', POLICY_T_TAG]);
    expect(event.tags).toContainEqual(['title', 'Terms of Service']);
    expect(event.tags).toContainEqual(['policy_type', 'tos']);
    expect(event.tags).toContainEqual(['policy_version', '1.0']);
    expect(event.tags).toContainEqual(['summary', 'Brief summary']);
    expect(result.naddr.startsWith('naddr1')).toBe(true);
    expect(result.eventId).toBe(event.id);
  });

  it('omits summary tag when not provided', async () => {
    const pool = createMockPool();
    const service = new PoliciesService(pool);
    const identity = makeIdentity();

    await service.publishPolicy(identity, {
      type: 'privacy',
      version: '1.0',
      title: 'Privacy',
      content: 'Body',
    });

    const event = pool.published[0]!;
    expect(event.tags.find((tag) => tag[0] === 'summary')).toBeUndefined();
  });

  it('rejects invalid type slug', async () => {
    const service = new PoliciesService(createMockPool());
    const identity = makeIdentity();

    await expect(
      service.publishPolicy(identity, {
        type: 'Has Spaces',
        version: '1.0',
        title: 'X',
        content: 'X',
      }),
    ).rejects.toThrow(/Invalid policy type/);
  });

  it('rejects empty content', async () => {
    const service = new PoliciesService(createMockPool());
    const identity = makeIdentity();

    await expect(
      service.publishPolicy(identity, {
        type: 'tos',
        version: '1.0',
        title: 'X',
        content: '',
      }),
    ).rejects.toThrow(/empty/);
  });
});

describe('PoliciesService.fetchPolicies', () => {
  it('returns parsed policies sorted by type', async () => {
    const pool = createMockPool();
    const service = new PoliciesService(pool);
    const identity = makeIdentity();

    pool.setEvents([
      makePolicyEvent(identity, 'tos', { title: 'ToS' }),
      makePolicyEvent(identity, 'privacy', { title: 'Privacy' }),
      makePolicyEvent(identity, 'refund', { title: 'Refund' }),
    ]);

    const policies = await service.fetchPolicies(identity.publicKey);
    expect(policies.map((policy) => policy.type)).toEqual(['privacy', 'refund', 'tos']);
    expect(policies[0]?.title).toBe('Privacy');
    expect(policies[0]?.naddr.startsWith('naddr1')).toBe(true);
  });

  it('dedupes by d-tag keeping the newest event', async () => {
    const pool = createMockPool();
    const service = new PoliciesService(pool);
    const identity = makeIdentity();

    pool.setEvents([
      makePolicyEvent(identity, 'tos', { createdAt: 1000, version: '1.0' }),
      makePolicyEvent(identity, 'tos', { createdAt: 2000, version: '2.0' }),
    ]);

    const policies = await service.fetchPolicies(identity.publicKey);
    expect(policies).toHaveLength(1);
    expect(policies[0]?.version).toBe('2.0');
    expect(policies[0]?.publishedAt).toBe(2000);
  });

  it('skips events with empty content (tombstones)', async () => {
    const pool = createMockPool();
    const service = new PoliciesService(pool);
    const identity = makeIdentity();

    pool.setEvents([makePolicyEvent(identity, 'tos', { content: '' })]);

    const policies = await service.fetchPolicies(identity.publicKey);
    expect(policies).toHaveLength(0);
  });

  it('skips events with invalid policy_type tag', async () => {
    const pool = createMockPool();
    const service = new PoliciesService(pool);
    const identity = makeIdentity();

    const bad = finalizeEvent(
      {
        kind: KIND_LONG_FORM_ARTICLE,
        created_at: 1000,
        tags: [
          ['d', `${POLICY_D_TAG_PREFIX}bad`],
          ['t', POLICY_T_TAG],
          ['title', 'Bad'],
          ['policy_type', 'has spaces'],
          ['policy_version', '1.0'],
        ],
        content: 'Body',
      },
      identity.secretKey,
    );
    pool.setEvents([bad]);

    const policies = await service.fetchPolicies(identity.publicKey);
    expect(policies).toHaveLength(0);
  });

  it('returns empty array when no events found', async () => {
    const service = new PoliciesService(createMockPool());
    const policies = await service.fetchPolicies('a'.repeat(64));
    expect(policies).toEqual([]);
  });
});

describe('PoliciesService.deletePolicy', () => {
  it('publishes an empty replacement under the same d-tag', async () => {
    const pool = createMockPool();
    const service = new PoliciesService(pool);
    const identity = makeIdentity();

    await service.deletePolicy(identity, 'tos');

    expect(pool.published).toHaveLength(1);
    const event = pool.published[0]!;
    expect(event.kind).toBe(KIND_LONG_FORM_ARTICLE);
    expect(event.tags).toContainEqual(['d', 'elisym-policy-tos']);
    expect(event.content).toBe('');
  });
});
