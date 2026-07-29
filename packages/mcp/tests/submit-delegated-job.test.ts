/**
 * submit_delegated_job pre-submit guards + proof emission.
 *
 * The tool must verify (card advertises delegation, on-chain delegation active
 * for the SAME delegate key, cap and balance cover the price) BEFORE publishing
 * anything - a published delegated job burns a single-use proof. The emission
 * test verifies the proof round-trips through the SDK verifier with the exact
 * (delegate, author, owner) binding the provider will check.
 */
import {
  DELEGATION_NONCE_REGEX,
  MAX_PROOF_TTL_SECS,
  USDC_SOLANA_DEVNET,
  exportKeyPairBytes,
  generateSolanaWallet,
  verifyDelegationAuthProof,
} from '@elisym/sdk';
import type { DelegationStatus } from '@elisym/sdk';
import type { KeyPairSigner } from '@solana/kit';
import { nip19 } from 'nostr-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { customerTools } from '../src/tools/customer.js';

let mockDelegation: DelegationStatus | null = null;

vi.mock('@solana/kit', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, createSolanaRpc: vi.fn(() => ({})) };
});

vi.mock('@elisym/sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, getDelegation: vi.fn(async () => mockDelegation) };
});

const PRICE = 50_000; // 0.05 USDC

