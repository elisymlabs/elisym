/**
 * Unit tests for the `approve_delegation` / `revoke_delegation` PRE-SIGNING
 * guards. The sign/send path (a real signer + websocket confirm) is exercised by
 * the live devnet e2e, not here. `getDelegation` is stubbed via `vi.mock` (with
 * the rest of `@elisym/sdk` kept real) so the refuse-replace and session-budget
 * paths are drivable without decoding a live SPL token account.
 */
import { assetKey, generateSolanaWallet, getDelegation, USDC_SOLANA_DEVNET } from '@elisym/sdk';
import { address, getBase58Encoder } from '@solana/kit';
import { nip19 } from 'nostr-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentContext, fetchProtocolConfig, type AgentInstance } from '../src/context.js';
import { walletTools } from '../src/tools/wallet.js';

vi.mock('@elisym/sdk', async (importActual) => {
  const actual = await importActual<typeof import('@elisym/sdk')>();
  return { ...actual, getDelegation: vi.fn() };
});

vi.mock('../src/context.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/context.js')>();
  return { ...actual, fetchProtocolConfig: vi.fn() };
});

const OWNER = '9vSzxkCJiEuGwYnJGo17XsofAANM5GMzBg5rJquejs7o';
const DELEGATE_A = '2miSgJ98vQWckZkdnBU7WtaRJQkdHY8UZJzqwC6FBFdM';
const DELEGATE_B = '4ARYGgibfQDcERcBj8E8pjcoE5SmeHXsAHe2HvYKvY78';
const PROVIDER_HEX = 'a'.repeat(64);

