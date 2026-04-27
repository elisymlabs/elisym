import { finalizeEvent, type Event, type Filter } from 'nostr-tools';
import { describe, it, expect, vi } from 'vitest';
import {
  KIND_APP_HANDLER,
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
} from '../src/constants';
import { ElisymIdentity } from '../src/primitives/identity';
import { DiscoveryService, toDTag } from '../src/services/discovery';
import type { NostrPool } from '../src/transport/pool';
import type { Agent, CapabilityCard, SubCloser } from '../src/types';

interface CapturedSub {
  filter: Filter;
  onEvent: (event: Event) => void;
  oneose?: () => void;
  closed: boolean;
  closeFn: ReturnType<typeof vi.fn>;
}

function createStreamPool(): {
  pool: NostrPool;
  subs: CapturedSub[];
  queryBatched: ReturnType<typeof vi.fn>;
  queryBatchedByTag: ReturnType<typeof vi.fn>;
} {
  const subs: CapturedSub[] = [];
  const queryBatched = vi.fn().mockResolvedValue([]);
  const queryBatchedByTag = vi.fn().mockResolvedValue([]);
  const pool = {
    querySync: vi.fn().mockResolvedValue([]),
    queryBatched,
    queryBatchedByTag,
    publish: vi.fn(),
    publishAll: vi.fn(),
    subscribe: vi.fn(
      (
        filter: Filter,
        onEvent: (event: Event) => void,
        opts?: { oneose?: () => void },
      ): SubCloser => {
        const captured: CapturedSub = {
          filter,
          onEvent,
          oneose: opts?.oneose,
          closed: false,
          closeFn: vi.fn(),
        };
        captured.closeFn.mockImplementation(() => {
          captured.closed = true;
        });
        subs.push(captured);
        return { close: captured.closeFn };
      },
    ),
    subscribeAndWait: vi.fn(async (): Promise<SubCloser> => ({ close: vi.fn() })),
    probe: vi.fn().mockResolvedValue(true),
    reset: vi.fn(),
    getRelays: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as NostrPool;
  return { pool, subs, queryBatched, queryBatchedByTag };
}

function makeCard(overrides: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    name: overrides.name ?? 'agent',
    description: 'desc',
    capabilities: ['text-gen'],
    payment: { chain: 'solana', network: 'devnet', address: '11111111111111111111111111111111' },
    ...overrides,
  };
}

function makeCapabilityEvent(
  identity: ElisymIdentity,
  card: CapabilityCard,
  opts: { createdAt?: number } = {},
): Event {
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: KIND_APP_HANDLER,
      created_at: createdAt,
      tags: [
        ['d', toDTag(card.name)],
        ['t', 'elisym'],
        ...card.capabilities.map((cap) => ['t', cap]),
        ['k', String(KIND_JOB_REQUEST)],
      ],
      content: JSON.stringify(card),
    },
    identity.secretKey,
  );
}

function makeTombstoneEvent(
  identity: ElisymIdentity,
  cardName: string,
  opts: { createdAt?: number } = {},
): Event {
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: KIND_APP_HANDLER,
      created_at: createdAt,
      tags: [
        ['d', toDTag(cardName)],
        ['t', 'elisym'],
      ],
      content: JSON.stringify({ deleted: true }),
    },
    identity.secretKey,
  );
}

function makeResultEvent(
  identity: ElisymIdentity,
  jobEventId: string,
  opts: { createdAt?: number; tags?: string[][] } = {},
): Event {
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: KIND_JOB_RESULT,
      created_at: createdAt,
      tags: [['e', jobEventId], ['t', 'elisym'], ...(opts.tags ?? [])],
      content: JSON.stringify({ ok: true }),
    },
    identity.secretKey,
  );
}

