import { describe, expect, it } from 'vitest';
import { redactRpcUrlsInText, stripRpcSecrets } from '../src/commands/start';

describe('stripRpcSecrets', () => {
  it('preserves a bare devnet URL', () => {
    expect(stripRpcSecrets('https://api.devnet.solana.com')).toBe('https://api.devnet.solana.com/');
  });

  it('masks an embedded query-string API key (Helius style)', () => {
    const scrubbed = stripRpcSecrets('https://rpc.helius.xyz?api-key=hunter2');
    expect(scrubbed).not.toContain('hunter2');
    // Third-party host: path + query dropped, host-only with a marker.
    expect(scrubbed).toBe('https://rpc.helius.xyz/***');
  });

  it('masks multiple query params atomically', () => {
    const scrubbed = stripRpcSecrets('https://api.example/rpc?token=XXX&network=mainnet');
    expect(scrubbed).not.toContain('XXX');
    expect(scrubbed).not.toContain('mainnet');
    expect(scrubbed).toBe('https://api.example/***');
  });

  it('strips a path-embedded API key (Alchemy/QuickNode style)', () => {
    const scrubbed = stripRpcSecrets('https://solana-mainnet.g.alchemy.com/v2/SECRETKEY123');
    expect(scrubbed).not.toContain('SECRETKEY123');
    expect(scrubbed).toBe('https://solana-mainnet.g.alchemy.com/***');
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

describe('redactRpcUrlsInText', () => {
  it('redacts an RPC URL embedded in an error message, keeping the surrounding text', () => {
    const message =
      'fetch failed: HTTP 401 at https://rpc.helius.xyz/?api-key=hunter2 (will retry)';
    const scrubbed = redactRpcUrlsInText(message);
    expect(scrubbed).not.toContain('hunter2');
    expect(scrubbed).toContain('HTTP 401');
    expect(scrubbed).toContain('https://rpc.helius.xyz/***');
    expect(scrubbed).toContain('(will retry)');
  });

  it('leaves text with no URL unchanged', () => {
    expect(redactRpcUrlsInText('Connection refused')).toBe('Connection refused');
  });
});
