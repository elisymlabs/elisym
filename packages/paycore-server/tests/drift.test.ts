import { buildStoreProfileEvent } from '@elisym/commerce';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { driftProblems } from '../src/node/drift';
import { NOW, SOLANA_PAYOUTS, key, ownerEvents } from './helpers/node-store';

describe('driftProblems (R1)', () => {
  const owner = key();
  const store = key();
  const committed = ownerEvents(owner, store, SOLANA_PAYOUTS, NOW - 60);
  const profileNaming = (named: string) =>
    finalizeEvent(
      buildStoreProfileEvent({ name: 'Shop', ownerPubkey: named, createdAt: NOW }),
      store.secretKey,
    );

  it('finds nothing when the profile names O and the newest payout list is committed', () => {
    const views = [
      {
        listings: [],
        payoutList: committed.payoutList,
        inboxList: undefined,
        profile: profileNaming(owner.pubkey),
      },
    ];
    expect(
      driftProblems(views, owner.pubkey, [{ id: committed.payoutList.id, kind: 10133 }]),
    ).toEqual([]);
    expect(driftProblems([], owner.pubkey, [])).toEqual([]);
  });

  it('names a profile pointing at another owner, and a payout list the server never committed', () => {
    const other = key();
    const views = [
      {
        listings: [],
        payoutList: committed.payoutList,
        inboxList: undefined,
        profile: profileNaming(other.pubkey),
      },
    ];
    const problems = driftProblems(views, owner.pubkey, []);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(other.pubkey);
    expect(problems[1]).toContain(committed.payoutList.id);
  });
  it('ignores a profile naming a former owner until its move switched, then while dated at or before the switch', () => {
    const former = key();
    const unrelated = key();
    const profileAt = (named: string, createdAt: number) =>
      finalizeEvent(
        buildStoreProfileEvent({ name: 'Shop', ownerPubkey: named, createdAt }),
        store.secretKey,
      );
    const viewsOf = (...profiles: ReturnType<typeof profileAt>[]) =>
      profiles.map((profile) => ({
        listings: [],
        payoutList: committed.payoutList,
        inboxList: undefined,
        profile,
      }));
    const commits = [{ id: committed.payoutList.id, kind: 10133 }];
    const switching = [{ owner: former.pubkey, switchedAt: undefined }];
    const switched = [{ owner: former.pubkey, switchedAt: NOW }];
    // Switching: a profile naming the former owner is the server's, however new.
    expect(
      driftProblems(viewsOf(profileAt(former.pubkey, NOW + 100)), owner.pubkey, commits, switching),
    ).toEqual([]);
    // Switched: up to and including the switch's own second, then drift.
    for (const createdAt of [NOW - 1, NOW]) {
      expect(
        driftProblems(
          viewsOf(profileAt(former.pubkey, createdAt)),
          owner.pubkey,
          commits,
          switched,
        ),
      ).toEqual([]);
    }
    const after = driftProblems(
      viewsOf(profileAt(former.pubkey, NOW + 1)),
      owner.pubkey,
      commits,
      switched,
    );
    expect(after).toHaveLength(1);
    expect(after[0]).toContain(former.pubkey);
    // An owner that was never this store's is drift whatever the moves.
    const other = driftProblems(
      viewsOf(profileAt(unrelated.pubkey, NOW - 10), profileAt(former.pubkey, NOW - 10)),
      owner.pubkey,
      commits,
      switching,
    );
    expect(other).toHaveLength(1);
    expect(other[0]).toContain(unrelated.pubkey);
  });
});
