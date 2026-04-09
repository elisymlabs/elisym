import { finalizeEvent, verifyEvent, type Event, type Filter } from 'nostr-tools';
import { describe, it, expect, vi } from 'vitest';
import { KIND_PING, KIND_PONG, DEFAULTS, LIMITS } from '../src/constants';
import { ElisymIdentity } from '../src/primitives/identity';
import { MessagingService } from '../src/services/messaging';
import type { NostrPool } from '../src/transport/pool';
import type { SubCloser } from '../src/types';

function createMockPool() {
  const published: Event[] = [];
  const subscribeCalls: { filter: Filter; onEvent: (ev: Event) => void }[] = [];

  return {
    published,
    subscribeCalls,
    querySync: vi.fn().mockResolvedValue([]),
    queryBatched: vi.fn().mockResolvedValue([]),
    queryBatchedByTag: vi.fn().mockResolvedValue([]),
    publish: vi.fn(async (event: Event) => {
      published.push(event);
    }),
    publishAll: vi.fn(async (event: Event) => {
      published.push(event);
    }),
    subscribe: vi.fn((filter: Filter, onEvent: (ev: Event) => void): SubCloser => {
      subscribeCalls.push({ filter, onEvent });
      return { close: vi.fn() };
    }),
    subscribeAndWait: vi.fn(
      async (_filter: Filter, _onEvent: (ev: Event) => void): Promise<SubCloser> => {
        return { close: vi.fn() };
      },
    ),
    probe: vi.fn().mockResolvedValue(true),
    reset: vi.fn(),
    getRelays: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as NostrPool & {
    published: Event[];
    subscribeCalls: { filter: Filter; onEvent: (ev: Event) => void }[];
  };
}

// --- pingAgent ---

describe('MessagingService.pingAgent', () => {
  it('returns cached result within TTL', async () => {
    const pool = createMockPool();
    const agentIdentity = ElisymIdentity.generate();
    let capturedOnEvent: ((ev: Event) => void) | null = null;

    // First ping: mock subscribeAndWait to capture handler, then auto-respond with pong
    (pool as any).subscribeAndWait = vi.fn(async (_f: Filter, onEvent: (ev: Event) => void) => {
      capturedOnEvent = onEvent;
      return { close: vi.fn() };
    });
    (pool as any).publishAll = vi.fn(async (event: Event) => {
      pool.published.push(event);
      if (event.kind === KIND_PING) {
        const { nonce } = JSON.parse(event.content);
        const pong = finalizeEvent(
          {
            kind: KIND_PONG,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', event.pubkey]],
            content: JSON.stringify({ type: 'elisym_pong', nonce }),
          },
          agentIdentity.secretKey,
        );
        capturedOnEvent?.(pong);
      }
    });

    const svc = new MessagingService(pool as any);
    const result1 = await svc.pingAgent(agentIdentity.publicKey, 5000, undefined, 0);
    expect(result1.online).toBe(true);

    // Second ping (cached) - should NOT call subscribeAndWait again
    const callsBefore = (pool as any).subscribeAndWait.mock.calls.length;
    const result2 = await svc.pingAgent(agentIdentity.publicKey, 5000, undefined, 0);
    expect(result2.online).toBe(true);
    expect((pool as any).subscribeAndWait.mock.calls.length).toBe(callsBefore);
  });

  it('deduplicates in-flight pings for same agent', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();

    let subscribeCount = 0;
    (pool as any).subscribeAndWait = vi.fn(async () => {
      subscribeCount++;
      return { close: vi.fn() };
    });
    (pool as any).publishAll = vi.fn(async () => {});

    const svc = new MessagingService(pool as any);
    // Start two pings concurrently
    const p1 = svc.pingAgent(agent.publicKey, 50, undefined, 0);
    const p2 = svc.pingAgent(agent.publicKey, 50, undefined, 0);

    const [r1, r2] = await Promise.all([p1, p2]);
    // Both resolve to same result
    expect(r1.online).toBe(r2.online);
    // subscribeAndWait called only once (second ping deduped)
    expect(subscribeCount).toBe(1);
  });

  it('returns offline on abort signal', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const controller = new AbortController();

    (pool as any).subscribeAndWait = vi.fn(async () => ({ close: vi.fn() }));

    const svc = new MessagingService(pool as any);
    controller.abort();
    const result = await svc.pingAgent(agent.publicKey, 5000, controller.signal, 0);
    expect(result.online).toBe(false);
    expect(result.identity).toBeNull();
  });

  it('returns offline on timeout', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();

    // subscribeAndWait resolves but no pong event arrives
    (pool as any).subscribeAndWait = vi.fn(async () => ({ close: vi.fn() }));
    (pool as any).publishAll = vi.fn(async () => {});

    const svc = new MessagingService(pool as any);
    const result = await svc.pingAgent(agent.publicKey, 50, undefined, 0);
    expect(result.online).toBe(false);
  });
});

