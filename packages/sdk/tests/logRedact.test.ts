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
});
