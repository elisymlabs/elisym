import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, it, expect } from 'vitest';
import { PROTOCOL_FEE_BPS, PROTOCOL_TREASURY } from '../src/constants';
import { calculateProtocolFee } from '../src/payment/fee';
import { SolanaPaymentStrategy } from '../src/payment/solana';

const payment = new SolanaPaymentStrategy();
const validAddress = Keypair.generate().publicKey.toBase58();

describe('calculateProtocolFee', () => {
  it('returns 0 for zero amount', () => {
    expect(calculateProtocolFee(0)).toBe(0);
  });

  it('calculates 3% fee correctly (ceil)', () => {
    // 100_000_000 lamports (0.1 SOL) -> 3% = 3_000_000
    expect(calculateProtocolFee(100_000_000)).toBe(3_000_000);
  });

  it('rounds up (ceil) for non-divisible amounts', () => {
    // 1 lamport -> ceil(1 * 300 / 10000) = ceil(0.03) = 1
    expect(calculateProtocolFee(1)).toBe(1);
  });

  it('handles small amounts correctly', () => {
    // 10 lamports -> ceil(10 * 300 / 10000) = ceil(0.3) = 1
    expect(calculateProtocolFee(10)).toBe(1);
    // 100 lamports -> ceil(100 * 300 / 10000) = ceil(3) = 3
    expect(calculateProtocolFee(100)).toBe(3);
    // 333 lamports -> ceil(333 * 300 / 10000) = ceil(9.99) = 10
    expect(calculateProtocolFee(333)).toBe(10);
  });

  it('handles 1 SOL', () => {
    // 1_000_000_000 lamports -> 3% = 30_000_000
    expect(calculateProtocolFee(1_000_000_000)).toBe(30_000_000);
  });

  it('handles large amounts without overflow', () => {
    // 100 SOL = 100_000_000_000 lamports -> 3% = 3_000_000_000
    expect(calculateProtocolFee(100_000_000_000)).toBe(3_000_000_000);
  });

  it('throws on negative amount', () => {
    expect(() => calculateProtocolFee(-1)).toThrow('non-negative');
    expect(() => calculateProtocolFee(-100_000_000)).toThrow('non-negative');
  });

  it('matches basis points formula: ceil(amount * BPS / 10000)', () => {
    const amounts = [1, 33, 100, 999, 1337, 50000, 140_000_000, 1_000_000_000];
    for (const amount of amounts) {
      const expected = Math.ceil((amount * PROTOCOL_FEE_BPS) / 10_000);
      expect(calculateProtocolFee(amount)).toBe(expected);
    }
  });
});

describe('SolanaPaymentStrategy.validatePaymentRequest', () => {
  const recipientAddr = Keypair.generate().publicKey.toBase58();
  const referenceAddr = Keypair.generate().publicKey.toBase58();
  const otherAddr = Keypair.generate().publicKey.toBase58();
  const validRequest = {
    recipient: recipientAddr,
    amount: 140_000_000,
    reference: referenceAddr,
    fee_address: PROTOCOL_TREASURY,
    fee_amount: calculateProtocolFee(140_000_000),
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 3600,
  };

  it('accepts valid payment request', () => {
    const result = payment.validatePaymentRequest(JSON.stringify(validRequest), recipientAddr);
    expect(result).toBeNull();
  });

  it('rejects invalid JSON', () => {
    const result = payment.validatePaymentRequest('not json');
    expect(result?.code).toBe('invalid_json');
    expect(result?.message).toContain('Invalid payment request JSON');
  });

  it('rejects recipient mismatch', () => {
    const result = payment.validatePaymentRequest(JSON.stringify(validRequest), otherAddr);
    expect(result?.code).toBe('recipient_mismatch');
    expect(result?.message).toContain('Recipient mismatch');
  });

  it('rejects wrong fee address', () => {
    const badRequest = { ...validRequest, fee_address: otherAddr };
    const result = payment.validatePaymentRequest(JSON.stringify(badRequest));
    expect(result?.code).toBe('fee_address_mismatch');
    expect(result?.message).toContain('Fee address mismatch');
  });

  it('rejects wrong fee amount', () => {
    const badRequest = { ...validRequest, fee_amount: 1 };
    const result = payment.validatePaymentRequest(JSON.stringify(badRequest));
    expect(result?.code).toBe('fee_amount_mismatch');
    expect(result?.message).toContain('Fee amount mismatch');
  });

  it('rejects missing fee', () => {
    const { fee_address: _a, fee_amount: _b, ...noFee } = validRequest;
    const result = payment.validatePaymentRequest(JSON.stringify(noFee));
    expect(result?.code).toBe('missing_fee');
    expect(result?.message).toContain('missing protocol fee');
  });

  it('accepts without expected recipient', () => {
    const result = payment.validatePaymentRequest(JSON.stringify(validRequest));
    expect(result).toBeNull();
  });
});

