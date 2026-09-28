import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { type PublishPool, type PublishRelay, publishToRelays } from '../src/publish';
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
});
