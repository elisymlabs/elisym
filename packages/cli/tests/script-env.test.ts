import { describe, expect, it } from 'vitest';
import { buildScriptEnv } from '../src/commands/start.js';

describe('buildScriptEnv (secret-leak regression)', () => {
  it('never leaks wallet/delegate secrets or the passphrase into script env', () => {
    process.env.ELISYM_PASSPHRASE = 'super-secret-pass';
    try {
      const secrets = {
        nostr_secret_key: 'aa'.repeat(32),
        solana_secret_key: 'PaymentSecretKeyBase58',
        solana_delegate_secret_key: 'DelegateSecretKeyBase58',
        llm_api_keys: { anthropic: 'sk-ant-test-123' },
      };
      const env = buildScriptEnv(secrets as never);

      // The passphrase would let a script decrypt .secrets.json at rest.
      expect(env.ELISYM_PASSPHRASE).toBeUndefined();
      // A leaked delegate key spends EVERY customer delegation up to its cap.
      expect(env.solana_delegate_secret_key).toBeUndefined();
      expect(env.SOLANA_DELEGATE_SECRET_KEY).toBeUndefined();
      const values = Object.values(env);
      expect(values).not.toContain('DelegateSecretKeyBase58');
      expect(values).not.toContain('PaymentSecretKeyBase58');
      expect(values).not.toContain(secrets.nostr_secret_key);

      // The per-provider LLM keys ARE the intentional pass-through.
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-123');
    } finally {
      delete process.env.ELISYM_PASSPHRASE;
    }
  });
});
