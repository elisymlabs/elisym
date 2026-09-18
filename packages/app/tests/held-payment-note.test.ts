import { classifyJobError } from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import { heldPaymentNote } from '../app/lib/heldPaymentNote';

/**
 * The one screen that tells a customer whose money has already left their wallet
 * what is happening to it. Both directions are money-sensitive: staying silent
 * where the job IS still open invites a second payment for the same job, and
 * reassuring where the job is already closed keeps someone waiting a day instead
 * of contacting the provider while the transaction is still fresh.
 */
describe('what a paying customer is told about their money', () => {
  // Verbatim from `@elisym/cli`, which the app does not depend on - these reach
  // the browser as plain feedback strings over Nostr. The list of terminal
  // verdicts below is a SAMPLE, not an inventory: what the code relies on is
  // that no terminal message starts with the pending-payment prefix, and the CLI
  // pins that prefix on its own side.
  //
  // The subtlety these fixtures exist to catch: a provider publishing TWO error
  // feedbacks delivers only the first, because a targeted customer's
  // subscription closes on it. So the string under test has to be the one the
  // customer's `onError` actually receives, not merely one the provider built.
  const PAYMENT_TIMEOUT = 'Payment timeout: no payment received before the deadline.';
  const TERMINAL_VERDICTS = [
    'Job permanently failed: no payment for this job was found on-chain after the payment request expired.',
    'Job permanently failed: agent did not recover within 24 hours',
    'Job permanently failed: the provider could not verify payment for this job. If you paid, contact the provider with your transaction signature.',
    'Job permanently failed: this provider no longer offers a skill for this job. If you paid, contact the provider with your transaction signature.',
    'Job permanently failed: the input file for this job could not be retrieved after an agent restart - contact the provider to resolve.',
  ];

  it('says the payment is still being looked for while the job is still open', () => {
    const note = heldPaymentNote(PAYMENT_TIMEOUT, true);
    expect(note).toBeDefined();
    expect(note).toMatch(/do not send it again/);
  });

  it('matches the pending-payment message as a PREFIX, not anywhere in the text', () => {
    // A provider's message that merely mentions a payment timeout - quoting an
    // upstream error, say - is not this provider saying "I am still looking".
    // Loosened to a substring match, the note would start appearing on failures
    // that are already terminal, which is the bug above wearing a new hat.
    expect(heldPaymentNote(`Job permanently failed: ${PAYMENT_TIMEOUT}`, true)).toBeUndefined();
    expect(heldPaymentNote(`upstream said: ${PAYMENT_TIMEOUT}`, true)).toBeUndefined();
  });

  it('says NOTHING about the money once the provider has closed the job', () => {
    // The regression this pins: `classifyJobError` has two buckets, so every
    // terminal verdict lands in the same one as a live payment timeout. Keying
    // the reassurance off "not an outage" promised a customer whose job was
    // already failed that it was still being re-checked for 24 hours.
    for (const verdict of TERMINAL_VERDICTS) {
      expect(heldPaymentNote(verdict, true)).toBeUndefined();
    }
  });

  it('marks a refusal as its own kind, so the thread can withhold Retry', () => {
    // The Retry button buys the job again. A refusal is deterministic and, on a
    // flat-priced skill, already charged, so retrying spends money for the same
    // sentence - `BuyContext` keys the entry's `refused` flag off this.
    expect(classifyJobError('The provider refused: say the size in USD.')).toBe('provider-refused');
    expect(classifyJobError('Internal processing error')).not.toBe('provider-refused');
  });

  it('says the job is closed and charged when the provider refused it', () => {
    // A refusal is terminal AND already charged on the flat-priced path, so the
    // outage note would be false twice over - and these reasons are the ones
    // most likely to trip the outage markers by accident, being ordinary
    // English rather than an API's words.
    for (const reason of [
      'insufficient detail in the brief - add the target audience.',
      'your billing address is missing a postal code.',
      'that file is unauthorized for this capability.',
    ]) {
      const note = heldPaymentNote(`The provider refused: ${reason}`, true);
      expect(note).toMatch(/will not be retried/);
      expect(note).not.toMatch(/back online/);
      // The label is not authenticated, so the note reports what the agent
      // SAYS and points at the wallet rather than asserting where the money is.
      expect(note).toMatch(/says it declined/);
    }
  });

  it('reassures through an agent outage - the one failure that really is held', () => {
    // The health gate refuses the job BEFORE running it and keeps it paid for
    // the recovery loop, so "the job will be retried automatically" is true of
    // this message and of no other.
    expect(heldPaymentNote('Agent temporarily unavailable', true)).toMatch(/back online/);
  });

  it('does not promise a retry for the mask on a job that is already closed', () => {
    // `Internal processing error` is what the runtime says when it will not
    // describe a terminal failure. The job is failed and nothing will re-run it;
    // promising otherwise is what keeps someone waiting instead of contacting
    // the provider while the transaction is fresh.
    expect(heldPaymentNote('Internal processing error', true)).toBeUndefined();
  });

  it('never talks about held money to someone who has not paid', () => {
    expect(heldPaymentNote(PAYMENT_TIMEOUT, false)).toBeUndefined();
    expect(heldPaymentNote('Internal processing error', false)).toBeUndefined();
    expect(heldPaymentNote('Input too long', false)).toBeUndefined();
  });
});
