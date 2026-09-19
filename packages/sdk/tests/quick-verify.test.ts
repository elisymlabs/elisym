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
  loadedAddresses?: unknown;
}) {
  return {
    meta: {
      err: opts.err ?? null,
      preBalances: opts.pre.map((value) => BigInt(value)),
      postBalances: opts.post.map((value) => BigInt(value)),
      preTokenBalances: opts.preTokenBalances,
      postTokenBalances: opts.postTokenBalances,
      loadedAddresses: opts.loadedAddresses,
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

  it('finds a recipient a lookup table supplied, not just a static key', async () => {
    const recipient = makeAddress();
    const payer = makeAddress();
    const writableFromTable = makeAddress();
    // The recipient is NOT in `accountKeys` - a v0 transaction built by a
    // router puts it in the table - but the balance arrays cover it, at the
    // slot that follows the static keys.
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer],
            loadedAddresses: { writable: [writableFromTable, recipient], readonly: [] },
            pre: [10_000_000, 0, 0],
            post: [8_000_000, 0, 1_000_000],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-table-recipient', recipient, 'mainnet');

    expect(result.receivedFunds).toBe(true);
  });

  it('does not read a balance the recipient merely already HELD as a payment', async () => {
    // The PRE half of the delta, unmeasured here exactly as it was in the
    // verifier: every other row starts the recipient at zero, so reading the
    // baseline as zero looks identical. Under that reading any transaction
    // that so much as MENTIONS a provider's address reports "received funds" -
    // the answer this function exists to give, to whoever ranks on it.
    const recipient = makeAddress();
    const payer = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, recipient],
            pre: [10_000_000, 5_000_000],
            post: [10_000_000, 5_000_000],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-pre-held', recipient, 'mainnet');

    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('recipient_mismatch');
  });

  it('does not read a TOKEN balance the recipient already held as a payment', async () => {
    // The same hole on the SPL half, where the baseline is a lookup rather than
    // an index: a missing pre-entry legitimately means zero, so the mutation
    // that always reads zero is invisible without a row that HAS one.
    const recipient = makeAddress();
    const payer = makeAddress();
    const mint = makeAddress();
    const tokenEntry = (amount: number) => [
      {
        accountIndex: 1,
        mint,
        owner: recipient,
        uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: amount / 1e6 },
      },
    ];
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, recipient],
            pre: [10_000_000, 0],
            post: [10_000_000, 0],
            preTokenBalances: tokenEntry(2_000_000),
            postTokenBalances: tokenEntry(2_000_000),
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-token-pre-held', recipient, 'mainnet');

    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('recipient_mismatch');
  });

  it("does not read SOMEONE ELSE's token credit as the recipient being paid", async () => {
    // The other half of the same two lines: round 14 measured HOW MUCH and left
    // WHOSE unmeasured, which is the shape the verifier's fee leg had. A real
    // transaction carries the token accounts of everyone it touched, so without
    // the owner test any transfer that merely includes the provider's address
    // among its keys reports a paid job.
    const recipient = makeAddress();
    const stranger = makeAddress();
    const payer = makeAddress();
    const mint = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, recipient],
            pre: [10_000_000, 0],
            post: [10_000_000, 0],
            preTokenBalances: [],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: mint as string,
                owner: stranger as string,
                uiTokenAmount: { amount: '5000000', decimals: 6, uiAmount: 5 },
              },
            ],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-stranger-token', recipient, 'mainnet');

    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('recipient_mismatch');
  });

  it('does not read a DIFFERENT mint as the baseline for this one', async () => {
    // The baseline is matched by owner AND mint. Matched by owner alone, an
    // account the recipient already held in another token supplies a zero
    // baseline for a balance that did not move.
    const recipient = makeAddress();
    const payer = makeAddress();
    const paidMint = makeAddress();
    const otherMint = makeAddress();
    const entry = (mint: string, amount: number) => ({
      accountIndex: 1,
      mint,
      owner: recipient as string,
      uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: amount / 1e6 },
    });
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, recipient],
            pre: [10_000_000, 0],
            post: [10_000_000, 0],
            // The other mint FIRST, and empty: that is the row a match on owner
            // alone settles on.
            preTokenBalances: [entry(otherMint as string, 0), entry(paidMint as string, 4_000_000)],
            postTokenBalances: [entry(paidMint as string, 4_000_000)],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(
      rpc,
      'sig-other-mint-baseline',
      recipient,
      'mainnet',
    );

    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('recipient_mismatch');
  });

  it('answers rather than throwing when a table supplies more keys than balance slots', async () => {
    // This branch introduced `mergeAccountKeys`, which made the key list longer
    // than it used to be - so the recipient's index can now point past the end
    // of the balance arrays, which it could not before. The undefined-slot
    // guard is what keeps that from being `BigInt(undefined)`, and
    // `verifyJobPaymentQuick` wraps nothing in a try: a throw here rejects the
    // caller's promise instead of answering "no payment seen".
    const recipient = makeAddress();
    const payer = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer],
            loadedAddresses: { writable: [makeAddress(), recipient], readonly: [] },
            pre: [10_000_000, 0],
            post: [9_000_000, 1_000_000],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-keys-past-slots', recipient, 'mainnet');

    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('recipient_mismatch');
  });

  it('answers rather than throwing when the recipient is missing entirely', async () => {
    // `isAddress` reads `.length`, so it THROWS on `undefined` rather than
    // answering false - and this function wraps nothing, so the caller's
    // promise rejects instead of being told the input was bad. The empty
    // string, which the neighbouring row uses, takes the other path and leaves
    // this half unmeasured. Reachable because the file says so itself: nothing
    // here calls it, it is public surface for callers building their own
    // ranking, and those need not be typed.
    const rpc = createMockRpc(() => ({ send: () => Promise.resolve(null) }));

    const result = await verifyJobPaymentQuick(
      rpc,
      'sig-no-recipient',
      undefined as unknown as Address,
      'devnet',
    );

    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('invalid_input');
  });

  it('answers rather than throwing when the RPC returns a tx with no meta', async () => {
    // `meta` is `<object|null>` in the Solana JSON-RPC spec, and this branch's
    // threat model includes a proxy that answers with shapes the spec allows
    // and the happy path does not. The closest existing row carries
    // `meta: { err: null }`, so the missing-meta half was never taken.
    const recipient = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve({
          meta: null,
          transaction: { message: { accountKeys: [recipient] } },
        }),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-no-meta', recipient, 'devnet');

    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('tx_failed');
  });

  it('never serves one recipient a verdict cached for another', async () => {
    // A positive verdict lives forever, and the signature it is keyed on is
    // public. Drop the recipient from the key and any agent asking about that
    // signature is told it was paid - the same hole the network component
    // beside it exists to close, through the other input.
    const paid = makeAddress();
    const other = makeAddress();
    const payer = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, paid, other],
            pre: [200_000_000, 0, 0],
            post: [199_000_000, 1_000_000, 0],
          }),
        ),
    }));

    expect((await verifyJobPaymentQuick(rpc, 'shared-sig', paid, 'mainnet')).receivedFunds).toBe(
      true,
    );
    expect((await verifyJobPaymentQuick(rpc, 'shared-sig', other, 'mainnet')).receivedFunds).toBe(
      false,
    );
  });

  it("does not take a stranger's row as the recipient's token baseline", async () => {
    // The owner half of the baseline lookup. Matched by mint alone, a
    // transaction carrying several accounts in the same mint - the ordinary
    // shape, since payer, recipient and treasury all hold one - hands back
    // whichever row comes first. An empty stranger's row then reads as a zero
    // baseline, and a balance that never moved reports as funds received.
    const recipient = makeAddress();
    const stranger = makeAddress();
    const payer = makeAddress();
    const mint = makeAddress() as string;
    const row = (owner: string, index: number, amount: number) => ({
      accountIndex: index,
      mint,
      owner,
      uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: amount / 1e6 },
    });
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer, recipient, stranger],
            pre: [0, 0, 0],
            post: [0, 0, 0],
            preTokenBalances: [
              row(stranger as string, 2, 0),
              row(recipient as string, 1, 5_000_000),
            ],
            postTokenBalances: [
              row(recipient as string, 1, 5_000_000),
              row(stranger as string, 2, 0),
            ],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'stranger-baseline', recipient, 'mainnet');

    expect(result.receivedFunds).toBe(false);
  });

  it('answers rather than throwing when the meta carries no balance arrays', async () => {
    // The twin of the undefined-slot guard one line below, and it was measured
    // while this one was not: a `meta` without the arrays at all makes
    // `BigInt(undefined)` throw, and this function wraps nothing - the caller's
    // promise rejects instead of being told no payment was seen.
    const recipient = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve({
          meta: { err: null },
          transaction: { message: { accountKeys: [recipient] } },
        }),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'no-balances', recipient, 'mainnet');

    expect(result.receivedFunds).toBe(false);
  });

  it('refuses rather than misreads when the loaded half is malformed', async () => {
    const recipient = makeAddress();
    const payer = makeAddress();
    // A proxy answering with a string for one half would be spread character by
    // character: two junk keys here, which push the recipient from slot 1 to
    // slot 3 and read some other account's delta as its own. The recipient must
    // therefore sit BEHIND the malformed half - a fixture that keeps it among
    // the static keys is green either way and proves nothing.
    //
    // The merge falls back to the static keys alone, so the recipient is not
    // found and the payment is refused. That is the intended trade: a refusal a
    // retry can fix, never a credit read off the wrong account.
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer],
            loadedAddresses: { writable: 'ab', readonly: [recipient] },
            pre: [10_000_000, 0, 0, 0],
            post: [8_000_000, 0, 0, 1_000_000],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-bad-loaded', recipient, 'mainnet');

    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('recipient_mismatch');
  });

  it('refuses on the OTHER malformed half too, though nothing shifts', async () => {
    // The mirror of the row above, and it needs its own words because the harm
    // is not the same one. `readonly` is spread LAST, so junk characters there
    // move no real account off its slot - the recipient sits in the writable
    // half and would still be read correctly. What the guard buys here is that a
    // container malformed in one half is not PARTIALLY trusted: the merge falls
    // back to the static keys alone and the payment is refused.
    //
    // Checking only `writable` therefore still passes the row above, and only
    // this fixture tells the two apart.
    const recipient = makeAddress();
    const payer = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: [payer],
            loadedAddresses: { writable: [recipient], readonly: 'ab' },
            pre: [10_000_000, 0],
            post: [8_000_000, 1_000_000],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-bad-readonly', recipient, 'mainnet');

    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('recipient_mismatch');
  });

  it('refuses when the STATIC half is malformed, which shifts the most', async () => {
    // The same hostile or broken proxy, one field over. A string in
    // `accountKeys` is spread inside the prefix every balance index is read
    // against, so it does not merely add junk - it moves every loaded address
    // onto another account's slot. The merge therefore answers with no keys at
    // all rather than with a shifted list.
    const recipient = makeAddress();
    const rpc = createMockRpc(() => ({
      send: () =>
        Promise.resolve(
          makeTx({
            keys: 'ab' as unknown as (string | null)[],
            loadedAddresses: { writable: [recipient], readonly: [] },
            pre: [10_000_000, 0, 0],
            post: [8_000_000, 0, 1_000_000],
          }),
        ),
    }));

    const result = await verifyJobPaymentQuick(rpc, 'sig-bad-static', recipient, 'mainnet');

    expect(result.receivedFunds).toBe(false);
    expect(result.reason).toBe('recipient_mismatch');
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
