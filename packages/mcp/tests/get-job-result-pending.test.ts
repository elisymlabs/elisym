/**
 * get_job_result reframes a wait-window timeout (the SDK's typed `onTimeout`
 * signal) as "not ready yet" - a non-error result the caller can re-poll -
 * while a real provider failure (via `onError`) stays an error, even when the
 * provider's error text happens to contain "timed out" (the bug the typed
 * signal fixes: substring matching used to mask such errors as pending).
 * The subscribe stub fires a single callback shortly after subscribing, so no
 * payment flow is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { customerTools } from '../src/tools/customer.js';

interface StubCallbacks {
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

async function runGetJobResult(agent: AgentInstance) {
  const ctx = ctxWith(agent);
  const tool = findTool('get_job_result');
  const input = tool.schema.parse({ job_event_id: JOB_ID });
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
});
