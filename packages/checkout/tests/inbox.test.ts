import { KIND_INBOX_RELAYS } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAYS, STORE_RELAY_CAP } from '../src/core/constants';
import { newestStoreInbox, readStoreInbox } from '../src/core/inbox';
import { MemoryRelays, NOW, nostrKey, sign } from './fixtures';

const store = nostrKey();

function inboxList(relays: string[], createdAt: number, signer = store): NostrEvent {
  return sign(
    {
      kind: KIND_INBOX_RELAYS,
      created_at: createdAt,
      tags: relays.map((relay) => ['relay', relay]),
      content: '',
    },
    signer,
  );
}

describe('newestStoreInbox', () => {
  it('takes the newest list the store signed, across every relay that answered', () => {
    const old = inboxList(['wss://old.example.com'], NOW - 100);
    const fresh = inboxList(['wss://new.example.com'], NOW - 10);
    expect(newestStoreInbox([fresh, old], store.pubkey, NOW)?.relays).toEqual([
      'wss://new.example.com',
    ]);
    expect(newestStoreInbox([old, fresh], store.pubkey, NOW)?.event.id).toBe(fresh.id);
  });

  it('ignores a forged, foreign or far-future list', () => {
    const genuine = inboxList(['wss://real.example.com'], NOW - 100);
    const forged = { ...inboxList(['wss://forged.example.com'], NOW - 10), sig: genuine.sig };
    const foreign = inboxList(['wss://foreign.example.com'], NOW - 5, nostrKey());
    const future = inboxList(['wss://future.example.com'], NOW + 3600);
    expect(newestStoreInbox([forged, foreign, future, genuine], store.pubkey, NOW)?.relays).toEqual(
      ['wss://real.example.com'],
    );
  });

  it('breaks a tie on created_at by the lowest id', () => {
    const first = inboxList(['wss://a.example.com'], NOW - 10);
    const second = inboxList(['wss://b.example.com'], NOW - 10);
    const lower = first.id < second.id ? first : second;
    expect(newestStoreInbox([first, second], store.pubkey, NOW)?.event.id).toBe(lower.id);
    expect(newestStoreInbox([second, first], store.pubkey, NOW)?.event.id).toBe(lower.id);
  });

  it('has no inbox when the newest list names no usable relay, and caps a long one', () => {
    const unusable = inboxList(['ws://plain.example.com', 'wss://localhost'], NOW - 10);
    const older = inboxList(['wss://real.example.com'], NOW - 100);
    expect(newestStoreInbox([unusable, older], store.pubkey, NOW)).toBeUndefined();
    const long = inboxList(
      Array.from({ length: 12 }, (_, index) => `wss://r${index}.example.com`),
      NOW - 10,
    );
    expect(newestStoreInbox([long], store.pubkey, NOW)?.relays).toHaveLength(STORE_RELAY_CAP);
  });

  it('reads from the default relays always, plus the store-named ones', async () => {
    const relays = new MemoryRelays([inboxList(['wss://inbox.example.com'], NOW - 10)]);
    const inbox = await readStoreInbox(
      relays,
      { hints: ['wss://hint.example.com'] },
      store.pubkey,
      NOW,
    );
    expect(inbox?.relays).toEqual(['wss://inbox.example.com']);
    expect(relays.queried).toEqual([[...DEFAULT_RELAYS, 'wss://hint.example.com']]);
  });

  it('reads only relay tags of a kind 10050', () => {
    const list = sign(
      {
        kind: KIND_INBOX_RELAYS,
        created_at: NOW - 10,
        tags: [
          ['r', 'wss://r-tag.example.com'],
          ['relay', 'wss://inbox.example.com'],
        ],
        content: '',
      },
      store,
    );
    const otherKind = sign(
      {
        kind: 10002,
        created_at: NOW - 5,
        tags: [['relay', 'wss://other.example.com']],
        content: '',
      },
      store,
    );
    expect(newestStoreInbox([list, otherKind], store.pubkey, NOW)?.relays).toEqual([
      'wss://inbox.example.com',
    ]);
  });
});
