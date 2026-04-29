import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACT_PATHS,
  INPUT_REDACT_PATHS,
  SECRET_REDACT_PATHS,
  makeCensor,
} from '../src/primitives/logRedact';

describe('log redact constants', () => {
  it('SECRET_REDACT_PATHS matches the expected snapshot', () => {
    expect(SECRET_REDACT_PATHS).toEqual([
      '*.ELISYM_NOSTR_PRIVATE_KEY',
      '*.ELISYM_SOLANA_PRIVATE_KEY',
      '*.nostrPrivateKeyHex',
      '*.solanaPrivateKeyBase58',
      '*.secretKey',
      '*.secret',
      'ELISYM_NOSTR_PRIVATE_KEY',
      'ELISYM_SOLANA_PRIVATE_KEY',
      'anthropic_api_key',
      'openai_api_key',
      'nostr_secret_key',
      'solana_secret_key',
      '*.anthropic_api_key',
      '*.openai_api_key',
      '*.nostr_secret_key',
      '*.solana_secret_key',
      'secrets',
      '*.secrets',
    ]);
  });

  it('INPUT_REDACT_PATHS matches the expected snapshot', () => {
    expect(INPUT_REDACT_PATHS).toEqual([
      'content',
      'input',
      'prompt',
      '*.content',
      '*.input',
      '*.prompt',
      'event.content',
      '*.event.content',
      'rawEventJson',
      'resultContent',
      '*.rawEventJson',
      '*.resultContent',
    ]);
  });

  it('DEFAULT_REDACT_PATHS concatenates secrets before input paths', () => {
    expect(DEFAULT_REDACT_PATHS).toEqual([...SECRET_REDACT_PATHS, ...INPUT_REDACT_PATHS]);
  });
});

describe('makeCensor', () => {
  it('returns [INPUT REDACTED] for content / input / prompt', () => {
    const censor = makeCensor();
    expect(censor('anything', ['content'])).toBe('[INPUT REDACTED]');
    expect(censor('anything', ['input'])).toBe('[INPUT REDACTED]');
    expect(censor('anything', ['prompt'])).toBe('[INPUT REDACTED]');
    expect(censor('anything', ['event', 'content'])).toBe('[INPUT REDACTED]');
  });

  it('returns [REDACTED] for secret paths', () => {
    const censor = makeCensor();
    expect(censor('leak', ['ELISYM_NOSTR_PRIVATE_KEY'])).toBe('[REDACTED]');
    expect(censor('leak', ['env', 'ELISYM_SOLANA_PRIVATE_KEY'])).toBe('[REDACTED]');
    expect(censor('leak', ['secret'])).toBe('[REDACTED]');
    expect(censor('leak', ['secretKey'])).toBe('[REDACTED]');
    expect(censor('leak', ['nostrPrivateKeyHex'])).toBe('[REDACTED]');
  });

  it('falls back to [REDACTED] when path is empty', () => {
    const censor = makeCensor();
    expect(censor('anything', [])).toBe('[REDACTED]');
  });

  it('returns [REDACTED] for on-disk secret field names', () => {
    const censor = makeCensor();
    expect(censor('leak', ['anthropic_api_key'])).toBe('[REDACTED]');
    expect(censor('leak', ['openai_api_key'])).toBe('[REDACTED]');
    expect(censor('leak', ['nostr_secret_key'])).toBe('[REDACTED]');
    expect(censor('leak', ['solana_secret_key'])).toBe('[REDACTED]');
    expect(censor('{leak-object}', ['secrets'])).toBe('[REDACTED]');
  });

  it('returns [INPUT REDACTED] for ledger entry user-input fields', () => {
    const censor = makeCensor();
    expect(censor('raw json', ['rawEventJson'])).toBe('[INPUT REDACTED]');
    expect(censor('llm output', ['resultContent'])).toBe('[INPUT REDACTED]');
    expect(censor('nested', ['entry', 'rawEventJson'])).toBe('[INPUT REDACTED]');
    expect(censor('nested', ['entry', 'resultContent'])).toBe('[INPUT REDACTED]');
  });
});
