/**
 * MCP input-length limits must match the SDK's LIMITS constant.
 *
 * Before this fix, MCP had `MAX_MESSAGE_LEN = 50_000` while the SDK enforced
 * `MAX_MESSAGE_LENGTH = 10_000`. Messages in the gap passed the MCP checkLen and then
 * threw a confusing SDK error. Same pattern for MAX_CAPABILITIES (MCP 50 vs SDK 20).
 *
 * This test locks in the re-export so a drift is caught on the next `bun qa`.
 */
import { LIMITS } from '@elisym/sdk';
import { describe, it, expect } from 'vitest';
import {
  MAX_CAPABILITIES,
  MAX_INPUT_LEN,
  MAX_MESSAGE_LEN,
  MAX_TIMEOUT_SECS,
  checkLen,
} from '../src/utils.js';

describe('MCP limits aligned with @elisym/sdk LIMITS', () => {
  it('MAX_MESSAGE_LEN matches SDK MAX_MESSAGE_LENGTH', () => {
    expect(MAX_MESSAGE_LEN).toBe(LIMITS.MAX_MESSAGE_LENGTH);
    expect(MAX_MESSAGE_LEN).toBe(10_000);
  });

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

  it('checkLen on a 15k message fails at the MCP layer (not leaked to SDK)', () => {
    // 15_000 is above the new MCP limit (10_000) but was below the old one (50_000).
    const msg = 'x'.repeat(15_000);
    expect(() => checkLen('message', msg, MAX_MESSAGE_LEN)).toThrow(/message too long/i);
  });

  it('checkLen on a 10k message passes (exact boundary)', () => {
    const msg = 'x'.repeat(10_000);
    expect(() => checkLen('message', msg, MAX_MESSAGE_LEN)).not.toThrow();
  });
});
