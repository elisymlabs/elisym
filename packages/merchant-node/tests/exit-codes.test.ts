import { describe, expect, it } from 'vitest';
import { INBOX_RELAYS_EXIT_CODE } from '../src/checks';
import { OWNER_REFUSAL_EXIT_CODE, setupExitCode } from '../src/owner-events';

describe("a failed setup's exit code", () => {
  it('keeps a marked failure over a stop signal received meanwhile; any other failure gives way', () => {
    // A contract with the control plane: the literals.
    expect(OWNER_REFUSAL_EXIT_CODE).toBe(3);
    expect(INBOX_RELAYS_EXIT_CODE).toBe(4);
    expect(setupExitCode(3, 143)).toBe(3);
    expect(setupExitCode(4, 143)).toBe(4);
    expect(setupExitCode(1, 143)).toBe(143);
    expect(setupExitCode(1, undefined)).toBe(1);
    expect(setupExitCode(4, undefined)).toBe(4);
  });
});
