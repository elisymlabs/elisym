/**
 * Error taxonomy for the x402 bridge. The runtime keys its keep-paid /
 * mark-failed decision on these classes, so the split IS the money logic:
 *
 * - `X402PreflightError`: raised BEFORE the customer pays (wallet invariant,
 *   quote/balance/margin/input checks). The job is refused with an error
 *   feedback and never enters the ledger.
 * - `X402TransientError`: upstream hiccup after the customer paid (network
 *   error, timeout, 5xx, 429). The runtime keeps the job `paid` so the
 *   recovery loop retries it (idempotency cache + paid-attempt budget bound
 *   the money).
 * - `X402PermanentError`: no retry will help (upstream 4xx, payment-policy
 *   rejection after a reprice, invalid/oversized response, exhausted paid
 *   attempt budget). The job fails; the documented operator risk applies.
 */

export class X402PreflightError extends Error {
  /**
   * Optional customer-facing text. Preflight reasons split in two: input
   * problems the CUSTOMER can act on (too large for a GET upstream) vs
   * operator problems (empty float, negative margin) that must stay generic
   * to avoid leaking billing state.
   */
  readonly customerMessage?: string;

  constructor(message: string, customerMessage?: string) {
    super(message);
    this.name = 'X402PreflightError';
    this.customerMessage = customerMessage;
  }
}

export class X402TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402TransientError';
  }
}

export class X402PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402PermanentError';
  }
}
