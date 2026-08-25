/**
 * D10 hostname allowlist tests: mainnet ONLY on the exact production host,
 * every other hostname (app-dev, localhost, loopback, LAN IPs, Vercel
 * previews, lookalikes) fails safe to devnet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCluster, rpcUrlFor, SOLANA_CLUSTER } from '~/lib/cluster';

describe('resolveCluster', () => {
  it('resolves mainnet only for the exact production host', () => {
    expect(resolveCluster('app.elisym.network')).toBe('mainnet');
  });

  it.each([
    'app-dev.elisym.network',
    'localhost',
    '127.0.0.1',
    '192.168.1.10',
    'elisym-app-abc123.vercel.app',
    'app.elisym.network.attacker.example',
    'evil-app.elisym.network',
    'staging.app.elisym.network',
    'some-unknown-host.example',
    '',
  ])('fails safe to devnet for %j', (hostname) => {
    expect(resolveCluster(hostname)).toBe('devnet');
  });

  it('module constant fails safe to devnet in a windowless (node) environment', () => {
    expect(SOLANA_CLUSTER).toBe('devnet');
  });
});

describe('rpcUrlFor', () => {
  // Hermetic on purpose. Vitest loads `packages/app/.env.local` exactly like the
  // dev server does, so without clearing these first the fallback cases assert
  // against whatever endpoint a developer happens to have configured - and the
  // failure diff then prints that endpoint, API key and all.
  beforeEach(() => {
    vi.stubEnv('VITE_SOLANA_RPC_URL_MAINNET', undefined);
    vi.stubEnv('VITE_SOLANA_RPC_URL_DEVNET', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to the public endpoint per cluster', () => {
    expect(rpcUrlFor('devnet')).toBe('https://api.devnet.solana.com');
    expect(rpcUrlFor('mainnet')).toBe('https://api.mainnet-beta.solana.com');
  });

  it('honours the per-cluster override', () => {
    vi.stubEnv('VITE_SOLANA_RPC_URL_MAINNET', 'https://provider.example/mainnet');
    vi.stubEnv('VITE_SOLANA_RPC_URL_DEVNET', 'https://provider.example/devnet');
    expect(rpcUrlFor('mainnet')).toBe('https://provider.example/mainnet');
    expect(rpcUrlFor('devnet')).toBe('https://provider.example/devnet');
  });

  it('keeps the overrides on separate variables, so a mainnet one cannot reach devnet', () => {
    vi.stubEnv('VITE_SOLANA_RPC_URL_MAINNET', 'https://provider.example/mainnet');
    expect(rpcUrlFor('devnet')).toBe('https://api.devnet.solana.com');
  });

  it('treats an empty override as unset rather than as a blank endpoint', () => {
    vi.stubEnv('VITE_SOLANA_RPC_URL_MAINNET', '');
    expect(rpcUrlFor('mainnet')).toBe('https://api.mainnet-beta.solana.com');
  });
});
