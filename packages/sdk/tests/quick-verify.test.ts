import { type Address, type Rpc, type SolanaRpcApi, getAddressDecoder } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LSM_SOLANA_MAINNET, clearQuickVerifyCache, verifyJobPaymentQuick } from '../src';

const RANDOM_ADDRESS_BYTES = 32;
const ADDRESS_DECODER = getAddressDecoder();

function makeAddress(): Address {
  const bytes = new Uint8Array(RANDOM_ADDRESS_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return ADDRESS_DECODER.decode(bytes);
}

function makeTx(opts: {
  keys: (string | null)[];
  pre: number[];
  post: number[];
  err?: unknown;
  preTokenBalances?: unknown;
  postTokenBalances?: unknown;
}) {
  return {
    meta: {
      err: opts.err ?? null,
      preBalances: opts.pre.map((value) => BigInt(value)),
      postBalances: opts.post.map((value) => BigInt(value)),
      preTokenBalances: opts.preTokenBalances,
      postTokenBalances: opts.postTokenBalances,
    },
    transaction: {
      message: {
        accountKeys: opts.keys,
      },
    },
  };
}

function createMockRpc(getTransactionImpl: (...args: unknown[]) => unknown): Rpc<SolanaRpcApi> {
  return {
    getTransaction: (...args: unknown[]) => getTransactionImpl(...args),
  } as unknown as Rpc<SolanaRpcApi>;
}

describe('verifyJobPaymentQuick', () => {
  beforeEach(() => {
    clearQuickVerifyCache();
  });

  afterEach(() => {
    clearQuickVerifyCache();
  });

  it('returns verified=true when recipient receives native SOL', async () => {
    const recipient = makeAddress();
    const payer = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, recipient],
            pre: [200_000_000, 0],
            post: [199_000_000, 1_000_000],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig1', recipient, 'devnet');
    expect(result.receivedFunds).toBe(true);
    expect(result.txSignature).toBe('sig1');
  });

  it('caches positive results indefinitely (second call skips RPC)', async () => {
    const recipient = makeAddress();
    const payer = makeAddress();
    const getTx = vi.fn(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, recipient],
            pre: [100_000, 0],
            post: [99_000, 1_000],
          }),
        ),
    }));
    const rpc = createMockRpc(getTx);

    const first = await verifyJobPaymentQuick(rpc, 'cached-sig', recipient, 'devnet');
    const second = await verifyJobPaymentQuick(rpc, 'cached-sig', recipient, 'devnet');

    expect(first.receivedFunds).toBe(true);
    expect(second.receivedFunds).toBe(true);
    expect(getTx).toHaveBeenCalledTimes(1);
  });

  it('returns not_found when tx is null', async () => {
    const recipient = makeAddress();
    const rpc = createMockRpc(() => ({ send: () => Promise.resolve(null) }));

    const result = await verifyJobPaymentQuick(rpc, 'missing-sig', recipient, 'devnet');
    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('returns recipient_mismatch when tx exists but recipient did not receive', async () => {
    const recipient = makeAddress();
    const otherRecipient = makeAddress();
    const payer = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, otherRecipient],
            pre: [100_000, 0],
            post: [99_000, 1_000],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-other', recipient, 'devnet');
    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('recipient_mismatch');
  });

  it('returns tx_failed when meta.err is set', async () => {
    const recipient = makeAddress();
    const payer = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, recipient],
            pre: [100_000, 0],
            post: [99_000, 1_000],
            err: { InstructionError: [0, 'Custom'] },
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-failed', recipient, 'devnet');
    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('tx_failed');
  });

  it('returns rpc_error when getTransaction throws', async () => {
    const recipient = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () => Promise.reject(new Error('rpc unavailable')),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-throw', recipient, 'devnet');
    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('rpc_error');
  });

  it('returns rpc_error when rpc has no getTransaction method', async () => {
    const result = await verifyJobPaymentQuick(
      {} as unknown as Rpc<SolanaRpcApi>,
      'sig-bad-rpc',
      makeAddress(),
      'devnet',
    );
    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('rpc_error');
  });

  it('rejects empty signature with invalid_input', async () => {
    const rpc = createMockRpc(() => ({ send: () => Promise.resolve(null) }));
    const result = await verifyJobPaymentQuick(rpc, '', makeAddress(), 'devnet');
    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('invalid_input');
  });

  it('rejects malformed recipient with invalid_input', async () => {
    const rpc = createMockRpc(() => ({ send: () => Promise.resolve(null) }));
    const result = await verifyJobPaymentQuick(
      rpc,
      'sig',
      'not-a-real-address' as Address,
      'devnet',
    );
    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('invalid_input');
  });

  it('verifies SPL token recipient via postTokenBalances', async () => {
    const recipient = makeAddress();
    const payer = makeAddress();
    const recipientAta = makeAddress();
    const mint = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, recipientAta],
            pre: [100_000_000, 0],
            post: [100_000_000, 0],
            preTokenBalances: [],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: mint as string,
                owner: recipient as string,
                uiTokenAmount: { amount: '500000' },
              },
            ],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'spl-sig', recipient, 'devnet');
    expect(result.receivedFunds).toBe(true);
  });

  it('verifies a Token-2022 recipient (LSM) - balance matching is owner+mint only', async () => {
    const recipient = makeAddress();
    const payer = makeAddress();
    const recipientAta = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, recipientAta],
            pre: [100_000_000, 0],
            post: [100_000_000, 0],
            preTokenBalances: [],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: LSM_SOLANA_MAINNET.mint ?? '',
                owner: recipient as string,
                uiTokenAmount: { amount: '12500000' },
              },
            ],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'lsm-sig', recipient, 'mainnet');
    expect(result.receivedFunds).toBe(true);
  });

  // H9: (txSignature, recipient) is cluster-ambiguous, so the cache must key
  // on the network too - one cluster's verdict must never serve the other.
  it('never serves one cluster cached verdict to the other', async () => {
    const recipient = makeAddress();
    const payer = makeAddress();
    const getTx = vi
      .fn()
      // Devnet sees a successful payment; positive results are cached forever.
      .mockReturnValueOnce({
        send: () =>
          Promise.resolve(
            makeTx({
              keys: [payer, recipient],
              pre: [100_000, 0],
              post: [99_000, 1_000],
            }),
          ),
      })
      // Mainnet has never seen this signature.
      .mockReturnValueOnce({ send: () => Promise.resolve(null) });
    const rpc = createMockRpc(getTx);

    const devnet = await verifyJobPaymentQuick(rpc, 'same-sig', recipient, 'devnet');
    expect(devnet.receivedFunds).toBe(true);

    const mainnet = await verifyJobPaymentQuick(rpc, 'same-sig', recipient, 'mainnet');
    expect(mainnet.receivedFunds).toBe(false);
    expect(mainnet.reason).toBe('not_found');
    expect(getTx).toHaveBeenCalledTimes(2);
  });

  it('negative cache expires after TTL so second call hits RPC again', async () => {
    vi.useFakeTimers();
    try {
      const recipient = makeAddress();
      const getTx = vi
        .fn()
        .mockReturnValueOnce({ send: () => Promise.resolve(null) })
        .mockReturnValueOnce({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [makeAddress(), recipient],
                pre: [100, 0],
                post: [99, 1],
              }),
            ),
        });
      const rpc = createMockRpc(getTx);

      const first = await verifyJobPaymentQuick(rpc, 'expiring-sig', recipient, 'devnet');
      expect(first.receivedFunds).toBe(false);
      expect(first.reason).toBe('not_found');

      // Within TTL: cached negative
      const second = await verifyJobPaymentQuick(rpc, 'expiring-sig', recipient, 'devnet');
      expect(second.receivedFunds).toBe(false);
      expect(getTx).toHaveBeenCalledTimes(1);

      // Past TTL: re-queries
      vi.advanceTimersByTime(61_000);
      const third = await verifyJobPaymentQuick(rpc, 'expiring-sig', recipient, 'devnet');
      expect(third.receivedFunds).toBe(true);
      expect(getTx).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
