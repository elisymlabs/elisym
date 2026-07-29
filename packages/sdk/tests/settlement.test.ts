import type { Rpc, Signature, SolanaRpcApi } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSignedPull,
  confirmPullToTerminal,
  isDefinitelyUnpaid,
  sendConfirmToTerminal,
} from '../src/payment/settlement';

const SIG = 'x'.repeat(64) as Signature;

/** Fast poll options so terminal tests run in milliseconds. */
const FAST = { pollIntervalMs: 1, recheckAttempts: 2, recheckDelayMs: 1 };

type StatusValue = { err: unknown } | null;

/**
 * Mock RPC: `statuses` is consumed one per `getSignatureStatuses` call (last
 * value repeats); `heights` one per `getBlockHeight` call (last repeats).
 * A `'throw'` entry makes that call reject.
 */
function mockRpc(
  statuses: (StatusValue | 'throw')[],
  heights: (bigint | 'throw')[] = [1n],
): Rpc<SolanaRpcApi> {
  let statusCall = 0;
  let heightCall = 0;
  return {
    getSignatureStatuses: () => ({
      send: async () => {
        const value = statuses[Math.min(statusCall++, statuses.length - 1)];
        if (value === 'throw') {
          throw new Error('rpc down');
        }
        return { value: [value] };
      },
    }),
    getBlockHeight: () => ({
      send: async () => {
        const value = heights[Math.min(heightCall++, heights.length - 1)];
        if (value === 'throw') {
          throw new Error('rpc down');
        }
        return value;
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

describe('isDefinitelyUnpaid (extracted to SDK)', () => {
  it('landed without error -> false (funds moved)', async () => {
    const rpc = mockRpc([{ err: null }]);
    await expect(isDefinitelyUnpaid(rpc, SIG, FAST)).resolves.toBe(false);
  });

  it('reverted on-chain -> true (no transfer happened)', async () => {
    const rpc = mockRpc([{ err: { InstructionError: [0, 'Custom'] } }]);
    await expect(isDefinitelyUnpaid(rpc, SIG, FAST)).resolves.toBe(true);
  });

  it('absent across every re-poll -> true', async () => {
    const rpc = mockRpc([null]);
    await expect(isDefinitelyUnpaid(rpc, SIG, FAST)).resolves.toBe(true);
  });

  it('absent then indexed on a re-poll -> false (propagation lag guarded)', async () => {
    const rpc = mockRpc([null, { err: null }]);
    await expect(isDefinitelyUnpaid(rpc, SIG, FAST)).resolves.toBe(false);
  });

  it('RPC failure -> false (indeterminate: assume the tx may have landed)', async () => {
    const rpc = mockRpc(['throw']);
    await expect(isDefinitelyUnpaid(rpc, SIG, FAST)).resolves.toBe(false);
  });
});

describe('confirmPullToTerminal', () => {
  it('landed -> landed', async () => {
    const rpc = mockRpc([{ err: null }]);
    await expect(confirmPullToTerminal(rpc, SIG, 100n, FAST)).resolves.toBe('landed');
  });

  it('reverted -> dead', async () => {
    const rpc = mockRpc([{ err: { InstructionError: [0, 'Custom'] } }]);
    await expect(confirmPullToTerminal(rpc, SIG, 100n, FAST)).resolves.toBe('dead');
  });

  it('lands after the first polls but before blockhash expiry -> landed', async () => {
    // Absent for 3 polls (heights stay below terminal), then lands.
    const rpc = mockRpc([null, null, null, { err: null }], [90n, 95n, 99n]);
    await expect(confirmPullToTerminal(rpc, SIG, 100n, FAST)).resolves.toBe('landed');
  });

  it('terminal + positively absent -> dead (no charge)', async () => {
    const rpc = mockRpc([null], [101n]);
    await expect(confirmPullToTerminal(rpc, SIG, 100n, FAST)).resolves.toBe('dead');
  });

  it('terminal + indeterminate landed-check -> assume-landed (money rule)', async () => {
    // Poll sees absent + past-terminal height; the final isDefinitelyUnpaid
    // re-poll (searchTransactionHistory) then hits an RPC failure -> cannot
    // prove absence -> assume the funds may have moved.
    const rpc = mockRpc([null, 'throw'], [101n]);
    await expect(confirmPullToTerminal(rpc, SIG, 100n, FAST)).resolves.toBe('assume-landed');
  });

  it('terminal + history re-poll finds the old landed tx -> assume-landed', async () => {
    // Recent-status poll misses it (aged out), the history search finds it.
    const rpc = mockRpc([null, { err: null }], [101n]);
    await expect(confirmPullToTerminal(rpc, SIG, 100n, FAST)).resolves.toBe('assume-landed');
  });

  it('poll budget exhausted before terminal -> unresolved (leave state for recovery)', async () => {
    const rpc = mockRpc(['throw'], ['throw']);
    await expect(confirmPullToTerminal(rpc, SIG, 100n, { ...FAST, maxAttempts: 3 })).resolves.toBe(
      'unresolved',
    );
  });

  it('persistently-erroring RPC is bounded by max-attempts (never hangs)', async () => {
    const rpc = mockRpc(['throw']);
    const outcome = await confirmPullToTerminal(rpc, SIG, 100n, { ...FAST, maxAttempts: 2 });
    expect(outcome).toBe('unresolved');
  });
});

describe('sendConfirmToTerminal', () => {
  it('swallows a send failure and resolves via the terminal-bounded poll', async () => {
    const send = vi.fn().mockRejectedValue(new Error('blockhash not found'));
    const rpc = {
      ...mockRpc([{ err: null }]),
      sendTransaction: () => ({ send }),
    } as unknown as Rpc<SolanaRpcApi>;
    await expect(
      sendConfirmToTerminal(
        rpc,
        { transaction: {}, signature: SIG, lastValidBlockHeight: 100n },
        FAST,
      ),
    ).resolves.toBe('landed');
  });
});

describe('buildSignedPull', () => {
  it('exposes the blockhash lifetime bound from getLatestBlockhash', async () => {
    // Signing needs real signer plumbing; assert the phase-A contract shape by
    // checking the blockhash fetch drives `lastValidBlockHeight`. Uses a real
    // signer from the wallet helper.
    const { generateSolanaWallet } = await import('../src/payment/wallet');
    const { signer } = await generateSolanaWallet();
    const rpc = {
      getLatestBlockhash: () => ({
        send: async () => ({
          value: {
            blockhash: '9zMND1Rt69qHt5wx3ZFRc7FRBcWtRUQXFPGGSPT9x9Ci',
            lastValidBlockHeight: 4242n,
          },
        }),
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    const pull = await buildSignedPull(rpc, signer, []);
    expect(pull.lastValidBlockHeight).toBe(4242n);
    expect(typeof pull.signature).toBe('string');
    expect(pull.signature.length).toBeGreaterThan(0);
  });
});
