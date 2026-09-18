import { PROVIDER_REFUSED_PREFIX, SCRIPT_REFUSAL_MAX_CHARS } from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import {
  boundedErrorText,
  customerErrorText,
  MAX_DISPLAYED_ERROR_CHARS,
  UNSTATED_FAILURE,
} from '../app/lib/errorText';

/**
 * Every buy-flow error a customer sees goes through one function, because some
 * of them are written by a stranger: a provider's `error` feedback arrives over
 * Nostr and is rendered verbatim in a toast and an inline note. Anything that
 * classifies such a string and then prints the raw one is the same bug as not
 * classifying it at all.
 */
describe('what an error is allowed to put on screen', () => {
  it('keeps an ordinary message as it is', () => {
    expect(customerErrorText('Timed out waiting for the provider')).toBe(
      'Timed out waiting for the provider',
    );
  });

  it('gives an unavailable agent the fixed sentence, whatever it said', () => {
    expect(customerErrorText('Agent temporarily unavailable')).toBe(
      'Agent unavailable. Try again later.',
    );
  });

  it('attributes a refusal and drops the runtime label the app matched on', () => {
    const shown = customerErrorText(`${PROVIDER_REFUSED_PREFIX}size this in USD, not SOL.`);
    expect(shown).toBe('The agent refused: size this in USD, not SOL.');
  });

  it('flattens a provider error into one line', () => {
    // A newline in a toast is a second line the provider gets to write; an
    // escape sequence is a colour the operator did not choose.
    const escape = String.fromCharCode(27);
    const shown = customerErrorText(`upstream said no\n${escape}[31mrun this command`);
    expect(shown).toBe('upstream said no [31mrun this command');
  });

  it('bounds a provider error that arrives without one', () => {
    const shown = customerErrorText('x'.repeat(40_000));
    expect([...shown].length).toBeLessThanOrEqual(MAX_DISPLAYED_ERROR_CHARS);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('bounds a refusal to the same budget the thread stores', () => {
    const shown = customerErrorText(`${PROVIDER_REFUSED_PREFIX}${'y'.repeat(40_000)}`);
    expect([...shown].length).toBeLessThanOrEqual(
      'The agent refused: '.length + SCRIPT_REFUSAL_MAX_CHARS,
    );
  });

  it('bounds the app`s own errors without reading them as verdicts', () => {
    // A wallet saying "insufficient SOL" is not the agent being unavailable,
    // so this path never classifies - but a wall of RPC JSON is still bounded.
    expect(boundedErrorText('Insufficient SOL for this transaction')).toBe(
      'Insufficient SOL for this transaction',
    );
    expect([...boundedErrorText('{'.repeat(40_000))].length).toBeLessThanOrEqual(
      MAX_DISPLAYED_ERROR_CHARS,
    );
  });

  it('says something when the message says nothing a reader could see', () => {
    // Zero-width joiners survive flattening on purpose (they spell words in
    // Persian), so a "message" made only of them is a non-empty string nobody
    // can read - and an empty red note explains nothing.
    expect(customerErrorText(String.fromCodePoint(0x200d).repeat(20))).toBe(UNSTATED_FAILURE);
  });
});