function findTool(name: string) {
  const tool = customerTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} not found in customerTools`);
  return tool;
}

let ownerSigner: KeyPairSigner;
let ownerSecretBytes: Uint8Array;
let delegateAddress: string;
const PROVIDER_NPUB = nip19.npubEncode('a'.repeat(64));

function providerCard(withDelegation = true) {
  return {
    npub: PROVIDER_NPUB,
    name: 'Delegated Provider',
    cards: [
      {
        name: 'delegated-skill',
        description: 'a USDC skill',
        capabilities: ['delegated-skill'],
        payment: {
          chain: 'solana',
          network: 'devnet',
          address: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
          job_price: PRICE,
          token: 'usdc',
          mint: USDC_SOLANA_DEVNET.mint,
          decimals: 6,
          symbol: 'USDC',
        },
        ...(withDelegation
          ? {
              delegation: {
                mechanism: 'spl-approve',
                suggested_cap_subunits: '50000000',
                delegate_pubkey: delegateAddress,
              },
            }
          : {}),
      },
    ],
  };
}

function buildStubAgent(opts: {
  fetchAgents: ReturnType<typeof vi.fn>;
  submitJobRequest?: ReturnType<typeof vi.fn>;
  subscribeToJobUpdates?: ReturnType<typeof vi.fn>;
}): AgentInstance {
  const identity = {
    publicKey: 'd'.repeat(64),
    npub: nip19.npubEncode('d'.repeat(64)),
    secretKey: new Uint8Array(32),
  };
  const client = {
    discovery: { fetchAgents: opts.fetchAgents },
    marketplace: {
      submitJobRequest: opts.submitJobRequest ?? vi.fn(),
      subscribeToJobUpdates: opts.subscribeToJobUpdates ?? vi.fn(() => () => {}),
    },
    ping: { pingAgent: vi.fn(async () => ({ online: true, identity: null })) },
  };
  return {
    client: client as never,
    identity: identity as never,
    name: 'stub',
    network: 'devnet',
    security: {},
    solanaKeypair: { publicKey: ownerSigner.address, secretKey: ownerSecretBytes },
  };
}

function ctxWith(agent: AgentInstance): AgentContext {
  const ctx = new AgentContext();
  ctx.register(agent);
  return ctx;
}

function activeDelegation(overrides: Partial<DelegationStatus> = {}): DelegationStatus {
  return {
    delegate: delegateAddress,
    remainingCap: 10_000_000n,
    mint: USDC_SOLANA_DEVNET.mint ?? '',
    owner: ownerSigner.address,
    balance: 10_000_000n,
    ...overrides,
  } as DelegationStatus;
}

beforeEach(async () => {
  vi.clearAllMocks();
  const ownerWallet = await generateSolanaWallet();
  ownerSigner = ownerWallet.signer;
  ownerSecretBytes = await exportKeyPairBytes(ownerSigner);
  const delegateWallet = await generateSolanaWallet();
  delegateAddress = delegateWallet.signer.address;
  mockDelegation = null;
});

async function callTool(agent: AgentInstance, extraInput: Record<string, unknown> = {}) {
  const tool = findTool('submit_delegated_job');
  const input = tool.schema.parse({
    input: 'do the work',
    provider_npub: PROVIDER_NPUB,
    capability: 'delegated-skill',
    max_price_lamports: PRICE,
    timeout_secs: 1,
    ...extraInput,
  });
  return tool.handler(ctxWith(agent), input);
}

describe('submit_delegated_job pre-submit guards', () => {
  it('refuses when the capability advertises no delegation descriptor', async () => {
    mockDelegation = activeDelegation();
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard(false)]),
      submitJobRequest,
    });
    const result = await callTool(agent);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/does not advertise delegated payment/i);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('refuses when there is no active delegation on-chain', async () => {
    mockDelegation = null;
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard()]),
      submitJobRequest,
    });
    const result = await callTool(agent);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/No active delegation/i);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('refuses when the on-chain delegate differs from the card delegate (rotated key)', async () => {
    mockDelegation = activeDelegation({
      delegate: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
    });
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard()]),
      submitJobRequest,
    });
    const result = await callTool(agent);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/granted to/i);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('refuses when the remaining cap is below the price', async () => {
    mockDelegation = activeDelegation({ remainingCap: BigInt(PRICE - 1) });
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard()]),
      submitJobRequest,
    });
    const result = await callTool(agent);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Remaining delegated cap/i);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('refuses when the balance is below the price', async () => {
    mockDelegation = activeDelegation({ balance: BigInt(PRICE - 1) });
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard()]),
      submitJobRequest,
    });
    const result = await callTool(agent);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/balance/i);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('returns a price confirmation (no publish) when max_price_lamports is omitted', async () => {
    mockDelegation = activeDelegation();
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard()]),
      submitJobRequest,
    });
    const result = await callTool(agent, { max_price_lamports: undefined });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toMatch(/max_price_lamports/);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });
});

describe('submit_delegated_job proof emission', () => {
  it('emits a verifiable single-use proof bound to the card delegate + agent author', async () => {
    mockDelegation = activeDelegation();
    const submitJobRequest = vi.fn(async () => 'job-event-1');
    // Resolve the wait immediately with a result carrying the pull tx tag.
    const subscribeToJobUpdates = vi.fn(
      (options: {
        callbacks: {
          onResult?: (
            content: string,
            eventId: string,
            attachment?: unknown,
            attachments?: unknown[],
            paymentTx?: string,
          ) => void;
        };
      }) => {
        queueMicrotask(() =>
          options.callbacks.onResult?.(
            'all done',
            'result-ev-1',
            undefined,
            undefined,
            'pull-sig-1',
          ),
        );
        return () => {};
      },
    );
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard()]),
      submitJobRequest,
      subscribeToJobUpdates: subscribeToJobUpdates as never,
    });

    const before = Math.floor(Date.now() / 1000);
    const result = await callTool(agent);
    const after = Math.floor(Date.now() / 1000);

    expect(submitJobRequest).toHaveBeenCalledTimes(1);
    const submitted = submitJobRequest.mock.calls[0]?.[1] as {
      capability: string;
      providerPubkey: string;
      delegatedPayment: { owner: string; expiryUnix: number; nonce: string; proof: string };
    };
    expect(submitted.capability).toBe('delegated-skill');
    const { owner, expiryUnix, nonce, proof } = submitted.delegatedPayment;
    expect(owner).toBe(ownerSigner.address);
    expect(nonce).toMatch(DELEGATION_NONCE_REGEX);
    expect(expiryUnix).toBeGreaterThanOrEqual(before + MAX_PROOF_TTL_SECS);
    expect(expiryUnix).toBeLessThanOrEqual(after + MAX_PROOF_TTL_SECS);

    // The proof verifies EXACTLY as the provider will verify it.
    await expect(
      verifyDelegationAuthProof({
        agentDelegate: delegateAddress,
        nostrAuthor: 'd'.repeat(64),
        owner,
        expiryUnix,
        nonce,
        proof,
      }),
    ).resolves.toBe(true);
    // ...and fails against any other delegate (cross-provider replay).
    await expect(
      verifyDelegationAuthProof({
        agentDelegate: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
        nostrAuthor: 'd'.repeat(64),
        owner,
        expiryUnix,
        nonce,
        proof,
      }),
    ).resolves.toBe(false);

    // The pull tx from the result event's `tx` tag is surfaced.
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toMatch(/pull_tx=pull-sig-1/);
    expect(result.content[0]?.text).toMatch(/event_id=job-event-1/);
  });
});
