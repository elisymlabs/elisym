/**
 * MCP input-length limits must match the SDK's LIMITS constant.
 *
 * Before this fix, MCP had its own literals (e.g. `MAX_CAPABILITIES = 50`) which were
 * larger than the SDK's (`20`). Inputs in the gap passed the MCP checkLen and then
 * threw a confusing SDK error. This test locks in the re-export so a drift is caught
 * on the next `bun qa`.
 */
import { LIMITS } from '@elisym/sdk';
import { describe, it, expect } from 'vitest';
import {
  MAX_CAPABILITIES,
  MAX_ENCRYPTED_INLINE_BYTES,
  MAX_INPUT_LEN,
  MAX_REINLINE_TEXT_BYTES,
  MAX_TIMEOUT_SECS,
  NIP44_MAX_PLAINTEXT_BYTES,
  checkLen,
} from '../src/utils.js';

describe('MCP limits aligned with @elisym/sdk LIMITS', () => {
  it('MAX_INPUT_LEN matches SDK MAX_INPUT_LENGTH', () => {
    expect(MAX_INPUT_LEN).toBe(LIMITS.MAX_INPUT_LENGTH);
  });

  it('MAX_CAPABILITIES matches SDK MAX_CAPABILITIES', () => {
    expect(MAX_CAPABILITIES).toBe(LIMITS.MAX_CAPABILITIES);
    expect(MAX_CAPABILITIES).toBe(20);
  });

  it('MAX_TIMEOUT_SECS matches SDK MAX_TIMEOUT_SECS', () => {
    expect(MAX_TIMEOUT_SECS).toBe(LIMITS.MAX_TIMEOUT_SECS);
  });

  it('encrypted-content byte limits match the SDK', () => {
    expect(NIP44_MAX_PLAINTEXT_BYTES).toBe(LIMITS.NIP44_MAX_PLAINTEXT_BYTES);
    expect(NIP44_MAX_PLAINTEXT_BYTES).toBe(65_535);
    expect(MAX_ENCRYPTED_INLINE_BYTES).toBe(LIMITS.MAX_ENCRYPTED_INLINE_BYTES);
    expect(MAX_REINLINE_TEXT_BYTES).toBe(LIMITS.MAX_REINLINE_TEXT_BYTES);
    // The spill threshold must stay under the hard NIP-44 cap.
    expect(MAX_ENCRYPTED_INLINE_BYTES).toBeLessThan(NIP44_MAX_PLAINTEXT_BYTES);
  });

  it('checkLen on input above MAX_INPUT_LEN fails at the MCP layer (not leaked to SDK)', () => {
    const overLimit = 'x'.repeat(MAX_INPUT_LEN + 1);
    expect(() => checkLen('input', overLimit, MAX_INPUT_LEN)).toThrow(/input too long/i);
  });

  it('checkLen on input at MAX_INPUT_LEN passes (exact boundary)', () => {
    const atLimit = 'x'.repeat(MAX_INPUT_LEN);
    expect(() => checkLen('input', atLimit, MAX_INPUT_LEN)).not.toThrow();
  });
});
