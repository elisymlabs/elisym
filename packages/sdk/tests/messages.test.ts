import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools';
import type { Event, Filter } from 'nostr-tools';
import * as nip59 from 'nostr-tools/nip59';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULTS,
  DiscoveryService,
  DM_INBOX_MARKER_TAG,
  DM_INBOX_MARKER_VALUE,
  ElisymIdentity,
  KIND_APP_HANDLER,
  KIND_DM_INBOX_RELAYS,
  KIND_DM_RUMOR,
  KIND_DM_SEAL,
  KIND_GIFT_WRAP,
  LIMITS,
  MessagesService,
  nip44Encrypt,
  type CapabilityCard,
  type NostrPool,
  type SubCloser,
} from '../src';

function createMockPool() {
  const published: Event[] = [];
  const subscribeCalls: { filter: Filter; onEvent: (ev: Event) => void }[] = [];

  return {
    published,
    subscribeCalls,
    querySync: vi.fn().mockResolvedValue([]),
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
    getRelays: vi.fn().mockReturnValue(['wss://relay.one', 'wss://relay.two']),
    onReset: vi.fn((_listener: () => void) => () => {}),
    close: vi.fn(),
  } as unknown as NostrPool & {
    published: Event[];
    subscribeCalls: { filter: Filter; onEvent: (ev: Event) => void }[];
  };
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** Relays deliver JSON - round-trip strips nostr-tools' in-memory verification cache. */
function asWireEvent(event: Event): Event {
  return JSON.parse(JSON.stringify(event)) as Event;
}

interface RumorShape {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

function buildRumor(
  senderPubkey: string,
  recipientPubkey: string | null,
  content: string,
  createdAt: number = nowSecs(),
  kind: number = KIND_DM_RUMOR,
): RumorShape {
  const rumor: RumorShape = {
    id: '',
    pubkey: senderPubkey,
    created_at: createdAt,
    kind,
    tags: recipientPubkey ? [['p', recipientPubkey]] : [],
    content,
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

/** Hand-rolled NIP-59 wrap so tests can inject malformed layers. */
function wrapRumor(
  rumor: RumorShape,
  sealerSecretKey: Uint8Array,
  wrapRecipientPubkey: string,
  mutateSeal?: (seal: Event) => Event,
): Event {
  let seal = finalizeEvent(
    {
      kind: KIND_DM_SEAL,
      content: nip44Encrypt(JSON.stringify(rumor), sealerSecretKey, wrapRecipientPubkey),
      created_at: nowSecs(),
      tags: [],
    },
    sealerSecretKey,
  );
  if (mutateSeal) {
    seal = mutateSeal(asWireEvent(seal));
  }
  const wrapKey = generateSecretKey();
  return asWireEvent(
    finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        content: nip44Encrypt(JSON.stringify(seal), wrapKey, wrapRecipientPubkey),
        created_at: nowSecs(),
        tags: [['p', wrapRecipientPubkey]],
      },
      wrapKey,
    ),
  );
}

/** A legitimate incoming DM built through nostr-tools' own wrap path. */
function legitWrap(
  senderIdentity: ElisymIdentity,
  recipientPubkey: string,
  content: string,
  createdAt: number = nowSecs(),
): Event {
  return asWireEvent(
    nip59.wrapEvent(
      {
        kind: KIND_DM_RUMOR,
        created_at: createdAt,
        tags: [['p', recipientPubkey]],
        content,
      },
      senderIdentity.secretKey,
      recipientPubkey,
    ),
  );
}

describe('MessagesService.send', () => {
  it('publishes recipient wrap first, self-copy second, identical rumor ids', async () => {
    const pool = createMockPool();
    const svc = new MessagesService(pool);
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    const { id } = await svc.send(alice, bob.publicKey, 'hello bob');

    expect(pool.published).toHaveLength(2);
    const [first, second] = pool.published;
    expect(first?.tags.find((tag) => tag[0] === 'p')?.[1]).toBe(bob.publicKey);
    expect(second?.tags.find((tag) => tag[0] === 'p')?.[1]).toBe(alice.publicKey);

    // Both wraps must carry the identical rumor, and its id is what send returned.
    const bobPool = createMockPool();
    (bobPool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([first]);
    const bobView = await new MessagesService(bobPool).fetchHistory(bob);
    expect(bobView).toHaveLength(1);
    expect(bobView[0]?.id).toBe(id);

    const alicePool = createMockPool();
    (alicePool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([second]);
    const aliceView = await new MessagesService(alicePool).fetchHistory(alice);
    expect(aliceView).toHaveLength(1);
    expect(aliceView[0]?.id).toBe(id);
    expect(aliceView[0]?.isMine).toBe(true);
    expect(aliceView[0]?.recipientPubkey).toBe(bob.publicKey);
  });

  it('throws when the recipient wrap fails, succeeds when only the self-copy fails', async () => {
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    const failFirst = createMockPool();
    (failFirst.publishAll as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('all relays down'),
    );
    await expect(new MessagesService(failFirst).send(alice, bob.publicKey, 'x')).rejects.toThrow(
      'all relays down',
    );

    const failSecond = createMockPool();
    (failSecond.publishAll as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (event: Event) => {
        failSecond.published.push(event);
      })
      .mockRejectedValueOnce(new Error('self copy failed'));
    await expect(
      new MessagesService(failSecond).send(alice, bob.publicKey, 'x'),
    ).resolves.toHaveProperty('id');
    expect(failSecond.published).toHaveLength(1);
    expect(failSecond.published[0]?.tags.find((tag) => tag[0] === 'p')?.[1]).toBe(bob.publicKey);
  });

  it('rejects invalid recipients and empty messages', async () => {
    const svc = new MessagesService(createMockPool());
    const alice = ElisymIdentity.generate();
    await expect(svc.send(alice, 'not-a-pubkey', 'hi')).rejects.toThrow('Invalid recipient');
    await expect(svc.send(alice, ElisymIdentity.generate().publicKey, '')).rejects.toThrow(
      'must not be empty',
    );
  });

  it('rejects oversize messages: char cap and escaped-bytes cap', async () => {
    const svc = new MessagesService(createMockPool());
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    await expect(
      svc.send(alice, bob.publicKey, 'a'.repeat(LIMITS.MAX_MESSAGE_LENGTH + 1)),
    ).rejects.toThrow('Message too long');

    // 10_000 control chars pass the char cap but JSON-escape to 6 bytes each
    // (60_002 bytes) - must fail with a clear error, not an opaque nip44 throw.
    await expect(
      svc.send(alice, bob.publicKey, ''.repeat(LIMITS.MAX_MESSAGE_LENGTH)),
    ).rejects.toThrow('too large after encoding');
  });
});

describe('MessagesService secure unwrap', () => {
  it('round-trips a legitimate message', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([
      legitWrap(bob, alice.publicKey, 'hi alice'),
    ]);

    const messages = await new MessagesService(pool).fetchHistory(alice);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('hi alice');
    expect(messages[0]?.senderPubkey).toBe(bob.publicKey);
    expect(messages[0]?.recipientPubkey).toBe(alice.publicKey);
    expect(messages[0]?.isMine).toBe(false);
  });

  it('rejects a spoofed seal (attacker-signed seal carrying a victim rumor.pubkey)', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const attacker = ElisymIdentity.generate();
    const victim = ElisymIdentity.generate();

    // nip59.unwrapEvent would accept this and attribute the message to the victim.
    const spoofedRumor = buildRumor(victim.publicKey, alice.publicKey, 'pay me, signed: victim');
    const wrap = wrapRumor(spoofedRumor, attacker.secretKey, alice.publicKey);
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([wrap]);

    expect(await new MessagesService(pool).fetchHistory(alice)).toHaveLength(0);
  });

  it('rejects a seal with an invalid signature', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    const rumor = buildRumor(bob.publicKey, alice.publicKey, 'tampered seal');
    const wrap = wrapRumor(rumor, bob.secretKey, alice.publicKey, (seal) => ({
      ...seal,
      sig: seal.sig.replace(/^../, seal.sig.startsWith('00') ? '11' : '00'),
    }));
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([wrap]);

    expect(await new MessagesService(pool).fetchHistory(alice)).toHaveLength(0);
  });

  it('rejects a tampered rumor id', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    const rumor = buildRumor(bob.publicKey, alice.publicKey, 'honest content');
    rumor.id = rumor.id.endsWith('0') ? `${rumor.id.slice(0, -1)}1` : `${rumor.id.slice(0, -1)}0`;
    const wrap = wrapRumor(rumor, bob.secretKey, alice.publicKey);
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([wrap]);

    expect(await new MessagesService(pool).fetchHistory(alice)).toHaveLength(0);
  });

  it('drops rumors stamped too far in the future', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    const farFuture = nowSecs() + DEFAULTS.DM_FUTURE_SKEW_SECS + 3_600;
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([
      legitWrap(bob, alice.publicKey, 'pinned forever', farFuture),
    ]);

    expect(await new MessagesService(pool).fetchHistory(alice)).toHaveLength(0);
  });

  it('drops rumors with non-integer or negative created_at (cursor-poisoning vectors)', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    // Both pass a bare `typeof === 'number'` check and the future-skew
    // comparison, then poison timestamp-keyed consumers (MCP read cursors).
    const wraps = [-1, 1.5].map((createdAt) =>
      wrapRumor(
        buildRumor(bob.publicKey, alice.publicKey, `stamped ${createdAt}`, createdAt),
        bob.secretKey,
        alice.publicKey,
      ),
    );
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue(wraps);

    expect(await new MessagesService(pool).fetchHistory(alice, { since: 0 })).toHaveLength(0);
  });

  it('drops non-DM rumor kinds (e.g. kind 15 file messages)', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    const fileRumor = buildRumor(bob.publicKey, alice.publicKey, 'blob-url', nowSecs(), 15);
    const wrap = wrapRumor(fileRumor, bob.secretKey, alice.publicKey);
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([wrap]);

    expect(await new MessagesService(pool).fetchHistory(alice)).toHaveLength(0);
  });

  it('does not crash on a rumor without a p tag - recipient falls back to own pubkey', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    const noPTag = buildRumor(bob.publicKey, null, 'malformed but decryptable');
    const wrap = wrapRumor(noPTag, bob.secretKey, alice.publicKey);
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([wrap]);

    const messages = await new MessagesService(pool).fetchHistory(alice);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.recipientPubkey).toBe(alice.publicKey);
  });

  it('dedups duplicate wraps by rumor id', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    const wrap = legitWrap(bob, alice.publicKey, 'once');
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([wrap, asWireEvent(wrap)]);

    expect(await new MessagesService(pool).fetchHistory(alice)).toHaveLength(1);
  });
});

