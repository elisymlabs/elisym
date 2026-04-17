/**
 * create_agent must respect the current active agent's
 * `security.agent_switch_enabled` flag when `activate=true`. Previously, a prompt
 * injection could force a pivot to a freshly generated wallet without any gate.
 *
 * These tests use a tmp $HOME so config files don't collide with the developer's
 * real ~/.elisym directory.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { agentTools } from '../src/tools/agent.js';

function findTool(name: string) {
  const tool = agentTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

function makeActiveAgentStub(name: string, switchEnabled: boolean): AgentInstance {
  return {
    client: {} as never,
    identity: {
      publicKey: 'a'.repeat(64),
      npub: 'npub1' + 'a'.repeat(59),
      secretKey: new Uint8Array(32),
    } as never,
    name,
    network: 'devnet',
    security: { agent_switch_enabled: switchEnabled },
  };
}

describe('create_agent respects agent_switch gate', () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;
  const originalEnvOverride = process.env.ELISYM_ALLOW_AGENT_SWITCH;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'elisym-create-gate-'));
    process.env.HOME = tmpHome;
    delete process.env.ELISYM_ALLOW_AGENT_SWITCH;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalEnvOverride === undefined) {
      delete process.env.ELISYM_ALLOW_AGENT_SWITCH;
    } else {
      process.env.ELISYM_ALLOW_AGENT_SWITCH = originalEnvOverride;
    }
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('refuses to activate when current agent has agent_switch_enabled=false', async () => {
    const ctx = new AgentContext();
    ctx.register(makeActiveAgentStub('locked', false));

    const tool = findTool('create_agent');
    const input = tool.schema.parse({
      name: 'new-agent',
      activate: true,
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/agent_switch is disabled/i);
    // The locked agent must still be active.
    expect(ctx.activeAgentName).toBe('locked');
    // The new agent must not have been registered.
    expect(ctx.registry.has('new-agent')).toBe(false);
  });

  it('allows activation when current agent has agent_switch_enabled=true', async () => {
    const ctx = new AgentContext();
    ctx.register(makeActiveAgentStub('unlocked', true));

    const tool = findTool('create_agent');
    const input = tool.schema.parse({
      name: 'new-agent',
      activate: true,
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBeFalsy();
    expect(ctx.activeAgentName).toBe('new-agent');
  });

  it('honors ELISYM_ALLOW_AGENT_SWITCH=1 env override', async () => {
    process.env.ELISYM_ALLOW_AGENT_SWITCH = '1';
    const ctx = new AgentContext();
    ctx.register(makeActiveAgentStub('locked', false));

    const tool = findTool('create_agent');
    const input = tool.schema.parse({
      name: 'new-agent',
      activate: true,
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBeFalsy();
    expect(ctx.activeAgentName).toBe('new-agent');
  });

  it('allows first-run create when no active agent exists', async () => {
    const ctx = new AgentContext(); // empty, no registered agents

    const tool = findTool('create_agent');
    const input = tool.schema.parse({
      name: 'first-agent',
      activate: true,
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBeFalsy();
    expect(ctx.activeAgentName).toBe('first-agent');
  });

  it('allows non-activating create even with a locked current agent', async () => {
    const ctx = new AgentContext();
    ctx.register(makeActiveAgentStub('locked', false));

    const tool = findTool('create_agent');
    const input = tool.schema.parse({
      name: 'passive',
      activate: false,
    });
    const result = await tool.handler(ctx, input);

    expect(result.isError).toBeFalsy();
    // Still locked.
    expect(ctx.activeAgentName).toBe('locked');
    // New agent is in registry but not active.
    expect(ctx.registry.has('passive')).toBe(true);
  });
});
