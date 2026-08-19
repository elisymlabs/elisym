/**
 * Unit tests for the session-spend helpers and the default/override pipeline.
 * No Solana or Nostr traffic - pure in-memory Maps + a temp config file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWN_ASSETS,
  LSM_SOLANA_MAINNET,
  assetKey,
  NATIVE_SOL,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
} from '@elisym/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentContext,
  assertCanSpend,
  recordSpend,
  remainingForAsset,
  takeSpendWarnings,
} from '../src/context.js';
import {
  buildEffectiveLimits,
  DEFAULT_SESSION_LIMITS,
  defaultSpendLimitsMap,
} from '../src/session-limits.js';

describe('defaultSpendLimitsMap', () => {
  it('contains 0.5 SOL as the default cap', () => {
    const map = defaultSpendLimitsMap();
    expect(map.get(assetKey(NATIVE_SOL))).toBe(500_000_000n);
  });

  it('contains a 50 USDC cap PER NETWORK the asset exists on (H8)', () => {
    const map = defaultSpendLimitsMap();
    // 50 USDC * 10^6 subunits = 50_000_000. assertCanSpend is a no-op for
    // assets with no entry, so a missing mainnet row would leave real-money
    // USDC spending uncapped while devnet stays capped.
    expect(map.get(assetKey(USDC_SOLANA_DEVNET))).toBe(50_000_000n);
    expect(map.get(assetKey(USDC_SOLANA_MAINNET))).toBe(50_000_000n);
    expect(assetKey(USDC_SOLANA_DEVNET)).not.toBe(assetKey(USDC_SOLANA_MAINNET));
  });

  it('keeps native SOL as a SINGLE cap shared across networks (deliberate)', () => {
    // assetKey(NATIVE_SOL) has no mint, so there is no per-network variant:
    // in a mixed-network process devnet and mainnet SOL spends draw down one
    // shared cap. Conservative direction - it can only under-allow, never
    // over-spend.
    const solEntries = DEFAULT_SESSION_LIMITS.filter((entry) => entry.asset.token === 'sol');
    expect(solEntries).toHaveLength(1);
    expect(solEntries[0]?.asset.mint).toBeUndefined();
    // Exactly four default entries: shared SOL + USDC per network + mainnet LSM.
    expect(defaultSpendLimitsMap().size).toBe(4);
  });

  it('contains 1,000,000 LSM as the mainnet-only default cap', () => {
    const map = defaultSpendLimitsMap();
    // 1_000_000 LSM * 10^6 subunits = 1_000_000_000_000.
    expect(map.get(assetKey(LSM_SOLANA_MAINNET))).toBe(1_000_000_000_000n);
    // Single row - LSM has no devnet variant to cap.
    const lsmEntries = DEFAULT_SESSION_LIMITS.filter((entry) => entry.asset.token === 'lsm');
    expect(lsmEntries).toHaveLength(1);
  });

  it('caps EVERY known asset - an asset with no row spends uncapped', () => {
    // `assertCanSpend` returns early when an asset has no limit, so a new
    // KNOWN_ASSETS member added without a DEFAULT_SESSION_LIMITS row would be
    // spendable without any session cap. This fails the moment that happens.
    const map = defaultSpendLimitsMap();
    for (const asset of KNOWN_ASSETS) {
      expect(map.has(assetKey(asset)), `${assetKey(asset)} has no default session cap`).toBe(true);
    }
  });
});

describe('LSM cap enforcement', () => {
  it('rejects an LSM spend that would exceed the default cap', () => {
    const ctx = new AgentContext();
    ctx.sessionSpendLimits.set(assetKey(LSM_SOLANA_MAINNET), 1_000_000_000_000n);
    ctx.sessionSpent.set(assetKey(LSM_SOLANA_MAINNET), 999_999_000_000n);
    expect(() => assertCanSpend(ctx, LSM_SOLANA_MAINNET, 2_000_000_000n)).toThrow(
      /Session spend limit reached/,
    );
  });
});

describe('formatSessionSpendLines network filtering', () => {
  it('shows only the assets that exist on the agent network (caps stay global)', async () => {
    const { formatSessionSpendLines } = await import('../src/tools/wallet.js');
    const ctx = new AgentContext();
    ctx.sessionSpendLimits = defaultSpendLimitsMap();

    const devnetLines = formatSessionSpendLines(ctx, 'devnet');
    expect(devnetLines.join('\n')).not.toContain('LSM');
    // Exactly SOL + devnet USDC (the mainnet-USDC row is filtered from display too).
    expect(devnetLines).toHaveLength(2);

    const mainnetLines = formatSessionSpendLines(ctx, 'mainnet');
    expect(mainnetLines.join('\n')).toContain('LSM');
    expect(mainnetLines).toHaveLength(3);
  });
});

describe('formatSplBalanceLine', () => {
  it('renders a read balance in whole units', async () => {
    const { formatSplBalanceLine } = await import('../src/tools/wallet.js');
    expect(formatSplBalanceLine(LSM_SOLANA_MAINNET, 25_000_000n)).toBe('LSM balance: 25 LSM');
    // A genuine zero still reads as zero.
    expect(formatSplBalanceLine(LSM_SOLANA_MAINNET, 0n)).toBe('LSM balance: 0 LSM');
  });

  it('says the read failed rather than claiming an empty wallet', async () => {
    // A rate-limited RPC returns null; rendering that as "0 LSM" would tell an
    // agent holding a fortune that its wallet is empty.
    const { formatSplBalanceLine } = await import('../src/tools/wallet.js');
    expect(formatSplBalanceLine(LSM_SOLANA_MAINNET, null)).toBe(
      'LSM balance: unavailable (balance read failed)',
    );
    expect(formatSplBalanceLine(LSM_SOLANA_MAINNET, undefined)).toBe(
      'LSM balance: unavailable (balance read failed)',
    );
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

describe('takeSpendWarnings', () => {
  function freshCtx(limit: bigint): AgentContext {
    const ctx = new AgentContext();
    ctx.sessionSpendLimits.set(assetKey(NATIVE_SOL), limit);
    return ctx;
  }

  it('returns no warnings when no cap is configured', () => {
    const ctx = new AgentContext();
    recordSpend(ctx, NATIVE_SOL, 1_000n);
    expect(takeSpendWarnings(ctx, NATIVE_SOL)).toEqual([]);
  });

  it('returns no warnings below 50%', () => {
    const ctx = freshCtx(1_000n);
    recordSpend(ctx, NATIVE_SOL, 499n);
    expect(takeSpendWarnings(ctx, NATIVE_SOL)).toEqual([]);
  });

  it('fires at exactly 50% of cap', () => {
    const ctx = freshCtx(1_000n);
    recordSpend(ctx, NATIVE_SOL, 500n);
    const lines = takeSpendWarnings(ctx, NATIVE_SOL);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/50%/);
  });

  it('fires both 50% and 80% when a single spend jumps past both', () => {
    const ctx = freshCtx(1_000n);
    recordSpend(ctx, NATIVE_SOL, 850n);
    const lines = takeSpendWarnings(ctx, NATIVE_SOL);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/50%/);
    expect(lines[1]).toMatch(/80%/);
  });

  it('is one-shot per threshold across successive spends', () => {
    const ctx = freshCtx(1_000n);
    // First crossing at 50%.
    recordSpend(ctx, NATIVE_SOL, 500n);
    const first = takeSpendWarnings(ctx, NATIVE_SOL);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/50%/);

    // Another call still in the 50-80 band - no new warning.
    recordSpend(ctx, NATIVE_SOL, 200n);
    expect(takeSpendWarnings(ctx, NATIVE_SOL)).toEqual([]);

    // Crossing 80% fires exactly once.
    recordSpend(ctx, NATIVE_SOL, 150n);
    const third = takeSpendWarnings(ctx, NATIVE_SOL);
    expect(third).toHaveLength(1);
    expect(third[0]).toMatch(/80%/);

    // Any further call produces no new warnings.
    recordSpend(ctx, NATIVE_SOL, 10n);
    expect(takeSpendWarnings(ctx, NATIVE_SOL)).toEqual([]);
  });

  it('does not double-fire if called twice after the same spend', () => {
    const ctx = freshCtx(1_000n);
    recordSpend(ctx, NATIVE_SOL, 800n);
    expect(takeSpendWarnings(ctx, NATIVE_SOL)).toHaveLength(2);
    expect(takeSpendWarnings(ctx, NATIVE_SOL)).toEqual([]);
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
    expect(map.get(assetKey(NATIVE_SOL))).toBe(500_000_000n);
  });

  it('overrides defaults from yaml', async () => {
    writeGlobalYaml(
      'session_spend_limits:\n' + '  - chain: solana\n' + '    token: sol\n' + '    amount: 1.5\n',
    );
    const map = await buildEffectiveLimits();
    expect(map.get(assetKey(NATIVE_SOL))).toBe(1_500_000_000n);
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
