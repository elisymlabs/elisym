import { type Address, type Rpc, type SolanaRpcApi, getAddressDecoder } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_FEE_BPS,
  PROTOCOL_TREASURY,
  USDC_SOLANA_DEVNET,
  calculateProtocolFee,
  estimateSolFeeLamports,
  formatFeeBreakdown,
} from '../src';

const ADDRESS_DECODER = getAddressDecoder();

function makeAddress(): Address {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return ADDRESS_DECODER.decode(bytes);
}

/**
 * Build an RPC stub that returns the supplied priority-fee samples and lets
 * the caller control whether `getAccountInfo` returns null (missing ATA) or
 * a populated value (existing ATA).
 */
function createMockRpc(options: {
  priorityFees?: Array<{ slot: number; prioritizationFee: bigint }>;
  atasExist?: boolean;
}): Rpc<SolanaRpcApi> {
  const fees = options.priorityFees ?? [
    { slot: 1, prioritizationFee: 1_000n },
    { slot: 2, prioritizationFee: 1_000n },
  ];
  const atasExist = options.atasExist ?? false;
  return {
    getRecentPrioritizationFees: () => ({
      send: () => Promise.resolve(fees),
    }),
    getMinimumBalanceForRentExemption: () => ({
      send: () => Promise.resolve(2_039_280n),
    }),
    getAccountInfo: () => ({
      send: () =>
        Promise.resolve({
          value: atasExist ? { lamports: 2_039_280n, data: new Uint8Array() } : null,
        }),
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

describe('estimateSolFeeLamports', () => {
  const payer = makeAddress();

  const usdcRequest = () => ({
    recipient: makeAddress(),
    amount: 50_000_000,
    reference: makeAddress(),
    fee_address: PROTOCOL_TREASURY as string,
    fee_amount: calculateProtocolFee(50_000_000, PROTOCOL_FEE_BPS),
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 600,
    asset: {
      chain: 'solana',
      token: 'usdc',
      mint: USDC_SOLANA_DEVNET.mint!,
      decimals: 6,
    },
  });

  it('SOL payment: rent is 0, total is base + priority', async () => {
    const rpc = createMockRpc({});
    const est = await estimateSolFeeLamports(
      rpc,
      {
        recipient: makeAddress(),
        amount: 1_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      payer,
    );
    expect(est.rentLamports).toBe(0n);
    expect(est.totalLamports).toBe(est.baseFeeLamports + est.priorityFeeLamports);
    expect(est.baseFeeLamports).toBe(5_000n);
  });

  it('USDC + both ATAs missing: rent = 2x rentPerAta', async () => {
    const rpc = createMockRpc({ atasExist: false });
    const est = await estimateSolFeeLamports(rpc, usdcRequest(), payer);
    expect(est.breakdown.missingAtaCount).toBe(2);
    expect(est.rentLamports).toBe(2n * 2_039_280n);
  });

  it('USDC + both ATAs exist: rent is 0', async () => {
    const rpc = createMockRpc({ atasExist: true });
    const est = await estimateSolFeeLamports(rpc, usdcRequest(), payer);
    expect(est.breakdown.missingAtaCount).toBe(0);
    expect(est.rentLamports).toBe(0n);
  });

  it('USDC without fee: missing ATA count is 1 when recipient ATA missing', async () => {
    const rpc = createMockRpc({ atasExist: false });
    const request = usdcRequest();
    const est = await estimateSolFeeLamports(
      rpc,
      {
        recipient: request.recipient,
        amount: request.amount,
        reference: request.reference,
        created_at: request.created_at,
        expiry_secs: request.expiry_secs,
        asset: request.asset,
      },
      payer,
    );
    expect(est.breakdown.missingAtaCount).toBe(1);
    expect(est.rentLamports).toBe(2_039_280n);
  });

  it('formatFeeBreakdown hides the ATA rent line when rentLamports=0', async () => {
    const rpc = createMockRpc({});
    const est = await estimateSolFeeLamports(
      rpc,
      {
        recipient: makeAddress(),
        amount: 1_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      payer,
    );
    const formatted = formatFeeBreakdown(est);
    expect(formatted).toContain('Base fee:');
    expect(formatted).toContain('Priority fee:');
    expect(formatted).toContain('Total:');
    expect(formatted).not.toContain('ATA rent:');
  });
});

// Satisfy import used only by another test file pattern
void vi;
