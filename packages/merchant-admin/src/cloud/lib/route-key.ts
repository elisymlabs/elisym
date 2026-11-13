/**
 * Routing one pasted key (plan `admin-unified.md` 2.3), with what it holds:
 * the same secret as an owner key asks cloud-api, the relays are read in
 * parallel, and every way out leaves exactly one live copy, for the part it
 * opens, or none.
 */
import type { StoreKey } from '../../lib/core';
import { cloudDecides, keyRoute, ownerAnswerOf } from '../../lib/key-route';
import { OwnerKey } from './owner-key';

/** Where the key went, with the copy that part takes. */
export type Routed =
  | { where: 'self-hosted'; key: StoreKey }
  | { where: 'cloud' | 'cloud-none'; owner: OwnerKey }
  | { where: 'unreachable' };

export interface RouteDeps {
  /** cloud-api's answer to `GET /owner`, signed by `owner` (bounded in time by the caller); a throw is none. */
  askOwner: (owner: OwnerKey) => Promise<{ status: number; body: unknown }>;
  /** Whether the relays show the store of `pubkey`; a failure counts as no. */
  relaysShowAStore: (pubkey: string) => Promise<boolean>;
}

/** Routes `key`; the relays are not waited for where the cloud's answer decides alone. */
export async function routeKey(key: StoreKey, deps: RouteDeps): Promise<Routed> {
  const owner = new OwnerKey(key.secretKey);
  const onRelays = Promise.resolve()
    .then(() => deps.relaysShowAStore(key.pubkey))
    .catch(() => false);
  // A request that throws is no answer: the relays decide.
  const asked = await Promise.resolve()
    .then(() => deps.askOwner(owner))
    .catch(() => ({ status: 0, body: {} }));
  const answer = ownerAnswerOf(asked);
  const found = cloudDecides(answer) ? false : await onRelays;
  const where = keyRoute(answer, found);
  if (where === 'self-hosted') {
    owner.close();
    return { where, key };
  }
  key.secretKey.fill(0);
  if (where === 'unreachable') {
    owner.close();
    return { where };
  }
  return { where, owner };
}

/** Zeroes what a route holds: one no part will take. */
export function dropRouted(routed: Routed): void {
  if (routed.where === 'self-hosted') {
    routed.key.secretKey.fill(0);
  } else if (routed.where !== 'unreachable') {
    routed.owner.close();
  }
}
