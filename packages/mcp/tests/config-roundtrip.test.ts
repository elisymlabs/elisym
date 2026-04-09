/**
 * regression test for the create_agent/init capability shape bug.
 *
 * The original code wrote `capabilities: string[]` into config.json, which silently
 * typechecked because `ToolDefinition.handler` was `input: any`. On the next
 * server start, `parseConfig` from `@elisym/sdk/node` strictly rejected the string
 * array and the agent became unloadable. This test forces a full round-trip:
 *
 *     create_agent payload shape -> saveAgentConfig -> JSON file -> parseConfig
 *
 * and fails if the saved config cannot be re-loaded.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@elisym/sdk/node';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveAgentConfig, loadAgentConfig } from '../src/config.js';

describe('agent config round-trip', () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'elisym-mcp-test-'));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('saves capabilities as proper Capability objects and re-loads via parseConfig', async () => {
    // This is exactly the shape that create_agent and `elisym-mcp init` must produce.
    // Previously, this was `capabilities: ['mcp-gateway']` (string[]) and the
    // round-trip through parseConfig threw.
    await saveAgentConfig('round-trip-agent', {
      name: 'round-trip-agent',
      description: 'test',
      capabilities: [
        { name: 'mcp-gateway', description: 'mcp-gateway', tags: ['mcp-gateway'], price: 0 },
        { name: 'summarize', description: 'summarize', tags: ['summarize'], price: 0 },
      ],
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: '0'.repeat(64),
      solanaSecretKey:
        '1111111111111111111111111111111111111111111111111111111111111111111111111111111111111', // 87-char placeholder
      network: 'devnet',
    });

    const raw = await readFile(
      join(process.env.HOME!, '.elisym', 'agents', 'round-trip-agent', 'config.json'),
      'utf-8',
    );
    // parseConfig is the exact function the MCP server calls at startup; if capabilities
    // are in the wrong shape this throws.
    const parsed = parseConfig(raw);
    expect(parsed.capabilities).toBeDefined();
    expect(Array.isArray(parsed.capabilities)).toBe(true);
    expect(parsed.capabilities?.[0]).toMatchObject({
      name: 'mcp-gateway',
      description: 'mcp-gateway',
      tags: ['mcp-gateway'],
      price: 0,
    });
  });

  it('saveAgentConfig + loadAgentConfig returns the secret key', async () => {
    await saveAgentConfig('load-agent', {
      name: 'load-agent',
      description: 'test',
      capabilities: [{ name: 'demo', description: 'demo', tags: ['demo'], price: 0 }],
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: 'a'.repeat(64),
      network: 'devnet',
    });

    const loaded = await loadAgentConfig('load-agent');
    expect(loaded.nostrSecretKey).toBe('a'.repeat(64));
  });

  it('empty capability tokens are filtered out', async () => {
    // Simulates `capabilities: 'a, , b,'` input after split/trim.
    await saveAgentConfig('filtered', {
      name: 'filtered',
      description: 'test',
      capabilities: [
        { name: 'a', description: 'a', tags: ['a'], price: 0 },
        { name: 'b', description: 'b', tags: ['b'], price: 0 },
      ],
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: '0'.repeat(64),
      network: 'devnet',
    });
    const raw = await readFile(
      join(process.env.HOME!, '.elisym', 'agents', 'filtered', 'config.json'),
      'utf-8',
    );
    const parsed = parseConfig(raw);
    expect(parsed.capabilities).toHaveLength(2);
  });
});
