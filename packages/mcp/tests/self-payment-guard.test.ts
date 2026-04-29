/**
 * regression tests for the self-payment guard in customer tools.
 *
 * Without this guard, an agent whose `solanaKeypair.publicKey` matches the
 * provider card's `payment.address` would publish a Nostr job and subsequently
 * sign a SOL/USDC transfer that lands back in its own wallet, paying the
 * protocol fee and gas for nothing. The guard short-circuits before
 * `submitJobRequest`, so we assert on the call count.
 */
import { nip19 } from 'nostr-tools';
import { describe, it, expect, vi } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { customerTools } from '../src/tools/customer.js';

const SHARED_WALLET = 'So1aNaSharedWallet11111111111111111111111111';
const OTHER_WALLET = 'So1aNaOtherWallet1111111111111111111111111111';
const VALID_PROVIDER_NPUB = nip19.npubEncode('a'.repeat(64));

function findTool(name: string) {
  const tool = customerTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in customerTools`);
  return tool;
}

function buildStubAgent(opts: {
  fetchAgents: ReturnType<typeof vi.fn>;
  submitJobRequest?: ReturnType<typeof vi.fn>;
  walletPubkey?: string;
  pingAgent?: ReturnType<typeof vi.fn>;
}): AgentInstance {
  const submitJobRequest = opts.submitJobRequest ?? vi.fn();
  const pingAgent = opts.pingAgent ?? vi.fn(async () => ({ online: true, identity: null }));
  const identity = {
    publicKey: 'd'.repeat(64),
    npub: nip19.npubEncode('d'.repeat(64)),
    secretKey: new Uint8Array(32),
  };
  const client = {
    discovery: { fetchAgents: opts.fetchAgents },
    marketplace: {
      submitJobRequest,
      subscribeToJobUpdates: vi.fn(() => () => {}),
    },
    ping: { pingAgent },
  };
  return {
    client: client as never,
    identity: identity as never,
    name: 'stub',
    network: 'devnet',
    security: {},
    solanaKeypair: opts.walletPubkey
      ? { publicKey: opts.walletPubkey, secretKey: new Uint8Array(64) }
      : undefined,
  };
}

function ctxWith(agent: AgentInstance): AgentContext {
  const ctx = new AgentContext();
  ctx.register(agent);
  return ctx;
}

function paidProviderCard(address: string) {
  return {
    npub: VALID_PROVIDER_NPUB,
    name: 'self-provider',
    cards: [
      {
        name: 'do-thing',
        description: 'paid capability',
        capabilities: ['do-thing'],
        payment: {
          chain: 'solana' as const,
          address,
          token: 'sol' as const,
          job_price: 1000,
        },
      },
    ],
  };
}

describe('submit_and_pay_job self-payment guard', () => {
  it('refuses to submit when the customer wallet matches the provider payment address', async () => {
    const fetchAgents = vi.fn(async () => [paidProviderCard(SHARED_WALLET)]);
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents,
      submitJobRequest,
      walletPubkey: SHARED_WALLET,
    });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'self-pay attempt',
      provider_npub: VALID_PROVIDER_NPUB,
      capability: 'do-thing',
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Cannot buy from yourself/);
    expect(result.content[0]?.text).toContain(SHARED_WALLET);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('proceeds past the guard when wallets differ', async () => {
    const fetchAgents = vi.fn(async () => [paidProviderCard(OTHER_WALLET)]);
    const submitJobRequest = vi.fn(async () => 'job-event-id');
    const agent = buildStubAgent({
      fetchAgents,
      submitJobRequest,
      walletPubkey: SHARED_WALLET,
    });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'normal buy',
      provider_npub: VALID_PROVIDER_NPUB,
      capability: 'do-thing',
      timeout_secs: 1,
    });

    const resultPromise = tool.handler(ctx, input);
    await new Promise((r) => setTimeout(r, 10));
    expect(submitJobRequest).toHaveBeenCalledTimes(1);
    void resultPromise;
  });
});

describe('buy_capability self-payment guard', () => {
  it('refuses to submit when the customer wallet matches the provider payment address', async () => {
    const fetchAgents = vi.fn(async () => [paidProviderCard(SHARED_WALLET)]);
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents,
      submitJobRequest,
      walletPubkey: SHARED_WALLET,
    });
    const ctx = ctxWith(agent);

    const tool = findTool('buy_capability');
    const input = tool.schema.parse({
      provider_npub: VALID_PROVIDER_NPUB,
      capability: 'do-thing',
      max_price_lamports: 10_000,
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Cannot buy from yourself/);
    expect(result.content[0]?.text).toContain(SHARED_WALLET);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('proceeds past the guard when wallets differ', async () => {
    const fetchAgents = vi.fn(async () => [paidProviderCard(OTHER_WALLET)]);
    const submitJobRequest = vi.fn(async () => 'job-event-id');
    const agent = buildStubAgent({
      fetchAgents,
      submitJobRequest,
      walletPubkey: SHARED_WALLET,
    });
    const ctx = ctxWith(agent);

    const tool = findTool('buy_capability');
    const input = tool.schema.parse({
      provider_npub: VALID_PROVIDER_NPUB,
      capability: 'do-thing',
      max_price_lamports: 10_000,
      timeout_secs: 1,
    });

    const resultPromise = tool.handler(ctx, input);
    await new Promise((r) => setTimeout(r, 10));
    expect(submitJobRequest).toHaveBeenCalledTimes(1);
    void resultPromise;
  });
});
