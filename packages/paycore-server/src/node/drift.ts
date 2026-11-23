/**
 * Drift (R1, parent section 4): what the relays serve for a hosted store that
 * the server never made. A store profile (kind 0, signed by S) naming an owner
 * other than O means S was used elsewhere; a payout list (kind 10133) by O the
 * server never committed means O also runs another store or node. Either
 * raises an alert and marks the store `degraded`; intake keeps running.
 */
import { KIND_PAYTO, parseStoreProfile } from '@elisym/commerce';
import { type RelayView, newest } from '@merchant-node/checks';
import type { CommittedOwnerEvent } from './load';

/** Every drift the relay views show, one line each; empty when none. */
export function driftProblems(
  views: readonly RelayView[],
  ownerPubkey: string,
  committed: readonly Pick<CommittedOwnerEvent, 'id' | 'kind'>[],
): string[] {
  const problems: string[] = [];
  const profiles = views.flatMap((view) => (view.profile === undefined ? [] : [view.profile]));
  const named = new Set(
    profiles
      .map((profile) => parseStoreProfile(profile)?.ownerPubkey)
      .filter((owner): owner is string => owner !== undefined && owner !== ownerPubkey),
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
