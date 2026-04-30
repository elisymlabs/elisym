import { getTransferSolInstructionDataDecoder } from '@solana-program/system';
import {
  type Address,
  type Blockhash,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  getAddressDecoder,
} from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  ELISYM_PROTOCOL_TAG,
  USDC_SOLANA_DEVNET,
  calculateProtocolFee,
  buildPaymentInstructions,
  SolanaPaymentStrategy,
  ProtocolConfigInput,
  parsePaymentRequest,
} from '../src';

const RANDOM_ADDRESS_BYTES = 32;
const ADDRESS_DECODER = getAddressDecoder();

function makeAddress(): Address {
  const bytes = new Uint8Array(RANDOM_ADDRESS_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return ADDRESS_DECODER.decode(bytes);
}

const TEST_FEE_BPS = 300;
const TEST_TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy' as Address;

const CONFIG: ProtocolConfigInput = {
  feeBps: TEST_FEE_BPS,
  treasury: TEST_TREASURY,
};

const payment = new SolanaPaymentStrategy();
const validAddress = makeAddress();

describe('calculateProtocolFee', () => {
  it('returns 0 for zero amount', () => {
    expect(calculateProtocolFee(0, TEST_FEE_BPS)).toBe(0);
  });

  it('returns 0 when feeBps is zero', () => {
    expect(calculateProtocolFee(1_000_000, 0)).toBe(0);
  });

  it('calculates 3% fee correctly (ceil)', () => {
    // 100_000_000 lamports (0.1 SOL) -> 3% = 3_000_000
    expect(calculateProtocolFee(100_000_000, TEST_FEE_BPS)).toBe(3_000_000);
  });

  it('rounds up (ceil) for non-divisible amounts', () => {
    // 1 lamport -> ceil(1 * 300 / 10000) = ceil(0.03) = 1
    expect(calculateProtocolFee(1, TEST_FEE_BPS)).toBe(1);
  });

  it('handles small amounts correctly', () => {
    // 10 lamports -> ceil(10 * 300 / 10000) = ceil(0.3) = 1
    expect(calculateProtocolFee(10, TEST_FEE_BPS)).toBe(1);
    // 100 lamports -> ceil(100 * 300 / 10000) = ceil(3) = 3
    expect(calculateProtocolFee(100, TEST_FEE_BPS)).toBe(3);
    // 333 lamports -> ceil(333 * 300 / 10000) = ceil(9.99) = 10
    expect(calculateProtocolFee(333, TEST_FEE_BPS)).toBe(10);
  });

  it('handles 1 SOL', () => {
    // 1_000_000_000 lamports -> 3% = 30_000_000
    expect(calculateProtocolFee(1_000_000_000, TEST_FEE_BPS)).toBe(30_000_000);
  });

  it('handles large amounts without overflow', () => {
    // 100 SOL = 100_000_000_000 lamports -> 3% = 3_000_000_000
    expect(calculateProtocolFee(100_000_000_000, TEST_FEE_BPS)).toBe(3_000_000_000);
  });

  it('throws on negative amount', () => {
    expect(() => calculateProtocolFee(-1, TEST_FEE_BPS)).toThrow('non-negative');
    expect(() => calculateProtocolFee(-100_000_000, TEST_FEE_BPS)).toThrow('non-negative');
  });

  it('throws on negative feeBps', () => {
    expect(() => calculateProtocolFee(100, -1)).toThrow('feeBps');
  });

  it('matches basis points formula: ceil(amount * BPS / 10000)', () => {
    const amounts = [1, 33, 100, 999, 1337, 50000, 140_000_000, 1_000_000_000];
    for (const amount of amounts) {
      const expected = Math.ceil((amount * TEST_FEE_BPS) / 10_000);
      expect(calculateProtocolFee(amount, TEST_FEE_BPS)).toBe(expected);
    }
  });
});

describe('SolanaPaymentStrategy.validatePaymentRequest', () => {
  const recipientAddr = makeAddress();
  const referenceAddr = makeAddress();
  const otherAddr = makeAddress();
  const validRequest = {
    recipient: recipientAddr,
    amount: 140_000_000,
    reference: referenceAddr,
    fee_address: TEST_TREASURY,
    fee_amount: calculateProtocolFee(140_000_000, TEST_FEE_BPS),
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 3600,
  };

  it('accepts valid payment request', () => {
    const result = payment.validatePaymentRequest(
      JSON.stringify(validRequest),
      CONFIG,
      recipientAddr,
    );
    expect(result).toBeNull();
  });

  it('rejects invalid JSON', () => {
    const result = payment.validatePaymentRequest('not json', CONFIG);
    expect(result?.code).toBe('invalid_json');
    expect(result?.message).toContain('Invalid payment request JSON');
  });

  it('rejects recipient mismatch', () => {
    const result = payment.validatePaymentRequest(JSON.stringify(validRequest), CONFIG, otherAddr);
    expect(result?.code).toBe('recipient_mismatch');
    expect(result?.message).toContain('Recipient mismatch');
  });

  it('rejects wrong fee address', () => {
    const badRequest = { ...validRequest, fee_address: otherAddr };
    const result = payment.validatePaymentRequest(JSON.stringify(badRequest), CONFIG);
    expect(result?.code).toBe('fee_address_mismatch');
    expect(result?.message).toContain('Fee address mismatch');
  });

  it('rejects wrong fee amount', () => {
    const badRequest = { ...validRequest, fee_amount: 1 };
    const result = payment.validatePaymentRequest(JSON.stringify(badRequest), CONFIG);
    expect(result?.code).toBe('fee_amount_mismatch');
    expect(result?.message).toContain('Fee amount mismatch');
  });

  it('rejects missing fee', () => {
    const { fee_address: _a, fee_amount: _b, ...noFee } = validRequest;
    const result = payment.validatePaymentRequest(JSON.stringify(noFee), CONFIG);
    expect(result?.code).toBe('missing_fee');
    expect(result?.message).toContain('missing protocol fee');
  });

  it('accepts without expected recipient', () => {
    const result = payment.validatePaymentRequest(JSON.stringify(validRequest), CONFIG);
    expect(result).toBeNull();
  });

  it('accepts fee_amount=0 when feeBps=0 (legal on-chain state)', () => {
    // Regression: set_fee_bps enforces <= MAX_FEE_BPS but not > 0. When an admin
    // sets feeBps=0, createPaymentRequest emits fee_address=treasury, fee_amount=0.
    // validatePaymentRequest must accept the same request it just produced.
    const zeroFeeConfig = { feeBps: 0, treasury: TEST_TREASURY };
    const zeroFeeRequest = { ...validRequest, fee_amount: 0 };
    const result = payment.validatePaymentRequest(
      JSON.stringify(zeroFeeRequest),
      zeroFeeConfig,
      recipientAddr,
    );
    expect(result).toBeNull();
  });
});

describe('SolanaPaymentStrategy.createPaymentRequest', () => {
  it('creates a payment request with correct fee', () => {
    const pr = payment.createPaymentRequest(validAddress, 100_000_000, CONFIG);
    expect(pr.recipient).toBe(validAddress);
    expect(pr.amount).toBe(100_000_000);
    expect(pr.fee_address).toBe(TEST_TREASURY);
    expect(pr.fee_amount).toBe(3_000_000);
    expect(pr.reference).toBeTruthy();
    expect(pr.created_at).toBeGreaterThan(0);
    expect(pr.expiry_secs).toBe(600);
  });

  it('respects custom expirySecs option', () => {
    const pr = payment.createPaymentRequest(validAddress, 100_000_000, CONFIG, {
      expirySecs: 120,
    });
    expect(pr.expiry_secs).toBe(120);
  });

  it('rejects zero amount', () => {
    expect(() => payment.createPaymentRequest(validAddress, 0, CONFIG)).toThrow(
      'Invalid payment amount',
    );
  });

  it('rejects negative amount', () => {
    expect(() => payment.createPaymentRequest(validAddress, -100, CONFIG)).toThrow(
      'Invalid payment amount',
    );
  });

  it('rejects NaN', () => {
    expect(() => payment.createPaymentRequest(validAddress, NaN, CONFIG)).toThrow(
      'Invalid payment amount',
    );
  });

  it('rejects Infinity', () => {
    expect(() => payment.createPaymentRequest(validAddress, Infinity, CONFIG)).toThrow(
      'Invalid payment amount',
    );
  });

  it('rejects invalid treasury in config', () => {
    expect(() =>
      payment.createPaymentRequest(validAddress, 100_000_000, {
        feeBps: TEST_FEE_BPS,
        treasury: 'not-a-valid-address' as Address,
      }),
    ).toThrow('Invalid treasury address');
  });
});

describe('buildPaymentInstructions', () => {
  function makeSigner(addressValue: Address): { address: Address } {
    return { address: addressValue };
  }

  it('produces 2 instructions when fee is present', async () => {
    const signer = makeSigner(makeAddress());
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        fee_address: TEST_TREASURY,
        fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
    );
    expect(instructions.length).toBe(3);
  });

  it('produces 1 instruction when fee is absent', async () => {
    const signer = makeSigner(makeAddress());
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
    );
    expect(instructions.length).toBe(2);
  });

  it('fee + providerAmount === totalAmount for various amounts', async () => {
    interface TransferIxLike {
      data: Uint8Array;
    }
    const dataDecoder = getTransferSolInstructionDataDecoder();
    const decodeAmount = (ix: TransferIxLike): bigint => dataDecoder.decode(ix.data).amount;
    const signer = makeSigner(makeAddress());
    const amounts = [10, 33, 100, 333, 999, 1337, 50_000, 140_000_000, 1_000_000_000];
    for (const amount of amounts) {
      const fee = calculateProtocolFee(amount, TEST_FEE_BPS);
      const instructions = await buildPaymentInstructions(
        {
          recipient: makeAddress(),
          amount,
          reference: makeAddress(),
          fee_address: TEST_TREASURY,
          fee_amount: fee,
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
        },
        signer as never,
      );
      const provider = decodeAmount(instructions[0] as TransferIxLike);
      const feeIx = instructions[1] as TransferIxLike | undefined;
      const feeLamports = feeIx ? decodeAmount(feeIx) : 0n;
      expect(Number(provider) + Number(feeLamports)).toBe(amount);
    }
  });

  it('attaches reference + protocol tag as read-only non-signer accounts on provider transfer', async () => {
    interface IxLike {
      accounts: ReadonlyArray<{ address: string; role: number }>;
    }
    const reference = makeAddress();
    const signer = makeSigner(makeAddress());
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference,
        fee_address: TEST_TREASURY,
        fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
    );
    const providerIx = instructions[0] as IxLike;
    const tail = providerIx.accounts.slice(-2);
    expect(tail[0]?.address).toBe(reference);
    expect(tail[0]?.role).toBe(0);
    expect(tail[1]?.address).toBe(ELISYM_PROTOCOL_TAG);
    expect(tail[1]?.role).toBe(0);
  });

  it('prepends an SPL Memo instruction when jobEventId is provided', async () => {
    interface IxLike {
      programAddress: string;
      data: Uint8Array;
    }
    const jobEventId = 'a'.repeat(64);
    const signer = makeSigner(makeAddress());
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
      { jobEventId },
    );
    expect(instructions.length).toBe(3);
    const memoIx = instructions[0] as IxLike;
    // SPL Memo program ID
    expect(memoIx.programAddress).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const decoded = new TextDecoder().decode(memoIx.data);
    expect(decoded).toBe(`elisym:v1:${jobEventId}`);
  });

  it('omits the memo instruction when jobEventId is absent', async () => {
    const signer = makeSigner(makeAddress());
    const instructions = await buildPaymentInstructions(
      {
        recipient: makeAddress(),
        amount: 100_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      signer as never,
    );
    expect(instructions.length).toBe(2);
  });
});

