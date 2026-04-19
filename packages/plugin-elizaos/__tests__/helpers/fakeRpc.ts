/**
 * Minimal RPC stub for the recovery-flow integration tests.
 *
 * The only part of the full `Rpc<SolanaRpcApi>` surface that the recovery
 * path actually touches is `verifyPayment`, which our stub strategy short-
 * circuits via `setVerifyOutcome`. The Solana RPC handle is therefore a
 * placeholder - the real strategy is replaced by `fakePaymentStrategy`
 * below.
 */
export const fakeRpc = {
  __isFakeRpc: true,
};

export interface VerifyOutcome {
  verified: boolean;
  txSignature?: string;
  error?: string;
}

let nextOutcome: VerifyOutcome = { verified: false };

export function setVerifyOutcome(outcome: VerifyOutcome): void {
  nextOutcome = outcome;
}

export function consumeVerifyOutcome(): VerifyOutcome {
  return nextOutcome;
}

export function resetVerifyOutcome(): void {
  nextOutcome = { verified: false };
}
