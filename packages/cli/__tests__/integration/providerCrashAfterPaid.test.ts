import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrashHarness, tick, type CrashHarness } from '../helpers/harness';

// Mock SDK payment helpers + solana kit the same way runtime.test.ts does,
// so recovery's on-chain fetches short-circuit instead of making real RPC calls.
vi.mock('@elisym/sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SolanaPaymentStrategy: vi.fn().mockImplementation(() => ({
      createPaymentRequest: vi.fn().mockReturnValue({
        recipient: 'addr',
        amount: 100_000,
        reference: 'ref',
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      }),
      verifyPayment: vi.fn().mockResolvedValue({ verified: true, txSignature: 'tx-sig' }),
    })),
    getProtocolConfig: vi.fn().mockResolvedValue({
      feeBps: 300,
      treasury: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
      admin: '11111111111111111111111111111111',
      pendingAdmin: null,
      paused: false,
      version: 1,
      source: 'onchain',
    }),
    getProtocolProgramId: vi.fn().mockReturnValue('BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE'),
  };
});

vi.mock('@solana/kit', () => ({
  createSolanaRpc: vi.fn().mockReturnValue({
    getTransaction: vi.fn(),
  }),
}));

let harness: CrashHarness;

beforeEach(() => {
  harness = createCrashHarness({ skillResult: 'summary text' });
});

afterEach(() => {
  harness.cleanup();
});

describe('integration: provider crashed after marking paid', () => {
  it('re-executes the skill on startup and delivers the result', async () => {
    const ID = 'paid-before-execute';
    harness.ledger.recordPaid({
      job_id: ID,
      input: 'please summarize',
      input_type: 'text',
      tags: ['elisym', 'text-gen'],
      customer_id: 'customer-pk',
      net_amount: 1_940_000,
      raw_event_json: JSON.stringify({
        id: ID,
        pubkey: 'customer-pk',
        created_at: Math.floor(Date.now() / 1000),
        kind: 5100,
        tags: [
          ['t', 'elisym'],
          ['t', 'text-gen'],
        ],
        content: 'please summarize',
        sig: 'sig',
      }),
      created_at: Math.floor(Date.now() / 1000),
    });

    const runPromise = harness.runtime.run();
    await tick(100);
    harness.runtime.stop();
    await runPromise.catch(() => undefined);

    expect(harness.skill.execute).toHaveBeenCalledOnce();
    expect(harness.transport.deliverResult).toHaveBeenCalledOnce();
    const delivery = harness.transport.deliverResult.mock.calls[0];
    expect(delivery?.[1]).toBe('summary text');
    expect(harness.ledger.getStatus(ID)).toBe('delivered');
  });
});
