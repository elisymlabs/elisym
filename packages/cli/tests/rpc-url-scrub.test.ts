import { describe, expect, it } from 'vitest';
import { stripRpcSecrets } from '../src/commands/start';

describe('stripRpcSecrets', () => {
  it('preserves a bare devnet URL', () => {
    expect(stripRpcSecrets('https://api.devnet.solana.com')).toBe('https://api.devnet.solana.com/');
  });

  it('masks an embedded query-string API key (Helius style)', () => {
    const scrubbed = stripRpcSecrets('https://rpc.helius.xyz?api-key=hunter2');
    expect(scrubbed).not.toContain('hunter2');
    expect(scrubbed).toContain('?***');
  });

  it('masks multiple query params atomically', () => {
    const scrubbed = stripRpcSecrets('https://api.example/rpc?token=XXX&network=mainnet');
    expect(scrubbed).not.toContain('XXX');
    expect(scrubbed).not.toContain('mainnet');
    expect(scrubbed).toContain('?***');
  });

  it('strips userinfo credentials (http basic auth style)', () => {
    const scrubbed = stripRpcSecrets('https://user:pass@rpc.example.com');
    expect(scrubbed).not.toContain('user');
    expect(scrubbed).not.toContain('pass');
  });

  it('returns a sentinel for unparseable URLs', () => {
    expect(stripRpcSecrets('not a url')).toBe('[unparseable RPC URL]');
  });
});
