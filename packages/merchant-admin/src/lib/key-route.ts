/**
 * Where a pasted key leads (plan `admin-unified.md` 2.3): cloud-api's answer
 * to `GET /owner` signed with it, and whether the relays showed a store whose
 * key it is. A self-hosted merchant never depends on our API: when the cloud
 * does not answer, the relays decide.
 */

/** What the sign-in opens. */
export type KeyRoute =
  /** A store in our cloud, or a partner's account (the partner view refuses an operator key). */
  | 'cloud'
  /** A key with no cloud store and no store on the relays: redeem an invite, or start a plan. */
  | 'cloud-none'
  /** A store the merchant runs: the relays showed it. */
  | 'self-hosted'
  /** The cloud did not answer, and the relays showed nothing for this key. */
  | 'unreachable';

/** cloud-api's answer to `GET /owner`, as the client gave it (status 0: no answer). */
export interface OwnerAnswer {
  status: number;
  /** `tenantId` of a 200 answer: a store's id, or null for none. */
  tenantId: string | null | undefined;
}

export function keyRoute(owner: OwnerAnswer, relaysShowAStore: boolean): KeyRoute {
  if (owner.status === 200 && typeof owner.tenantId === 'string') {
    return 'cloud';
  }
  if (owner.status === 200 && owner.tenantId === null) {
    return relaysShowAStore ? 'self-hosted' : 'cloud-none';
  }
  // Refused as an owner: a partner key (or an operator's, which the partner view refuses).
  if (owner.status === 403) {
    return 'cloud';
  }
  // Any other answer, an error or none at all: the relays decide.
  return relaysShowAStore ? 'self-hosted' : 'unreachable';
}

/** Whether a relay read of a store key found its store: a profile name or an inbox list. */
export function relaysShowAStore(view: { name?: string; noInboxList: boolean }): boolean {
  return view.name !== undefined || !view.noInboxList;
}

/** Whether the cloud's answer decides alone: the relays could not change where the key leads. */
export function cloudDecides(owner: OwnerAnswer): boolean {
  return keyRoute(owner, true) === keyRoute(owner, false);
}

/** The route's view of the client's answer: `tenantId` only from a string or a null. */
export function ownerAnswerOf(answer: { status: number; body: unknown }): OwnerAnswer {
  const { body } = answer;
  const tenantId =
    body !== null && typeof body === 'object' && 'tenantId' in body ? body.tenantId : undefined;
  return {
    status: answer.status,
    tenantId: typeof tenantId === 'string' || tenantId === null ? tenantId : undefined,
  };
}