describe('SolanaPaymentStrategy.createPaymentRequest', () => {
  it('creates a payment request with correct fee', () => {
    const pr = payment.createPaymentRequest(validAddress, 100_000_000);
    expect(pr.recipient).toBe(validAddress);
    expect(pr.amount).toBe(100_000_000);
    expect(pr.fee_address).toBe(PROTOCOL_TREASURY);
    expect(pr.fee_amount).toBe(3_000_000);
    expect(pr.reference).toBeTruthy();
    expect(pr.created_at).toBeGreaterThan(0);
    expect(pr.expiry_secs).toBe(600);
  });

  it('rejects zero amount', () => {
    expect(() => payment.createPaymentRequest(validAddress, 0)).toThrow('Invalid payment amount');
  });

  it('rejects negative amount', () => {
    expect(() => payment.createPaymentRequest(validAddress, -100)).toThrow(
      'Invalid payment amount',
    );
  });

  it('rejects NaN', () => {
    expect(() => payment.createPaymentRequest(validAddress, NaN)).toThrow('Invalid payment amount');
  });

  it('rejects Infinity', () => {
    expect(() => payment.createPaymentRequest(validAddress, Infinity)).toThrow(
      'Invalid payment amount',
    );
  });
});

describe('SolanaPaymentStrategy.buildTransaction', () => {
  it('throws on negative provider amount (fee > amount)', async () => {
    const { PublicKey } = require('@solana/web3.js');
    await expect(
      payment.buildTransaction(Keypair.generate().publicKey.toBase58(), {
        recipient: Keypair.generate().publicKey.toBase58(),
        amount: 100,
        reference: Keypair.generate().publicKey.toBase58(),
        fee_address: PROTOCOL_TREASURY,
        fee_amount: 999,
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      }),
    ).rejects.toThrow('non-positive provider amount');
  });

  it('fee + providerAmount === totalAmount for various amounts', async () => {
    // Skip amounts where fee >= amount (e.g. 1 lamport: fee=1, providerAmount=0)
    const amounts = [10, 33, 100, 333, 999, 1337, 50_000, 140_000_000, 1_000_000_000];
    for (const amount of amounts) {
      const fee = calculateProtocolFee(amount);
      const tx = await payment.buildTransaction(Keypair.generate().publicKey.toBase58(), {
        recipient: Keypair.generate().publicKey.toBase58(),
        amount,
        reference: Keypair.generate().publicKey.toBase58(),
        fee_address: PROTOCOL_TREASURY,
        fee_amount: fee,
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      });
      // Provider transfer is first instruction, fee transfer is second
      const providerLamports =
        (tx.instructions[0] as any).data.readBigUInt64LE?.(4) ??
        Number((tx.instructions[0] as any).lamports);
      const feeLamports = tx.instructions[1]
        ? ((tx.instructions[1] as any).data.readBigUInt64LE?.(4) ??
          Number((tx.instructions[1] as any).lamports))
        : 0;
      // Verify the invariant: fee + provider = total
      expect(Number(providerLamports) + Number(feeLamports)).toBe(amount);
    }
  });
});

describe('SolanaPaymentStrategy.validatePaymentRequest - expiry', () => {
  it('rejects expired payment request', () => {
    const expired = {
      recipient: Keypair.generate().publicKey.toBase58(),
      amount: 100_000_000,
      reference: Keypair.generate().publicKey.toBase58(),
      fee_address: PROTOCOL_TREASURY,
      fee_amount: calculateProtocolFee(100_000_000),
      created_at: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
      expiry_secs: 3600, // 1 hour expiry
    };
    const result = payment.validatePaymentRequest(JSON.stringify(expired));
    expect(result?.code).toBe('expired');
    expect(result?.message).toContain('expired');
  });
});

describe('SolanaPaymentStrategy.buildTransaction - fee address', () => {
  it('throws on fee_address not matching PROTOCOL_TREASURY', async () => {
    await expect(
      payment.buildTransaction(Keypair.generate().publicKey.toBase58(), {
        recipient: Keypair.generate().publicKey.toBase58(),
        amount: 100_000_000,
        reference: Keypair.generate().publicKey.toBase58(),
        fee_address: Keypair.generate().publicKey.toBase58(),
        fee_amount: calculateProtocolFee(100_000_000),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      }),
    ).rejects.toThrow('Invalid fee address');
  });
});