function makeFeedbackEvent(
  customer: ElisymIdentity,
  providerPubkey: string,
  opts: {
    createdAt?: number;
    status?: string;
    tx?: string;
    jobEventId?: string;
    rating?: '0' | '1';
  } = {},
): Event {
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000);
  const tags: string[][] = [['p', providerPubkey]];
  if (opts.status) tags.push(['status', opts.status]);
  if (opts.tx) tags.push(['tx', opts.tx]);
  if (opts.jobEventId) tags.push(['e', opts.jobEventId]);
  if (opts.rating) tags.push(['rating', opts.rating]);
  return finalizeEvent(
    {
      kind: KIND_JOB_FEEDBACK,
      created_at: createdAt,
      tags,
      content: '',
    },
    customer.secretKey,
  );
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('DiscoveryService.streamAgents', () => {
  it('happy path: emits onAgent per event then onEose then onComplete', async () => {
    const { pool, subs } = createStreamPool();
    const svc = new DiscoveryService(pool);

    const a = ElisymIdentity.generate();
    const b = ElisymIdentity.generate();
    const c = ElisymIdentity.generate();
    const evA = makeCapabilityEvent(a, makeCard({ name: 'a-agent' }));
    const evB = makeCapabilityEvent(b, makeCard({ name: 'b-agent' }));
    const evC = makeCapabilityEvent(c, makeCard({ name: 'c-agent' }));

    const onAgent = vi.fn();
    const onEose = vi.fn();
    const onComplete = vi.fn();

    svc.streamAgents('devnet', { onAgent, onEose, onComplete });

    expect(subs).toHaveLength(2);
    const [capSub, resultSub] = subs;
    expect(capSub!.filter.kinds).toEqual([KIND_APP_HANDLER]);
    expect(resultSub!.filter.kinds).toEqual([KIND_JOB_RESULT]);

    capSub!.onEvent(evA);
    capSub!.onEvent(evB);
    capSub!.onEvent(evC);

    expect(onAgent).toHaveBeenCalledTimes(3);
    const emittedPubkeys = onAgent.mock.calls.map((call) => (call[0] as Agent).pubkey);
    expect(emittedPubkeys).toEqual([a.publicKey, b.publicKey, c.publicKey]);

    capSub!.oneose!();
    resultSub!.oneose!();

    expect(onEose).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
    await flushMicrotasks();

    expect(onComplete).toHaveBeenCalledTimes(1);
    const sorted = onComplete.mock.calls[0]![0] as Agent[];
    expect(sorted).toHaveLength(3);
    expect(new Set(sorted.map((agent) => agent.pubkey))).toEqual(
      new Set([a.publicKey, b.publicKey, c.publicKey]),
    );
  });

  it('newer-wins dedup by (pubkey, d-tag): a stale event does not re-emit', async () => {
    const { pool, subs } = createStreamPool();
    const svc = new DiscoveryService(pool);

    const a = ElisymIdentity.generate();
    const now = Math.floor(Date.now() / 1000);
    const newer = makeCapabilityEvent(a, makeCard({ name: 'a-agent', description: 'new' }), {
      createdAt: now,
    });
    const older = makeCapabilityEvent(a, makeCard({ name: 'a-agent', description: 'old' }), {
      createdAt: now - 100,
    });

    const onAgent = vi.fn();
    svc.streamAgents('devnet', { onAgent });

    const capSub = subs[0]!;
    capSub.onEvent(newer);
    capSub.onEvent(older);

    expect(onAgent).toHaveBeenCalledTimes(1);
    const agent = onAgent.mock.calls[0]![0] as Agent;
    expect(agent.cards[0]!.description).toBe('new');
  });

  it('paid-job stream: kind:6100 events trigger onPaidJob with provider pubkey + ts', async () => {
    const { pool, subs } = createStreamPool();
    const svc = new DiscoveryService(pool);

    const provider = ElisymIdentity.generate();
    const onPaidJob = vi.fn();
    svc.streamAgents('devnet', { onAgent: vi.fn(), onPaidJob });

    const resultSub = subs[1]!;
    const ts = Math.floor(Date.now() / 1000);
    const resultEvent = makeResultEvent(provider, 'job-id-1', { createdAt: ts });
    resultSub.onEvent(resultEvent);

    expect(onPaidJob).toHaveBeenCalledTimes(1);
    expect(onPaidJob).toHaveBeenCalledWith(provider.publicKey, ts);
  });

  it('sybil cross-check: payment-completed without matching kind:6xxx result does not set lastPaidJobAt', async () => {
    const { pool, subs, queryBatched, queryBatchedByTag } = createStreamPool();
    const svc = new DiscoveryService(pool);

    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();
    const capEvent = makeCapabilityEvent(provider, makeCard({ name: 'p-agent' }));

    // No matching kind:6100 result. Just a forged feedback claiming payment.
    queryBatched.mockResolvedValueOnce([]);
    queryBatchedByTag.mockResolvedValueOnce([
      makeFeedbackEvent(customer, provider.publicKey, {
        status: 'payment-completed',
        tx: 'forged-signature',
        jobEventId: 'made-up-job-id',
      }),
    ]);

    const onComplete = vi.fn();
    svc.streamAgents('devnet', { onAgent: vi.fn(), onComplete });

    const capSub = subs[0]!;
    const resultSub = subs[1]!;
    capSub.onEvent(capEvent);
    capSub.oneose!();
    resultSub.oneose!();

    await flushMicrotasks();
    await flushMicrotasks();

    expect(onComplete).toHaveBeenCalledTimes(1);
    const sorted = onComplete.mock.calls[0]![0] as Agent[];
    expect(sorted).toHaveLength(1);
    expect(sorted[0]!.lastPaidJobAt).toBeUndefined();
    expect(sorted[0]!.lastPaidJobTx).toBeUndefined();
  });

  it('matched payment-completed sets lastPaidJobAt when result event exists for the same job', async () => {
    const { pool, subs, queryBatched, queryBatchedByTag } = createStreamPool();
    const svc = new DiscoveryService(pool);

    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();
    const capEvent = makeCapabilityEvent(provider, makeCard({ name: 'p-agent' }));
    const jobEventId = 'real-job-id';
    const ts = Math.floor(Date.now() / 1000);

    queryBatched.mockResolvedValueOnce([makeResultEvent(provider, jobEventId, { createdAt: ts })]);
    queryBatchedByTag.mockResolvedValueOnce([
      makeFeedbackEvent(customer, provider.publicKey, {
        status: 'payment-completed',
        tx: 'real-signature',
        jobEventId,
        createdAt: ts,
      }),
    ]);

    const onComplete = vi.fn();
    svc.streamAgents('devnet', { onAgent: vi.fn(), onComplete });

    const capSub = subs[0]!;
    const resultSub = subs[1]!;
    capSub.onEvent(capEvent);
    capSub.oneose!();
    resultSub.oneose!();

    await flushMicrotasks();
    await flushMicrotasks();

    const sorted = onComplete.mock.calls[0]![0] as Agent[];
    expect(sorted[0]!.lastPaidJobAt).toBe(ts);
    expect(sorted[0]!.lastPaidJobTx).toBe('real-signature');
  });

  it('closer.close cancels both subscriptions and aborts in-flight enrichment', async () => {
    const { pool, subs, queryBatched } = createStreamPool();
    const svc = new DiscoveryService(pool);

    // Block enrichment on a never-resolving query so we can observe abort.
    let resolveQuery: (events: Event[]) => void = () => {};
    queryBatched.mockReturnValueOnce(
      new Promise<Event[]>((resolve) => {
        resolveQuery = resolve;
      }),
    );

    const onComplete = vi.fn();
    const provider = ElisymIdentity.generate();
    const closer = svc.streamAgents('devnet', { onAgent: vi.fn(), onComplete });

    const capSub = subs[0]!;
    const resultSub = subs[1]!;
    capSub.onEvent(makeCapabilityEvent(provider, makeCard({ name: 'p' })));
    capSub.oneose!();

    closer.close();

    expect(capSub.closed).toBe(true);
    expect(resultSub.closed).toBe(true);

    // Unblock the in-flight query post-abort. onComplete must NOT fire.
    resolveQuery([]);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('opts.signal abort short-circuits onComplete', async () => {
    const { pool, subs, queryBatched } = createStreamPool();
    const svc = new DiscoveryService(pool);

    let resolveQuery: (events: Event[]) => void = () => {};
    queryBatched.mockReturnValueOnce(
      new Promise<Event[]>((resolve) => {
        resolveQuery = resolve;
      }),
    );

    const ac = new AbortController();
    const onComplete = vi.fn();
    const provider = ElisymIdentity.generate();
    svc.streamAgents('devnet', { onAgent: vi.fn(), onComplete, signal: ac.signal });

    const capSub = subs[0]!;
    capSub.onEvent(makeCapabilityEvent(provider, makeCard({ name: 'p' })));
    capSub.oneose!();

    ac.abort();
    resolveQuery([]);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('tombstone over one of multiple cards re-emits onAgent with the surviving card', () => {
    const { pool, subs } = createStreamPool();
    const svc = new DiscoveryService(pool);

    const provider = ElisymIdentity.generate();
    const now = Math.floor(Date.now() / 1000);
    const cardA = makeCapabilityEvent(provider, makeCard({ name: 'card-a' }), {
      createdAt: now,
    });
    const cardB = makeCapabilityEvent(provider, makeCard({ name: 'card-b' }), {
      createdAt: now,
    });
    const tombA = makeTombstoneEvent(provider, 'card-a', { createdAt: now + 10 });

    const onAgent = vi.fn();
    svc.streamAgents('devnet', { onAgent });

    const capSub = subs[0]!;
    capSub.onEvent(cardA);
    capSub.onEvent(cardB);
    capSub.onEvent(tombA);

    expect(onAgent).toHaveBeenCalledTimes(3);
    const final = onAgent.mock.calls[2]![0] as Agent;
    expect(final.cards.map((card) => card.name)).toEqual(['card-b']);
  });

  it('tombstone over the only card removes the agent from the post-EOSE snapshot', async () => {
    const { pool, subs } = createStreamPool();
    const svc = new DiscoveryService(pool);

    const provider = ElisymIdentity.generate();
    const now = Math.floor(Date.now() / 1000);
    const card = makeCapabilityEvent(provider, makeCard({ name: 'only-card' }), {
      createdAt: now,
    });
    const tomb = makeTombstoneEvent(provider, 'only-card', { createdAt: now + 10 });

    const onComplete = vi.fn();
    svc.streamAgents('devnet', { onAgent: vi.fn(), onComplete });

    const capSub = subs[0]!;
    const resultSub = subs[1]!;
    capSub.onEvent(card);
    capSub.onEvent(tomb);
    capSub.oneose!();
    resultSub.oneose!();

    await flushMicrotasks();
    await flushMicrotasks();

    expect(onComplete).toHaveBeenCalledTimes(1);
    const sorted = onComplete.mock.calls[0]![0] as Agent[];
    expect(sorted).toHaveLength(0);
  });

  it('two streamAgents calls open independent subscription pairs (reset support)', () => {
    const { pool, subs } = createStreamPool();
    const svc = new DiscoveryService(pool);

    svc.streamAgents('devnet', { onAgent: vi.fn() });
    svc.streamAgents('devnet', { onAgent: vi.fn() });

    expect(subs).toHaveLength(4);
    expect(subs[0]!.filter.kinds).toEqual([KIND_APP_HANDLER]);
    expect(subs[1]!.filter.kinds).toEqual([KIND_JOB_RESULT]);
    expect(subs[2]!.filter.kinds).toEqual([KIND_APP_HANDLER]);
    expect(subs[3]!.filter.kinds).toEqual([KIND_JOB_RESULT]);
  });
});