describe('SolanaPaymentStrategy.buildTransaction', () => {
  function createMockRpc(): Rpc<SolanaRpcApi> {
    return {
      getLatestBlockhash: () => ({
        send: () =>
          Promise.resolve({
            value: {
              blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi' as Blockhash,
              lastValidBlockHeight: 1000n,
            },
          }),
      }),
      getTransaction: vi.fn(),
      getSignaturesForAddress: vi.fn(),
    } as unknown as Rpc<SolanaRpcApi>;
  }

  function makeSigner(addressValue: Address): { address: Address; signMessage: () => never } {
    return {
      address: addressValue,
      signMessage: () => {
        throw new Error('not implemented');
      },
    };
  }

  it('throws on negative provider amount (fee > amount)', async () => {
    const signer = makeSigner(makeAddress());
    await expect(
      payment.buildTransaction(
        {
          recipient: makeAddress(),
          amount: 100,
          reference: makeAddress(),
          fee_address: TEST_TREASURY,
          fee_amount: 999,
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
        },
        signer as never,
        createMockRpc(),
        CONFIG,
      ),
    ).rejects.toThrow('non-positive provider amount');
  });

  it('throws on fee_address not matching configured treasury', async () => {
    const signer = makeSigner(makeAddress());
    await expect(
      payment.buildTransaction(
        {
          recipient: makeAddress(),
          amount: 100_000_000,
          reference: makeAddress(),
          fee_address: makeAddress(),
          fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 600,
        },
        signer as never,
        createMockRpc(),
        CONFIG,
      ),
    ).rejects.toThrow('Invalid fee address');
  });

  it('throws on expired payment request', async () => {
    const signer = makeSigner(makeAddress());
    await expect(
      payment.buildTransaction(
        {
          recipient: makeAddress(),
          amount: 100_000_000,
          reference: makeAddress(),
          fee_address: TEST_TREASURY,
          fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
          created_at: Math.floor(Date.now() / 1000) - 7200,
          expiry_secs: 3600,
        },
        signer as never,
        createMockRpc(),
        CONFIG,
      ),
    ).rejects.toThrow('expired');
  });
});