// --- sendMessage ---

describe('MessagingService.sendMessage', () => {
  it('rejects invalid pubkey', async () => {
    const pool = createMockPool();
    const svc = new MessagingService(pool as any);
    const identity = ElisymIdentity.generate();

    await expect(svc.sendMessage(identity, 'invalid', 'hello')).rejects.toThrow(
      'Invalid recipient pubkey',
    );
  });

  it('rejects too long message', async () => {
    const pool = createMockPool();
    const svc = new MessagingService(pool as any);
    const identity = ElisymIdentity.generate();
    const recipient = ElisymIdentity.generate();

    await expect(
      svc.sendMessage(identity, recipient.publicKey, 'x'.repeat(LIMITS.MAX_MESSAGE_LENGTH + 1)),
    ).rejects.toThrow('Message too long');
  });

  it('publishes NIP-17 wrapped message', async () => {
    const pool = createMockPool();
    const svc = new MessagingService(pool as any);
    const sender = ElisymIdentity.generate();
    const recipient = ElisymIdentity.generate();

    await svc.sendMessage(sender, recipient.publicKey, 'hello');
    expect(pool.published.length).toBe(1);
    // NIP-17 wraps in kind:1059 (gift wrap)
    expect(pool.published[0]!.kind).toBe(1059);
  });
});

// --- sendPong ---

describe('MessagingService.sendPong', () => {
  it('publishes ephemeral pong event', async () => {
    const pool = createMockPool();
    const svc = new MessagingService(pool as any);
    const identity = ElisymIdentity.generate();
    const recipient = ElisymIdentity.generate();

    await svc.sendPong(identity, recipient.publicKey, 'abc123def456abc123def456abc12345');
    expect(pool.published.length).toBe(1);

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_PONG);
    expect(ev.tags.find((t) => t[0] === 'p')?.[1]).toBe(recipient.publicKey);

    const content = JSON.parse(ev.content);
    expect(content.type).toBe('elisym_pong');
    expect(content.nonce).toBe('abc123def456abc123def456abc12345');
  });
});

// --- subscribeToPings ---

describe('MessagingService.subscribeToPings', () => {
  it('subscribes with correct filter and calls callback for valid pings', () => {
    const pool = createMockPool();
    const svc = new MessagingService(pool as any);
    const identity = ElisymIdentity.generate();
    const sender = ElisymIdentity.generate();
    const callback = vi.fn();

    svc.subscribeToPings(identity, callback);
    expect(pool.subscribeCalls.length).toBe(1);

    const { onEvent } = pool.subscribeCalls[0]!;
    const nonce = 'a'.repeat(32);
    const pingEvent = finalizeEvent(
      {
        kind: KIND_PING,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', identity.publicKey]],
        content: JSON.stringify({ type: 'elisym_ping', nonce }),
      },
      sender.secretKey,
    );

    onEvent(pingEvent);
    expect(callback).toHaveBeenCalledWith(sender.publicKey, nonce);
  });

  it('ignores pings with wrong type', () => {
    const pool = createMockPool();
    const svc = new MessagingService(pool as any);
    const identity = ElisymIdentity.generate();
    const sender = ElisymIdentity.generate();
    const callback = vi.fn();

    svc.subscribeToPings(identity, callback);
    const { onEvent } = pool.subscribeCalls[0]!;

    const badEvent = finalizeEvent(
      {
        kind: KIND_PING,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', identity.publicKey]],
        content: JSON.stringify({ type: 'other', nonce: 'a'.repeat(32) }),
      },
      sender.secretKey,
    );

    onEvent(badEvent);
    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores pings with wrong nonce length', () => {
    const pool = createMockPool();
    const svc = new MessagingService(pool as any);
    const identity = ElisymIdentity.generate();
    const sender = ElisymIdentity.generate();
    const callback = vi.fn();

    svc.subscribeToPings(identity, callback);
    const { onEvent } = pool.subscribeCalls[0]!;

    const badEvent = finalizeEvent(
      {
        kind: KIND_PING,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', identity.publicKey]],
        content: JSON.stringify({ type: 'elisym_ping', nonce: 'short' }),
      },
      sender.secretKey,
    );

    onEvent(badEvent);
    expect(callback).not.toHaveBeenCalled();
  });
});
