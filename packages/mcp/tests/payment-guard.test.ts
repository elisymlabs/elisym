/**
 * regression tests for the single-shot payment guard.
 *
 * The SDK's `subscribeToJobUpdates` delivers every `payment-required` feedback event
 * to `onFeedback` until the result arrives. Without the `paying/paid` guard in
 * `makePaymentFeedbackHandler`, duplicate feedback (malicious, echoed, or retried)
 * triggers multiple concurrent calls to `executePaymentFlow`, each broadcasting its
 * own Solana transfer - a wallet-drain vector.
 *
 * These tests use a stub `AgentInstance` and an injected `executor` to count how many
 * times the payment would be broadcast. They never touch Solana or Nostr.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentInstance } from '../src/context.js';
import { makePaymentFeedbackHandler } from '../src/tools/customer.js';

function stubAgent(hasSolana = true): AgentInstance {
  return {
    client: {} as never,
    identity: {} as never,
    name: 'test',
    network: 'devnet',
    security: {},
    solanaKeypair: hasSolana
      ? { publicKey: 'stub-pubkey', secretKey: new Uint8Array(64) }
      : undefined,
  };
}

function buildHandler(overrides: {
  executor?: ReturnType<typeof vi.fn>;
  hasSolana?: boolean;
  maxPriceLamports?: number;
  resolveNoWallet?: (msg: string) => void;
  resolveResult?: (msg: string) => void;
  rejectPayment?: (e: Error) => void;
  onPaid?: (sig: string) => void;
}) {
  const executor =
    overrides.executor ?? vi.fn(async () => 'mock-signature-' + Math.random().toString(36));
  const resolveNoWallet = overrides.resolveNoWallet ?? vi.fn();
  const resolveResult = overrides.resolveResult ?? vi.fn();
  const rejectPayment = overrides.rejectPayment ?? vi.fn();
  const onPaid = overrides.onPaid ?? vi.fn();
  const { onFeedback: handler, onResultReceived } = makePaymentFeedbackHandler({
    agent: stubAgent(overrides.hasSolana ?? true),
    jobId: 'job-abc',
    providerPubkey: 'a'.repeat(64),
    expectedRecipient: 'So1aNaExpectedRecipient1111111111111111111',
    maxPriceLamports: overrides.maxPriceLamports,
    resolveNoWallet,
    resolveResult,
    rejectPayment,
    onPaid,
    executor,
  });
  return {
    handler,
    onResultReceived,
    executor,
    resolveNoWallet,
    resolveResult,
    rejectPayment,
    onPaid,
  };
}

describe('makePaymentFeedbackHandler', () => {
  it('triggers payment exactly once on a single payment-required event', async () => {
    const { handler, executor, onPaid } = buildHandler({ maxPriceLamports: 10000 });
    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    // Executor is fired synchronously (returns a promise). Await microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate payment-required events while paying is in flight', async () => {
    // Make the executor hang so we observe the "in-flight" state across duplicates.
    let releaseExecutor!: (sig: string) => void;
    const executor = vi.fn(
      () =>
        new Promise<string>((res) => {
          releaseExecutor = res;
        }),
    );
    const { handler, onPaid, rejectPayment } = buildHandler({ executor, maxPriceLamports: 10000 });

    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    // Three more duplicates while first payment is still pending.
    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    handler('payment-required', 2000, '{"recipient":"y","amount":2000}');
    handler('payment-required', 9999, '{"recipient":"z","amount":9999}');

    expect(executor).toHaveBeenCalledTimes(1);

    // Let the first payment finish; subsequent duplicates should still be ignored.
    releaseExecutor('sig-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(onPaid).toHaveBeenCalledWith('sig-1');
    expect(rejectPayment).not.toHaveBeenCalled();

    // Post-paid duplicates are also ignored.
    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate payment-required events after successful payment', async () => {
    const executor = vi.fn(async () => 'sig-1');
    const { handler, onPaid } = buildHandler({ executor, maxPriceLamports: 10000 });

    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    await Promise.resolve();
    await Promise.resolve();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(onPaid).toHaveBeenCalledWith('sig-1');

    // Now a late duplicate arrives.
    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    handler('payment-required', 2000, '{"recipient":"y","amount":2000}');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('rejects payment when amount exceeds max_price_lamports before calling executor', async () => {
    const executor = vi.fn(async () => 'sig-should-not-happen');
    const { handler, rejectPayment } = buildHandler({
      executor,
      maxPriceLamports: 500,
    });

    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    expect(executor).not.toHaveBeenCalled();
    expect(rejectPayment).toHaveBeenCalledTimes(1);
    expect(rejectPayment.mock.calls[0]?.[0].message).toMatch(/exceeds max/);
  });

  it('resolves with fallback message when no Solana wallet configured', () => {
    const executor = vi.fn(async () => 'sig-should-not-happen');
    const {
      handler,
      executor: exec,
      resolveNoWallet,
    } = buildHandler({
      executor,
      hasSolana: false,
      maxPriceLamports: 10000,
    });

    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    expect(exec).not.toHaveBeenCalled();
    expect(resolveNoWallet).toHaveBeenCalledTimes(1);
    expect(resolveNoWallet.mock.calls[0]?.[0]).toMatch(/no Solana wallet/i);
  });

  it('allows retry after an executor failure (paying flag cleared)', async () => {
    const executor = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay down'))
      .mockResolvedValueOnce('sig-ok');
    const { handler, rejectPayment, onPaid } = buildHandler({ executor, maxPriceLamports: 10000 });

    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    await Promise.resolve();
    await Promise.resolve();
    expect(rejectPayment).toHaveBeenCalledTimes(1);
    expect(rejectPayment.mock.calls[0]?.[0].message).toMatch(/Payment failed.*relay down/);

    // After failure, the guard clears `paying` so a caller-driven retry path is
    // theoretically possible (though the outer subscription is usually dead by now).
    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    await Promise.resolve();
    await Promise.resolve();
    expect(executor).toHaveBeenCalledTimes(2);
    expect(onPaid).toHaveBeenCalledWith('sig-ok');
  });

  it('rejects payment when max_price_lamports is not set (confirmation gate)', () => {
    const executor = vi.fn(async () => 'sig-should-not-happen');
    const { handler, rejectPayment } = buildHandler({ executor });

    handler('payment-required', 1000, '{"recipient":"x","amount":1000}');
    expect(executor).not.toHaveBeenCalled();
    expect(rejectPayment).toHaveBeenCalledTimes(1);
    expect(rejectPayment.mock.calls[0]?.[0].message).toMatch(/no max_price_lamports set/);
  });

  it('enforces max_price_lamports against the signed JSON amount, not the tag amount', () => {
    // Wallet-drain regression: a malicious provider publishes a low tag amount
    // (passes the cap) while the signed JSON carries a large transfer.
    const executor = vi.fn(async () => 'sig-should-not-happen');
    const { handler, rejectPayment } = buildHandler({
      executor,
      maxPriceLamports: 10_000,
    });

    handler('payment-required', 100, '{"recipient":"x","amount":1000000000}');
    expect(executor).not.toHaveBeenCalled();
    expect(rejectPayment).toHaveBeenCalledTimes(1);
  });

  it('rejects when feedback tag amount disagrees with the signed JSON amount', () => {
    const executor = vi.fn(async () => 'sig-should-not-happen');
    const { handler, rejectPayment } = buildHandler({
      executor,
      maxPriceLamports: 10_000_000_000,
    });

    handler('payment-required', 100, '{"recipient":"x","amount":1000000000}');
    expect(executor).not.toHaveBeenCalled();
    expect(rejectPayment).toHaveBeenCalledTimes(1);
    expect(rejectPayment.mock.calls[0]?.[0].message).toMatch(/mismatch/);
  });

  it('rejects when payment_request is not valid JSON', () => {
    const executor = vi.fn(async () => 'sig-should-not-happen');
    const { handler, rejectPayment } = buildHandler({ executor, maxPriceLamports: 10_000 });

    handler('payment-required', 1000, 'not-json');
    expect(executor).not.toHaveBeenCalled();
    expect(rejectPayment).toHaveBeenCalledTimes(1);
    expect(rejectPayment.mock.calls[0]?.[0].message).toMatch(/malformed/);
  });

  it('ignores feedback events whose status is not payment-required', () => {
    const executor = vi.fn(async () => 'sig');
    const { handler } = buildHandler({ executor, maxPriceLamports: 10000 });

    handler('processing', undefined, undefined);
    handler('error', undefined, undefined);
    handler('payment-completed', 1000, undefined);
    // payment-required without paymentRequest is also ignored.
    handler('payment-required', 1000, undefined);
    expect(executor).not.toHaveBeenCalled();
  });
});