// --- verifyPayment tests ---

describe('SolanaPaymentStrategy.verifyPayment', () => {
  const recipientAddr = Keypair.generate().publicKey.toBase58();
  const referenceAddr = Keypair.generate().publicKey.toBase58();
  const amount = 100_000_000;
  const feeAmount = calculateProtocolFee(amount);
  const netAmount = amount - feeAmount;

  function makePR(overrides?: Record<string, unknown>) {
    return {
      recipient: recipientAddr,
      amount,
      reference: referenceAddr,
      fee_address: PROTOCOL_TREASURY,
      fee_amount: feeAmount,
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
      ...overrides,
    };
  }

  function makeKeys(...addrs: string[]) {
    return {
      length: addrs.length,
      get(i: number) {
        return addrs[i] ? { toBase58: () => addrs[i] } : null;
      },
    };
  }

  function makeTx(opts: { keys: string[]; pre: number[]; post: number[]; err?: unknown }) {
    return {
      meta: {
        err: opts.err ?? null,
        preBalances: opts.pre,
        postBalances: opts.post,
      },
      transaction: {
        message: { getAccountKeys: () => makeKeys(...opts.keys) },
      },
    };
  }

  function mockConn(
    overrides: {
      getTransaction?: (...args: unknown[]) => unknown;
      getSignaturesForAddress?: (...args: unknown[]) => unknown;
    } = {},
  ) {
    return {
      getTransaction: overrides.getTransaction ?? (() => Promise.resolve(null)),
      getSignaturesForAddress: overrides.getSignaturesForAddress ?? (() => Promise.resolve([])),
    };
  }

  const FAST = { retries: 1, intervalMs: 10 };

  describe('by signature', () => {
    const payerAddr = Keypair.generate().publicKey.toBase58();

    it('verifies valid payment', async () => {
      const conn = mockConn({
        getTransaction: () =>
          Promise.resolve(
            makeTx({
              keys: [payerAddr, recipientAddr, referenceAddr, PROTOCOL_TREASURY],
              pre: [200_000_000, 0, 0, 0],
              post: [200_000_000 - amount, netAmount, 0, feeAmount],
            }),
          ),
      });

      const result = await payment.verifyPayment(conn, makePR(), {
        txSignature: 'validSig',
        ...FAST,
      });
      expect(result.verified).toBe(true);
      expect(result.txSignature).toBe('validSig');
    });

    it('rejects transaction without reference key (replay attack)', async () => {
      const wrongRef = Keypair.generate().publicKey.toBase58();
      const conn = mockConn({
        getTransaction: () =>
          Promise.resolve(
            makeTx({
              keys: [payerAddr, recipientAddr, wrongRef, PROTOCOL_TREASURY],
              pre: [200_000_000, 0, 0, 0],
              post: [200_000_000 - amount, netAmount, 0, feeAmount],
            }),
          ),
      });

      const result = await payment.verifyPayment(conn, makePR(), {
        txSignature: 'replaySig',
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Reference key not found');
    });

    it('rejects failed transaction', async () => {
      const conn = mockConn({
        getTransaction: () =>
          Promise.resolve(
            makeTx({
              keys: [payerAddr, recipientAddr, referenceAddr, PROTOCOL_TREASURY],
              pre: [0, 0, 0, 0],
              post: [0, 0, 0, 0],
              err: { InstructionError: [0, 'Custom'] },
            }),
          ),
      });

      const result = await payment.verifyPayment(conn, makePR(), {
        txSignature: 'failedSig',
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('failed on-chain');
    });

    it('rejects insufficient recipient amount', async () => {
      const conn = mockConn({
        getTransaction: () =>
          Promise.resolve(
            makeTx({
              keys: [payerAddr, recipientAddr, referenceAddr, PROTOCOL_TREASURY],
              pre: [200_000_000, 0, 0, 0],
              post: [200_000_000, 1_000, 0, feeAmount],
            }),
          ),
      });

      const result = await payment.verifyPayment(conn, makePR(), {
        txSignature: 'lowSig',
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Recipient received');
    });

    it('rejects insufficient fee', async () => {
      const conn = mockConn({
        getTransaction: () =>
          Promise.resolve(
            makeTx({
              keys: [payerAddr, recipientAddr, referenceAddr, PROTOCOL_TREASURY],
              pre: [200_000_000, 0, 0, 0],
              post: [200_000_000 - amount, netAmount, 0, 1],
            }),
          ),
      });

      const result = await payment.verifyPayment(conn, makePR(), {
        txSignature: 'lowFeeSig',
        ...FAST,
      });
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Treasury received');
    });

    it('verifies correctly with sparse account keys (null key in middle)', async () => {
      const conn = mockConn({
        getTransaction: () =>
          Promise.resolve({
            meta: {
              err: null,
              // 5 balance entries: payer(0), null(1), recipient(2), reference(3), treasury(4)
              preBalances: [200_000_000, 0, 0, 0, 0],
              postBalances: [200_000_000 - amount, 0, netAmount, 0, feeAmount],
            },
            transaction: {
              message: {
                getAccountKeys: () => ({
                  length: 5,
                  get(i: number) {
                    const addrs = [
                      payerAddr,
                      null,
                      recipientAddr,
                      referenceAddr,
                      PROTOCOL_TREASURY,
                    ];
                    const a = addrs[i];
                    return a ? { toBase58: () => a } : null;
                  },
                }),
              },
            },
          }),
      });

      const result = await payment.verifyPayment(conn, makePR(), {
        txSignature: 'sparseSig',
        ...FAST,
      });
      expect(result.verified).toBe(true);
    });

    it('retries on pending transaction', async () => {
      let calls = 0;
      const conn = mockConn({
        getTransaction: () => {
          calls++;
          if (calls < 3) return Promise.resolve(null);
          return Promise.resolve(
            makeTx({
              keys: [payerAddr, recipientAddr, referenceAddr, PROTOCOL_TREASURY],
              pre: [200_000_000, 0, 0, 0],
              post: [200_000_000 - amount, netAmount, 0, feeAmount],
            }),
          );
        },
      });

      const result = await payment.verifyPayment(conn, makePR(), {
        txSignature: 'pendingSig',
        retries: 5,
        intervalMs: 10,
      });
      expect(result.verified).toBe(true);
      expect(calls).toBe(3);
    });
  });

  describe('by reference', () => {
    const payerAddr = Keypair.generate().publicKey.toBase58();

    it('verifies valid payment by reference', async () => {
      const conn = mockConn({
        getSignaturesForAddress: () => Promise.resolve([{ signature: 'refSig1', err: null }]),
        getTransaction: () =>
          Promise.resolve(
            makeTx({
              keys: [payerAddr, recipientAddr, referenceAddr, PROTOCOL_TREASURY],
              pre: [200_000_000, 0, 0, 0],
              post: [200_000_000 - amount, netAmount, 0, feeAmount],
            }),
          ),
      });

      const result = await payment.verifyPayment(conn, makePR(), FAST);
      expect(result.verified).toBe(true);
      expect(result.txSignature).toBe('refSig1');
    });

    it('returns error when no matching signatures found', async () => {
      const conn = mockConn({
        getSignaturesForAddress: () => Promise.resolve([]),
      });

      const result = await payment.verifyPayment(conn, makePR(), FAST);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('No matching transaction found');
    });

    it('skips errored signatures', async () => {
      const conn = mockConn({
        getSignaturesForAddress: () =>
          Promise.resolve([{ signature: 'failSig', err: { InstructionError: 'x' } }]),
        getTransaction: () => Promise.resolve(null),
      });

      const result = await payment.verifyPayment(conn, makePR(), FAST);
      expect(result.verified).toBe(false);
    });
  });

  describe('input validation', () => {
    it('rejects invalid connection', async () => {
      const result = await payment.verifyPayment(null, makePR());
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid connection');
    });

    it('rejects zero amount', async () => {
      const result = await payment.verifyPayment(mockConn(), makePR({ amount: 0 }));
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid payment amount');
    });

    it('rejects negative amount', async () => {
      const result = await payment.verifyPayment(mockConn(), makePR({ amount: -1 }));
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid payment amount');
    });

    it('rejects fee below required', async () => {
      const result = await payment.verifyPayment(mockConn(), makePR({ fee_amount: 1 }));
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Protocol fee');
    });

    it('rejects wrong fee address', async () => {
      const result = await payment.verifyPayment(
        mockConn(),
        makePR({ fee_address: Keypair.generate().publicKey.toBase58() }),
      );
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Invalid fee address');
    });

    it('rejects fee exceeding amount', async () => {
      const result = await payment.verifyPayment(mockConn(), makePR({ fee_amount: amount + 1 }));
      expect(result.verified).toBe(false);
      expect(result.error).toContain('exceeds or equals');
    });
  });
});
