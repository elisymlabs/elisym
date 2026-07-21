/**
 * Stage-3 session management: the `.job-sessions.json` store, the auto-mode
 * continue-gate in the submit tools, explicit session_id overrides, the
 * provider-mismatch guard, create_job's explicit-only behavior, the
 * conditional customer-history transition, and list_job_sessions.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_ID_REGEX } from '@elisym/sdk';
import { nip19 } from 'nostr-tools';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import {
  appendCustomerJob,
  findCustomerJob,
  transitionCustomerJobStatus,
} from '../src/storage/customer-history.js';
import {
  buildFirstPrompt,
  bumpSessionTurnCount,
  clearInMemorySessions,
  findLiveSession,
  findSessionById,
  findSessionByJobId,
  listJobSessions,
  recordSessionSubmit,
  JOB_SESSIONS_FILENAME,
  MAX_JOB_IDS_PER_SESSION,
  MAX_SESSION_ENTRIES,
  SESSION_LIVENESS_MS,
  type SessionStoreHandle,
} from '../src/storage/job-sessions.js';
import { customerTools } from '../src/tools/customer.js';

vi.mock('../src/iroh.js', () => ({
  ensureIrohTransport: vi.fn(() => ({
    seedBytes: vi.fn(async () => ({ ticket: 'blobticket-spill', size: 70_000 })),
    seedPath: vi.fn(async () => ({ ticket: 'blobticket-file', size: 1234 })),
  })),
}));

function findTool(name: string) {
  const tool = customerTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in customerTools`);
  return tool;
}

const PROVIDER_A_PUBKEY = 'a'.repeat(64);
const PROVIDER_B_PUBKEY = 'b'.repeat(64);
const PROVIDER_A_NPUB = nip19.npubEncode(PROVIDER_A_PUBKEY);
const PROVIDER_B_NPUB = nip19.npubEncode(PROVIDER_B_PUBKEY);
const IDENTITY_PUBKEY = 'd'.repeat(64);

function contextProviderEvent(npub: string, context = true) {
  return {
    npub,
    name: 'Chatty Provider',
    cards: [
      {
        name: 'general',
        description: 'free conversational capability',
        capabilities: ['general'],
        payment: undefined,
        ...(context ? { context: true } : {}),
      },
    ],
  };
}

function buildStubAgent(opts: {
  fetchAgents: ReturnType<typeof vi.fn>;
  submitJobRequest?: ReturnType<typeof vi.fn>;
  subscribeToJobUpdates?: ReturnType<typeof vi.fn>;
  hasSolana?: boolean;
  agentDir?: string;
}): AgentInstance {
  const submitJobRequest = opts.submitJobRequest ?? vi.fn(async () => 'job-event-id');
  const identity = {
    publicKey: IDENTITY_PUBKEY,
    npub: nip19.npubEncode(IDENTITY_PUBKEY),
    secretKey: new Uint8Array(32),
  };
  const client = {
    discovery: { fetchAgents: opts.fetchAgents },
    marketplace: {
      submitJobRequest,
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
    agentDir: opts.agentDir,
    solanaKeypair:
      (opts.hasSolana ?? false)
        ? { publicKey: 'sol-pub', secretKey: new Uint8Array(64) }
        : undefined,
  };
}

function ctxWith(agent: AgentInstance): AgentContext {
  const ctx = new AgentContext();
  ctx.register(agent);
  return ctx;
}

let dir: string;
let handle: SessionStoreHandle;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'elisym-sessions-'));
  handle = { agentDir: dir, identityPubkey: IDENTITY_PUBKEY };
  clearInMemorySessions();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

async function seedSession(
  target: SessionStoreHandle,
  sessionId: string,
  providerPubkey: string,
  jobEventId = 'job-1',
): Promise<void> {
  await recordSessionSubmit(target, {
    sessionId,
    providerPubkey,
    providerName: 'Chatty Provider',
    capability: 'general',
    firstPrompt: buildFirstPrompt('hello there', undefined, 'general'),
    jobEventId,
  });
}

describe('job-sessions store', () => {
  it('creates an entry on first submit and finds it live', async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    const live = await findLiveSession(handle, PROVIDER_A_PUBKEY);
    expect(live?.sessionId).toBe(UUID_A);
    expect(live?.turnCount).toBe(0);
    expect(live?.jobIds).toEqual(['job-1']);
    expect(live?.firstPrompt).toBe('hello there');
  });

  it('bumps turnCount and lastUsedAt independently', async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    await bumpSessionTurnCount(handle, UUID_A);
    await bumpSessionTurnCount(handle, UUID_A);
    const entry = await findSessionById(handle, UUID_A);
    expect(entry?.turnCount).toBe(2);
  });

  it('treats sessions past the liveness window as absent', async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    // Backdate lastUsedAt past the window by rewriting the file directly.
    const path = join(dir, JOB_SESSIONS_FILENAME);
    const store = JSON.parse(await readFile(path, 'utf-8'));
    store.sessions[0].lastUsedAt = Date.now() - SESSION_LIVENESS_MS - 1000;
    await writeFile(path, JSON.stringify(store));
    expect(await findLiveSession(handle, PROVIDER_A_PUBKEY)).toBeUndefined();
    // Still findable by explicit id - explicit continues are the caller's choice.
    expect(await findSessionById(handle, UUID_A)).toBeDefined();
  });

  it('caps jobIds per session and sessions per store (LRU)', async () => {
    for (let i = 0; i < MAX_JOB_IDS_PER_SESSION + 5; i++) {
      await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY, `job-${i}`);
    }
    const entry = await findSessionById(handle, UUID_A);
    expect(entry?.jobIds.length).toBe(MAX_JOB_IDS_PER_SESSION);
    expect(entry?.jobIds.at(-1)).toBe(`job-${MAX_JOB_IDS_PER_SESSION + 4}`);
    expect(await findSessionByJobId(handle, 'job-0')).toBeUndefined();
  }, 15_000);

  it('LRU-trims oldest sessions past MAX_SESSION_ENTRIES', async () => {
    // Write a full store directly (per-submit writes would be slow), then push
    // one more through the API and check the oldest fell out.
    const now = Date.now();
    const sessions = Array.from({ length: MAX_SESSION_ENTRIES }, (_, i) => ({
      sessionId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      providerPubkey: PROVIDER_A_PUBKEY,
      capability: 'general',
      createdAt: now - (MAX_SESSION_ENTRIES - i) * 1000,
      lastUsedAt: now - (MAX_SESSION_ENTRIES - i) * 1000,
      turnCount: 0,
      firstPrompt: 'x',
      jobIds: [],
    }));
    await writeFile(
      join(dir, JOB_SESSIONS_FILENAME),
      JSON.stringify({ version: 1, sessions }, null, 2),
    );
    await seedSession(handle, UUID_B, PROVIDER_B_PUBKEY);
    const all = await listJobSessions(handle, MAX_SESSION_ENTRIES);
    expect(all.length).toBe(MAX_SESSION_ENTRIES);
    expect(all[0]?.sessionId).toBe(UUID_B);
    expect(all.find((s) => s.sessionId === '00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('tolerates a corrupt file (empty store, no throw)', async () => {
    await writeFile(join(dir, JOB_SESSIONS_FILENAME), '{not json');
    expect(await findLiveSession(handle, PROVIDER_A_PUBKEY)).toBeUndefined();
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    expect((await findSessionById(handle, UUID_A))?.sessionId).toBe(UUID_A);
  });

  it('keeps ephemeral registries isolated per identity pubkey', async () => {
    const memA: SessionStoreHandle = { identityPubkey: 'e'.repeat(64) };
    const memB: SessionStoreHandle = { identityPubkey: 'f'.repeat(64) };
    await seedSession(memA, UUID_A, PROVIDER_A_PUBKEY);
    expect(await findLiveSession(memA, PROVIDER_A_PUBKEY)).toBeDefined();
    expect(await findLiveSession(memB, PROVIDER_A_PUBKEY)).toBeUndefined();
  });

  it('buildFirstPrompt falls back for empty inputs', () => {
    expect(buildFirstPrompt('  real prompt  ', undefined, 'general')).toBe('real prompt');
    expect(buildFirstPrompt('', 'diff.patch', 'review')).toBe('[file: diff.patch]');
    expect(buildFirstPrompt('', undefined, 'review')).toBe('[review]');
  });
});

describe('transitionCustomerJobStatus', () => {
  const baseEntry = {
    jobEventId: 'job-t',
    capability: 'general',
    providerPubkey: PROVIDER_A_PUBKEY,
    submittedAt: 1,
    completedAt: 2,
  };

  it('fires exactly once from pending, and never from completed', async () => {
    await appendCustomerJob(dir, { ...baseEntry, status: 'pending' });
    expect(
      await transitionCustomerJobStatus(dir, 'job-t', ['pending', 'timeout'], 'completed'),
    ).toBe(true);
    expect(
      await transitionCustomerJobStatus(dir, 'job-t', ['pending', 'timeout'], 'completed'),
    ).toBe(false);
    expect((await findCustomerJob(dir, 'job-t'))?.status).toBe('completed');
  });

  it('fires from timeout (free-job wait expiry is a mainline session case)', async () => {
    await appendCustomerJob(dir, { ...baseEntry, status: 'timeout' });
    expect(
      await transitionCustomerJobStatus(dir, 'job-t', ['pending', 'timeout'], 'completed'),
    ).toBe(true);
  });

  it('returns false for unknown jobs', async () => {
    expect(
      await transitionCustomerJobStatus(dir, 'nope', ['pending', 'timeout'], 'completed'),
    ).toBe(false);
  });
});

describe('session_id schema', () => {
  it("accepts 'new', 'none', a v4 UUID, and omission; rejects garbage", () => {
    const tool = findTool('submit_and_pay_job');
    const base = { input: 'hi', provider_npub: PROVIDER_A_NPUB };
    expect(() => tool.schema.parse({ ...base, session_id: 'new' })).not.toThrow();
    expect(() => tool.schema.parse({ ...base, session_id: 'none' })).not.toThrow();
    expect(() => tool.schema.parse({ ...base, session_id: UUID_A })).not.toThrow();
    expect(() => tool.schema.parse(base)).not.toThrow();
    expect(() => tool.schema.parse({ ...base, session_id: 'SESSION-1' })).toThrow();
    // Letter-bearing id so the uppercase variant actually differs (digits don't case-fold).
    expect(() =>
      tool.schema.parse({ ...base, session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).not.toThrow();
    expect(() =>
      tool.schema.parse({ ...base, session_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }),
    ).toThrow();
  });
});

describe('auto mode in submit_and_pay_job', () => {
  async function runSubmit(
    agent: AgentInstance,
    extra: Record<string, unknown> = {},
  ): Promise<{ result: Awaited<ReturnType<ReturnType<typeof findTool>['handler']>> }> {
    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'hello provider',
      provider_npub: PROVIDER_A_NPUB,
      timeout_secs: 1,
      ...extra,
    });
    return { result: await tool.handler(ctxWith(agent), input) };
  }

  /** subscribeToJobUpdates stub that immediately delivers a text result. */
  function resolveWithResult(text: string) {
    return vi.fn((options: { callbacks: { onResult: (c: string, e: string) => void } }) => {
      queueMicrotask(() => options.callbacks.onResult(text, 'result-event'));
      return () => {};
    });
  }

  it('auto-starts a session on first contact with a context provider and reports it', async () => {
    const submitJobRequest = vi.fn(async () => 'job-auto-1');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB)]),
      submitJobRequest,
      subscribeToJobUpdates: resolveWithResult('answer!'),
      agentDir: dir,
    });

    const { result } = await runSubmit(agent);

    expect(result.isError).toBeFalsy();
    const submitArgs = submitJobRequest.mock.calls[0]![1] as { sessionId?: string };
    expect(submitArgs.sessionId).toMatch(SESSION_ID_REGEX);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain(`session_id=${submitArgs.sessionId}`);
    expect(text).toMatch(/A conversation was started with this job/);
    // Bookkeeping: entry recorded at submit, turnCount bumped on the in-window success.
    const entry = await findSessionById(handle, submitArgs.sessionId!);
    expect(entry?.jobIds).toEqual(['job-auto-1']);
    expect(entry?.turnCount).toBe(1);
  });

  it('gates (no publish) when a live conversation exists and session_id is omitted', async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB)]),
      submitJobRequest,
      agentDir: dir,
    });

    const { result } = await runSubmit(agent);

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/no completed exchange is recorded on this side yet/);
    expect(text).toContain(`session_id="${UUID_A}"`);
    expect(text).toMatch(/session_id="new"/);
    expect(text).toMatch(/session_id="none"/);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('states the exchange count in the gate once turns completed', async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    await bumpSessionTurnCount(handle, UUID_A);
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB)]),
      submitJobRequest: vi.fn(),
      agentDir: dir,
    });
    const { result } = await runSubmit(agent);
    expect(result.content[0]?.text).toMatch(/ongoing conversation .* 1 completed exchange\b/s);
  });

  it('session gate runs BEFORE the price gate (paid provider, no max_price, live session)', async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    const paidContextProvider = {
      npub: PROVIDER_A_NPUB,
      name: 'Paid Chatty',
      cards: [
        {
          name: 'general',
          description: 'paid conversational capability',
          capabilities: ['general'],
          context: true,
          payment: {
            chain: 'solana' as const,
            address: 'provider-wallet-addr',
            token: 'usdc' as const,
            job_price: 500_000,
          },
        },
      ],
    };
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [paidContextProvider]),
      submitJobRequest,
      hasSolana: true,
      agentDir: dir,
    });

    const { result } = await runSubmit(agent);

    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/conversation/);
    expect(text).not.toMatch(/max_price_lamports/);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it("explicit 'new' skips the gate and starts a fresh session", async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    const submitJobRequest = vi.fn(async () => 'job-new-1');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB)]),
      submitJobRequest,
      subscribeToJobUpdates: resolveWithResult('fresh!'),
      agentDir: dir,
    });

    await runSubmit(agent, { session_id: 'new' });

    const submitArgs = submitJobRequest.mock.calls[0]![1] as { sessionId?: string };
    expect(submitArgs.sessionId).toMatch(SESSION_ID_REGEX);
    expect(submitArgs.sessionId).not.toBe(UUID_A);
  });

  it("explicit 'none' skips the gate and submits stateless", async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    const submitJobRequest = vi.fn(async () => 'job-none-1');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB)]),
      submitJobRequest,
      subscribeToJobUpdates: resolveWithResult('one-off'),
      agentDir: dir,
    });

    const { result } = await runSubmit(agent, { session_id: 'none' });

    const submitArgs = submitJobRequest.mock.calls[0]![1] as { sessionId?: string };
    expect(submitArgs.sessionId).toBeUndefined();
    expect(result.content[0]?.text ?? '').not.toContain('session_id=');
  });

  it('an explicit UUID continues that session (skips the gate)', async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    const submitJobRequest = vi.fn(async () => 'job-cont-1');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB)]),
      submitJobRequest,
      subscribeToJobUpdates: resolveWithResult('continued'),
      agentDir: dir,
    });

    const { result } = await runSubmit(agent, { session_id: UUID_A });

    const submitArgs = submitJobRequest.mock.calls[0]![1] as { sessionId?: string };
    expect(submitArgs.sessionId).toBe(UUID_A);
    expect(result.content[0]?.text ?? '').toContain(`session_id=${UUID_A}`);
    const entry = await findSessionById(handle, UUID_A);
    expect(entry?.jobIds).toContain('job-cont-1');
  });

  it('rejects continuing a session recorded for a different provider', async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_B_NPUB)]),
      submitJobRequest,
      agentDir: dir,
    });

    const tool = findTool('submit_and_pay_job');
    const input = tool.schema.parse({
      input: 'hi',
      provider_npub: PROVIDER_B_NPUB,
      session_id: UUID_A,
      timeout_secs: 1,
    });
    const result = await tool.handler(ctxWith(agent), input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(PROVIDER_A_NPUB);
    expect(result.content[0]?.text).toMatch(/session_id="new"/);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });

  it('stays stateless in auto mode for a provider without the context flag', async () => {
    const submitJobRequest = vi.fn(async () => 'job-nc-1');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB, false)]),
      submitJobRequest,
      subscribeToJobUpdates: resolveWithResult('plain'),
      agentDir: dir,
    });

    const { result } = await runSubmit(agent);

    const submitArgs = submitJobRequest.mock.calls[0]![1] as { sessionId?: string };
    expect(submitArgs.sessionId).toBeUndefined();
    expect(result.content[0]?.text ?? '').not.toContain('session_id=');
  });

  it("warns (but submits) on explicit 'new' against a context-less capability", async () => {
    const submitJobRequest = vi.fn(async () => 'job-warn-1');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB, false)]),
      submitJobRequest,
      subscribeToJobUpdates: resolveWithResult('maybe amnesiac'),
      agentDir: dir,
    });

    const { result } = await runSubmit(agent, { session_id: 'new' });

    expect(submitJobRequest).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toMatch(/does not advertise conversation support/);
  });

  it('auto mode sees the context flag on a wallet-less provider (d-tag fallback card matching)', async () => {
    // No payment block on the card at all - paymentCardForCapability alone
    // would miss it; the context check must fall back to d-tag matching.
    const submitJobRequest = vi.fn(async () => 'job-wl-1');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB)]),
      submitJobRequest,
      subscribeToJobUpdates: resolveWithResult('hello'),
      agentDir: dir,
      hasSolana: false,
    });

    await runSubmit(agent);
    const submitArgs = submitJobRequest.mock.calls[0]![1] as { sessionId?: string };
    expect(submitArgs.sessionId).toMatch(SESSION_ID_REGEX);
  });

  it('works for ephemeral agents through the in-memory registry (gate on second call)', async () => {
    const submitJobRequest = vi.fn(async () => 'job-eph-1');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB)]),
      submitJobRequest,
      subscribeToJobUpdates: resolveWithResult('eph'),
      // no agentDir: ephemeral
    });

    const first = await runSubmit(agent);
    expect(first.result.isError).toBeFalsy();
    expect(submitJobRequest).toHaveBeenCalledTimes(1);
    // In-window success bumped the in-memory turnCount.
    const memHandle: SessionStoreHandle = { identityPubkey: IDENTITY_PUBKEY };
    const live = await findLiveSession(memHandle, PROVIDER_A_PUBKEY);
    expect(live?.turnCount).toBe(1);

    const second = await runSubmit(agent);
    expect(second.result.content[0]?.text).toMatch(/ongoing conversation/);
    expect(submitJobRequest).toHaveBeenCalledTimes(1);
  });
});

