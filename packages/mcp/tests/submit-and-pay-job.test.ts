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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '@elisym/sdk';
import { nip19 } from 'nostr-tools';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { customerTools } from '../src/tools/customer.js';

// Mock the (node-only) iroh transport so the seed paths run without the native
// addon. Both methods are exposed: seedBytes (large-text spill) and seedPath
// (submit_and_pay_job_from_file). Each returns a deterministic ticket/size.
const mockSeedBytes = vi.fn(async () => ({ ticket: 'blobticket-spill', size: 70_000 }));
const mockSeedPath = vi.fn(async () => ({ ticket: 'blobticket-file', size: 1234 }));
vi.mock('../src/iroh.js', () => ({
  ensureIrohTransport: vi.fn(() => ({ seedBytes: mockSeedBytes, seedPath: mockSeedPath })),
}));

function findTool(name: string) {
  const tool = customerTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in customerTools`);
  return tool;
}

/** Build a stub `AgentInstance` whose client has mockable marketplace/discovery/ping. */
function buildStubAgent(opts: {
  fetchAgents: ReturnType<typeof vi.fn>;
  submitJobRequest?: ReturnType<typeof vi.fn>;
  hasSolana?: boolean;
  /** Provider ping result. Defaults to online=true so the pre-ping guard passes. */
  pingAgent?: ReturnType<typeof vi.fn>;
  /** Set to mark the agent persistent (eligible to seed a spilled input). */
  agentDir?: string;
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
    agentDir: opts.agentDir,
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
  it('refuses to submit when the provider is offline (pre-ping fails)', async () => {
    const fetchAgents = vi.fn(async () => []);
    const submitJobRequest = vi.fn();
    const pingAgent = vi.fn(async () => ({ online: false, identity: null }));
    const agent = buildStubAgent({ fetchAgents, submitJobRequest, pingAgent });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'hello',
      provider_npub: VALID_PROVIDER_NPUB,
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/is offline/);
    // Offline short-circuit: never touch discovery and never publish a job.
    expect(fetchAgents).not.toHaveBeenCalled();
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

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
    // Wait for the submitJobRequest call instead of a fixed tick, so a slow CI
    // runner can't assert before the handler reaches it.
    await vi.waitFor(() => expect(submitJobRequest).toHaveBeenCalledTimes(1));
    // Resolve the dangling promise via an explicit subscription-close path is not trivial
    // here; we simply ignore the hanging promise - vitest will clean up after the test.
    void resultPromise;
  });
});

// Paid provider card whose recipient differs from the stub buyer wallet ('sol-pub').
function paidProviderEvent(jobPrice: number) {
  return {
    npub: VALID_PROVIDER_NPUB,
    name: 'Test Provider',
    cards: [
      {
        name: 'do-thing',
        description: 'paid capability',
        capabilities: ['do-thing'],
        payment: {
          chain: 'solana' as const,
          address: 'provider-wallet-addr',
          token: 'usdc' as const,
          job_price: jobPrice,
        },
      },
    ],
  };
}

describe('confirm-before-publish gate', () => {
  it('returns a price confirmation (not an error) and publishes NO job when max_price_lamports is unset', async () => {
    const fetchAgents = vi.fn(async () => [paidProviderEvent(500_000)]);
    const submitJobRequest = vi.fn(async () => 'job-event-id');
    // hasSolana:false keeps gasHintForCardAsset hermetic (it short-circuits to '' with no
    // wallet, so the confirmation is built without a live RPC call). The gate itself is
    // wallet-independent, so this still exercises the confirm-before-publish path.
    const agent = buildStubAgent({ fetchAgents, submitJobRequest, hasSolana: false });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'remove bg',
      provider_npub: VALID_PROVIDER_NPUB,
      capability: 'do-thing',
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/costs/);
    expect(result.content[0]?.text).toMatch(/max_price_lamports/);
    // The core orphan regression: no NIP-90 request is broadcast before confirmation.
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('publishes exactly one job when max_price_lamports >= advertised price', async () => {
    const fetchAgents = vi.fn(async () => [paidProviderEvent(500_000)]);
    const submitJobRequest = vi.fn(async () => 'job-event-id');
    const agent = buildStubAgent({ fetchAgents, submitJobRequest, hasSolana: true });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'remove bg',
      provider_npub: VALID_PROVIDER_NPUB,
      capability: 'do-thing',
      max_price_lamports: 500_000,
      timeout_secs: 1,
    });

    const resultPromise = tool.handler(ctx, input);
    await vi.waitFor(() => expect(submitJobRequest).toHaveBeenCalledTimes(1));
    void resultPromise;
  });

  it('rejects with an over-cap error and publishes NO job when max_price_lamports < price', async () => {
    const fetchAgents = vi.fn(async () => [paidProviderEvent(500_000)]);
    const submitJobRequest = vi.fn(async () => 'job-event-id');
    const agent = buildStubAgent({ fetchAgents, submitJobRequest, hasSolana: true });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'remove bg',
      provider_npub: VALID_PROVIDER_NPUB,
      capability: 'do-thing',
      max_price_lamports: 100_000,
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/exceeds max/);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('buy_capability keeps its confirmation wording after the shared-gate refactor', async () => {
    const fetchAgents = vi.fn(async () => [paidProviderEvent(500_000)]);
    const submitJobRequest = vi.fn(async () => 'job-event-id');
    const agent = buildStubAgent({ fetchAgents, submitJobRequest, hasSolana: false });
    const ctx = ctxWith(agent);

    const tool = findTool('buy_capability');
    const input = tool.schema.parse({
      provider_npub: VALID_PROVIDER_NPUB,
      capability: 'do-thing',
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/Capability "do-thing" from "Test Provider" costs/);
    expect(result.content[0]?.text).toMatch(
      /call buy_capability again with max_price_lamports set/,
    );
    expect(submitJobRequest).not.toHaveBeenCalled();
  });
});

describe('submit_and_pay_job large-text spill', () => {
  const largeInput = 'x'.repeat(LIMITS.MAX_ENCRYPTED_INLINE_BYTES + 10_000);

  it('rejects a large input on an ephemeral agent with a clean error (no crash, no publish)', async () => {
    mockSeedBytes.mockClear();
    const fetchAgents = vi.fn(async () => []);
    const submitJobRequest = vi.fn();
    // No agentDir => ephemeral => cannot seed a spill.
    const agent = buildStubAgent({ fetchAgents, submitJobRequest });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({ input: largeInput, provider_npub: VALID_PROVIDER_NPUB });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/requires a persistent agent/i);
    // The spill decision runs before discovery/publish, so nothing leaks out.
    expect(mockSeedBytes).not.toHaveBeenCalled();
    expect(fetchAgents).not.toHaveBeenCalled();
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('seeds a large input via iroh and submits an empty inline body + text/plain attachment', async () => {
    mockSeedBytes.mockClear();
    const providerEvent = {
      npub: VALID_PROVIDER_NPUB,
      cards: [
        { name: 'general', description: 'free', capabilities: ['general'], payment: undefined },
      ],
    };
    const fetchAgents = vi.fn(async () => [providerEvent]);
    const submitJobRequest = vi.fn(async () => 'job-event-id');
    // Persistent (agentDir set) + free provider + no wallet => reaches submitJobRequest.
    const agent = buildStubAgent({
      fetchAgents,
      submitJobRequest,
      hasSolana: false,
      agentDir: '/tmp/stub-agent',
    });
    const ctx = ctxWith(agent);

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: largeInput,
      provider_npub: VALID_PROVIDER_NPUB,
      timeout_secs: 1,
    });
    const resultPromise = tool.handler(ctx, input);
    // submitJobRequest fires only after the input is seeded, so waiting for that
    // call (instead of a fixed sleep) deterministically proves seeding ran first
    // and avoids a flaky race on a loaded CI runner.
    await vi.waitFor(() => expect(submitJobRequest).toHaveBeenCalledTimes(1));

    expect(mockSeedBytes).toHaveBeenCalledTimes(1);
    const submitArgs = submitJobRequest.mock.calls[0]![1] as {
      input: string;
      attachment?: { mime: string; transports: { kind: string; ticket: string }[] };
    };
    expect(submitArgs.input).toBe('');
    expect(submitArgs.attachment?.mime).toBe('text/plain');
    expect(submitArgs.attachment?.transports[0]?.ticket).toBe('blobticket-spill');
    void resultPromise;
  });
});

describe('submit_and_pay_job_from_file always seeds via iroh (never inline)', () => {
  // The handler runs the REAL prepareFileInput/validateInputPath/isProbablyText
  // (fs is not mocked), so each case writes a real temp file and passes
  // allow_outside_cwd: true (the temp file is outside the package cwd).
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-fromfile-'));
    mockSeedBytes.mockClear();
    mockSeedPath.mockClear();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function freeProviderSetup(): {
    agent: AgentInstance;
    submitJobRequest: ReturnType<typeof vi.fn>;
  } {
    const providerEvent = {
      npub: VALID_PROVIDER_NPUB,
      cards: [
        { name: 'general', description: 'free', capabilities: ['general'], payment: undefined },
      ],
    };
    const submitJobRequest = vi.fn(async () => 'job-event-id');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [providerEvent]),
      submitJobRequest,
      hasSolana: false,
      agentDir: '/tmp/stub-agent',
    });
    return { agent, submitJobRequest };
  }

  async function runFromFile(agent: AgentInstance, filePath: string) {
    const tool = findTool('submit_and_pay_job_from_file');
    const input = tool.schema.parse({
      input_path: filePath,
      provider_npub: VALID_PROVIDER_NPUB,
      allow_outside_cwd: true,
      timeout_secs: 1,
    });
    return tool.handler(ctxWith(agent), input);
  }

  it('seeds a binary file as application/octet-stream with an empty inline body', async () => {
    const p = join(dir, 'tiny.jpg');
    await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]));
    const { agent, submitJobRequest } = freeProviderSetup();

    const resultPromise = runFromFile(agent, p);
    // Wait for submitJobRequest (which fires only after seedPath) rather than a
    // fixed sleep, so a slow CI runner can't lose the race before seeding lands.
    await vi.waitFor(() => expect(submitJobRequest).toHaveBeenCalledTimes(1));

    expect(mockSeedPath).toHaveBeenCalledTimes(1);
    expect(mockSeedBytes).not.toHaveBeenCalled();
    const submitArgs = submitJobRequest.mock.calls[0]![1] as {
      input: string;
      attachment?: { mime: string; transports: { kind: string; ticket: string }[] };
    };
    expect(submitArgs.input).toBe('');
    expect(submitArgs.attachment?.mime).toBe('application/octet-stream');
    expect(submitArgs.attachment?.transports[0]?.ticket).toBe('blobticket-file');
    void resultPromise;
  });

  it('seeds a text file as text/plain (provider re-inlines to stdin)', async () => {
    const p = join(dir, 'notes.txt');
    await writeFile(p, 'hello world');
    const { agent, submitJobRequest } = freeProviderSetup();

    const resultPromise = runFromFile(agent, p);
    await vi.waitFor(() => expect(submitJobRequest).toHaveBeenCalledTimes(1));

    expect(mockSeedPath).toHaveBeenCalledTimes(1);
    const submitArgs = submitJobRequest.mock.calls[0]![1] as {
      input: string;
      attachment?: { mime: string };
    };
    expect(submitArgs.input).toBe('');
    expect(submitArgs.attachment?.mime).toBe('text/plain');
    void resultPromise;
  });

  it('rejects on an ephemeral agent (no agentDir) without seeding or publishing', async () => {
    const p = join(dir, 'tiny.bin');
    await writeFile(p, Buffer.from([0xff, 0x00, 0x01]));
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({ fetchAgents: vi.fn(async () => []), submitJobRequest });

    const result = await runFromFile(agent, p);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/requires a persistent agent/i);
    expect(mockSeedPath).not.toHaveBeenCalled();
    expect(submitJobRequest).not.toHaveBeenCalled();
  });
});
