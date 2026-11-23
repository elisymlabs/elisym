import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import { OFFER_RELAYS } from '@merchant-node/constants';
import type { Filter, NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { key } from '../../merchant-node/tests/fixtures';
import { type NewestReadPool, newestOnRelays } from '../src/relay/newest';

const T = 1_791_000_000;

function signed(
  author: ReturnType<typeof key>,
  kind: number,
  createdAt: number,
  content = '',
  tags: string[][] = [],
): NostrEvent {
  return finalizeEvent({ kind, created_at: createdAt, tags, content }, author.secretKey);
}

/** A pool answering `events` to any read, recording what it was asked and whether it was destroyed. */
function fakePool(answer: (filter: Filter) => Promise<NostrEvent[]>) {
  const asked: { relays: string[]; filter: Filter }[] = [];
  const state = { destroyed: false };
  const pool: NewestReadPool = {
    querySync: (relays, filter) => {
      asked.push({ relays, filter });
      return answer(filter);
    },
    destroy: () => {
      state.destroyed = true;
    },
  };
  return { pool, asked, state };
}

describe('newestOnRelays', () => {
  it('picks the newest payout list, and of two in the same second the lowest id', async () => {
    const owner = key();
    const older = signed(owner, KIND_PAYTO, T - 10, 'old');
    const tied = [signed(owner, KIND_PAYTO, T, 'a'), signed(owner, KIND_PAYTO, T, 'b')];
    const lowest = [...tied].sort((left, right) => (left.id < right.id ? -1 : 1))[0];
    const { pool, asked, state } = fakePool(async () => [older, ...tied]);
    const newest = await newestOnRelays(owner.pubkey, KIND_PAYTO, { makePool: () => pool });
    expect(newest?.id).toBe(lowest?.id);
    expect(asked).toEqual([
      { relays: [...OFFER_RELAYS], filter: { kinds: [KIND_PAYTO], authors: [owner.pubkey] } },
    ]);
    expect(state.destroyed).toBe(true);

    // The same set in the other order picks the same event.
    const reversed = fakePool(async () => [...tied].reverse());
    expect(
      (await newestOnRelays(owner.pubkey, KIND_PAYTO, { makePool: () => reversed.pool }))?.id,
    ).toBe(lowest?.id);
  });

  it('ignores a newer event with a bad signature, a changed body or another author', async () => {
    const owner = key();
    const other = key();
    const good = signed(owner, KIND_PAYTO, T, 'good');
    const newer = signed(owner, KIND_PAYTO, T + 10, 'newer');
    // Spread keeps nostr-tools' cached "verified" mark: the check must not trust it.
    const badSignature = { ...newer, sig: 'ab'.repeat(64) };
    const changedBody = { ...signed(owner, KIND_PAYTO, T + 20, 'x'), content: 'changed' };
    const forgedAuthor = { ...signed(other, KIND_PAYTO, T + 30), pubkey: owner.pubkey };
    const otherAuthor = signed(other, KIND_PAYTO, T + 40);
    const otherKind = signed(owner, 0, T + 50);
    const { pool } = fakePool(async () => [
      badSignature,
      changedBody,
      forgedAuthor,
      otherAuthor,
      otherKind,
      good,
    ]);
    expect((await newestOnRelays(owner.pubkey, KIND_PAYTO, { makePool: () => pool }))?.id).toBe(
      good.id,
    );
  });

  it('reads a store authorization at the store address only', async () => {
    const owner = key();
    const store = key();
    const ours = signed(owner, KIND_STORE_AUTH, T, '', [['d', store.pubkey]]);
    const anotherStore = signed(owner, KIND_STORE_AUTH, T + 10, '', [['d', key().pubkey]]);
    const { pool, asked } = fakePool(async () => [anotherStore, ours]);
    const found = await newestOnRelays(owner.pubkey, KIND_STORE_AUTH, {
      d: store.pubkey,
      makePool: () => pool,
      relays: ['wss://one.example.com'],
    });
    expect(found?.id).toBe(ours.id);
    expect(asked[0]).toEqual({
      relays: ['wss://one.example.com'],
      filter: { kinds: [KIND_STORE_AUTH], authors: [owner.pubkey], '#d': [store.pubkey] },
    });
    await expect(
      newestOnRelays(owner.pubkey, KIND_STORE_AUTH, { makePool: () => pool }),
    ).rejects.toThrow(/`d` is required/);
  });

  it('answers none when nothing is served, the read fails or runs past the timeout', async () => {
    const owner = key();
    const empty = fakePool(async () => []);
    expect(await newestOnRelays(owner.pubkey, KIND_PAYTO, { makePool: () => empty.pool })).toBe(
      undefined,
    );

    const failing = fakePool(() => Promise.reject(new Error('relay down')));
    expect(
      await newestOnRelays(owner.pubkey, KIND_PAYTO, { makePool: () => failing.pool }),
    ).toBeUndefined();
    expect(failing.state.destroyed).toBe(true);

    const hanging = fakePool(() => new Promise<NostrEvent[]>(() => undefined));
    const started = Date.now();
    expect(
      await newestOnRelays(owner.pubkey, KIND_PAYTO, {
        makePool: () => hanging.pool,
        timeoutMs: 50,
      }),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(hanging.state.destroyed).toBe(true);
  });
});
