import { describe, it, expect } from 'vitest';
import {
  NATIVE_SOL,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  LSM_SOLANA_MAINNET,
  TOKEN_2022_PROGRAM_ADDRESS_STR,
  KNOWN_ASSETS,
  assetKey,
  assetByKey,
  resolveKnownAsset,
  resolveUsdcAsset,
  resolveLsmAsset,
  splAssetsForNetwork,
  resolveAssetFromPaymentRequest,
  parseAssetAmount,
  formatAssetAmount,
  type Asset,
} from '../src/payment/assets';

const SPL_FIXTURE: Asset = {
  chain: 'solana',
  token: 'usdc',
  mint: 'TestMint1111111111111111111111111111111111',
  decimals: 6,
  symbol: 'USDC',
};

describe('assetKey', () => {
  it('uses two-part form for native assets', () => {
    expect(assetKey(NATIVE_SOL)).toBe('solana:sol');
  });

  it('uses three-part form for SPL/ERC-20', () => {
    expect(assetKey(SPL_FIXTURE)).toBe('solana:usdc:TestMint1111111111111111111111111111111111');
  });
});

describe('resolveKnownAsset / assetByKey', () => {
  it('resolves known native SOL', () => {
    expect(resolveKnownAsset('solana', 'sol')).toBe(NATIVE_SOL);
    expect(assetByKey('solana:sol')).toBe(NATIVE_SOL);
  });

  it('returns undefined for unknown combinations', () => {
    expect(resolveKnownAsset('solana', 'btc')).toBeUndefined();
    expect(resolveKnownAsset('ethereum', 'eth')).toBeUndefined();
    expect(assetByKey('nope:nope')).toBeUndefined();
  });

  it('KNOWN_ASSETS exposes SOL, USDC (devnet + mainnet), and LSM (mainnet)', () => {
    expect(KNOWN_ASSETS).toHaveLength(4);
    expect(KNOWN_ASSETS[0]).toBe(NATIVE_SOL);
    expect(KNOWN_ASSETS[1]).toBe(USDC_SOLANA_DEVNET);
    expect(KNOWN_ASSETS[1]?.mint).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    expect(KNOWN_ASSETS[2]).toBe(USDC_SOLANA_MAINNET);
    expect(KNOWN_ASSETS[2]?.mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(KNOWN_ASSETS[3]).toBe(LSM_SOLANA_MAINNET);
    expect(KNOWN_ASSETS[3]?.mint).toBe('86T4G3zJaBxQAuWAbfXggE5d5XEt4bns3Y41jgVLpump');
    expect(KNOWN_ASSETS[3]?.decimals).toBe(6);
    expect(KNOWN_ASSETS[3]?.tokenProgram).toBe(TOKEN_2022_PROGRAM_ADDRESS_STR);
    // Classic-program assets never declare a tokenProgram.
    expect(KNOWN_ASSETS[1]?.tokenProgram).toBeUndefined();
    expect(KNOWN_ASSETS[2]?.tokenProgram).toBeUndefined();
  });

  it('resolves LSM by (chain, token, mint) and from a payment request', () => {
    const lsmMint = '86T4G3zJaBxQAuWAbfXggE5d5XEt4bns3Y41jgVLpump';
    const resolved = resolveKnownAsset('solana', 'lsm', lsmMint);
    expect(resolved?.symbol).toBe('LSM');
    expect(resolved?.tokenProgram).toBe(TOKEN_2022_PROGRAM_ADDRESS_STR);
    const fromRequest = resolveAssetFromPaymentRequest({
      asset: { chain: 'solana', token: 'lsm', mint: lsmMint },
    });
    expect(fromRequest.token).toBe('lsm');
    expect(fromRequest.decimals).toBe(6);
  });
});

describe('resolveLsmAsset / splAssetsForNetwork', () => {
  it('resolves LSM on mainnet only', () => {
    expect(resolveLsmAsset('mainnet')).toBe(LSM_SOLANA_MAINNET);
    expect(resolveLsmAsset('devnet')).toBeUndefined();
  });

  it('lists per-network SPL assets: devnet = USDC, mainnet = USDC + LSM', () => {
    expect(splAssetsForNetwork('devnet')).toEqual([USDC_SOLANA_DEVNET]);
    expect(splAssetsForNetwork('mainnet')).toEqual([USDC_SOLANA_MAINNET, LSM_SOLANA_MAINNET]);
  });
});

describe('resolveUsdcAsset', () => {
  it('resolves the devnet USDC mint for devnet', () => {
    expect(resolveUsdcAsset('devnet')).toBe(USDC_SOLANA_DEVNET);
  });

  it('resolves the mainnet USDC mint for mainnet', () => {
    expect(resolveUsdcAsset('mainnet')).toBe(USDC_SOLANA_MAINNET);
  });

  it('the two mints differ and share token/decimals/symbol', () => {
    expect(USDC_SOLANA_DEVNET.mint).not.toBe(USDC_SOLANA_MAINNET.mint);
    expect(USDC_SOLANA_MAINNET.token).toBe('usdc');
    expect(USDC_SOLANA_MAINNET.decimals).toBe(6);
    expect(USDC_SOLANA_MAINNET.symbol).toBe('USDC');
  });
});

describe('resolveAssetFromPaymentRequest', () => {
  it('returns NATIVE_SOL when no asset is present', () => {
    expect(resolveAssetFromPaymentRequest({})).toBe(NATIVE_SOL);
  });

  it('resolves a known asset', () => {
    const sol = resolveAssetFromPaymentRequest({ asset: { chain: 'solana', token: 'sol' } });
    expect(sol.token).toBe('sol');
  });

  it('strips unsafe chars from provider asset ids in the unknown-asset error', () => {
    let msg = '';
    try {
      resolveAssetFromPaymentRequest({ asset: { chain: 'evil\nchain <x>', token: 'tok' } });
    } catch (error) {
      msg = error instanceof Error ? error.message : String(error);
    }
    expect(msg).toContain('Unknown asset');
    // Injection payload (newline, markup) stripped; safe chars preserved.
    expect(msg).not.toContain('\n');
    expect(msg).not.toContain('<x>');
    expect(msg).toContain('evilchain');
  });
});

describe('parseAssetAmount', () => {
  it('parses SOL whole numbers', () => {
    expect(parseAssetAmount(NATIVE_SOL, '1')).toBe(1_000_000_000n);
    expect(parseAssetAmount(NATIVE_SOL, '10')).toBe(10_000_000_000n);
  });

  it('parses SOL decimals', () => {
    expect(parseAssetAmount(NATIVE_SOL, '0.5')).toBe(500_000_000n);
    expect(parseAssetAmount(NATIVE_SOL, '0.1')).toBe(100_000_000n);
    expect(parseAssetAmount(NATIVE_SOL, '0.000000001')).toBe(1n);
  });

  it('parses SPL (6 decimals) amounts', () => {
    expect(parseAssetAmount(SPL_FIXTURE, '1')).toBe(1_000_000n);
    expect(parseAssetAmount(SPL_FIXTURE, '1.234567')).toBe(1_234_567n);
    expect(parseAssetAmount(SPL_FIXTURE, '0.000001')).toBe(1n);
  });

  it('rejects overspecified fractions', () => {
    expect(() => parseAssetAmount(NATIVE_SOL, '1.1234567890')).toThrow(/too many decimals/);
    expect(() => parseAssetAmount(SPL_FIXTURE, '1.1234567')).toThrow(/too many decimals/);
  });

  it('rejects malformed strings', () => {
    expect(() => parseAssetAmount(NATIVE_SOL, '')).toThrow();
    expect(() => parseAssetAmount(NATIVE_SOL, '-1')).toThrow(/cannot be negative/);
    expect(() => parseAssetAmount(NATIVE_SOL, '1e9')).toThrow(/decimal/);
    expect(() => parseAssetAmount(NATIVE_SOL, '1,000')).toThrow(/decimal/);
    expect(() => parseAssetAmount(NATIVE_SOL, 'abc')).toThrow(/decimal/);
  });

  it('rejects zero', () => {
    expect(() => parseAssetAmount(NATIVE_SOL, '0')).toThrow(/positive/);
    expect(() => parseAssetAmount(NATIVE_SOL, '0.0')).toThrow(/positive/);
  });
});

describe('formatAssetAmount', () => {
  it('formats SOL trimming trailing zeros', () => {
    expect(formatAssetAmount(NATIVE_SOL, 0n)).toBe('0 SOL');
    expect(formatAssetAmount(NATIVE_SOL, 1n)).toBe('0.000000001 SOL');
    expect(formatAssetAmount(NATIVE_SOL, 100_000_000n)).toBe('0.1 SOL');
    expect(formatAssetAmount(NATIVE_SOL, 1_000_000_000n)).toBe('1 SOL');
  });

  it('formats SPL trimming trailing zeros', () => {
    expect(formatAssetAmount(SPL_FIXTURE, 1_234_567n)).toBe('1.234567 USDC');
    expect(formatAssetAmount(SPL_FIXTURE, 1_000_000n)).toBe('1 USDC');
    expect(formatAssetAmount(SPL_FIXTURE, 10_000n)).toBe('0.01 USDC');
  });

  it('formats negative amounts', () => {
    expect(formatAssetAmount(SPL_FIXTURE, -10_000n)).toBe('-0.01 USDC');
  });

  it('roundtrips parse → format → parse', () => {
    const raw = parseAssetAmount(NATIVE_SOL, '0.5');
    const formatted = formatAssetAmount(NATIVE_SOL, raw);
    expect(formatted).toBe('0.5 SOL');
    expect(parseAssetAmount(NATIVE_SOL, '0.5')).toBe(raw);
  });
});

describe('ops scripts cover every known asset', () => {
  // The AssetStats design counts new assets without a program upgrade, but the
  // two ops scripts that pre-create and audit those PDAs carry their own mint
  // literals (config-client is dependency-light and cannot import the SDK -
  // the SDK depends on it). Without this check, adding an asset to
  // KNOWN_ASSETS would silently leave its PDA uncreated, and the first real
  // payer in that asset would fund the rent.
  const SCRIPTS = [
    'packages/config-client/scripts/create-asset-stats.ts',
    'packages/config-client/scripts/admin.ts',
  ];

  it.each(SCRIPTS)('%s lists every KNOWN_ASSETS mint', async (scriptPath) => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL(`../../../${scriptPath}`, import.meta.url), 'utf8');
    for (const asset of KNOWN_ASSETS) {
      if (!asset.mint) {
        // Native SOL is covered by the sentinel PDA, referenced by name.
        expect(source).toContain('NATIVE_ASSET_SENTINEL');
        continue;
      }
      expect(source, `${asset.symbol} (${asset.mint}) missing from ${scriptPath}`).toContain(
        asset.mint,
      );
    }
  });
});
