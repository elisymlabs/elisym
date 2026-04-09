/**
 * regression test for submit_and_pay_job expected-recipient fail-fast.
 *
 * Before the fix, when the target provider was not in the current discovery snapshot,
 * `expectedRecipient` fell through to `undefined` and `validatePaymentRequest(..., undefined)`
 * silently skipped the recipient-mismatch check. An attacker controlling a relay echo
 * or a compromised provider could then redirect funds to an arbitrary address.
 *
 * These tests build a stub `AgentContext` with a fake `client.discovery.fetchAgents` and
 * `client.marketplace.submitJobRequest`, then call the real `submit_and_pay_job` handler.
 * The fail-fast branch runs before `submitJobRequest`, so we can assert the call count.
 */
import { nip19 } from 'nostr-tools';
import { describe, it, expect, vi } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { customerTools } from '../src/tools/customer.js';

function findTool(name: string) {
  const tool = customerTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in customerTools`);
  return tool;
}

/** Build a stub `AgentInstance` whose client has mockable marketplace/discovery. */
function buildStubAgent(opts: {
  fetchAgents: ReturnType<typeof vi.fn>;
  submitJobRequest?: ReturnType<typeof vi.fn>;
  hasSolana?: boolean;
}): AgentInstance {
  const submitJobRequest = opts.submitJobRequest ?? vi.fn();
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
  };
  return {
    client: client as never,
    identity: identity as never,
    name: 'stub',
    network: 'devnet',
    security: {},
    solanaKeypair:
      (opts.hasSolana ?? true)
        ? { publicKey: 'sol-pub', secretKey: new Uint8Array(64) }
        : undefined,
  };
}

function ctxWith(agent: AgentInstance): AgentContext {
  const ctx = new AgentContext();
  ctx.register(agent);
  return ctx;
}

// A valid-looking npub (must decode, we don't care about content).
const VALID_PROVIDER_NPUB = nip19.npubEncode('a'.repeat(64));

describe('submit_and_pay_job expected-recipient fail-fast', () => {
  it('refuses to submit when provider is not in the discovery snapshot', async () => {
    const fetchAgents = vi.fn(async () => []);
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({ fetchAgents, submitJobRequest });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'do a thing',
      provider_npub: VALID_PROVIDER_NPUB,
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not found on devnet/);
    // No job event is ever published if we can't verify the recipient.
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('refuses to submit when customer has a wallet but provider has no Solana address for the capability', async () => {
    // Provider is on the network, but its only card is free (no payment.address).
    const providerEvent = {
      npub: VALID_PROVIDER_NPUB,
      cards: [
        {
          name: 'free-capability',
          description: 'nothing to pay',
          capabilities: ['free-capability'],
          payment: undefined,
        },
      ],
    };
    const fetchAgents = vi.fn(async () => [providerEvent]);
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({ fetchAgents, submitJobRequest, hasSolana: true });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'pay me',
      provider_npub: VALID_PROVIDER_NPUB,
      capability: 'free-capability',
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/no Solana payment address/i);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('allows free providers when the customer has no Solana wallet', async () => {
    // No wallet + no provider recipient = free-job path, should NOT fail-fast.
    const providerEvent = {
      npub: VALID_PROVIDER_NPUB,
      cards: [
        {
          name: 'general',
          description: 'free',
          capabilities: ['general'],
          payment: undefined,
        },
      ],
    };
    const fetchAgents = vi.fn(async () => [providerEvent]);
    const submitJobRequest = vi.fn(async () => 'job-event-id');
    const agent = buildStubAgent({ fetchAgents, submitJobRequest, hasSolana: false });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'free request',
      provider_npub: VALID_PROVIDER_NPUB,
      timeout_secs: 1, // short so the subscribe-timeout fires quickly
    });

    // The handler will wait for a job result; the stub subscribe returns no events and
    // the SDK's real timer isn't in play (subscribe is a no-op stub), so the awaitJobResult
    // promise won't resolve on its own. We only care that `submitJobRequest` was called,
    // which is the invariant we assert. Race with a short timeout to avoid hanging.
    const resultPromise = tool.handler(ctx, input);
    // Give the handler a tick to reach the submitJobRequest call.
    await new Promise((r) => setTimeout(r, 10));
    expect(submitJobRequest).toHaveBeenCalledTimes(1);
    // Resolve the dangling promise via an explicit subscription-close path is not trivial
    // here; we simply ignore the hanging promise - vitest will clean up after the test.
    void resultPromise;
  });
});
