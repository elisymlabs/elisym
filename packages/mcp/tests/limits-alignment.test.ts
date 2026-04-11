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
import { MAX_CAPABILITIES, MAX_INPUT_LEN, MAX_TIMEOUT_SECS, checkLen } from '../src/utils.js';

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

  it('checkLen on input above MAX_INPUT_LEN fails at the MCP layer (not leaked to SDK)', () => {
    const overLimit = 'x'.repeat(MAX_INPUT_LEN + 1);
    expect(() => checkLen('input', overLimit, MAX_INPUT_LEN)).toThrow(/input too long/i);
  });

  it('checkLen on input at MAX_INPUT_LEN passes (exact boundary)', () => {
    const atLimit = 'x'.repeat(MAX_INPUT_LEN);
    expect(() => checkLen('input', atLimit, MAX_INPUT_LEN)).not.toThrow();
  });
});
