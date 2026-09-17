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

const REFUSED_NOTE =
  'The agent says it declined this job, so it is closed and will not be retried. A flat-priced job is charged before it runs, so if you paid, check the job in your wallet history rather than sending it again.';

const STILL_SOUGHT_NOTE =
  'If your payment did go through, it is not lost: the agent keeps re-checking the chain and delivers the result if it finds it, so do not send it again. If it never finds it, the job is closed within 24 hours.';

/**
 * What to tell a customer who has already sent a payment about the money, given
 * the failure they just hit - or `undefined` when there is nothing TRUE to say.
 *
 * The undefined case is the point. `classifyJobError` sorts a failure into an
 * outage, a provider's refusal, or everything else - and that last bucket holds
 * a provider's terminal verdicts ("no payment for this job was found on-chain",
 * "the agent did not recover within 24 hours") beside a live payment timeout.
 * Promising that a job the provider has already closed is still being re-checked
 * for a day is worse than saying nothing - it is the message that keeps someone
 * waiting instead of contacting the provider while the transaction is fresh.
 */
export function heldPaymentNote(error: string, paid: boolean): string | undefined {
  if (!paid) {
    return undefined;
  }
  const kind = classifyJobError(error);
  if (kind === 'agent-unavailable') {
    return OUTAGE_NOTE;
  }
  // A refusal is terminal AND already charged on the flat-priced path. Saying
  // nothing would leave someone waiting for a retry that is not coming; the
  // outage note would promise them exactly that retry.
  if (kind === 'provider-refused') {
    return REFUSED_NOTE;
  }
  if (error.startsWith(PAYMENT_STILL_SOUGHT_PREFIX)) {
    return STILL_SOUGHT_NOTE;
  }
  return undefined;
}
