/**
 * `isDefinitelyUnpaid` gates whether a financial path may release a reservation or
 * report a retryable failure after `sendAndConfirm` threw. It must return true ONLY
 * with positive evidence that no funds moved (absent from the chain, or reverted).
 * For a confirmed/processed tx (funds moved) or an indeterminate RPC failure it
 * returns false so the caller does NOT release/retry - avoiding a double withdrawal
 * or an under-counted spend cap on a transient RPC error.
 */
import type { Rpc, Signature, SolanaRpcApi } from '@solana/kit';
import { describe, it, expect, vi } from 'vitest';
import { isDefinitelyUnpaid } from '../src/utils.js';

const SIGNATURE = 'sig1111111111111111111111111111111111111111111' as Signature;
// recheckDelayMs: 0 keeps the absent-status re-poll instant in tests.
const FAST = { recheckDelayMs: 0 } as const;

function mockRpc(status: unknown, throws = false): Rpc<SolanaRpcApi> {
  return {
    getSignatureStatuses: () => ({
      send: async () => {
        if (throws) {
          throw new Error('rpc unavailable');
        }
        return { value: [status] };
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

/** Returns each status in turn, repeating the last once exhausted. */
function mockRpcSeq(statuses: unknown[]): Rpc<SolanaRpcApi> {
  let call = 0;
  return {
    getSignatureStatuses: () => ({
      send: async () => {
        const status = statuses[Math.min(call, statuses.length - 1)];
        call += 1;
        return { value: [status] };
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

describe('isDefinitelyUnpaid', () => {
  it('returns true when the signature stays absent across re-polls', async () => {
    expect(await isDefinitelyUnpaid(mockRpc(null), SIGNATURE, FAST)).toBe(true);
  });

  it('returns true for a tx that landed but reverted on-chain', async () => {
    const rpc = mockRpc({
      err: { InstructionError: [0, 'Custom'] },
      confirmationStatus: 'confirmed',
    });
    expect(await isDefinitelyUnpaid(rpc, SIGNATURE)).toBe(true);
  });

  it('returns false for a confirmed tx with no error (funds moved)', async () => {
    const rpc = mockRpc({ err: null, confirmationStatus: 'confirmed' });
    expect(await isDefinitelyUnpaid(rpc, SIGNATURE)).toBe(false);
  });

  it('returns false for a finalized tx with no error', async () => {
    const rpc = mockRpc({ err: null, confirmationStatus: 'finalized' });
    expect(await isDefinitelyUnpaid(rpc, SIGNATURE)).toBe(false);
  });

  it('returns false for a merely processed tx (on chain, may still confirm)', async () => {
    const rpc = mockRpc({ err: null, confirmationStatus: 'processed' });
    expect(await isDefinitelyUnpaid(rpc, SIGNATURE)).toBe(false);
  });

  it('returns false on an RPC failure (indeterminate - assume it may have landed)', async () => {
    const rpc = mockRpc(null, true);
    expect(await isDefinitelyUnpaid(rpc, SIGNATURE)).toBe(false);
  });

  it('re-polls a null status and returns false once the landed tx becomes visible', async () => {
    // First query lags (null), the second shows the tx on-chain with no error: a
    // landed-but-not-yet-indexed tx must NOT be reported as unpaid.
    const rpc = mockRpcSeq([null, { err: null, confirmationStatus: 'confirmed' }]);
    expect(await isDefinitelyUnpaid(rpc, SIGNATURE, FAST)).toBe(false);
  });

  it('stops polling as soon as a status is found', async () => {
    const send = vi.fn(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }));
    const rpc = { getSignatureStatuses: () => ({ send }) } as unknown as Rpc<SolanaRpcApi>;
    await isDefinitelyUnpaid(rpc, SIGNATURE, FAST);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