describe('SolanaPaymentStrategy.validatePaymentRequest - expiry', () => {
  it('rejects expired payment request', () => {
    const expired = {
      recipient: makeAddress(),
      amount: 100_000_000,
      reference: makeAddress(),
      fee_address: TEST_TREASURY,
      fee_amount: calculateProtocolFee(100_000_000, TEST_FEE_BPS),
      created_at: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
      expiry_secs: 3600, // 1 hour expiry
    };
    const result = payment.validatePaymentRequest(JSON.stringify(expired), CONFIG);
    expect(result?.code).toBe('expired');
    expect(result?.message).toContain('expired');
  });
});

// --- verifyPayment tests ---

describe('SolanaPaymentStrategy.verifyPayment', () => {
  const recipientAddr = makeAddress();
  const referenceAddr = makeAddress();
  const amount = 100_000_000;
  const feeAmount = calculateProtocolFee(amount, TEST_FEE_BPS);
  const netAmount = amount - feeAmount;

  function makePR(overrides?: Record<string, unknown>) {
    return {
      recipient: recipientAddr,
      amount,
      reference: referenceAddr,
      fee_address: TEST_TREASURY,
      fee_amount: feeAmount,
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
      ...overrides,
    };
  }

  function makeTx(opts: { keys: (string | null)[]; pre: number[]; post: number[]; err?: unknown }) {
    return {
      meta: {
        err: opts.err ?? null,
        preBalances: opts.pre.map((value) => BigInt(value)),
        postBalances: opts.post.map((value) => BigInt(value)),
      },
      transaction: {
        message: {
          accountKeys: opts.keys,
        },
      },
    };
  }

  function createMockRpc(
    overrides: {
      getTransaction?: (...args: unknown[]) => unknown;
      getSignaturesForAddress?: (...args: unknown[]) => unknown;
    } = {},
  ): Rpc<SolanaRpcApi> {
    const wrap = <T>(value: T) => ({ send: () => Promise.resolve(value) });
    const getTransactionImpl = overrides.getTransaction ?? (() => wrap<unknown>(null));
    const getSignaturesForAddressImpl =
      overrides.getSignaturesForAddress ?? (() => wrap<unknown[]>([]));
    return {
      getLatestBlockhash: () =>
        wrap({ value: { blockhash: 'mock' as Blockhash, lastValidBlockHeight: 1n } }),
      getTransaction: (...args: unknown[]) => getTransactionImpl(...args),
      getSignaturesForAddress: (...args: unknown[]) => getSignaturesForAddressImpl(...args),
    } as unknown as Rpc<SolanaRpcApi>;
  }

  const FAST = { retries: 1, intervalMs: 10 };

  describe('by signature', () => {
    const payerAddr = makeAddress();

    it('verifies valid payment', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'validSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(true);
      expect(result.txSignature).toBe('validSig');
    });

    it('rejects transaction without reference key (replay attack)', async () => {
      const wrongRef = makeAddress();
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, wrongRef, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'replaySig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Reference key not found');
    });

    it('rejects failed transaction', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [0, 0, 0, 0],
                post: [0, 0, 0, 0],
                err: { InstructionError: [0, 'Custom'] },
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'failedSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('failed on-chain');
    });

    it('rejects insufficient recipient amount', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000, 1_000, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'lowSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Recipient received');
    });

    it('rejects insufficient fee', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, 1],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'lowFeeSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Treasury received');
    });

    it('verifies correctly with sparse account keys (null key in middle)', async () => {
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, null, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0, 0],
                post: [200_000_000 - amount, 0, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'sparseSig' as Signature,
        ...FAST,
      });
      expect(result.verified).toBe(true);
    });

    it('retries on pending transaction', async () => {
      let calls = 0;
      const rpc = createMockRpc({
        getTransaction: () => ({
          send: () => {
            calls++;
            if (calls < 3) return Promise.resolve(null);
            return Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, feeAmount],
              }),
            );
          },
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, {
        txSignature: 'pendingSig' as Signature,
        retries: 5,
        intervalMs: 10,
      });
      expect(result.verified).toBe(true);
      expect(calls).toBe(3);
    });
  });

  describe('by reference', () => {
    const payerAddr = makeAddress();

    it('verifies valid payment by reference', async () => {
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({
          send: () => Promise.resolve([{ signature: 'refSig1' as Signature, err: null }]),
        }),
        getTransaction: () => ({
          send: () =>
            Promise.resolve(
              makeTx({
                keys: [payerAddr, recipientAddr, referenceAddr, TEST_TREASURY],
                pre: [200_000_000, 0, 0, 0],
                post: [200_000_000 - amount, netAmount, 0, feeAmount],
              }),
            ),
        }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, FAST);
      expect(result.verified).toBe(true);
      expect(result.txSignature).toBe('refSig1');
    });

    it('returns error when no matching signatures found', async () => {
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({ send: () => Promise.resolve([]) }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, FAST);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('No matching transaction found');
    });

    it('skips errored signatures', async () => {
      const rpc = createMockRpc({
        getSignaturesForAddress: () => ({
          send: () =>
            Promise.resolve([
              { signature: 'failSig' as Signature, err: { InstructionError: 'x' } },
            ]),
        }),
        getTransaction: () => ({ send: () => Promise.resolve(null) }),
      });

      const result = await payment.verifyPayment(rpc, makePR(), CONFIG, FAST);
      expect(result.verified).toBe(false);
    });
  });

  describe('input validation', () => {
    it('rejects invalid rpc', async () => {
      const result = await payment.verifyPayment(
        null as unknown as Rpc<SolanaRpcApi>,
        makePR(),
        CONFIG,
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid rpc');
    });

    it('rejects zero amount', async () => {
      const result = await payment.verifyPayment(createMockRpc(), makePR({ amount: 0 }), CONFIG);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid payment amount');
    });

    it('rejects negative amount', async () => {
      const result = await payment.verifyPayment(createMockRpc(), makePR({ amount: -1 }), CONFIG);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid payment amount');
    });

    it('rejects fee below required', async () => {
      const result = await payment.verifyPayment(
        createMockRpc(),
        makePR({ fee_amount: 1 }),
        CONFIG,
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Protocol fee');
    });

    it('rejects wrong fee address', async () => {
      const result = await payment.verifyPayment(
        createMockRpc(),
        makePR({ fee_address: makeAddress() }),
        CONFIG,
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid fee address');
    });

    it('rejects fee exceeding amount', async () => {
      const result = await payment.verifyPayment(
        createMockRpc(),
        makePR({ fee_amount: amount + 1 }),
        CONFIG,
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('exceeds or equals');
    });
  });
});

describe('USDC (SPL) payment flow', () => {
  it('parsePaymentRequest accepts an asset field', () => {
    const req = {
      recipient: validAddress,
      amount: 50_000_000,
      reference: makeAddress(),
      fee_address: TEST_TREASURY,
      fee_amount: calculateProtocolFee(50_000_000, TEST_FEE_BPS),
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
      asset: {
        chain: 'solana',
        token: 'usdc',
        mint: USDC_SOLANA_DEVNET.mint,
        decimals: 6,
      },
    };
    const result = parsePaymentRequest(JSON.stringify(req));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.asset?.token).toBe('usdc');
    }
  });

  it('parsePaymentRequest without asset stays backwards-compatible (defaults to SOL)', () => {
    const req = {
      recipient: validAddress,
      amount: 100_000_000,
      reference: makeAddress(),
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
    };
    const result = parsePaymentRequest(JSON.stringify(req));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.asset).toBeUndefined();
    }
  });

  it('validatePaymentRequest rejects unknown asset with invalid_asset code', () => {
    const req = {
      recipient: validAddress,
      amount: 50_000_000,
      reference: makeAddress(),
      fee_address: TEST_TREASURY,
      fee_amount: calculateProtocolFee(50_000_000, TEST_FEE_BPS),
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
      asset: {
        chain: 'solana',
        token: 'doge',
        mint: makeAddress(),
        decimals: 8,
      },
    };
    const err = payment.validatePaymentRequest(JSON.stringify(req), CONFIG, validAddress);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('invalid_asset');
  });

  it('createPaymentRequest embeds asset when provided', () => {
    const req = payment.createPaymentRequest(validAddress, 50_000_000, CONFIG, {
      asset: USDC_SOLANA_DEVNET,
    });
    expect(req.asset?.token).toBe('usdc');
    expect(req.asset?.mint).toBe(USDC_SOLANA_DEVNET.mint);
    expect(req.asset?.decimals).toBe(6);
  });

  it('createPaymentRequest omits asset when native SOL is selected', () => {
    const req = payment.createPaymentRequest(validAddress, 100_000_000, CONFIG);
    expect(req.asset).toBeUndefined();
  });

  it('buildPaymentInstructions emits ATA create + TransferChecked for SPL', async () => {
    const signer = {
      address: makeAddress(),
    };
    const recipient = makeAddress();
    const reference = makeAddress();
    const instructions = await buildPaymentInstructions(
      {
        recipient,
        amount: 50_000_000,
        reference,
        fee_address: TEST_TREASURY,
        fee_amount: calculateProtocolFee(50_000_000, TEST_FEE_BPS),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
        asset: {
          chain: 'solana',
          token: 'usdc',
          mint: USDC_SOLANA_DEVNET.mint,
          decimals: 6,
        },
      },
      signer as never,
    );
    // Expect: 2x ATA create (recipient + treasury) + 2x TransferChecked (provider + fee) + increment_stats
    expect(instructions.length).toBe(5);

    interface IxLike {
      accounts: ReadonlyArray<{ address: string; role: number }>;
    }
    // TransferChecked with reference + protocol tag is ix[2] (after the two ATA creates).
    const providerIx = instructions[2] as IxLike;
    const tail = providerIx.accounts.slice(-2);
    expect(tail[0]?.address).toBe(reference);
    expect(tail[0]?.role).toBe(0);
    expect(tail[1]?.address).toBe(ELISYM_PROTOCOL_TAG);
    expect(tail[1]?.role).toBe(0);
  });
});