function findTool(name: string) {
  const tool = walletTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} not found in walletTools`);
  return tool;
}

function providerWithDelegation(delegateKeys: string[]) {
  return {
    npub: nip19.npubEncode(PROVIDER_HEX),
    name: 'delegation-provider',
    cards: delegateKeys.map((key, index) => ({
      name: `cap-${index}`,
      description: 'delegation capability',
      capabilities: [`cap-${index}`],
      delegation: {
        mechanism: 'spl-approve' as const,
        suggested_cap_subunits: '5000000',
        delegate_pubkey: key,
      },
    })),
  };
}

function buildStubAgent(opts: {
  fetchAgent: ReturnType<typeof vi.fn>;
  walletPubkey?: string;
  secretKey?: Uint8Array;
}): AgentInstance {
  const identity = {
    publicKey: 'd'.repeat(64),
    npub: nip19.npubEncode('d'.repeat(64)),
    secretKey: new Uint8Array(32),
  };
  const client = {
    discovery: { fetchAgent: opts.fetchAgent },
    marketplace: {},
    ping: {},
  };
  return {
    client: client as never,
    identity: identity as never,
    name: 'stub',
    network: 'devnet',
    security: {},
    solanaKeypair:
      opts.walletPubkey === undefined
        ? undefined
        : { publicKey: opts.walletPubkey, secretKey: opts.secretKey ?? new Uint8Array(64) },
  };
}

function ctxWith(agent: AgentInstance): AgentContext {
  const ctx = new AgentContext();
  ctx.register(agent);
  return ctx;
}

afterEach(() => {
  delete process.env.ELISYM_ALLOW_DELEGATION;
  vi.mocked(getDelegation).mockReset();
  vi.mocked(fetchProtocolConfig).mockReset();
});

describe('approve_delegation guards', () => {
  const tool = findTool('approve_delegation');

  it('rejects when the gate is off', async () => {
    delete process.env.ELISYM_ALLOW_DELEGATION;
    const agent = buildStubAgent({ fetchAgent: vi.fn(), walletPubkey: OWNER });
    const result = await tool.handler(
      ctxWith(agent),
      tool.schema.parse({ provider: PROVIDER_HEX, cap_usdc: '5' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/ELISYM_ALLOW_DELEGATION/);
  });

  it('rejects when no Solana key is configured (before the gate)', async () => {
    process.env.ELISYM_ALLOW_DELEGATION = '1';
    const agent = buildStubAgent({ fetchAgent: vi.fn() });
    const result = await tool.handler(
      ctxWith(agent),
      tool.schema.parse({ provider: PROVIDER_HEX, cap_usdc: '5' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not configured/);
  });

  it('rejects when the provider is not found on the network', async () => {
    process.env.ELISYM_ALLOW_DELEGATION = '1';
    const fetchAgent = vi.fn(async () => null);
    const agent = buildStubAgent({ fetchAgent, walletPubkey: OWNER });
    const result = await tool.handler(
      ctxWith(agent),
      tool.schema.parse({ provider: PROVIDER_HEX, cap_usdc: '5' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not found/);
  });

  it('rejects when the provider advertises no delegation', async () => {
    process.env.ELISYM_ALLOW_DELEGATION = '1';
    const fetchAgent = vi.fn(async () => ({
      npub: nip19.npubEncode(PROVIDER_HEX),
      name: 'no-deleg',
      cards: [{ name: 'x', description: '', capabilities: ['x'] }],
    }));
    const agent = buildStubAgent({ fetchAgent, walletPubkey: OWNER });
    const result = await tool.handler(
      ctxWith(agent),
      tool.schema.parse({ provider: PROVIDER_HEX, cap_usdc: '5' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/does not advertise/);
  });

  it('rejects when the provider advertises conflicting delegate keys', async () => {
    process.env.ELISYM_ALLOW_DELEGATION = '1';
    const fetchAgent = vi.fn(async () => providerWithDelegation([DELEGATE_A, DELEGATE_B]));
    const agent = buildStubAgent({ fetchAgent, walletPubkey: OWNER });
    const result = await tool.handler(
      ctxWith(agent),
      tool.schema.parse({ provider: PROVIDER_HEX, cap_usdc: '5' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/conflicting/);
  });

  it('refuses to silently replace a different existing delegate', async () => {
    process.env.ELISYM_ALLOW_DELEGATION = '1';
    vi.mocked(getDelegation).mockResolvedValue({
      delegate: DELEGATE_B,
      remainingCap: 1_000_000n,
      mint: USDC_SOLANA_DEVNET.mint ?? '',
      owner: OWNER,
      balance: 0n,
    });
    const fetchAgent = vi.fn(async () => providerWithDelegation([DELEGATE_A]));
    const agent = buildStubAgent({ fetchAgent, walletPubkey: OWNER });
    const result = await tool.handler(
      ctxWith(agent),
      tool.schema.parse({ provider: PROVIDER_HEX, cap_usdc: '5' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/already delegates to a different key/);
    expect(result.content[0]?.text).toContain(DELEGATE_B);
  });

  it('bypasses the refuse-replace guard when replace_existing is set', async () => {
    process.env.ELISYM_ALLOW_DELEGATION = '1';
    vi.mocked(getDelegation).mockResolvedValue({
      delegate: DELEGATE_B,
      remainingCap: 1_000_000n,
      mint: USDC_SOLANA_DEVNET.mint ?? '',
      owner: OWNER,
      balance: 0n,
    });
    const fetchAgent = vi.fn(async () => providerWithDelegation([DELEGATE_A]));
    // Invalid-length secret so agentSigner throws before any network I/O; we assert
    // only that the different-delegate refuse guard was bypassed (not the on-chain
    // result, which the live devnet e2e covers).
    const agent = buildStubAgent({
      fetchAgent,
      walletPubkey: OWNER,
      secretKey: new Uint8Array(10),
    });
    const result = await tool.handler(
      ctxWith(agent),
      tool.schema.parse({ provider: PROVIDER_HEX, cap_usdc: '5', replace_existing: true }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toMatch(/already delegates to a different key/);
    expect(result.content[0]?.text).toMatch(/Approve failed/);
  });

  it('rejects an approve whose protocol fee exceeds the session USDC cap', async () => {
    process.env.ELISYM_ALLOW_DELEGATION = '1';
    vi.mocked(getDelegation).mockResolvedValue(null);
    vi.mocked(fetchProtocolConfig).mockResolvedValue({ feeBps: 500, treasury: address(OWNER) });
    const fetchAgent = vi.fn(async () => providerWithDelegation([DELEGATE_A]));
    // A real keypair so agentSigner succeeds and the flow reaches reserveSpend.
    const wallet = await generateSolanaWallet();
    const secretKey = new Uint8Array(getBase58Encoder().encode(wallet.secretKeyBase58));
    const agent = buildStubAgent({ fetchAgent, walletPubkey: wallet.signer.address, secretKey });
    const ctx = ctxWith(agent);
    ctx.sessionSpendLimits.set(assetKey(USDC_SOLANA_DEVNET), 1_000n); // 0.001 USDC session cap
    // cap 5 USDC at feeBps 500 (5%) -> fee 0.25 USDC = 250_000 subunits, far over the cap.
    const result = await tool.handler(
      ctx,
      tool.schema.parse({ provider: PROVIDER_HEX, cap_usdc: '5' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Session spend limit reached/);
  });
});

describe('revoke_delegation guard', () => {
  const tool = findTool('revoke_delegation');

  it('rejects when no Solana key is configured', async () => {
    const agent = buildStubAgent({ fetchAgent: vi.fn() });
    const result = await tool.handler(ctxWith(agent), tool.schema.parse({}));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not configured/);
  });
});
