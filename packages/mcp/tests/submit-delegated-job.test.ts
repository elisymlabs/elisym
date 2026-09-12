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
  assetKey,
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

// Observe what lands in the buyer's own job history. The recorded spend figure
// is provider-asserted, so it must be bounded before it is written.
const appendCustomerJobSpy = vi.fn(async () => {});
vi.mock('../src/storage/customer-history.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    appendCustomerJob: (...args: unknown[]) => appendCustomerJobSpy(...(args as [])),
  };
});

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

function providerCard(withDelegation = true, metered?: { min_subunits: string }) {
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
        ...(metered ? { metered } : {}),
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
    // `recordJobOutcome` is a no-op without an agentDir, so the history
    // assertions below would silently observe nothing. The writer itself is
    // mocked, so no file is touched.
    agentDir: '/tmp/elisym-stub-agent',
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

async function callTool(
  agent: AgentInstance,
  extraInput: Record<string, unknown> = {},
  ctx?: AgentContext,
) {
  const tool = findTool('submit_delegated_job');
  const input = tool.schema.parse({
    input: 'do the work',
    provider_npub: PROVIDER_NPUB,
    capability: 'delegated-skill',
    max_price_lamports: PRICE,
    timeout_secs: 1,
    ...extraInput,
  });
  return tool.handler(ctx ?? ctxWith(agent), input);
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

  it('quotes a RANGE for a metered card, not a flat price', async () => {
    // The card price is the ceiling on a metered capability, so quoting it as a
    // flat "costs X" would overstate the usual charge several-fold.
    mockDelegation = activeDelegation();
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard(true, { min_subunits: '1000' })]),
      submitJobRequest,
    });
    const result = await callTool(agent, { max_price_lamports: undefined });
    expect(result.isError).not.toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/billed for what it actually uses/i);
    expect(text).toMatch(/from 0\.001/);
    expect(text).toMatch(/never more than/i);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('bounds a provider-asserted settled amount before writing it to buyer history', async () => {
    // The `amount` tag is provider-controlled and reaches us through a parser
    // that accepts negatives and prefix-parses garbage. A hostile provider must
    // not be able to write an arbitrary spend into the customer's own record
    // while the on-chain pull moved something else - so it is clamped to the
    // ceiling the buyer approved.
    mockDelegation = activeDelegation();
    const subscribeToJobUpdates = vi.fn(
      (options: {
        callbacks: {
          onResult?: (
            content: string,
            eventId: string,
            attachment?: unknown,
            attachments?: unknown[],
            paymentTx?: string,
            paidAmountSubunits?: number,
          ) => void;
        };
      }) => {
        queueMicrotask(() =>
          // Ten times the card price - a figure the buyer never approved.
          options.callbacks.onResult?.('done', 'ev', undefined, undefined, 'sig', PRICE * 10),
        );
        return () => {};
      },
    );
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard(true, { min_subunits: '1000' })]),
      submitJobRequest: vi.fn(async () => 'job-ev'),
      subscribeToJobUpdates: subscribeToJobUpdates as never,
    });

    await callTool(agent);

    const recorded = appendCustomerJobSpy.mock.calls.at(-1)?.[1] as
      | { paidAmountSubunits?: string }
      | undefined;
    expect(recorded?.paidAmountSubunits).toBe(String(PRICE));
  });

  it('ignores the reported amount entirely on a FLAT card', async () => {
    // A flat capability always pulls exactly the advertised price, so its own
    // card is the authority. Trusting a provider figure here would let one lie
    // about a spend that is known by construction.
    mockDelegation = activeDelegation();
    const subscribeToJobUpdates = vi.fn(
      (options: {
        callbacks: {
          onResult?: (
            content: string,
            eventId: string,
            attachment?: unknown,
            attachments?: unknown[],
            paymentTx?: string,
            paidAmountSubunits?: number,
          ) => void;
        };
      }) => {
        queueMicrotask(() =>
          options.callbacks.onResult?.('done', 'ev', undefined, undefined, 'sig', 1),
        );
        return () => {};
      },
    );
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard()]),
      submitJobRequest: vi.fn(async () => 'job-ev'),
      subscribeToJobUpdates: subscribeToJobUpdates as never,
    });

    await callTool(agent);

    const recorded = appendCustomerJobSpy.mock.calls.at(-1)?.[1] as
      | { paidAmountSubunits?: string }
      | undefined;
    expect(recorded?.paidAmountSubunits).toBe(String(PRICE));
  });

  it('records the settled amount when the provider reports a credible one', async () => {
    mockDelegation = activeDelegation();
    const subscribeToJobUpdates = vi.fn(
      (options: {
        callbacks: {
          onResult?: (
            content: string,
            eventId: string,
            attachment?: unknown,
            attachments?: unknown[],
            paymentTx?: string,
            paidAmountSubunits?: number,
          ) => void;
        };
      }) => {
        queueMicrotask(() =>
          options.callbacks.onResult?.('done', 'ev', undefined, undefined, 'sig', 6_100),
        );
        return () => {};
      },
    );
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard(true, { min_subunits: '1000' })]),
      submitJobRequest: vi.fn(async () => 'job-ev'),
      subscribeToJobUpdates: subscribeToJobUpdates as never,
    });

    await callTool(agent);

    const recorded = appendCustomerJobSpy.mock.calls.at(-1)?.[1] as
      | { paidAmountSubunits?: string }
      | undefined;
    expect(recorded?.paidAmountSubunits).toBe('6100');
  });

  it('rejects a metered report BELOW the published floor', async () => {
    mockDelegation = activeDelegation();
    const subscribeToJobUpdates = vi.fn(
      (options: {
        callbacks: {
          onResult?: (
            content: string,
            eventId: string,
            attachment?: unknown,
            attachments?: unknown[],
            paymentTx?: string,
            paidAmountSubunits?: number,
          ) => void;
        };
      }) => {
        queueMicrotask(() =>
          options.callbacks.onResult?.('done', 'ev', undefined, undefined, 'sig', 1),
        );
        return () => {};
      },
    );
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard(true, { min_subunits: '1000' })]),
      submitJobRequest: vi.fn(async () => 'job-ev'),
      subscribeToJobUpdates: subscribeToJobUpdates as never,
    });

    await callTool(agent);

    const recorded = appendCustomerJobSpy.mock.calls.at(-1)?.[1] as
      | { paidAmountSubunits?: string }
      | undefined;
    expect(recorded?.paidAmountSubunits).toBe(String(PRICE));
  });

  it('gates max_price_lamports on the ceiling, not the metered floor', async () => {
    mockDelegation = activeDelegation();
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard(true, { min_subunits: '1000' })]),
      submitJobRequest,
    });
    // A cap that sits BETWEEN the floor and the ceiling. This job would very
    // likely settle under it, but the buyer has to approve the most it can
    // cost: the runtime clamps into `[min, price]` and may well pull the
    // ceiling (a skill that reports nothing does exactly that). Gating on the
    // floor would publish a job that can legitimately charge above the cap.
    const result = await callTool(agent, { max_price_lamports: PRICE - 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/exceeds max/);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('refuses when the ceiling does not fit the remaining session budget', async () => {
    mockDelegation = activeDelegation();
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard(true, { min_subunits: '1000' })]),
      submitJobRequest,
    });
    const ctx = ctxWith(agent);
    // Budget above the metered FLOOR but below the ceiling. The job might well
    // settle inside the budget - but it might not, and nothing signed here can
    // stop the pull afterwards, so the ceiling is what has to fit.
    ctx.sessionSpendLimits.set(assetKey(USDC_SOLANA_DEVNET), BigInt(PRICE) - 1n);
    const result = await callTool(agent, {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Session spend limit/i);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('charges the session counter what actually settled, not the ceiling', async () => {
    mockDelegation = activeDelegation();
    const settled = 6_100; // inside [1000, PRICE]
    const subscribeToJobUpdates = vi.fn(
      (options: {
        callbacks: {
          onResult?: (
            content: string,
            eventId: string,
            attachment?: unknown,
            attachments?: unknown[],
            paymentTx?: string,
            paidAmountSubunits?: number,
          ) => void;
        };
      }) => {
        queueMicrotask(() =>
          options.callbacks.onResult?.('done', 'ev', undefined, undefined, 'sig', settled),
        );
        return () => {};
      },
    );
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerCard(true, { min_subunits: '1000' })]),
      submitJobRequest: vi.fn(async () => 'job-ev'),
      subscribeToJobUpdates: subscribeToJobUpdates as never,
    });
    const ctx = ctxWith(agent);
    ctx.sessionSpendLimits.set(assetKey(USDC_SOLANA_DEVNET), 10_000_000n);

    await callTool(agent, {}, ctx);

    // The whole point of metering: the buyer's session budget is charged the
    // real figure. Billing the ceiling here would exhaust a session cap several
    // times faster than the money actually leaving the wallet.
    expect(ctx.sessionSpent.get(assetKey(USDC_SOLANA_DEVNET))).toBe(BigInt(settled));
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
