import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import type { Rpc, Signature, SolanaRpcApi } from '@solana/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPriorityFeeCache } from '../src/payment/priorityFee';
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
  const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

  /** Blockhash-only RPC: no `getRecentPrioritizationFees`, so estimation fails. */
  function blockhashOnlyRpc(): Rpc<SolanaRpcApi> {
    return {
      getLatestBlockhash: () => ({
        send: async () => ({
          value: {
            blockhash: '9zMND1Rt69qHt5wx3ZFRc7FRBcWtRUQXFPGGSPT9x9Ci',
            lastValidBlockHeight: 4242n,
          },
        }),
      }),
    } as unknown as Rpc<SolanaRpcApi>;
  }

  const SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR = 2;
  const SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR = 3;

  interface ComputeBudget {
    unitLimit?: number;
    unitPrice?: bigint;
  }

  /**
   * The two ComputeBudget instructions the pull carries, read back off the
   * compiled message: `[2, u32 LE units]` and `[3, u64 LE microLamports/CU]`.
   * Asserting the decoded VALUES, not just the program's presence - the CU
   * limit alone puts ComputeBudget in the account list, so a presence check
   * would stay green with the priority-fee bid removed.
   */
  function computeBudgetOf(transaction: Readonly<unknown>): ComputeBudget {
    const { messageBytes } = transaction as { messageBytes: Uint8Array };
    const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const accounts = message.staticAccounts as readonly string[];
    const budget: ComputeBudget = {};
    for (const instruction of message.instructions) {
      const data = instruction.data;
      if (accounts[instruction.programAddressIndex] !== COMPUTE_BUDGET_PROGRAM || !data) {
        continue;
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (data[0] === SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR) {
        budget.unitLimit = view.getUint32(1, true);
      }
      if (data[0] === SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR) {
        budget.unitPrice = view.getBigUint64(1, true);
      }
    }
    return budget;
  }

  beforeEach(() => {
    // The estimator caches by (network, percentile) across tests in this file.
    clearPriorityFeeCache();
  });

  it('exposes the blockhash lifetime bound from getLatestBlockhash', async () => {
    // Signing needs real signer plumbing; assert the phase-A contract shape by
    // checking the blockhash fetch drives `lastValidBlockHeight`. Uses a real
    // signer from the wallet helper.
    const { generateSolanaWallet } = await import('../src/payment/wallet');
    const { signer } = await generateSolanaWallet();
    const pull = await buildSignedPull(blockhashOnlyRpc(), signer, [], { network: 'devnet' });
    expect(pull.lastValidBlockHeight).toBe(4242n);
    expect(typeof pull.signature).toBe('string');
    expect(pull.signature.length).toBeGreaterThan(0);
  });

  it('bids a priority fee, so collection is not stuck at the base rate', async () => {
    const { generateSolanaWallet } = await import('../src/payment/wallet');
    const { signer } = await generateSolanaWallet();
    const pull = await buildSignedPull(blockhashOnlyRpc(), signer, [], {
      network: 'mainnet',
      priorityFeeMicroLamports: 1234n,
    });
    // The CU ceiling is sized for the pull, not inherited from the payment
    // path: the bid is charged on the REQUESTED limit.
    expect(computeBudgetOf(pull.transaction)).toEqual({
      unitLimit: 60_000,
      unitPrice: 1234n,
    });
  });

  it('consults the estimator for the pull network, and skips it when overridden', async () => {
    const { generateSolanaWallet } = await import('../src/payment/wallet');
    const { signer } = await generateSolanaWallet();
    const getRecentPrioritizationFees = vi.fn(() => ({
      send: async () => [{ slot: 1n, prioritizationFee: 4321n }],
    }));
    const rpc = {
      ...blockhashOnlyRpc(),
      getRecentPrioritizationFees,
    } as unknown as Rpc<SolanaRpcApi>;

    const estimated = await buildSignedPull(rpc, signer, [], { network: 'mainnet' });
    expect(getRecentPrioritizationFees).toHaveBeenCalledTimes(1);
    expect(computeBudgetOf(estimated.transaction).unitPrice).toBe(4321n);

    // Drop the estimator's 10s cache first: with it warm, an override that was
    // silently ignored would still leave the call count at 1.
    clearPriorityFeeCache();
    const overridden = await buildSignedPull(rpc, signer, [], {
      network: 'mainnet',
      priorityFeeMicroLamports: 9n,
    });
    expect(getRecentPrioritizationFees).toHaveBeenCalledTimes(1);
    expect(computeBudgetOf(overridden.transaction).unitPrice).toBe(9n);
  });

  it('still produces a signed pull when the fee estimate fails', async () => {
    // A pull at the base rate beats a pull that never goes out: an RPC that
    // cannot answer the fee query must not abort collection.
    const { generateSolanaWallet } = await import('../src/payment/wallet');
    const { signer } = await generateSolanaWallet();
    const pull = await buildSignedPull(blockhashOnlyRpc(), signer, [], { network: 'mainnet' });
    expect(pull.signature.length).toBeGreaterThan(0);
    expect(computeBudgetOf(pull.transaction).unitPrice).toBe(0n);
  });
});
