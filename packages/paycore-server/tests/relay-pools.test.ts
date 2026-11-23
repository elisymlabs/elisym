import type { AddressInfo } from 'node:net';
import { InboxListener } from '@merchant-node/listener';
import { storeAuth } from '@merchant-node/store-node';
import type { Filter, NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { StorePools } from '../src/relay/pools';

const KIND_GIFT_WRAP = 1059;
const KIND_CLIENT_AUTH = 22242;

interface Connection {
  socket: WebSocket;
  challenge: string;
  authed: Set<string>;
  subs: Map<string, Filter[]>;
}

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }
  const wanted = filter['#p'];
  if (wanted !== undefined) {
    const tagged = event.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]);
    if (!wanted.some((pubkey) => tagged.includes(pubkey))) {
      return false;
    }
  }
  return true;
}

/**
 * A relay speaking NIP-01 and NIP-42: it sends a challenge on connect, closes
 * an unauthenticated REQ for gift wraps with `auth-required`, and serves wraps
 * only to a connection authenticated as every pubkey the REQ names.
 */
class FakeRelay {
  readonly connections = new Set<Connection>();
  readonly events: NostrEvent[] = [];
  /** REQs closed with `auth-required`. */
  authRequired = 0;
  private readonly server: WebSocketServer;
  private challenges = 0;

