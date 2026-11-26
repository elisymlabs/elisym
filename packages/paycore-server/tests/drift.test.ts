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
});
