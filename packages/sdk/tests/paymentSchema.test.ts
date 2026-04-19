import { describe, expect, it } from 'vitest';
import { parsePaymentRequest, PaymentRequestSchema } from '../src';

const VALID_BASE58 = '11111111111111111111111111111111';

function valid(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    recipient: VALID_BASE58,
    amount: 1_000_000,
    reference: VALID_BASE58,
    fee_address: VALID_BASE58,
    fee_amount: 30_000,
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 600,
    ...overrides,
  });
}

describe('parsePaymentRequest', () => {
  it('accepts a well-formed request', () => {
    const result = parsePaymentRequest(valid());
    expect(result.ok).toBe(true);
  });

  it('rejects a non-JSON body', () => {
    const result = parsePaymentRequest('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_json');
    }
  });

  it('rejects a negative amount', () => {
    const result = parsePaymentRequest(valid({ amount: -1 }));
    expect(result.ok).toBe(false);
  });

  it('rejects a floating-point amount', () => {
    const result = parsePaymentRequest(valid({ amount: 1.5 }));
    expect(result.ok).toBe(false);
  });

  it('rejects Infinity', () => {
    // JSON.stringify turns Infinity into null, so the schema sees null not Infinity.
    const result = parsePaymentRequest('{"amount":null,"recipient":"x","reference":"x"}');
    expect(result.ok).toBe(false);
  });

  it('rejects non-integer string amount', () => {
    const result = parsePaymentRequest(valid({ amount: '1' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a very large amount over MAX_SAFE_INTEGER', () => {
    const result = parsePaymentRequest(valid({ amount: Number.MAX_SAFE_INTEGER + 1 }));
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed recipient (not base58)', () => {
    const result = parsePaymentRequest(valid({ recipient: 'not-base58!!!' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a missing reference', () => {
    const result = parsePaymentRequest(
      JSON.stringify({
        recipient: VALID_BASE58,
        amount: 1_000_000,
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects expiry_secs outside the LIMITS.MAX_TIMEOUT_SECS bound', () => {
    const result = parsePaymentRequest(valid({ expiry_secs: 99_999 }));
    expect(result.ok).toBe(false);
  });

  it('rejects amount above the caller-supplied maxAmountLamports', () => {
    const result = parsePaymentRequest(valid({ amount: 5_000_000 }), {
      maxAmountLamports: 2_000_000n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('amount_exceeds_max');
    }
  });

  it('accepts amount at exactly the maxAmountLamports cap', () => {
    const result = parsePaymentRequest(valid({ amount: 2_000_000 }), {
      maxAmountLamports: 2_000_000n,
    });
    expect(result.ok).toBe(true);
  });

  it('PaymentRequestSchema.safeParse mirrors parsePaymentRequest', () => {
    const result = PaymentRequestSchema.safeParse(JSON.parse(valid()));
    expect(result.success).toBe(true);
  });
});
