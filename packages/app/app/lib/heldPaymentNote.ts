import { classifyJobError } from '@elisym/sdk';

/**
 * The provider's word for "no payment reached me inside the live window". It is
 * the one failure that leaves the job OPEN and still being looked for, so it is
 * the only one the pending note below is true of.
 *
 * A cross-package contract the app cannot import: `@elisym/cli` is not a
 * dependency here, and these arrive as plain feedback strings over Nostr. It is
 * not loose coupling, though - the same prefix is on the CLI's customer-safe
 * allowlist, so a message that stopped starting with it would be masked to a
 * generic string on that side and its own tests would fail. The CLI pins the
 * prefix explicitly for this reader.
 *
 * Matched as a PREFIX, never a substring: a provider quoting a payment timeout
 * inside some other, terminal failure is not this provider saying it is still
 * looking.
 */
const PAYMENT_STILL_SOUGHT_PREFIX = 'Payment timeout';

const OUTAGE_NOTE =
  'Your payment is held. Once the agent is back online, the job will be retried automatically and the result delivered.';

const STILL_SOUGHT_NOTE =
  'If your payment did go through, it is not lost: the agent keeps re-checking the chain and delivers the result if it finds it, so do not send it again. If it never finds it, the job is closed within 24 hours.';

/**
 * What to tell a customer who has already sent a payment about the money, given
 * the failure they just hit - or `undefined` when there is nothing TRUE to say.
 *
 * The undefined case is the point. `classifyJobError` has only two buckets, so
 * every failure that is not an outage lands in the same one: a provider's
 * terminal verdicts ("no payment for this job was found on-chain", "the agent
 * did not recover within 24 hours") sit there beside a live payment timeout.
 * Promising that a job the provider has already closed is still being re-checked
 * for a day is worse than saying nothing - it is the message that keeps someone
 * waiting instead of contacting the provider while the transaction is fresh.
 */
export function heldPaymentNote(error: string, paid: boolean): string | undefined {
  if (!paid) {
    return undefined;
  }
  if (classifyJobError(error) === 'agent-unavailable') {
    return OUTAGE_NOTE;
  }
  if (error.startsWith(PAYMENT_STILL_SOUGHT_PREFIX)) {
    return STILL_SOUGHT_NOTE;
  }
  return undefined;
}
