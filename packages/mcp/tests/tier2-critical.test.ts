import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Tier 2 CRITICAL regression tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveAgentConfig, loadAgentConfig, updateAgentSecurity } from '../src/config.js';
import { AgentContext, explorerClusterFor, rpcUrlFor, type AgentInstance } from '../src/context.js';
import { registeredTools } from '../src/server.js';
import { parseSolToLamports } from '../src/utils.js';

describe('tool registry', () => {
  it('all tool names are unique and non-empty', () => {
    const names = registeredTools.map((t) => t.name);
    expect(names.every((n) => n && n.length > 0)).toBe(true);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('registers exactly 21 tools (ping_agent folded into search/pre-ping; estimate_payment_cost added with USDC; submit_feedback / add_contact / remove_contact / list_contacts added)', () => {
    expect(registeredTools).toHaveLength(21);
  });

  it('every registered tool has a Zod schema and a handler', () => {
    for (const tool of registeredTools) {
      expect(tool.schema).toBeDefined();
      expect(typeof tool.handler).toBe('function');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe('network mapping', () => {
  it('rpcUrlFor returns the devnet RPC', () => {
    expect(rpcUrlFor('devnet')).toBe('https://api.devnet.solana.com');
  });

  it('explorer cluster query param matches network', () => {
    expect(explorerClusterFor('devnet')).toBe('devnet');
  });
});

describe('withdrawal nonce', () => {
  it('issues and consumes a nonce exactly once', () => {
    const ctx = new AgentContext();
    ctx.issueWithdrawalNonce({
      id: 'abc',
      agentName: 'a',
      destination: 'dest',
      amountRaw: '1',
      lamports: 1_000_000n,
      createdAt: Date.now(),
    });
    const first = ctx.consumeWithdrawalNonce('abc');
    expect(first).toBeTruthy();
    const second = ctx.consumeWithdrawalNonce('abc');
    expect(second).toBeNull();
  });

  it('rejects an expired nonce', () => {
    const ctx = new AgentContext();
    ctx.issueWithdrawalNonce({
      id: 'old',
      agentName: 'a',
      destination: 'dest',
      amountRaw: '1',
      lamports: 1n,
      createdAt: Date.now() - AgentContext.NONCE_TTL_MS - 1,
    });
    expect(ctx.consumeWithdrawalNonce('old')).toBeNull();
  });

  it('returns null for unknown nonce', () => {
    const ctx = new AgentContext();
    expect(ctx.consumeWithdrawalNonce('nonexistent')).toBeNull();
  });
});

describe('config security flags', () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'elisym-mcp-tier2-'));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('saveAgentConfig persists security block and loadAgentConfig returns it', async () => {
    await saveAgentConfig('sec-agent', {
      name: 'sec-agent',
      description: 'test',
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: '0'.repeat(64),
      network: 'devnet',
      security: { withdrawals_enabled: true, agent_switch_enabled: false },
    });
    const loaded = await loadAgentConfig('sec-agent');
    expect(loaded.security.withdrawals_enabled).toBe(true);
    expect(loaded.security.agent_switch_enabled).toBe(false);
    expect(loaded.network).toBe('devnet');
  });

  it('defaults both flags to undefined when not set', async () => {
    await saveAgentConfig('default-sec', {
      name: 'default-sec',
      description: 'test',
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: '0'.repeat(64),
      network: 'devnet',
    });
    const loaded = await loadAgentConfig('default-sec');
    expect(loaded.security.withdrawals_enabled).toBeFalsy();
    expect(loaded.security.agent_switch_enabled).toBeFalsy();
  });

  it('updateAgentSecurity merges flags', async () => {
    await saveAgentConfig('merge-sec', {
      name: 'merge-sec',
      description: 'test',
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: '0'.repeat(64),
      solanaSecretKey: 'z'.repeat(87),
      solanaAddress: 'CYWTDfv5keEpddQRkpYCuSGkzPkMRh2UWsw7zrgoC4QP',
      network: 'devnet',
      security: { agent_switch_enabled: true },
    });
    const merged = await updateAgentSecurity('merge-sec', { withdrawals_enabled: true });
    expect(merged.withdrawals_enabled).toBe(true);
    expect(merged.agent_switch_enabled).toBe(true);

    const reloaded = await loadAgentConfig('merge-sec');
    expect(reloaded.network).toBe('devnet');
    expect(reloaded.security.withdrawals_enabled).toBe(true);
    expect(reloaded.security.agent_switch_enabled).toBe(true);
  });

  it('payments[].network propagates into AgentConfigData', async () => {
    await saveAgentConfig('net-agent', {
      name: 'net-agent',
      description: 'test',
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: '0'.repeat(64),
      solanaSecretKey: 'z'.repeat(87),
      solanaAddress: 'CYWTDfv5keEpddQRkpYCuSGkzPkMRh2UWsw7zrgoC4QP',
      network: 'devnet',
    });
    const loaded = await loadAgentConfig('net-agent');
    expect(loaded.network).toBe('devnet');
    expect(loaded.payments?.[0]?.network).toBe('devnet');
  });

  it('rejects loading a YAML that declares a non-devnet network', async () => {
    // Simulate a hand-edited or legacy YAML with mainnet - Zod in agent-store
    // rejects it with a clear error before the MCP adapter gets a chance.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(tmpHome, '.elisym', 'legacy-mainnet');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'elisym.yaml'),
      [
        'description: old',
        'relays: [wss://relay.damus.io]',
        'payments:',
        '  - chain: solana',
        '    network: mainnet',
        '    address: CYWTDfv5keEpddQRkpYCuSGkzPkMRh2UWsw7zrgoC4QP',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(dir, '.secrets.json'),
      JSON.stringify({ nostr_secret_key: '0'.repeat(64) }),
    );
    await expect(loadAgentConfig('legacy-mainnet')).rejects.toThrow();
  });
});

describe('encryption', () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;
  const originalPassphrase = process.env.ELISYM_PASSPHRASE;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'elisym-mcp-enc-'));
    process.env.HOME = tmpHome;
    delete process.env.ELISYM_PASSPHRASE;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalPassphrase) {
      process.env.ELISYM_PASSPHRASE = originalPassphrase;
    } else {
      delete process.env.ELISYM_PASSPHRASE;
    }
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('saves encrypted config and loads it with passphrase', async () => {
    await saveAgentConfig('enc-agent', {
      name: 'enc-agent',
      description: 'test',
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: 'a'.repeat(64),
      network: 'devnet',
      passphrase: 'my-secret-pass',
    });

    // Fails without passphrase.
    await expect(loadAgentConfig('enc-agent')).rejects.toThrow(/encrypted|passphrase/i);

    // Succeeds with passphrase.
    const loaded = await loadAgentConfig('enc-agent', 'my-secret-pass');
    expect(loaded.nostrSecretKey).toBe('a'.repeat(64));
    expect(loaded.encrypted).toBe(true);
  });

  it('unencrypted config loads without passphrase and encrypted=false', async () => {
    await saveAgentConfig('plain-agent', {
      name: 'plain-agent',
      description: 'test',
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: 'b'.repeat(64),
      network: 'devnet',
    });
    const loaded = await loadAgentConfig('plain-agent');
    expect(loaded.encrypted).toBe(false);
    expect(loaded.nostrSecretKey).toBe('b'.repeat(64));
  });

  it('reads passphrase from ELISYM_PASSPHRASE env var when not passed explicitly', async () => {
    await saveAgentConfig('env-enc', {
      name: 'env-enc',
      description: 'test',
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: 'c'.repeat(64),
      network: 'devnet',
      passphrase: 'env-pass',
    });
    process.env.ELISYM_PASSPHRASE = 'env-pass';
    const loaded = await loadAgentConfig('env-enc');
    expect(loaded.nostrSecretKey).toBe('c'.repeat(64));
  });
});

describe('parseSolToLamports input validation', () => {
  it('rejects scientific notation', () => {
    expect(() => parseSolToLamports('1e9')).toThrow(/decimal/);
  });

  it('rejects hex', () => {
    expect(() => parseSolToLamports('0x5')).toThrow(/decimal/);
  });

  it('rejects comma-separated', () => {
    expect(() => parseSolToLamports('1,000')).toThrow(/decimal/);
  });

  it('rejects leading plus', () => {
    expect(() => parseSolToLamports('+5')).toThrow(/decimal/);
  });

  it('rejects multiple dots', () => {
    expect(() => parseSolToLamports('1.2.3')).toThrow(/decimal/);
  });

  it('accepts trailing dot', () => {
    expect(parseSolToLamports('1.')).toBe(1_000_000_000n);
  });
});

describe('AgentInstance structure', () => {
  it('AgentInstance requires a network field', () => {
    // Compile-time contract via a structural type check.
    type Required<T> = { [K in keyof T]-?: T[K] };
    const _check: Pick<Required<AgentInstance>, 'network' | 'security'> = {
      network: 'devnet',
      security: {},
    };
    expect(_check.network).toBe('devnet');
  });
});