  constructor() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server.on('connection', (socket) => this.accept(socket));
  }

  async ready(): Promise<string> {
    if (this.server.address() === null) {
      await new Promise<void>((resolve) => {
        this.server.once('listening', resolve);
      });
    }
    const { port } = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/`;
  }

  /** REQs open for a store's wraps. */
  openReqsFor(pubkey: string): number {
    let count = 0;
    for (const connection of this.connections) {
      for (const filters of connection.subs.values()) {
        if (filters.some((filter) => filter['#p']?.includes(pubkey) === true)) {
          count += 1;
        }
      }
    }
    return count;
  }

  /** Open sockets authenticated as `pubkey`. */
  socketsOf(pubkey: string): number {
    return [...this.connections].filter((connection) => connection.authed.has(pubkey)).length;
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private accept(socket: WebSocket): void {
    this.challenges += 1;
    const connection: Connection = {
      socket,
      challenge: `challenge-${this.challenges}`,
      authed: new Set(),
      subs: new Map(),
    };
    this.connections.add(connection);
    socket.on('close', () => {
      this.connections.delete(connection);
    });
    socket.on('message', (data) => {
      this.handle(connection, JSON.parse(String(data)) as unknown[]);
    });
    this.send(connection, ['AUTH', connection.challenge]);
  }

  private send(connection: Connection, message: unknown[]): void {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify(message));
    }
  }

  private handle(connection: Connection, message: unknown[]): void {
    const [type] = message;
    if (type === 'AUTH') {
      const event = message[1] as NostrEvent;
      const challenge = event.tags.find((tag) => tag[0] === 'challenge')?.[1];
      const accepted =
        verifyEvent(event) && event.kind === KIND_CLIENT_AUTH && challenge === connection.challenge;
      if (accepted) {
        connection.authed.add(event.pubkey);
      }
      this.send(connection, ['OK', event.id, accepted, accepted ? '' : 'invalid: bad auth']);
      return;
    }
    if (type === 'REQ') {
      const id = message[1] as string;
      const filters = message.slice(2) as Filter[];
      const wantsWraps = filters.some((filter) => filter.kinds?.includes(KIND_GIFT_WRAP) === true);
      const allowed = filters.every((filter) =>
        (filter['#p'] ?? []).every((pubkey) => connection.authed.has(pubkey)),
      );
      if (wantsWraps && connection.authed.size === 0) {
        this.authRequired += 1;
        this.send(connection, ['CLOSED', id, 'auth-required: gift wraps are for their recipient']);
        return;
      }
      if (wantsWraps && !allowed) {
        this.send(connection, ['CLOSED', id, 'restricted: not your wraps']);
        return;
      }
      connection.subs.set(id, filters);
      for (const event of this.events) {
        if (filters.some((filter) => matches(filter, event))) {
          this.send(connection, ['EVENT', id, event]);
        }
      }
      this.send(connection, ['EOSE', id]);
      return;
    }
    if (type === 'CLOSE') {
      connection.subs.delete(message[1] as string);
      return;
    }
    if (type === 'EVENT') {
      const event = message[1] as NostrEvent;
      this.events.push(event);
      this.send(connection, ['OK', event.id, true, '']);
      for (const other of this.connections) {
        for (const [id, filters] of other.subs) {
          if (filters.some((filter) => matches(filter, event))) {
            this.send(other, ['EVENT', id, event]);
          }
        }
      }
    }
  }
}

function wrapFor(recipient: string, createdAt: number): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: createdAt,
      tags: [['p', recipient]],
      content: `sealed for ${recipient.slice(0, 8)}`,
    },
    generateSecretKey(),
  );
}

async function publish(url: string, events: NostrEvent[]): Promise<void> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  for (const event of events) {
    const acknowledged = new Promise<void>((resolve) => {
      const onMessage = (data: unknown) => {
        const [type, id] = JSON.parse(String(data)) as unknown[];
        if (type === 'OK' && id === event.id) {
          socket.off('message', onMessage);
          resolve();
        }
      };
      socket.on('message', onMessage);
    });
    socket.send(JSON.stringify(['EVENT', event]));
    await acknowledged;
  }
  socket.close();
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface RunningStore {
  pubkey: string;
  wraps: NostrEvent[];
  listener: InboxListener;
}

function startStore(pools: StorePools, relay: string, now: number): RunningStore {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const wraps: NostrEvent[] = [];
  const listener = new InboxListener({
    pool: pools.open(pubkey),
    storePubkey: pubkey,
    auth: storeAuth(secretKey),
    onWrap: (wrap) => wraps.push(wrap),
    log: () => undefined,
    now: () => now,
  });
  listener.listen(relay, now);
  return { pubkey, wraps, listener };
}

const relays: FakeRelay[] = [];
const allPools: StorePools[] = [];

afterEach(async () => {
  for (const pools of allPools.splice(0)) {
    pools.closeAll();
  }
  for (const relay of relays.splice(0)) {
    await relay.close();
  }
});

function setup(): { relay: FakeRelay; pools: StorePools } {
  const relay = new FakeRelay();
  const pools = new StorePools();
  relays.push(relay);
  allPools.push(pools);
  return { relay, pools };
}

describe('StorePools', () => {
  it('two stores on one AUTH-gated relay each receive their own wraps, stored and live', async () => {
    const { relay, pools } = setup();
    const url = await relay.ready();
    const now = Math.floor(Date.now() / 1000);
    const first = startStore(pools, url, now);
    const second = startStore(pools, url, now);
    expect(pools.size).toBe(2);
    const stored = [wrapFor(first.pubkey, now - 60), wrapFor(second.pubkey, now - 30)];
    await publish(url, stored);
    await waitFor(
      () => first.listener.isLive(url) && second.listener.isLive(url),
      'both inboxes read through',
    );
    expect(relay.authRequired).toBeGreaterThanOrEqual(2);
    expect(relay.socketsOf(first.pubkey)).toBe(1);
    expect(relay.socketsOf(second.pubkey)).toBe(1);
    const live = [wrapFor(second.pubkey, now), wrapFor(first.pubkey, now)];
    await publish(url, live);
    await waitFor(
      () =>
        new Set(first.wraps.map((wrap) => wrap.id)).size === 2 &&
        new Set(second.wraps.map((wrap) => wrap.id)).size === 2,
      'the live wraps',
    );
    expect(new Set(first.wraps.map((wrap) => wrap.id))).toEqual(
      new Set([stored[0]?.id, live[1]?.id]),
    );
    expect(new Set(second.wraps.map((wrap) => wrap.id))).toEqual(
      new Set([stored[1]?.id, live[0]?.id]),
    );
  });

  it('a stopped store leaves no REQ and no socket on the relay; the other one keeps listening', async () => {
    const { relay, pools } = setup();
    const url = await relay.ready();
    const now = Math.floor(Date.now() / 1000);
    const first = startStore(pools, url, now);
    const second = startStore(pools, url, now);
    await waitFor(
      () => first.listener.isLive(url) && second.listener.isLive(url),
      'both inboxes read through',
    );
    expect(relay.openReqsFor(first.pubkey)).toBeGreaterThan(0);

    first.listener.close();
    pools.close(first.pubkey);
    await waitFor(
      () => relay.socketsOf(first.pubkey) === 0 && relay.openReqsFor(first.pubkey) === 0,
      'the stopped store gone from the relay',
    );
    expect(pools.size).toBe(1);
    expect(relay.socketsOf(second.pubkey)).toBe(1);
    expect(relay.openReqsFor(second.pubkey)).toBeGreaterThan(0);

    const late = [wrapFor(first.pubkey, now), wrapFor(second.pubkey, now)];
    await publish(url, late);
    await waitFor(
      () => second.wraps.some((wrap) => wrap.id === late[1]?.id),
      'the running store wrap',
    );
    expect(first.wraps).toEqual([]);
    expect(relay.connections.size).toBe(1);
  });

  it('refuses a second pool for a running store and opens a fresh one after close', () => {
    const made: number[] = [];
    const pools = new StorePools(() => {
      made.push(made.length);
      return { destroy: () => undefined } as unknown as ReturnType<StorePools['open']>;
    });
    pools.open('a');
    expect(() => pools.open('a')).toThrow(/already has a relay pool/);
    pools.close('a');
    pools.close('a');
    pools.open('a');
    expect(made).toEqual([0, 1]);
  });

  it('closeAll destroys every pool once and forgets them', () => {
    const destroyed: string[] = [];
    let next = 0;
    const names = ['a', 'b', 'c'];
    const pools = new StorePools(() => {
      const name = names[next] ?? 'extra';
      next += 1;
      return { destroy: () => destroyed.push(name) } as unknown as ReturnType<StorePools['open']>;
    });
    for (const name of names) {
      pools.open(name);
    }
    pools.closeAll();
    expect(destroyed).toEqual(['a', 'b', 'c']);
    expect(pools.size).toBe(0);
    pools.closeAll();
    expect(destroyed).toEqual(['a', 'b', 'c']);
    pools.open('a');
    expect(pools.size).toBe(1);
  });
});
