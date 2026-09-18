import { describe, expect, it } from 'vitest';
import {
  classifyJobError,
  PROVIDER_FAILED_MESSAGE,
  PROVIDER_REFUSED_PREFIX,
} from '../src/services/jobErrors';

describe('classifyJobError', () => {
  it('reads a provider refusal as its own kind, whatever words it uses', () => {
    // These are ordinary English in a refusal and outage markers as substrings.
    for (const reason of [
      'insufficient detail in the brief - add the target audience.',
      'your billing address is missing a postal code.',
      'that file is unauthorized for this capability.',
    ]) {
      expect(classifyJobError(`${PROVIDER_REFUSED_PREFIX}${reason}`)).toBe('provider-refused');
    }
  });

  it('matches the label as a prefix, never as a substring', () => {
    expect(classifyJobError(`some wrapper said "${PROVIDER_REFUSED_PREFIX}nope"`)).not.toBe(
      'provider-refused',
    );
  });

  it('classifies the canonical runtime message', () => {
    expect(classifyJobError('Agent temporarily unavailable')).toBe('agent-unavailable');
  });

  it('does NOT read the sanitization mask as an outage', () => {
    // It is the runtime's mask for a terminal failure it will not describe, so
    // the job is closed and nothing retries it. Calling it an outage had the app
    // tell a paying customer their money was held and the result would arrive.
    expect(classifyJobError('Internal processing error')).toBe('unknown');
  });

  it('does not read the terminal sentence as an outage', () => {
    // The distinction that matters: the gate's message keeps the job paid for
    // the recovery loop, so "held, it will be retried" is true of it. This one
    // is what the runtime says when a job is CLOSED, and promising a retry for
    // it keeps someone waiting instead of contacting the provider.
    expect(classifyJobError(PROVIDER_FAILED_MESSAGE)).not.toBe('agent-unavailable');
  });

  it('classifies raw Anthropic auth errors that leak through script skills', () => {
    expect(
      classifyJobError('script failed (exit 1): Anthropic count_tokens error: invalid x-api-key'),
    ).toBe('agent-unavailable');
  });

  it('classifies billing-language signals', () => {
    expect(classifyJobError('credit balance is too low')).toBe('agent-unavailable');
    expect(classifyJobError('insufficient_quota')).toBe('agent-unavailable');
    expect(classifyJobError('billing not active')).toBe('agent-unavailable');
  });

  it('classifies auth-language signals', () => {
    expect(classifyJobError('Unauthorized')).toBe('agent-unavailable');
    expect(classifyJobError('authentication_error: invalid_api_key')).toBe('agent-unavailable');
  });

  it('matches case-insensitively', () => {
    expect(classifyJobError('AGENT TEMPORARILY UNAVAILABLE')).toBe('agent-unavailable');
    expect(classifyJobError('Invalid X-Api-Key')).toBe('agent-unavailable');
  });

  it('leaves transport / payment / validation errors as unknown', () => {
    expect(classifyJobError('Timed out waiting for response (120s).')).toBe('unknown');
    expect(classifyJobError('Provider returned an error')).toBe('unknown');
    // The real provider-side wording. `unknown` is the right answer - the job is
    // still open and being re-checked, which is not an agent outage; the web app
    // keys its "your payment is held" note off the message itself.
    expect(classifyJobError('Payment timeout: no payment received before the deadline.')).toBe(
      'unknown',
    );
    expect(classifyJobError('Rate limited, try again later')).toBe('unknown');
    expect(classifyJobError('Server overloaded, try again later')).toBe('unknown');
    expect(classifyJobError('Wallet disconnected - reconnect and retry')).toBe('unknown');
  });
});
