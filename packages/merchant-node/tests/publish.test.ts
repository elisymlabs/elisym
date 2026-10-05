import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  type PublishPool,
  type PublishRelay,
  publishToRelays,
  setupPublisher,
} from '../src/publish';
import { T0, key } from './fixtures';

const store = key();
const auth = async (template: Parameters<typeof finalizeEvent>[0]) =>
  finalizeEvent(template, store.secretKey);
const event = finalizeEvent(
  { kind: 1, created_at: T0, tags: [], content: 'x' },
  store.secretKey,
) as NostrEvent;

function relay(answers: (() => Promise<string>)[], auths: string[] = []): PublishRelay {
  let call = 0;
  return {
    publish: () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return answer === undefined ? Promise.resolve('') : answer();
    },
    auth: async () => {
      auths.push('auth');
      return '';
    },
  };
}

function pool(relays: Record<string, PublishRelay | 'down'>): PublishPool {
  return {
    ensureRelay: async (url) => {
      const found = relays[url];
      if (found === undefined || found === 'down') {
        throw new Error('connection failed');
      }
      return found;
    },
  };
}

describe('publishToRelays', () => {
  it('counts only relays that said OK, and never an unreachable one', async () => {
    const logs: string[] = [];
    const accepted = await publishToRelays(
      pool({
        'wss://ok.example.com': relay([() => Promise.resolve('')]),
        'wss://down.example.com': 'down',
        'wss://no.example.com': relay([() => Promise.reject(new Error('blocked: spam'))]),
      }),
      ['wss://ok.example.com', 'wss://down.example.com', 'wss://no.example.com'],
      event,
      auth,
      (message) => logs.push(message),
    );
    expect(accepted).toEqual(['wss://ok.example.com']);
    expect(logs).toHaveLength(2);
  });

  it('signs AUTH with the store key and sends again when a relay asks, and only then', async () => {
    const auths: string[] = [];
    const accepted = await publishToRelays(
      pool({
        'wss://member.example.com': relay(
          [
            () => Promise.reject(new Error('auth-required: members only')),
            () => Promise.resolve(''),
          ],
          auths,
        ),
      }),
      ['wss://member.example.com'],
      event,
      auth,
      () => undefined,
    );
    expect(accepted).toEqual(['wss://member.example.com']);
    expect(auths).toEqual(['auth']);

    const refusedAuths: string[] = [];
    await publishToRelays(
      pool({
        'wss://no.example.com': relay(
          [() => Promise.reject(new Error('blocked: spam'))],
          refusedAuths,
        ),
      }),
      ['wss://no.example.com'],
      event,
      auth,
      () => undefined,
    );
    expect(refusedAuths).toEqual([]);
  });

  it('gives up on a relay that never answers', async () => {
    const accepted = await publishToRelays(
      pool({ 'wss://slow.example.com': relay([() => new Promise<string>(() => undefined)]) }),
      ['wss://slow.example.com'],
      event,
      auth,
      () => undefined,
      20,
    );
    expect(accepted).toEqual([]);
  });

  it('M22: skips a relay that hung or could not connect for the rest of a setup, not one that refused', async () => {
    let hungTries = 0;
    let downTries = 0;
    const hung: PublishRelay = {
      publish: () => {
        hungTries += 1;
        return new Promise<string>(() => undefined);
      },
      auth: async () => '',
    };
    const refusing = relay([() => Promise.reject(new Error('blocked: spam'))]);
    const publishPool: PublishPool = {
      ensureRelay: async (url) => {
        if (url === 'wss://down.example.com') {
          downTries += 1;
          throw new Error('connection failed');
        }
        if (url === 'wss://hung.example.com') {
          return hung;
        }
        return url === 'wss://no.example.com' ? refusing : relay([() => Promise.resolve('')]);
      },
    };
    const breaker = new Set<string>();
    const relays = [
      'wss://ok.example.com',
      'wss://hung.example.com',
      'wss://down.example.com',
      'wss://no.example.com',
    ];
    for (let index = 0; index < 5; index += 1) {
      const accepted = await publishToRelays(
        publishPool,
        relays,
        event,
        auth,
        () => undefined,
        20,
        breaker,
      );
      // A healthy relay takes every event, whatever the others do.
      expect(accepted).toEqual(['wss://ok.example.com']);
    }
    expect(hungTries).toBe(1);
    expect(downTries).toBe(1);
    expect([...breaker].sort()).toEqual(['wss://down.example.com', 'wss://hung.example.com']);
  });

  it('counts an event out when any relay took it, a partial OK', async () => {
    const accepted = await publishToRelays(
      pool({
        'wss://ok.example.com': relay([() => Promise.resolve('')]),
        'wss://slow.example.com': relay([() => new Promise<string>(() => undefined)]),
      }),
      ['wss://ok.example.com', 'wss://slow.example.com'],
      event,
      auth,
      () => undefined,
      20,
      new Set(),
    );
    expect(accepted).toEqual(['wss://ok.example.com']);
  });

  it("trips on nostr-tools' own publish timeout, never on a relay refusal that mentions one", async () => {
    const breaker = new Set<string>();
    const publishPool = pool({
      'wss://slow.example.com': relay([() => Promise.reject(new Error('publish timed out'))]),
      'wss://limited.example.com': relay([
        () => Promise.reject(new Error('rate-limited: timed out, slow down')),
      ]),
    });
    await publishToRelays(
      publishPool,
      ['wss://slow.example.com', 'wss://limited.example.com'],
      event,
      auth,
      () => undefined,
      1_000,
      breaker,
    );
    expect([...breaker]).toEqual(['wss://slow.example.com']);
  });

  it('M22: a setup publisher shares one breaker across every event, and notes what no default relay took', async () => {
    let hungTries = 0;
    const publishPool: PublishPool = {
      ensureRelay: async (url) =>
        url === 'wss://hung.example.com'
          ? {
              publish: () => {
                hungTries += 1;
                return new Promise<string>(() => undefined);
              },
              auth: async () => '',
            }
          : relay([() => Promise.resolve('')]),
    };
    const publisher = setupPublisher(
      publishPool,
      ['wss://hung.example.com', 'wss://own.example.com'],
      ['wss://hung.example.com'],
      auth,
      () => undefined,
      20,
    );
    for (const name of ['one', 'two', 'three']) {
      expect(await publisher.publish(event, name)).toBe(true);
    }
    expect(hungTries).toBe(1);
    expect(publisher.missedDefaults).toEqual(['one', 'two', 'three']);
  });
});
