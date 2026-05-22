/**
 * get_job_result reframes a wait-window timeout as "not ready yet" (a non-error
 * result the caller can re-poll) while keeping a real provider failure an error.
 * The subscribe stub fires onError directly, so no payment flow is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { customerTools } from '../src/tools/customer.js';

function findTool(name: string) {
  const tool = customerTools.find((toolDef) => toolDef.name === name);
  if (!tool) throw new Error(`tool ${name} not found in customerTools`);
  return tool;
}

/** Agent whose subscribeToJobUpdates fires a single onError shortly after subscribing. */
function buildAgent(onErrorMessage: string): AgentInstance {
  const identity = {
    publicKey: 'd'.repeat(64),
    npub: 'npub-stub',
    secretKey: new Uint8Array(32),
  };
  const client = {
    marketplace: {
      subscribeToJobUpdates: vi.fn((options: { callbacks: { onError: (msg: string) => void } }) => {
        setTimeout(() => options.callbacks.onError(onErrorMessage), 5);
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

describe('get_job_result pending behavior', () => {
  it('returns a non-error "not ready yet" notice on a wait-window timeout', async () => {
    const ctx = ctxWith(buildAgent('Timed out waiting for response (1s).'));
    const tool = findTool('get_job_result');
    const input = tool.schema.parse({ job_event_id: JOB_ID });

    const result = await tool.handler(ctx, input);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/not ready yet/i);
  });

  it('returns an error for a real provider failure (non-timeout)', async () => {
    const ctx = ctxWith(buildAgent('provider exploded'));
    const tool = findTool('get_job_result');
    const input = tool.schema.parse({ job_event_id: JOB_ID });

    const result = await tool.handler(ctx, input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/failed to fetch/i);
  });
});
