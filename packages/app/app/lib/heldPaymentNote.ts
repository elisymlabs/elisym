import { classifyJobError, PROVIDER_FAILED_MESSAGE, type JobErrorKind } from '@elisym/sdk';

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

const CRASHED_NOTE =
  "The job failed on the agent's side and is closed. A flat-priced job is charged before it runs, so if you paid, check the job in your wallet history and contact the provider rather than sending it again.";

const REFUSED_NOTE =
  'The agent says it declined this job, so it is closed and will not be retried. A flat-priced job is charged before it runs, so if you paid, check the job in your wallet history rather than sending it again.';

const STILL_SOUGHT_NOTE =
  'If your payment did go through, it is not lost: the agent keeps re-checking the chain and delivers the result if it finds it, so do not send it again. If it never finds it, the job is closed within 24 hours.';

/**
 * The same money answer for a refusal the THREAD holds, with no buy session
 * behind it.
 *
 * A refusal survives a reload and can be discovered by the reconcile on a later
 * tab open; `heldPaymentNote` reaches only the ephemeral error of the session
 * that produced it, so without this a customer who paid and came back is shown
 * the reason and never told the job is closed and already charged.
 */
export function refusedPaymentNote(paid: boolean): string | undefined {
  return paid ? REFUSED_NOTE : undefined;
}

const CLIENT_FAILED_NOTE =
  'Your payment was sent. This step failed in your browser, not at the agent, so the job may still be running - check job history before buying it again.';

/**
 * What to say when the payment landed and THIS SIDE then failed.
 *
 * None of the notes above can be true here: they read a provider's verdict, and
 * there is no verdict - a wallet, an RPC or a local step threw after the money
 * moved. Saying nothing is the one answer that is certainly wrong, because the
 * customer is looking at a failure with their payment already gone.
 */
export function clientFailureNote(paid: boolean): string | undefined {
  return paid ? CLIENT_FAILED_NOTE : undefined;
}

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
export function heldPaymentNote(
  error: string,
  paid: boolean,
  known?: JobErrorKind,
): string | undefined {
  if (!paid) {
    return undefined;
  }
  // `known` is the caller's already-computed classification of this same string
  // - see `customerErrorText`, which renders beside this note.
  const kind = known ?? classifyJobError(error);
  if (kind === 'agent-unavailable') {
    return OUTAGE_NOTE;
  }
  // A refusal is terminal AND already charged on the flat-priced path. Saying
  // nothing would leave someone waiting for a retry that is not coming; the
  // outage note would promise them exactly that retry. Through the same
  // function the thread bubble calls, so the two surfaces cannot drift into
  // telling one customer two things about one job.
  if (kind === 'provider-refused') {
    return refusedPaymentNote(paid);
  }
  if (error.startsWith(PAYMENT_STILL_SOUGHT_PREFIX)) {
    return STILL_SOUGHT_NOTE;
  }
  // The provider's skill fell over. Terminal like a refusal, and charged like
  // one, but not a decision - so it gets its own sentence rather than the
  // refusal's "the agent says it declined this job".
  if (error === PROVIDER_FAILED_MESSAGE) {
    return CRASHED_NOTE;
  }
  return undefined;
}
