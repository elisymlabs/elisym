/**
 * Invariants that protect operational guarantees we've promised elsewhere
 * (README, MCP tool descriptions, security notes). A regression here would
 * change observable behaviour for MCP clients even if types still compile.
 */
import { describe, expect, it } from 'vitest';
import { registeredTools } from '../src/server.js';
import { customerTools } from '../src/tools/customer.js';
import { discoveryTools } from '../src/tools/discovery.js';

describe('broadcast is not reachable through any MCP tool', () => {
  const JOB_SUBMITTING_TOOLS = ['create_job', 'submit_and_pay_job', 'buy_capability'];

  for (const toolName of JOB_SUBMITTING_TOOLS) {
    it(`${toolName} requires provider_npub in its Zod schema`, () => {
      const tool = customerTools.find((candidate) => candidate.name === toolName);
      expect(tool, `tool ${toolName} is registered`).toBeDefined();
      // Parsing input without provider_npub must throw. If this ever becomes
      // optional, a caller could issue a broadcast job through MCP, which is
      // explicitly out of scope for the customer-mode server.
      expect(() => tool!.schema.parse({ input: 'x', capability: 'y' })).toThrow(/provider_npub/);
    });
  }
});

describe('ping is an internal mechanism, not a user-facing tool', () => {
  it('ping_agent is not registered as an MCP tool', () => {
    // Pre-ping runs inside submit_and_pay_job / buy_capability and inside
    // search_agents. Exposing it as a separate tool historically caused LLMs
    // to skip it when it mattered and call it when it didn't.
    expect(registeredTools.some((tool) => tool.name === 'ping_agent')).toBe(false);
    expect(discoveryTools.some((tool) => tool.name === 'ping_agent')).toBe(false);
  });
});
