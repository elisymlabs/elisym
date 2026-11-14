/**
 * get_job_result reframes a wait-window timeout (the SDK's typed `onTimeout`
 * signal) as "not ready yet" - a non-error result the caller can re-poll -
 * while a real provider failure (via `onError`) stays an error, even when the
 * provider's error text happens to contain "timed out" (the bug the typed
 * signal fixes: substring matching used to mask such errors as pending).
 * The subscribe stub fires a single callback shortly after subscribing, so no
 * payment flow is needed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nip19 } from 'nostr-tools';
import { describe, it, expect, vi } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { appendCustomerJob } from '../src/storage/customer-history.js';
import { customerTools } from '../src/tools/customer.js';

interface StubCallbacks {
  onResult: (content: string, eventId: string, attachment?: unknown) => void;
  onError: (msg: string) => void;
  onTimeout: (timeoutMs: number) => void;
}

function findTool(name: string) {
  const tool = customerTools.find((toolDef) => toolDef.name === name);
  if (!tool) throw new Error(`tool ${name} not found in customerTools`);
  return tool;
}

/** Agent whose subscribeToJobUpdates invokes `fire` with the callbacks shortly after subscribing. */
function buildAgent(fire: (callbacks: StubCallbacks) => void): AgentInstance {
  const identity = {
    publicKey: 'd'.repeat(64),
    npub: 'npub-stub',
    secretKey: new Uint8Array(32),
  };
  const client = {
    marketplace: {
      subscribeToJobUpdates: vi.fn((options: { callbacks: StubCallbacks }) => {
        setTimeout(() => fire(options.callbacks), 5);
        return () => {};
      }),
    },
  };
  return {
    client: client as never,
    identity: identity as never,
    name: 'stub',
    network: 'devnet',
    security: {},
    solanaKeypair: undefined,
  };
}

function ctxWith(agent: AgentInstance): AgentContext {
  const ctx = new AgentContext();
  ctx.register(agent);
  return ctx;
}

const JOB_ID = 'a'.repeat(64);

async function runGetJobResult(agent: AgentInstance, extra: Record<string, unknown> = {}) {
  const ctx = ctxWith(agent);
  const tool = findTool('get_job_result');
  const input = tool.schema.parse({ job_event_id: JOB_ID, ...extra });
  return tool.handler(ctx, input);
}

describe('get_job_result pending behavior', () => {
  it('returns a non-error "not ready yet" notice on a wait-window timeout', async () => {
    const result = await runGetJobResult(buildAgent((cb) => cb.onTimeout(1000)));

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/not ready yet/i);
  });

  it('returns an error for a real provider failure (non-timeout)', async () => {
    const result = await runGetJobResult(buildAgent((cb) => cb.onError('provider exploded')));

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/failed to fetch/i);
  });

  it('returns an error for a provider error whose text contains "timed out" (not masked as pending)', async () => {
    const result = await runGetJobResult(
      buildAgent((cb) => cb.onError('upstream request timed out')),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/failed to fetch/i);
  });

  it('flags an unauthenticated result when provider_npub is omitted', async () => {
    // No provider_npub -> the SDK skips its result-author check, so any author could
    // have published this result. The handler must surface that the author is unverified.
    const result = await runGetJobResult(buildAgent((cb) => cb.onResult('the answer', 'evt')));

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/not verified/i);
    expect(result.content[0]?.text).toContain('the answer');
  });

  it('binds the result to the provider recorded for a job submitted here', async () => {
    // No provider_npub, but the local history knows who was hired: the SDK filters
    // results by that author, so no unverified note and no third-party substitution.
    const agentDir = mkdtempSync(join(tmpdir(), 'elisym-get-job-result-'));
    try {
      const provider = 'b'.repeat(64);
      await appendCustomerJob(agentDir, {
        jobEventId: JOB_ID,
        capability: 'translate',
        providerPubkey: provider,
        status: 'pending',
        submittedAt: 1_700_000_000_000,
        completedAt: 1_700_000_000_000,
      });
      const agent = buildAgent((cb) => cb.onResult('the answer', 'evt'));
      agent.agentDir = agentDir;
      const result = await runGetJobResult(agent);

      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).not.toMatch(/not verified/i);
      const subscribe = vi.mocked(agent.client.marketplace.subscribeToJobUpdates);
      expect(subscribe.mock.calls[0]?.[0]).toMatchObject({ providerPubkey: provider });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('omits the unauthenticated note when provider_npub is supplied', async () => {
    const result = await runGetJobResult(
      buildAgent((cb) => cb.onResult('the answer', 'evt')),
      {
        provider_npub: nip19.npubEncode('a'.repeat(64)),
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).not.toMatch(/not verified/i);
    expect(result.content[0]?.text).toContain('the answer');
  });
});