describe('create_job explicit-only sessions', () => {
  it('omitting session_id stays stateless even for a context provider', async () => {
    const submitJobRequest = vi.fn(async () => 'job-cj-1');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => [contextProviderEvent(PROVIDER_A_NPUB)]),
      submitJobRequest,
      agentDir: dir,
    });

    const tool = findTool('create_job');
    const input = tool.schema.parse({ input: 'hi', provider_npub: PROVIDER_A_NPUB });
    const result = await tool.handler(ctxWith(agent), input);

    const submitArgs = submitJobRequest.mock.calls[0]![1] as { sessionId?: string };
    expect(submitArgs.sessionId).toBeUndefined();
    expect(result.content[0]?.text).not.toContain('session_id');
    // create_job performs no discovery resolution - auto mode must not have fetched.
    expect(agent.client.discovery.fetchAgents).not.toHaveBeenCalled();
  });

  it("'new' mints a session, returns it in the JSON, and records bookkeeping (no turnCount)", async () => {
    const submitJobRequest = vi.fn(async () => 'job-cj-2');
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => []),
      submitJobRequest,
      agentDir: dir,
    });

    const tool = findTool('create_job');
    const input = tool.schema.parse({
      input: 'hi',
      provider_npub: PROVIDER_A_NPUB,
      session_id: 'new',
    });
    const result = await tool.handler(ctxWith(agent), input);

    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { session_id?: string };
    expect(parsed.session_id).toMatch(SESSION_ID_REGEX);
    const entry = await findSessionById(handle, parsed.session_id!);
    expect(entry?.jobIds).toEqual(['job-cj-2']);
    expect(entry?.turnCount).toBe(0);
  });

  it('rejects a session recorded for a different provider', async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY);
    const submitJobRequest = vi.fn();
    const agent = buildStubAgent({
      fetchAgents: vi.fn(async () => []),
      submitJobRequest,
      agentDir: dir,
    });

    const tool = findTool('create_job');
    const input = tool.schema.parse({
      input: 'hi',
      provider_npub: PROVIDER_B_NPUB,
      session_id: UUID_A,
    });
    const result = await tool.handler(ctxWith(agent), input);

    expect(result.isError).toBe(true);
    expect(submitJobRequest).not.toHaveBeenCalled();
  });
});

