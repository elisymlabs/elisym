import type { WrappedOrderMessage } from '@elisym/commerce';
import { type AuthSigner, type PublishPool, publishToRelays } from './publish';
import { deliveryDone } from './reply';

export interface HandSent {
  /** Inbox relays that took the buyer's answer. */
  taken: string[];
  /** Inbox relays that took the store's own copy (for the admin). */
  copyTaken: string[];
}

/**
 * Publish a hand answer: the buyer's first and on its own (a relay's rate limit
 * must not refuse it because of the copy), then the store's copy, both to every
 * inbox relay and both awaited, so a process exit right after never cuts them.
 */
export async function publishHandAnswer(
  pool: PublishPool,
  relays: readonly string[],
  wrap: WrappedOrderMessage,
  auth: AuthSigner,
  log: (message: string) => void,
): Promise<HandSent> {
  const taken = await publishToRelays(pool, relays, wrap.recipientWrap, auth, log);
  const copyTaken = await publishToRelays(pool, relays, wrap.selfWrap, auth, log);
  return { taken, copyTaken };
}

/**
 * What the operator is told after a hand answer, and whether it counts as sent.
 * A copy no relay took does not fail the command (the buyer has the answer), but
 * says to run it again: a rerun sends the stored answer again, and the admin counts
 * it once.
 */
export function handOutcome(
  sent: HandSent,
  relayCount: number,
): { lines: string[]; done: boolean } {
  const lines = [`taken by ${sent.taken.length} of ${relayCount}: ${sent.taken.join(', ') || '-'}`];
  if (sent.copyTaken.length === 0) {
    lines.push('the copy for your admin was taken by no relay: run the same command again');
  }
  return { lines, done: deliveryDone(sent.taken.length, relayCount, 0) };
}
