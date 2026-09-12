/**
 * regression tests for list_my_jobs.
 *
 * Before the fix, `list_my_jobs` called `fetchRecentJobs(undefined, limit, ...)` which
 * does not filter by customer, so it returned every NIP-90 job on the network. It also
 * returned `job.result` verbatim, which is NIP-44 ciphertext for targeted jobs (since
 * fetchRecentJobs does not decrypt).
 *
 * These tests verify (1) only jobs where `customer === agent.identity.publicKey` are
 * kept, and (2) targeted results are decrypted via `queryJobResults`.
 */
import { nip19 } from 'nostr-tools';
import { describe, it, expect, vi } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { customerTools } from '../src/tools/customer.js';

function findTool(name: string) {
  const tool = customerTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

const MY_PUBKEY = 'd'.repeat(64);
const MY_NPUB = nip19.npubEncode(MY_PUBKEY);
const OTHER_PUBKEY = 'e'.repeat(64);

// Local history is where the BOUNDED spend figure lives (`settledSubunitsForHistory`
// clamps a provider-asserted amount to the card's published range before it is
// written). `nostr.amount` is the raw provider tag. The precedence between them
// decides which of the two the user actually reads.
const mockLocalHistory: Array<Record<string, unknown>> = [];
vi.mock('../src/storage/customer-history.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readCustomerHistory: async () => ({ version: 1, jobs: mockLocalHistory }) };
});

function buildStubAgent(opts: {
  fetchRecentJobs: ReturnType<typeof vi.fn>;
  queryJobResults?: ReturnType<typeof vi.fn>;
}): AgentInstance {
  return {
    client: {
      discovery: { fetchAgents: vi.fn() },
      marketplace: {
        fetchRecentJobs: opts.fetchRecentJobs,
        queryJobResults: opts.queryJobResults ?? vi.fn(async () => new Map()),
        subscribeToJobUpdates: vi.fn(() => () => {}),
      },
    } as never,
    identity: { publicKey: MY_PUBKEY, npub: MY_NPUB, secretKey: new Uint8Array(32) } as never,
    name: 'stub',
    network: 'devnet',
    agentDir: '/tmp/elisym-list-jobs-stub',
    security: {},
  };
}

