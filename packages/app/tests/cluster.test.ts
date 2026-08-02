/**
 * D10 hostname allowlist tests: mainnet ONLY on the exact production host,
 * every other hostname (app-dev, localhost, loopback, LAN IPs, Vercel
 * previews, lookalikes) fails safe to devnet.
 */
import { describe, expect, it } from 'vitest';
import { resolveCluster, SOLANA_CLUSTER } from '~/lib/cluster';

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