describe('MessagesService since handling', () => {
  it('widens the relay filter by the 2-day slack but trims results to logical since', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();
    const logicalSince = nowSecs() - 600;

    const fresh = legitWrap(bob, alice.publicKey, 'fresh', logicalSince + 60);
    const stale = legitWrap(bob, alice.publicKey, 'stale', logicalSince - 60);
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([fresh, stale]);

    const messages = await new MessagesService(pool).fetchHistory(alice, { since: logicalSince });
    expect(messages.map((message) => message.content)).toEqual(['fresh']);

    const filter = (pool.querySync as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Filter;
    expect(filter.since).toBe(logicalSince - DEFAULTS.DM_WRAP_TIMESTAMP_SLACK_SECS);
  });

  it('floors the widened filter at zero for since: 0', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();

    await new MessagesService(pool).fetchHistory(alice, { since: 0 });
    const filter = (pool.querySync as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Filter;
    expect(filter.since).toBe(0);
  });

  it('subscribe does NOT trim: a rumor slightly older than since still arrives', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();
    const received: string[] = [];

    const subscribeSince = nowSecs();
    new MessagesService(pool).subscribe(
      alice,
      (message) => {
        received.push(message.content);
      },
      { since: subscribeSince },
    );

    const seamCall = pool.subscribeCalls[0];
    expect(seamCall).toBeDefined();
    expect((seamCall?.filter as Filter).since).toBe(
      subscribeSince - DEFAULTS.DM_WRAP_TIMESTAMP_SLACK_SECS,
    );
    seamCall?.onEvent(legitWrap(bob, alice.publicKey, 'skewed', subscribeSince - 30));
    expect(received).toEqual(['skewed']);
  });

  it('subscribe dedups replayed wraps by rumor id', () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();
    const received: string[] = [];

    new MessagesService(pool).subscribe(alice, (message) => {
      received.push(message.content);
    });
    const wrap = legitWrap(bob, alice.publicKey, 'replayed');
    pool.subscribeCalls[0]?.onEvent(wrap);
    pool.subscribeCalls[0]?.onEvent(asWireEvent(wrap));
    expect(received).toEqual(['replayed']);
  });
});

