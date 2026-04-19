import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrashHarness, tick, type CrashHarness } from '../helpers/harness';

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
  harness = createCrashHarness();
});

afterEach(() => {
  harness.cleanup();
});

describe('integration: provider crashed after marking executed', () => {
  it('re-delivers the cached result without calling the skill again', async () => {
    const ID = 'executed-before-deliver';
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
    harness.ledger.markExecuted(ID, 'cached summary');

    const runPromise = harness.runtime.run();
    await tick(100);
    harness.runtime.stop();
    await runPromise.catch(() => undefined);

    // The skill must not re-execute when a cached result already exists;
    // the recovery path only re-delivers.
    expect(harness.skill.execute).not.toHaveBeenCalled();
    expect(harness.transport.deliverResult).toHaveBeenCalledOnce();
    const delivery = harness.transport.deliverResult.mock.calls[0];
    expect(delivery?.[1]).toBe('cached summary');
    expect(harness.ledger.getStatus(ID)).toBe('delivered');
  });
});