describe('list_job_sessions', () => {
  it('lists sessions newest-first with a limit', async () => {
    await seedSession(handle, UUID_A, PROVIDER_A_PUBKEY, 'job-1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedSession(handle, UUID_B, PROVIDER_B_PUBKEY, 'job-2');
    const agent = buildStubAgent({ fetchAgents: vi.fn(async () => []), agentDir: dir });

    const tool = findTool('list_job_sessions');
    const result = await tool.handler(ctxWith(agent), tool.schema.parse({ limit: 1 }));

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Found 1 conversation(s)');
    expect(text).toContain(UUID_B);
    expect(text).not.toContain(UUID_A);
  });

  it('serves the in-memory registry for ephemeral agents (never an empty lie)', async () => {
    const memHandle: SessionStoreHandle = { identityPubkey: IDENTITY_PUBKEY };
    await seedSession(memHandle, UUID_A, PROVIDER_A_PUBKEY);
    const agent = buildStubAgent({ fetchAgents: vi.fn(async () => []) });

    const tool = findTool('list_job_sessions');
    const result = await tool.handler(ctxWith(agent), tool.schema.parse({}));

    expect(result.content[0]?.text).toContain(UUID_A);
  });
});

describe('get_job_result late bump (integration)', () => {
  const UUID_LATE = '9f8e7d6c-5b4a-4321-8abc-def012345678';
  const LATE_JOB = 'f'.repeat(64);

  function resultAgent() {
    return buildStubAgent({
      fetchAgents: vi.fn(async () => []),
      subscribeToJobUpdates: vi.fn(
        (options: { callbacks: { onResult: (content: string, eventId: string) => void } }) => {
          setTimeout(() => options.callbacks.onResult('late answer', LATE_JOB), 5);
          return () => {};
        },
      ),
      agentDir: dir,
    });
  }

  async function seedPendingJob(providerPubkey: string) {
    await appendCustomerJob(dir, {
      jobEventId: LATE_JOB,
      capability: 'general',
      providerPubkey,
      submittedAt: 1,
      completedAt: 2,
      status: 'pending',
    });
    await recordSessionSubmit(handle, {
      sessionId: UUID_LATE,
      providerPubkey,
      capability: 'general',
      firstPrompt: 'hello',
      jobEventId: LATE_JOB,
    });
  }

  it('bumps the turn count once on an authenticated fetch, idempotent on re-poll', async () => {
    await seedPendingJob(PROVIDER_A_PUBKEY);
    const tool = findTool('get_job_result');
    const input = tool.schema.parse({ job_event_id: LATE_JOB, provider_npub: PROVIDER_A_NPUB });
    await tool.handler(ctxWith(resultAgent()), input);
    expect((await findSessionById(handle, UUID_LATE))?.turnCount).toBe(1);
    // Re-poll of the now-completed entry: the conditional transition does not
    // fire, so the count stays exactly once per exchange.
    await tool.handler(ctxWith(resultAgent()), input);
    expect((await findSessionById(handle, UUID_LATE))?.turnCount).toBe(1);
  });

  it('never bumps for an unauthenticated fetch or a mismatched author', async () => {
    await seedPendingJob(PROVIDER_B_PUBKEY);
    const tool = findTool('get_job_result');
    // No provider_npub: the SDK skipped its author check - the bump must not
    // trust a spoofable result.
    await tool.handler(ctxWith(resultAgent()), tool.schema.parse({ job_event_id: LATE_JOB }));
    expect((await findSessionById(handle, UUID_LATE))?.turnCount).toBe(0);
    // provider_npub differing from the author recorded at submit: no bump.
    await tool.handler(
      ctxWith(resultAgent()),
      tool.schema.parse({ job_event_id: LATE_JOB, provider_npub: PROVIDER_A_NPUB }),
    );
    expect((await findSessionById(handle, UUID_LATE))?.turnCount).toBe(0);
  });
});
