/**
 * Unit tests for the session-spend helpers and the default/override pipeline.
 * No Solana or Nostr traffic - pure in-memory Maps + a temp config file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetKey, NATIVE_SOL } from '@elisym/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentContext, assertCanSpend, recordSpend, remainingForAsset } from '../src/context.js';
import { buildEffectiveLimits, defaultSpendLimitsMap } from '../src/session-limits.js';

describe('defaultSpendLimitsMap', () => {
  it('contains 0.1 SOL as the default cap', () => {
    const map = defaultSpendLimitsMap();
    expect(map.get(assetKey(NATIVE_SOL))).toBe(100_000_000n);
  });
});

describe('assertCanSpend / recordSpend / remainingForAsset', () => {
  it('is a no-op when no limit is configured for the asset', () => {
    const ctx = new AgentContext();
    expect(() => assertCanSpend(ctx, NATIVE_SOL, 999_999_999_999n)).not.toThrow();
    expect(remainingForAsset(ctx, NATIVE_SOL)).toBeNull();
  });

  it('allows spending up to and including the cap', () => {
    const ctx = new AgentContext();
    ctx.sessionSpendLimits.set(assetKey(NATIVE_SOL), 1_000n);
    expect(() => assertCanSpend(ctx, NATIVE_SOL, 1_000n)).not.toThrow();
    recordSpend(ctx, NATIVE_SOL, 1_000n);
    expect(remainingForAsset(ctx, NATIVE_SOL)).toBe(0n);
  });

  it('rejects spend that would exceed the cap', () => {
    const ctx = new AgentContext();
    ctx.sessionSpendLimits.set(assetKey(NATIVE_SOL), 1_000n);
    ctx.sessionSpent.set(assetKey(NATIVE_SOL), 600n);
    expect(() => assertCanSpend(ctx, NATIVE_SOL, 500n)).toThrow(/Session spend limit reached/);
  });

  it('recordSpend is additive and per-asset', () => {
    const ctx = new AgentContext();
    recordSpend(ctx, NATIVE_SOL, 100n);
    recordSpend(ctx, NATIVE_SOL, 50n);
    expect(ctx.sessionSpent.get(assetKey(NATIVE_SOL))).toBe(150n);
  });
});

describe('buildEffectiveLimits', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'elisym-mcp-limits-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Also set USERPROFILE for Windows-style homedir() compatibility.
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeGlobalYaml(body: string): void {
    const elisymDir = join(tmpHome, '.elisym');
    mkdirSync(elisymDir, { recursive: true });
    writeFileSync(join(elisymDir, 'config.yaml'), body);
  }

  it('uses defaults when no config.yaml exists', async () => {
    const map = await buildEffectiveLimits();
    expect(map.get(assetKey(NATIVE_SOL))).toBe(100_000_000n);
  });

  it('overrides defaults from yaml', async () => {
    writeGlobalYaml(
      'session_spend_limits:\n' + '  - chain: solana\n' + '    token: sol\n' + '    amount: 0.5\n',
    );
    const map = await buildEffectiveLimits();
    expect(map.get(assetKey(NATIVE_SOL))).toBe(500_000_000n);
  });

  it('throws on unknown asset in yaml', async () => {
    writeGlobalYaml(
      'session_spend_limits:\n' +
        '  - chain: solana\n' +
        '    token: unknowntoken\n' +
        '    amount: 1\n',
    );
    await expect(buildEffectiveLimits()).rejects.toThrow(/Unknown asset/);
  });

  it('throws on duplicate assetKey in yaml', async () => {
    writeGlobalYaml(
      'session_spend_limits:\n' +
        '  - chain: solana\n' +
        '    token: sol\n' +
        '    amount: 0.5\n' +
        '  - chain: solana\n' +
        '    token: sol\n' +
        '    amount: 0.7\n',
    );
    await expect(buildEffectiveLimits()).rejects.toThrow(/Duplicate/);
  });
});
