import bs58 from 'bs58';
import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/environment';

const VALID_HEX = 'a'.repeat(64);
const VALID_SOLANA = bs58.encode(new Uint8Array(64));

function envless<T>(fn: () => T): T {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ELISYM_')) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  }
}

describe('validateConfig', () => {
  it('accepts a minimal customer config', () => {
    const cfg = envless(() =>
      validateConfig({
        ELISYM_NOSTR_PRIVATE_KEY: VALID_HEX,
        ELISYM_SOLANA_PRIVATE_KEY: VALID_SOLANA,
      }),
    );
    expect(cfg.mode).toBe('customer');
    expect(cfg.network).toBe('devnet');
    expect(cfg.maxSpendPerJobLamports).toBe(10_000_000n);
    expect(cfg.maxSpendPerHourLamports).toBe(100_000_000n);
    expect(cfg.requireApprovalAboveLamports).toBe(5_000_000n);
    expect(cfg.nostrPrivateKeyHex).toBe(VALID_HEX);
  });

  it('rejects missing Solana private key', () => {
    expect(() =>
      envless(() =>
        validateConfig({
          ELISYM_NOSTR_PRIVATE_KEY: VALID_HEX,
        }),
      ),
    ).toThrow(/ELISYM_SOLANA_PRIVATE_KEY is required/);
  });

  it('rejects an invalid Nostr hex key', () => {
    expect(() =>
      envless(() =>
        validateConfig({
          ELISYM_NOSTR_PRIVATE_KEY: 'zz',
          ELISYM_SOLANA_PRIVATE_KEY: VALID_SOLANA,
        }),
      ),
    ).toThrow();
  });

  it('rejects a too-short Solana key', () => {
    expect(() =>
      envless(() =>
        validateConfig({
          ELISYM_NOSTR_PRIVATE_KEY: VALID_HEX,
          ELISYM_SOLANA_PRIVATE_KEY: bs58.encode(new Uint8Array(32)),
        }),
      ),
    ).toThrow(/64-byte secret/);
  });

  it('requires provider capabilities and price in provider mode', () => {
    expect(() =>
      envless(() =>
        validateConfig({
          ELISYM_NOSTR_PRIVATE_KEY: VALID_HEX,
          ELISYM_SOLANA_PRIVATE_KEY: VALID_SOLANA,
          ELISYM_MODE: 'provider',
        }),
      ),
    ).toThrow(/Provider mode requires/);
  });

  it('accepts a full provider config', () => {
    const cfg = envless(() =>
      validateConfig({
        ELISYM_NOSTR_PRIVATE_KEY: VALID_HEX,
        ELISYM_SOLANA_PRIVATE_KEY: VALID_SOLANA,
        ELISYM_MODE: 'provider',
        ELISYM_PROVIDER_CAPABILITIES: 'summarization, text/summarize',
        ELISYM_PROVIDER_PRICE_SOL: '0.002',
        ELISYM_PROVIDER_ACTION_MAP: '{"summarization":"SUMMARIZE_TEXT"}',
      }),
    );
    expect(cfg.providerCapabilities).toEqual(['summarization', 'text/summarize']);
    expect(cfg.providerPriceLamports).toBe(2_000_000n);
    expect(cfg.providerActionMap).toEqual({ summarization: 'SUMMARIZE_TEXT' });
  });

  it('rounds 1-lamport SOL amount correctly', () => {
    const cfg = envless(() =>
      validateConfig({
        ELISYM_NOSTR_PRIVATE_KEY: VALID_HEX,
        ELISYM_SOLANA_PRIVATE_KEY: VALID_SOLANA,
        ELISYM_MAX_SPEND_PER_JOB_SOL: '0.000000001',
      }),
    );
    expect(cfg.maxSpendPerJobLamports).toBe(1n);
  });
});
