import type { NostrEvent } from 'nostr-tools';
import type { MerchantOrder } from './ledger';
import { type AuthSigner, type PublishPool, publishToRelays } from './publish';
import { type Delivery, buildDeliveryReply, creditedAsset } from './reply';
import type { DeliveryAttempt } from './runtime';

export interface DeliverDeps {
  pool: PublishPool;
  /** The store's inbox relays: by convention it replies there, as the buyer key has none. */
  inboxRelays: readonly string[];
  delivery: Delivery;
  storeSecretKey: Uint8Array;
  auth: AuthSigner;
  log: (message: string) => void;
  now: () => number;
}

/**
 * Publish the delivery of a paid order to the inbox relays not in `skip`: the
 * ones that took it, and the store's own copy of the reply for the runtime to
 * queue (it is never published here, on the buyer path).
 */
export async function deliverOrder(
  deps: DeliverDeps,
  order: MerchantOrder,
  skip: readonly string[],
): Promise<DeliveryAttempt> {
  if (order.paid !== undefined && creditedAsset(order.paid.caip19) === undefined) {
    deps.log(
      `delivery for ${order.key}: asset ${order.paid.caip19} is not in the registry, sent without it`,
    );
  }
  const reply = buildDeliveryReply(order, deps.delivery, deps.storeSecretKey, deps.now());
  const taken = await publishToRelays(
    deps.pool,
    deps.inboxRelays.filter((relay) => !skip.includes(relay)),
    reply.recipientWrap,
    deps.auth,
    deps.log,
  );
  return { taken, selfWrap: reply.selfWrap };
}

/**
 * How the store's copies are published: to every inbox relay, whichever took the
 * buyer's copy (the attempt that makes an order delivered may have reached none).
 */
export function publishSelfCopy(
  deps: Pick<DeliverDeps, 'pool' | 'inboxRelays' | 'auth' | 'log'>,
): (wrap: NostrEvent) => Promise<string[]> {
  return (wrap) => publishToRelays(deps.pool, deps.inboxRelays, wrap, deps.auth, deps.log);
}