describe('MessagesService.listConversations', () => {
  it('groups by counterpart with unreadCount from readCursors', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();
    const charlie = ElisymIdentity.generate();
    const base = nowSecs() - 1_000;

    // alice -> bob self-copy (own message must group under bob, never count as unread)
    const selfCopy = asWireEvent(
      nip59.wrapEvent(
        {
          kind: KIND_DM_RUMOR,
          created_at: base + 10,
          tags: [['p', bob.publicKey]],
          content: 'hi bob',
        },
        alice.secretKey,
        alice.publicKey,
      ),
    );
    const bobReplyRead = legitWrap(bob, alice.publicKey, 'read reply', base + 20);
    const bobReplyUnread = legitWrap(bob, alice.publicKey, 'unread reply', base + 30);
    const charlieMsg = legitWrap(charlie, alice.publicKey, 'first contact', base + 5);
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([
      selfCopy,
      bobReplyRead,
      bobReplyUnread,
      charlieMsg,
    ]);

    const summaries = await new MessagesService(pool).listConversations(alice, {
      readCursors: { [bob.publicKey]: base + 20 },
    });

    expect(summaries).toHaveLength(2);
    // Newest conversation first: bob's last message (base+30) beats charlie's (base+5).
    expect(summaries[0]?.counterpartPubkey).toBe(bob.publicKey);
    expect(summaries[0]?.messageCount).toBe(3);
    expect(summaries[0]?.lastMessage.content).toBe('unread reply');
    // Strictly newer than cursor: only the base+30 reply. Own message never counts.
    expect(summaries[0]?.unreadCount).toBe(1);
    // Missing cursor: every counterpart-authored message is unread.
    expect(summaries[1]?.counterpartPubkey).toBe(charlie.publicKey);
    expect(summaries[1]?.unreadCount).toBe(1);
  });

  it('omits unreadCount when readCursors is not passed', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([
      legitWrap(bob, alice.publicKey, 'hello'),
    ]);

    const summaries = await new MessagesService(pool).listConversations(alice);
    expect(summaries[0]?.unreadCount).toBeUndefined();
  });
});

