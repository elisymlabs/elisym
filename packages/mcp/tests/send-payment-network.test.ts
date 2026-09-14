/**
 * Cross-network payment-request rejection through the `send_payment` tool.
 *
 * `send_payment` is the manual/DM-initiated payment path that bypasses
 * discovery isolation entirely, so it must inherit the SDK's network-mismatch
 * rejection from `validatePaymentRequest` (customer network = the agent's
 * configured network). `fetchProtocolConfig` is stubbed so no RPC traffic
 * happens; the SDK validation itself runs for real.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentContext, fetchProtocolConfig, type AgentInstance } from '../src/context.js';
import { walletTools } from '../src/tools/wallet.js';

vi.mock('../src/context.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/context.js')>();
  return { ...actual, fetchProtocolConfig: vi.fn() };
});

const WALLET = '9vSzxkCJiEuGwYnJGo17XsofAANM5GMzBg5rJquejs7o';
const RECIPIENT = '2miSgJ98vQWckZkdnBU7WtaRJQkdHY8UZJzqwC6FBFdM';
const REFERENCE = '4ARYGgibfQDcERcBj8E8pjcoE5SmeHXsAHe2HvYKvY78';
const TREASURY = 'CYWTDfv5keEpddQRkpYCuSGkzPkMRh2UWsw7zrgoC4QP';

function findTool(name: string) {
  const tool = walletTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} not found in walletTools`);
  return tool;
}

function stubAgent(network: AgentInstance['network']): AgentInstance {
  return {
    client: {} as never,
    identity: {} as never,
    name: 'net-test',
    network,
    security: {},
    solanaKeypair: { publicKey: WALLET, secretKey: new Uint8Array(64) },
  };
}

function ctxWith(agent: AgentInstance): AgentContext {
  const ctx = new AgentContext();
  ctx.register(agent);
  return ctx;
}

function requestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    recipient: RECIPIENT,
    amount: 1_000,
    reference: REFERENCE,
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 300,
    ...overrides,
  });
}

afterEach(() => {
  vi.mocked(fetchProtocolConfig).mockReset();
});

describe('send_payment per-network asset membership (M4)', () => {
  const tool = findTool('send_payment');
  const LSM_MINT = '86T4G3zJaBxQAuWAbfXggE5d5XEt4bns3Y41jgVLpump';
  const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('devnet agent refuses an LSM request even when the caller expects lsm', async () => {
    vi.mocked(fetchProtocolConfig).mockResolvedValue({ feeBps: 0, treasury: TREASURY });
    const result = await tool.handler(
      ctxWith(stubAgent('devnet')),
      tool.schema.parse({
        payment_request: requestJson({
          network: 'devnet',
          asset: { chain: 'solana', token: 'lsm', mint: LSM_MINT, decimals: 6 },
        }),
        expected_solana_recipient: RECIPIENT,
        expected_asset: 'lsm',
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not available on devnet/);
  });

  it('devnet agent refuses the wrong-network USDC variant (mainnet mint, devnet-tagged request)', async () => {
    vi.mocked(fetchProtocolConfig).mockResolvedValue({ feeBps: 0, treasury: TREASURY });
    const result = await tool.handler(
      ctxWith(stubAgent('devnet')),
      tool.schema.parse({
        payment_request: requestJson({
          network: 'devnet',
          asset: { chain: 'solana', token: 'usdc', mint: MAINNET_USDC_MINT, decimals: 6 },
        }),
        expected_solana_recipient: RECIPIENT,
        expected_asset: 'usdc',
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not available on devnet/);
  });
});

describe('send_payment cross-network rejection', () => {
  const tool = findTool('send_payment');

  it('devnet agent rejects a request that settles on mainnet', async () => {
    vi.mocked(fetchProtocolConfig).mockResolvedValue({ feeBps: 0, treasury: TREASURY });
    const result = await tool.handler(
      ctxWith(stubAgent('devnet')),
      tool.schema.parse({
        payment_request: requestJson({ network: 'mainnet' }),
        expected_solana_recipient: RECIPIENT,
        expected_asset: 'sol',
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/network mismatch/i);
    expect(result.content[0]?.text).toMatch(/mainnet/);
  });

  it('mainnet agent rejects a legacy request with no network field (treated as devnet)', async () => {
    vi.mocked(fetchProtocolConfig).mockResolvedValue({ feeBps: 0, treasury: TREASURY });
    const result = await tool.handler(
      ctxWith(stubAgent('mainnet')),
      tool.schema.parse({
        payment_request: requestJson(),
        expected_solana_recipient: RECIPIENT,
        expected_asset: 'sol',
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/network mismatch/i);
    expect(result.content[0]?.text).toMatch(/devnet/);
  });

  it('same-network request passes the network gate (fails later, on the fee check)', async () => {
    vi.mocked(fetchProtocolConfig).mockResolvedValue({ feeBps: 0, treasury: TREASURY });
    // fee_amount > 0 under a zero on-chain rate: proves validation got PAST the
    // network gate for a same-network request and rejected on money grounds.
    const result = await tool.handler(
      ctxWith(stubAgent('devnet')),
      tool.schema.parse({
        payment_request: requestJson({
          network: 'devnet',
          fee_address: TREASURY,
          fee_amount: 5,
        }),
        expected_solana_recipient: RECIPIENT,
        expected_asset: 'sol',
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toMatch(/network mismatch/i);
  });
});
