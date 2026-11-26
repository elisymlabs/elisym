/**
 * Drift (R1, parent section 4): what the relays serve for a hosted store that
 * the server never made. A store profile (kind 0, signed by S) naming an owner
 * other than O means S was used elsewhere; a payout list (kind 10133) by O the
 * server never committed means O also runs another store or node. Either
 * raises an alert and marks the store `degraded`; intake keeps running. A
 * store that moved to a new owner key served profiles naming its former
 * owners: one naming a former owner is drift only once that move switched,
 * and only when dated after the switch (the first profile naming the next owner).
 */
import { KIND_PAYTO, parseStoreProfile } from '@elisym/commerce';
import { type RelayView, newest } from '@merchant-node/checks';
import type { FormerOwner } from '../state/move-rows';
import type { CommittedOwnerEvent } from './load';

/** Whether a profile naming `owner`, dated `createdAt`, is one the server made before a move switched. */
function formerProfile(
  formerOwners: readonly FormerOwner[],
  owner: string,
  createdAt: number,
): boolean {
  const former = formerOwners.find((entry) => entry.owner === owner);
  return (
    former !== undefined && (former.switchedAt === undefined || createdAt <= former.switchedAt)
  );
}

/** Every drift the relay views show, one line each; empty when none. */
export function driftProblems(
  views: readonly RelayView[],
  ownerPubkey: string,
  committed: readonly Pick<CommittedOwnerEvent, 'id' | 'kind'>[],
  formerOwners: readonly FormerOwner[] = [],
): string[] {
  const problems: string[] = [];
  const profiles = views.flatMap((view) => (view.profile === undefined ? [] : [view.profile]));
  const named = new Set(
    profiles.flatMap((profile) => {
      const owner = parseStoreProfile(profile)?.ownerPubkey;
      return owner === undefined ||
        owner === ownerPubkey ||
        formerProfile(formerOwners, owner, profile.created_at)
        ? []
        : [owner];
    }),
  );
  for (const owner of named) {
    problems.push(`a store profile signed by the store key names another owner: ${owner}`);
  }
  const served = newest(
    views.flatMap((view) => (view.payoutList === undefined ? [] : [view.payoutList])),
  );
  const lists = new Set(
    committed.filter((event) => event.kind === KIND_PAYTO).map((event) => event.id),
  );
  if (served !== undefined && served.pubkey === ownerPubkey && !lists.has(served.id)) {
    problems.push(
      `the relays serve a payout list by the owner that this server never committed: ${served.id}`,
    );
  }
  return problems;
}