describe('MessagesService.publishInboxRelays', () => {
  function relayTags(event: Event): string[] {
    return event.tags
      .filter((tag) => tag[0] === 'relay')
      .map((tag) => tag[1])
      .filter((url): url is string => typeof url === 'string');
  }

  function hasMarker(event: Event): boolean {
    return event.tags.some(
      (tag) => tag[0] === DM_INBOX_MARKER_TAG && tag[1] === DM_INBOX_MARKER_VALUE,
    );
  }

  function inboxEvent(
    identity: ElisymIdentity,
    relays: string[],
    withMarker: boolean,
    createdAt: number = nowSecs(),
  ): Event {
    const tags = relays.map((url) => ['relay', url]);
    if (withMarker) {
      tags.push([DM_INBOX_MARKER_TAG, DM_INBOX_MARKER_VALUE]);
    }
    return asWireEvent(
      finalizeEvent(
        { kind: KIND_DM_INBOX_RELAYS, created_at: createdAt, tags, content: '' },
        identity.secretKey,
      ),
    );
  }

  it('explicit mode publishes unconditionally without the marker, repeatedly', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const svc = new MessagesService(pool);

    // Pre-existing external marker-less 10050 must NOT block an explicit call.
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([
      inboxEvent(agent, ['wss://external.example'], false),
    ]);

    await svc.publishInboxRelays(agent, ['wss://custom.one']);
    await svc.publishInboxRelays(agent, ['wss://custom.two']);

    expect(pool.published).toHaveLength(2);
    expect(relayTags(pool.published[0] as Event)).toEqual(['wss://custom.one']);
    expect(relayTags(pool.published[1] as Event)).toEqual(['wss://custom.two']);
    expect(hasMarker(pool.published[0] as Event)).toBe(false);
    expect(pool.querySync).not.toHaveBeenCalled();
  });

  it('default mode publishes the pool relay set with the marker when none exists', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();

    await new MessagesService(pool).publishInboxRelays(agent);

    expect(pool.published).toHaveLength(1);
    const event = pool.published[0] as Event;
    expect(event.kind).toBe(KIND_DM_INBOX_RELAYS);
    expect(relayTags(event)).toEqual(['wss://relay.one', 'wss://relay.two']);
    expect(hasMarker(event)).toBe(true);
  });

  it('default mode is debounced per service instance per pubkey', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const svc = new MessagesService(pool);

    await svc.publishInboxRelays(agent);
    await svc.publishInboxRelays(agent);
    expect(pool.published).toHaveLength(1);
  });

  it('default mode never overwrites an operator (marker-less) 10050', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([
      inboxEvent(agent, ['wss://operator.example'], false),
    ]);

    await new MessagesService(pool).publishInboxRelays(agent);
    expect(pool.published).toHaveLength(0);
  });

  it('default mode refreshes a marker-tagged 10050 with a stale relay set, skips an identical one', async () => {
    const agent = ElisymIdentity.generate();

    const stalePool = createMockPool();
    (stalePool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([
      inboxEvent(agent, ['wss://old.example'], true),
    ]);
    await new MessagesService(stalePool).publishInboxRelays(agent);
    expect(stalePool.published).toHaveLength(1);

    const samePool = createMockPool();
    (samePool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([
      inboxEvent(agent, ['wss://relay.one', 'wss://relay.two'], true),
    ]);
    await new MessagesService(samePool).publishInboxRelays(agent);
    expect(samePool.published).toHaveLength(0);
  });

  it('the newest event wins the ownership judgment, in either array order', async () => {
    const agent = ElisymIdentity.generate();
    const staleOurs = inboxEvent(agent, ['wss://old.example'], true, nowSecs() - 3_600);
    const newerOperator = inboxEvent(agent, ['wss://operator.example'], false, nowSecs());

    for (const order of [
      [staleOurs, newerOperator],
      [newerOperator, staleOurs],
    ]) {
      const pool = createMockPool();
      (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue(order);
      await new MessagesService(pool).publishInboxRelays(agent);
      expect(pool.published).toHaveLength(0);
    }
  });

  it('ignores forged candidates: bad signature, wrong author, wrong kind, far-future', async () => {
    const agent = ElisymIdentity.generate();
    const stranger = ElisymIdentity.generate();

    const badSig = inboxEvent(agent, ['wss://forged.example'], false);
    badSig.sig = badSig.sig.replace(/^../, badSig.sig.startsWith('00') ? '11' : '00');
    const wrongAuthor = inboxEvent(stranger, ['wss://stranger.example'], false);
    const wrongKind = asWireEvent(
      finalizeEvent(
        { kind: 10_051, created_at: nowSecs(), tags: [['relay', 'wss://x.example']], content: '' },
        agent.secretKey,
      ),
    );
    const farFuture = inboxEvent(
      agent,
      ['wss://future.example'],
      false,
      nowSecs() + DEFAULTS.DM_FUTURE_SKEW_SECS + 3_600,
    );

    const pool = createMockPool();
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([
      badSig,
      wrongAuthor,
      wrongKind,
      farFuture,
    ]);

    // Every candidate is forged - the guard must treat the inbox as empty and publish.
    await new MessagesService(pool).publishInboxRelays(agent);
    expect(pool.published).toHaveLength(1);
    expect(hasMarker(pool.published[0] as Event)).toBe(true);
  });

  it('rejects an empty explicit relay list', async () => {
    const svc = new MessagesService(createMockPool());
    await expect(svc.publishInboxRelays(ElisymIdentity.generate(), [])).rejects.toThrow(
      'must not be empty',
    );
  });
});

describe('announce integration (publishCapability -> 10050)', () => {
  const CARD: CapabilityCard = {
    name: 'test-agent',
    description: 'test',
    capabilities: ['echo'],
    payment: {
      chain: 'solana',
      network: 'devnet',
      address: 'So11111111111111111111111111111111111111112',
    },
  };

  it('announce publishes both the capability card and the marker-tagged 10050', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const messages = new MessagesService(pool);
    const discovery = new DiscoveryService(pool, messages);

    await discovery.publishCapability(agent, CARD);

    const kinds = pool.published.map((event) => event.kind);
    expect(kinds).toContain(KIND_APP_HANDLER);
    expect(kinds).toContain(KIND_DM_INBOX_RELAYS);
  });

  it('a 10050 failure does not fail the announce', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    (pool.publishAll as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (event: Event) => {
        pool.published.push(event);
      })
      .mockRejectedValueOnce(new Error('relays refused the 10050'));
    const discovery = new DiscoveryService(pool, new MessagesService(pool));

    await expect(discovery.publishCapability(agent, CARD)).resolves.toBeTypeOf('string');
    expect(pool.published.map((event) => event.kind)).toEqual([KIND_APP_HANDLER]);
  });

  it('N publishCapability calls produce exactly one 10050 publish (debounce)', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const discovery = new DiscoveryService(pool, new MessagesService(pool));

    await discovery.publishCapability(agent, CARD);
    await discovery.publishCapability(agent, { ...CARD, name: 'second-skill' });
    await discovery.publishCapability(agent, { ...CARD, name: 'third-skill' });

    const inboxEvents = pool.published.filter((event) => event.kind === KIND_DM_INBOX_RELAYS);
    expect(inboxEvents).toHaveLength(1);
  });

  it('an explicit custom-list publish followed by an announce leaves the custom list intact', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();
    const messages = new MessagesService(pool);
    const discovery = new DiscoveryService(pool, messages);

    await messages.publishInboxRelays(agent, ['wss://my-own-relay.example']);
    const explicitEvent = pool.published[0];
    expect(explicitEvent).toBeDefined();
    // The announce path queries relays for existing 10050s - serve the explicit one back.
    (pool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([
      asWireEvent(explicitEvent as Event),
    ]);

    await discovery.publishCapability(agent, CARD);

    const inboxEvents = pool.published.filter((event) => event.kind === KIND_DM_INBOX_RELAYS);
    expect(inboxEvents).toHaveLength(1);
    expect(inboxEvents[0]?.tags).toEqual([['relay', 'wss://my-own-relay.example']]);
  });

  it('standalone DiscoveryService (no messages service) announces without a 10050', async () => {
    const pool = createMockPool();
    const agent = ElisymIdentity.generate();

    await new DiscoveryService(pool).publishCapability(agent, CARD);
    expect(pool.published.map((event) => event.kind)).toEqual([KIND_APP_HANDLER]);
  });
});

describe('MessagesService rumor id stability', () => {
  it('self and recipient wraps decrypt to the same rumor id (fixed created_at template)', async () => {
    const pool = createMockPool();
    const alice = ElisymIdentity.generate();
    const bob = ElisymIdentity.generate();

    const { id } = await new MessagesService(pool).send(alice, bob.publicKey, 'same rumor');
    const [recipientWrap, selfWrap] = pool.published;

    const alicePool = createMockPool();
    (alicePool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([selfWrap]);
    const bobPool = createMockPool();
    (bobPool.querySync as ReturnType<typeof vi.fn>).mockResolvedValue([recipientWrap]);

    const aliceMessages = await new MessagesService(alicePool).fetchHistory(alice);
    const bobMessages = await new MessagesService(bobPool).fetchHistory(bob);
    expect(aliceMessages[0]?.id).toBe(id);
    expect(bobMessages[0]?.id).toBe(id);

    const publicKeyOf = getPublicKey(alice.secretKey);
    expect(aliceMessages[0]?.senderPubkey).toBe(publicKeyOf);
  });
});