describe('list_my_jobs', () => {
  it('reports the provider NET, not the gross the customer signed', async () => {
    // The two sides measure different things on an ordinary job: the relay tag
    // is the provider's net (price minus protocol fee), the local record is the
    // gross the customer signed. Preferring local would move every flat row from
    // net to gross while nostr-only rows stayed net - two definitions in one
    // list. On a delegated job they agree by construction.
    mockLocalHistory.length = 0;
    mockLocalHistory.push({
      jobEventId: 'job-1',
      capability: 'echo',
      providerPubkey: 'p'.repeat(64),
      paidAmountSubunits: '6100',
      status: 'completed',
      submittedAt: Date.now(),
    });
    const fetchRecentJobs = vi.fn(async () => [
      {
        eventId: 'job-1',
        customer: MY_PUBKEY,
        status: 'success',
        createdAt: 1,
        capability: 'echo',
        amount: 999_999_999,
        result: 'done',
        resultEventId: undefined,
      },
    ]);
    const agent = buildStubAgent({ fetchRecentJobs });
    const ctx = new AgentContext();
    ctx.register(agent);

    const tool = findTool('list_my_jobs');
    const result = await tool.handler(ctx, tool.schema.parse({ limit: 10, include_nostr: true }));
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('999999999');
    expect(text).not.toContain('6100');
    mockLocalHistory.length = 0;
  });

  it('drops an implausible provider-tagged amount instead of rendering it', async () => {
    // `nostr.amount` is the provider's own tag, parsed by something that accepts
    // negatives and prefix-parses garbage, and it is shown to the user as a
    // spend figure. We cannot make it true - only the provider knows what its
    // pull moved - but nonsense must not reach the display.
    mockLocalHistory.length = 0;
    for (const bad of [-5, 1.5, Number.NaN]) {
      const fetchRecentJobs = vi.fn(async () => [
        {
          eventId: 'job-bad',
          customer: MY_PUBKEY,
          status: 'success',
          createdAt: 1,
          capability: 'echo',
          amount: bad,
          result: 'done',
          resultEventId: undefined,
        },
      ]);
      const agent = buildStubAgent({ fetchRecentJobs });
      const ctx = new AgentContext();
      ctx.register(agent);
      const tool = findTool('list_my_jobs');
      const result = await tool.handler(ctx, tool.schema.parse({ limit: 10, include_nostr: true }));
      const text = result.content[0]?.text ?? '';
      expect(text).not.toContain(String(bad));
    }
  });

  it('filters jobs by the current customer pubkey', async () => {
    const fetchRecentJobs = vi.fn(async () => [
      { eventId: 'j1', customer: MY_PUBKEY, status: 'success', createdAt: 1, capability: 'a' },
      { eventId: 'j2', customer: OTHER_PUBKEY, status: 'success', createdAt: 2, capability: 'b' },
      { eventId: 'j3', customer: MY_PUBKEY, status: 'processing', createdAt: 3, capability: 'c' },
      { eventId: 'j4', customer: OTHER_PUBKEY, status: 'error', createdAt: 4, capability: 'd' },
      { eventId: 'j5', customer: MY_PUBKEY, status: 'success', createdAt: 5, capability: 'e' },
    ]);
    const agent = buildStubAgent({ fetchRecentJobs });
    const ctx = new AgentContext();
    ctx.register(agent);

    const tool = findTool('list_my_jobs');
    const input = tool.schema.parse({ limit: 10, include_nostr: true });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Found 3 of your jobs/);
    expect(text).toContain('"event_id": "j1"');
    expect(text).toContain('"event_id": "j3"');
    expect(text).toContain('"event_id": "j5"');
    expect(text).not.toContain('"event_id": "j2"');
    expect(text).not.toContain('"event_id": "j4"');
  });

  it('queries with the relay-side customer filter and the plain limit', async () => {
    const fetchRecentJobs = vi.fn(async () => []);
    const agent = buildStubAgent({ fetchRecentJobs });
    const ctx = new AgentContext();
    ctx.register(agent);

    const tool = findTool('list_my_jobs');
    const input = tool.schema.parse({ limit: 20, include_nostr: true });
    await tool.handler(ctx, input);
    // The authors filter replaces the old 5x over-fetch: the relay narrows to
    // our own requests, so the tool passes the caller's limit through.
    expect(fetchRecentJobs).toHaveBeenCalledWith(undefined, 20, undefined, [100], MY_PUBKEY);
  });

  it('decrypts targeted results via queryJobResults', async () => {
    const fetchRecentJobs = vi.fn(async () => [
      {
        eventId: 'enc-1',
        customer: MY_PUBKEY,
        status: 'success',
        createdAt: 1,
        capability: 'summarize',
        result: 'ENCRYPTED_CIPHERTEXT_BLOB',
        resultEventId: 'r-enc-1',
      },
      {
        eventId: 'plain-1',
        customer: MY_PUBKEY,
        status: 'success',
        createdAt: 2,
        capability: 'echo',
        result: 'hello world (plaintext)',
        resultEventId: undefined, // no targeted result event
      },
    ]);
    const queryJobResults = vi.fn(async () => {
      const map = new Map();
      map.set('enc-1', {
        content: 'decrypted summary here',
        amount: 0,
        senderPubkey: 'p',
        decryptionFailed: false,
      });
      return map;
    });
    const agent = buildStubAgent({ fetchRecentJobs, queryJobResults });
    const ctx = new AgentContext();
    ctx.register(agent);

    const tool = findTool('list_my_jobs');
    const input = tool.schema.parse({ limit: 10, include_nostr: true });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBeFalsy();
    // queryJobResults was called exactly once, only for the eventId that has resultEventId set.
    expect(queryJobResults).toHaveBeenCalledTimes(1);
    expect(queryJobResults.mock.calls[0]?.[1]).toEqual(['enc-1']);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('decrypted summary here');
    expect(text).toContain('hello world (plaintext)');
    // The raw ciphertext must never reach the LLM.
    expect(text).not.toContain('ENCRYPTED_CIPHERTEXT_BLOB');
  });

  it('marks decryption failures explicitly instead of leaking ciphertext', async () => {
    const fetchRecentJobs = vi.fn(async () => [
      {
        eventId: 'bad',
        customer: MY_PUBKEY,
        status: 'success',
        createdAt: 1,
        capability: 'x',
        result: 'SOME_CIPHERTEXT',
        resultEventId: 'r-bad',
      },
    ]);
    const queryJobResults = vi.fn(async () => {
      const map = new Map();
      map.set('bad', {
        content: '',
        amount: 0,
        senderPubkey: 'p',
        decryptionFailed: true,
      });
      return map;
    });
    const agent = buildStubAgent({ fetchRecentJobs, queryJobResults });
    const ctx = new AgentContext();
    ctx.register(agent);

    const tool = findTool('list_my_jobs');
    const result = await tool.handler(ctx, tool.schema.parse({ include_nostr: true }));
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('[decryption failed');
    expect(text).not.toContain('SOME_CIPHERTEXT');
  });

  it('tolerates queryJobResults failure and falls back without crashing', async () => {
    const fetchRecentJobs = vi.fn(async () => [
      {
        eventId: 'e1',
        customer: MY_PUBKEY,
        status: 'success',
        createdAt: 1,
        capability: 'x',
        result: 'plain result',
        resultEventId: 'r1',
      },
    ]);
    const queryJobResults = vi.fn(async () => {
      throw new Error('relay exploded');
    });
    const agent = buildStubAgent({ fetchRecentJobs, queryJobResults });
    const ctx = new AgentContext();
    ctx.register(agent);

    const tool = findTool('list_my_jobs');
    const result = await tool.handler(ctx, tool.schema.parse({ include_nostr: true }));
    expect(result.isError).toBeFalsy();
    // Last-resort fallback: raw content wrapped in boundary markers.
    expect(result.content[0]?.text).toContain('plain result');
  });
});
