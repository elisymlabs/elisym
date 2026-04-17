/**
 * Round-trip regression test: create_agent/init payload shape must survive
 * saveAgentConfig -> on-disk YAML + secrets -> loadAgentConfig without loss
 * or schema errors.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('saveAgentConfig writes YAML + secrets and loadAgentConfig reads them back', async () => {
    await saveAgentConfig('round-trip-agent', {
      name: 'round-trip-agent',
      description: 'round-trip test',
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: '0'.repeat(64),
      solanaAddress: 'CYWTDfv5keEpddQRkpYCuSGkzPkMRh2UWsw7zrgoC4QP',
      solanaSecretKey: '1'.repeat(87),
      network: 'devnet',
    });

    const agentDir = join(tmpHome, '.elisym', 'round-trip-agent');
    const yamlRaw = await readFile(join(agentDir, 'elisym.yaml'), 'utf-8');
    expect(yamlRaw).toContain('description: round-trip test');
    expect(yamlRaw).toContain('CYWTDfv5keEpddQRkpYCuSGkzPkMRh2UWsw7zrgoC4QP');

    const secretsRaw = JSON.parse(await readFile(join(agentDir, '.secrets.json'), 'utf-8'));
    expect(secretsRaw.nostr_secret_key).toBe('0'.repeat(64));

    const loaded = await loadAgentConfig('round-trip-agent');
    expect(loaded.nostrSecretKey).toBe('0'.repeat(64));
    expect(loaded.solanaSecretKey).toBe('1'.repeat(87));
    expect(loaded.payments?.[0]?.address).toBe('CYWTDfv5keEpddQRkpYCuSGkzPkMRh2UWsw7zrgoC4QP');
    expect(loaded.network).toBe('devnet');
    expect(loaded.encrypted).toBe(false);
  });

  it('saveAgentConfig + loadAgentConfig returns the secret key', async () => {
    await saveAgentConfig('load-agent', {
      name: 'load-agent',
      description: 'test',
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: 'a'.repeat(64),
      network: 'devnet',
    });

    const loaded = await loadAgentConfig('load-agent');
    expect(loaded.nostrSecretKey).toBe('a'.repeat(64));
  });

  it('omits payments when no Solana address is given', async () => {
    await saveAgentConfig('no-wallet', {
      name: 'no-wallet',
      description: 'test',
      relays: ['wss://relay.damus.io'],
      nostrSecretKey: 'b'.repeat(64),
      network: 'devnet',
    });

    const loaded = await loadAgentConfig('no-wallet');
    expect(loaded.payments).toBeUndefined();
    // network falls back to 'devnet' (only supported value) even without payments.
    expect(loaded.network).toBe('devnet');
  });
});
