/**
 * The relay-touching read tools share the tool rate limiter: an injected loop over
 * list_conversations, get_messages or get_agent_policies cannot amplify relay traffic.
 */
import { nip19 } from 'nostr-tools';
import { describe, it, expect } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { messagesTools } from '../src/tools/messages.js';
import { policiesTools } from '../src/tools/policies.js';
import { MAX_NPUB_LEN } from '../src/utils.js';

const TOOL_WINDOW = 10;

function exhaustedContext(): AgentContext {
  const ctx = new AgentContext();
  const agent: AgentInstance = {
    client: {} as never,
    identity: {
      publicKey: 'd'.repeat(64),
      npub: 'npub-stub',
      secretKey: new Uint8Array(32),
    } as never,
    name: 'stub',
    network: 'devnet',
    security: {},
    solanaKeypair: undefined,
  };
  ctx.register(agent);
  for (let call = 0; call < TOOL_WINDOW; call++) {
    ctx.toolRateLimiter.check();
  }
  return ctx;
}

function findTool(tools: typeof messagesTools, name: string) {
  const tool = tools.find((toolDef) => toolDef.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

const NPUB = nip19.npubEncode('a'.repeat(64));

describe('relay-touching read tools are rate-limited', () => {
  it.each([
    [messagesTools, 'list_conversations', {}],
    [messagesTools, 'get_messages', { counterpart: NPUB }],
    [policiesTools, 'get_agent_policies', { agent_npub: NPUB }],
  ] as const)('%#: %s refuses once the window is full', async (tools, name, args) => {
    const tool = findTool(tools, name);
    await expect(tool.handler(exhaustedContext(), tool.schema.parse(args))).rejects.toThrow(
      /Rate limit/,
    );
  });

  it('get_agent_policies refuses an npub longer than any npub', () => {
    const tool = findTool(policiesTools, 'get_agent_policies');
    expect(tool.schema.safeParse({ agent_npub: 'n'.repeat(MAX_NPUB_LEN + 1) }).success).toBe(false);
    expect(tool.schema.safeParse({ agent_npub: NPUB }).success).toBe(true);
  });
});
