import { describe, expect, it } from 'vitest';
import { classifyJobError } from '../src/services/jobErrors';

describe('classifyJobError', () => {
  it('classifies the canonical runtime message', () => {
    expect(classifyJobError('Agent temporarily unavailable')).toBe('agent-unavailable');
  });

  it('classifies the API-leaks sanitization mask', () => {
    expect(classifyJobError('Internal processing error')).toBe('agent-unavailable');
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
    expect(classifyJobError('payment timeout')).toBe('unknown');
    expect(classifyJobError('Rate limited, try again later')).toBe('unknown');
    expect(classifyJobError('Server overloaded, try again later')).toBe('unknown');
    expect(classifyJobError('Wallet disconnected - reconnect and retry')).toBe('unknown');
  });
});
