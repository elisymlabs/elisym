import { buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { handOutcome, publishHandAnswer } from '../src/hand-publish';
import type { PublishPool } from '../src/publish';
import { T0, key } from './fixtures';

const RELAYS = ['wss://inbox-a', 'wss://inbox-b'];

function answer() {
  const store = key();
  const buyer = key();
  return wrapOrderMessage(
    buildOrderMessage(
      {
        type: 'status',
        buyerPubkey: buyer.pubkey,
        orderId: 'b3a7c2d4-0000-4000-8000-00000000e001',
        status: 'completed',
      },
      T0,
    ),
    store.secretKey,
    buyer.pubkey,
  );
}

/** Relays that take every event, except that `refuseCopies` refuse the store's copy. */
function pool(sent: string[], copyId: string, refuseCopies: boolean): PublishPool {
  return {
    ensureRelay: async (url) => ({
      publish: async (event: NostrEvent) => {
        const which = event.id === copyId ? 'copy' : 'buyer';
        sent.push(`${which}@${url}`);
        if (which === 'copy' && refuseCopies) {
          throw new Error('blocked: rate-limited');
        }
        return '';
      },
      auth: async () => '',
    }),
  };
}

const auth = async (template: Parameters<typeof finalizeEvent>[0]) =>
  finalizeEvent(template, key().secretKey);

describe('a hand answer', () => {
  it("starts the store's copy only once the buyer's answer has settled", async () => {
    const wrap = answer();
    const sent: string[] = [];
    let release: (() => void) | undefined;
    const buyerSettles = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held: PublishPool = {
      ensureRelay: async (url) => ({
        publish: async (event: NostrEvent) => {
          const which = event.id === wrap.selfWrap.id ? 'copy' : 'buyer';
          sent.push(`${which}@${url}`);
          if (which === 'buyer') {
            await buyerSettles;
          }
          return '';
        },
        auth: async () => '',
      }),
    };
    const publishing = publishHandAnswer(held, RELAYS, wrap, auth, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.some((entry) => entry.startsWith('copy@'))).toBe(false);
    release?.();
    await publishing;
    expect(sent.filter((entry) => entry.startsWith('copy@'))).toHaveLength(RELAYS.length);
  });

  it("is published to the buyer first, then as the store's copy, to every inbox relay", async () => {
    const wrap = answer();
    const sent: string[] = [];
    const result = await publishHandAnswer(
      pool(sent, wrap.selfWrap.id, false),
      RELAYS,
      wrap,
      auth,
      () => undefined,
    );
    expect(sent).toEqual([
      'buyer@wss://inbox-a',
      'buyer@wss://inbox-b',
      'copy@wss://inbox-a',
      'copy@wss://inbox-b',
    ]);
    expect(result).toEqual({ taken: RELAYS, copyTaken: RELAYS });
    expect(handOutcome(result, RELAYS.length)).toEqual({
      lines: ['taken by 2 of 2: wss://inbox-a, wss://inbox-b'],
      done: true,
    });
  });

  it('says to run it again when no relay took the copy, and still counts the answer as sent', async () => {
    const wrap = answer();
    const sent: string[] = [];
    const result = await publishHandAnswer(
      pool(sent, wrap.selfWrap.id, true),
      RELAYS,
      wrap,
      auth,
      () => undefined,
    );
    expect(result).toEqual({ taken: RELAYS, copyTaken: [] });
    expect(handOutcome(result, RELAYS.length)).toEqual({
      lines: [
        'taken by 2 of 2: wss://inbox-a, wss://inbox-b',
        'the copy for your admin was taken by no relay: run the same command again',
      ],
      done: true,
    });
    expect(handOutcome({ taken: [], copyTaken: [] }, RELAYS.length).done).toBe(false);
  });
});
