import { describe, it, expect } from 'vitest';
import { validateAgentName, serializeConfig } from '../src/primitives/config';
import { parseConfig } from '../src/primitives/config-node';
import { encryptSecret } from '../src/primitives/encryption';
import type { AgentConfig } from '../src/types';

describe('validateAgentName', () => {
  it('accepts valid names', () => {
    expect(() => validateAgentName('my-agent')).not.toThrow();
    expect(() => validateAgentName('agent_01')).not.toThrow();
    expect(() => validateAgentName('A')).not.toThrow();
    expect(() => validateAgentName('a'.repeat(64))).not.toThrow();
  });

  it('rejects empty name', () => {
    expect(() => validateAgentName('')).toThrow();
  });

  it('rejects name longer than 64 chars', () => {
    expect(() => validateAgentName('a'.repeat(65))).toThrow();
  });

  it('rejects names with spaces', () => {
    expect(() => validateAgentName('my agent')).toThrow();
  });

  it('rejects names with special characters', () => {
    expect(() => validateAgentName('agent@home')).toThrow();
    expect(() => validateAgentName('agent.v2')).toThrow();
    expect(() => validateAgentName('agent/path')).toThrow();
  });
});

describe('serializeConfig', () => {
  const minimalConfig: AgentConfig = {
    identity: {
      secret_key: 'abcd1234',
      name: 'test-agent',
    },
    relays: ['wss://relay.damus.io'],
  };

  it('serializes minimal config to valid JSON', () => {
    const json = serializeConfig(minimalConfig);
    const parsed = JSON.parse(json);
    expect(parsed.identity.name).toBe('test-agent');
    expect(parsed.identity.secret_key).toBe('abcd1234');
    expect(parsed.relays).toEqual(['wss://relay.damus.io']);
    expect(parsed.capabilities).toBeUndefined();
    expect(parsed.payments).toBeUndefined();
    expect(parsed.wallet).toBeUndefined();
    expect(parsed.llm).toBeUndefined();
  });

  it('serializes full config', () => {
    const fullConfig: AgentConfig = {
      identity: {
        secret_key: 'abcd1234',
        name: 'test-agent',
        description: 'A test agent',
        picture: 'https://example.com/avatar.png',
        banner: 'https://example.com/banner.png',
      },
      relays: ['wss://relay.damus.io'],
      capabilities: [
        { name: 'text-gen', description: 'Generate text', tags: ['text'], price: 10000000 },
        {
          name: 'code-review',
          description: 'Review code',
          tags: ['code', 'review'],
          price: 50000000,
        },
      ],
      payments: [{ chain: 'solana', network: 'devnet', address: 'addr123' }],
      wallet: {
        chain: 'solana',
        network: 'devnet',
        secret_key: 'walletkey123',
      },
      llm: {
        provider: 'anthropic',
        api_key: 'sk-test',
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
      },
    };
    const json = serializeConfig(fullConfig);
    const parsed = JSON.parse(json);
    expect(parsed.capabilities).toHaveLength(2);
    expect(parsed.capabilities[0].tags).toEqual(['text']);
    expect(parsed.capabilities[1].price).toBe(50000000);
    expect(parsed.payments[0].address).toBe('addr123');
    expect(parsed.wallet.chain).toBe('solana');
    expect(parsed.llm.provider).toBe('anthropic');
  });
});

describe('parseConfig', () => {
  it('round-trips through serialize/parse', () => {
    const config: AgentConfig = {
      identity: { secret_key: 'hex1234', name: 'test' },
      relays: ['wss://relay.damus.io'],
      capabilities: [{ name: 'test', description: 'Test', tags: ['test'], price: 100 }],
      payments: [{ chain: 'solana', network: 'devnet', address: 'addr' }],
    };
    const json = serializeConfig(config);
    const parsed = parseConfig(json);
    expect(parsed).toEqual(config);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseConfig('not json')).toThrow();
  });

  // 30s timeout: this test runs 6 scrypt operations (3 encrypts in setup +
  // 3 decrypts inside parseConfig). Each scrypt round is ~800ms on the GitHub
  // Actions runner, putting the total just over the default 5s vitest cap
  // (passed locally, flaked in CI). Other tests in this file only do 1-2
  // scrypt rounds and stay well under the default.
  it('decrypts encrypted fields with passphrase', () => {
    const passphrase = 'test-pass';
    const config: AgentConfig = {
      identity: {
        secret_key: encryptSecret('my-nostr-key', passphrase),
        name: 'test',
      },
      relays: [],
      wallet: {
        chain: 'solana',
        network: 'devnet',
        secret_key: encryptSecret('my-wallet-key', passphrase),
      },
      llm: {
        provider: 'anthropic',
        api_key: encryptSecret('sk-api-key', passphrase),
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
      },
    };
    const json = serializeConfig(config);
    const parsed = parseConfig(json, passphrase);
    expect(parsed.identity.secret_key).toBe('my-nostr-key');
    expect(parsed.wallet!.secret_key).toBe('my-wallet-key');
    expect(parsed.llm!.api_key).toBe('sk-api-key');
  }, 30_000);

  it('throws if encrypted fields exist but no passphrase', () => {
    const config: AgentConfig = {
      identity: {
        secret_key: encryptSecret('secret', 'pass'),
        name: 'test',
      },
      relays: [],
    };
    const json = serializeConfig(config);
    expect(() => parseConfig(json)).toThrow('no passphrase');
  });

  it('passes through unencrypted fields without passphrase', () => {
    const config: AgentConfig = {
      identity: { secret_key: 'plain-hex-key', name: 'test' },
      relays: ['wss://relay.damus.io'],
    };
    const json = serializeConfig(config);
    const parsed = parseConfig(json);
    expect(parsed.identity.secret_key).toBe('plain-hex-key');
  });
});
