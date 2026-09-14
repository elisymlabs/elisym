import {
  LSM_SOLANA_MAINNET,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  assetKey,
  type CapabilityCard,
} from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import { checkBuyAffordability } from '../app/lib/balanceCheck';

const USDC_KEY = assetKey(USDC_SOLANA_DEVNET);
const USDC_MAINNET_KEY = assetKey(USDC_SOLANA_MAINNET);
const LSM_KEY = assetKey(LSM_SOLANA_MAINNET);

function makeCard(payment: NonNullable<CapabilityCard['payment']>): CapabilityCard {
  return {
    name: 'test-skill',
    description: 'test',
    capabilities: ['test'],
    payment,
  } as CapabilityCard;
}

const SOL_CARD = makeCard({
  chain: 'solana',
  network: 'devnet',
  address: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
  job_price: 1_000_000_000,
});

const USDC_CARD = makeCard({
  chain: 'solana',
  network: 'devnet',
  address: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
  job_price: 5_000_000,
  token: 'usdc',
  mint: USDC_SOLANA_DEVNET.mint,
  decimals: 6,
  symbol: 'USDC',
});

/** Mint omitted: the mint must come from the page's cluster, not from a flat registry scan. */
const USDC_MINTLESS_CARD = makeCard({
  chain: 'solana',
  network: 'mainnet',
  address: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
  job_price: 5_000_000,
  token: 'usdc',
  decimals: 6,
  symbol: 'USDC',
});

const LSM_CARD = makeCard({
  chain: 'solana',
  network: 'mainnet',
  address: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
  job_price: 25_000_000,
  token: 'lsm',
  mint: LSM_SOLANA_MAINNET.mint,
  decimals: 6,
  symbol: 'LSM',
});

describe('checkBuyAffordability (registry-driven assets)', () => {
  it('passes a SOL card when balance covers price + gas', () => {
    const result = checkBuyAffordability({
      card: SOL_CARD,
      solLamports: 1_100_000_000n,
      splRaw: {},
      gasLamports: 10_000,
      network: 'devnet',
    });
    expect(result.ok).toBe(true);
  });

  it('fails tier 1 on a SOL card with the SOL deficit in whole units', () => {
    const result = checkBuyAffordability({
      card: SOL_CARD,
      solLamports: 900_000_000n,
      splRaw: {},
      gasLamports: 10_000,
      network: 'devnet',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 100_000_000 lamports short, rendered in SOL (9 decimals), not lamports.
      expect(result.tooltip).toBe('Need 0.1 SOL more to buy.');
    }
  });

  it('fails tier 1 on a USDC card with the deficit in USDC decimals', () => {
    const result = checkBuyAffordability({
      card: USDC_CARD,
      solLamports: 1_000_000_000n,
      splRaw: { [USDC_KEY]: 4_000_000n },
      gasLamports: 10_000,
      network: 'devnet',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 1_000_000 subunits short at 6 decimals = 1 USDC (9-decimal math would say 0.001).
      expect(result.tooltip).toBe('Need 1 USDC more to buy.');
    }
  });

  it('fails tier 1 on an LSM card with the deficit in LSM decimals', () => {
    const result = checkBuyAffordability({
      card: LSM_CARD,
      solLamports: 1_000_000_000n,
      splRaw: { [LSM_KEY]: 10_000_000n },
      gasLamports: 10_000,
      network: 'mainnet',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tooltip).toBe('Need 15 LSM more to buy.');
    }
  });

  it('fails tier 2 on an LSM card with the gas deficit in SOL', () => {
    const result = checkBuyAffordability({
      card: LSM_CARD,
      solLamports: 1_000n,
      splRaw: { [LSM_KEY]: 30_000_000n },
      gasLamports: 4_200_000,
      network: 'mainnet',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tooltip).toBe('Need 0.004199 SOL more for the network fee.');
    }
  });

  it('passes an LSM card when LSM covers price and SOL covers gas', () => {
    const result = checkBuyAffordability({
      card: LSM_CARD,
      solLamports: 10_000_000n,
      splRaw: { [LSM_KEY]: 30_000_000n },
      gasLamports: 4_200_000,
      network: 'mainnet',
    });
    expect(result.ok).toBe(true);
  });

  it('treats an SPL balance equal to the price as affordable, one subunit less as not', () => {
    const args = {
      card: LSM_CARD,
      solLamports: 10_000_000n,
      gasLamports: 4_200_000,
      network: 'mainnet' as const,
    };
    expect(checkBuyAffordability({ ...args, splRaw: { [LSM_KEY]: 25_000_000n } }).ok).toBe(true);
    expect(checkBuyAffordability({ ...args, splRaw: { [LSM_KEY]: 24_999_999n } }).ok).toBe(false);
  });

  it('treats SOL left after the price equal to gas as affordable, one lamport less as not', () => {
    const args = {
      card: SOL_CARD,
      splRaw: {},
      gasLamports: 10_000,
      network: 'devnet' as const,
    };
    // price 1 SOL + 10_000 lamports gas: the exact sum passes, one lamport under fails.
    expect(checkBuyAffordability({ ...args, solLamports: 1_000_010_000n }).ok).toBe(true);
    const short = checkBuyAffordability({ ...args, solLamports: 1_000_009_999n });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.tooltip).toContain('SOL more for the network fee');
    }
  });

  it('resolves a mint-less USDC card against the page cluster, not a flat registry scan', () => {
    // Mainnet page: the balance lives under the mainnet USDC key, so the check
    // must run rather than abstain on a devnet-keyed lookup miss.
    const result = checkBuyAffordability({
      card: USDC_MINTLESS_CARD,
      solLamports: 1_000_000_000n,
      splRaw: { [USDC_MAINNET_KEY]: 4_000_000n },
      gasLamports: 10_000,
      network: 'mainnet',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tooltip).toBe('Need 1 USDC more to buy.');
    }
  });

  it('abstains on a card that settles on another chain', () => {
    // Same token id, different chain: the Solana USDC balance says nothing
    // about what this card charges, so the gate must not do that math.
    const otherChainCard = makeCard({
      chain: 'base' as unknown as 'solana',
      network: 'mainnet',
      address: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
      job_price: 5_000_000,
      token: 'usdc',
      decimals: 6,
      symbol: 'USDC',
    });
    const result = checkBuyAffordability({
      card: otherChainCard,
      solLamports: 0n,
      splRaw: { [USDC_MAINNET_KEY]: 0n },
      gasLamports: 10_000,
      network: 'mainnet',
    });
    expect(result.ok).toBe(true);
  });

  it('abstains on a mainnet-only asset while the page is on devnet', () => {
    const result = checkBuyAffordability({
      card: LSM_CARD,
      solLamports: 0n,
      splRaw: {},
      gasLamports: 10_000,
      network: 'devnet',
    });
    expect(result.ok).toBe(true);
  });

  it('abstains while the SPL balance is still loading', () => {
    const result = checkBuyAffordability({
      card: LSM_CARD,
      solLamports: 10_000_000n,
      splRaw: { [LSM_KEY]: null },
      gasLamports: 4_200_000,
      network: 'mainnet',
    });
    expect(result.ok).toBe(true);
  });

  it('still blocks an SPL card on a known token deficit when the SOL read failed', () => {
    // Each tier abstains on its own missing input. The click-time read times
    // out per asset, so an unreadable SOL balance must not discard a decisive
    // token balance and let an unpayable job through.
    const result = checkBuyAffordability({
      card: USDC_CARD,
      solLamports: null,
      splRaw: { [USDC_KEY]: 1_000_000n },
      gasLamports: 0,
      network: 'devnet',
    });
    expect(result).toEqual({ ok: false, tooltip: 'Need 4 USDC more to buy.' });
  });

  it('abstains from the fee tier alone when the SOL read failed but the token covers the price', () => {
    const result = checkBuyAffordability({
      card: USDC_CARD,
      solLamports: null,
      splRaw: { [USDC_KEY]: 5_000_000n },
      gasLamports: 4_200_000,
      network: 'devnet',
    });
    expect(result.ok).toBe(true);
  });

  it('abstains entirely when the token read failed, even with SOL below the fee estimate', () => {
    // The fee figure is a deliberate worst case (two ATA creations that are
    // usually no-ops), so letting it decide alone on a wallet whose token
    // balance we could not read would refuse buys that would have settled.
    const result = checkBuyAffordability({
      card: USDC_CARD,
      solLamports: 1_000n,
      splRaw: { [USDC_KEY]: null },
      gasLamports: 4_200_000,
      network: 'devnet',
    });
    expect(result.ok).toBe(true);
  });

  it('abstains on a SOL card when the SOL read failed', () => {
    const result = checkBuyAffordability({
      card: SOL_CARD,
      solLamports: null,
      splRaw: {},
      gasLamports: 5_000,
      network: 'devnet',
    });
    expect(result.ok).toBe(true);
  });

  it('abstains on an unknown-asset card instead of doing SOL math', () => {
    const unknownCard = makeCard({
      chain: 'solana',
      network: 'devnet',
      address: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
      job_price: 123_456,
      token: 'doge',
      mint: 'So11111111111111111111111111111111111111112',
      decimals: 8,
      symbol: 'DOGE',
    });
    const result = checkBuyAffordability({
      card: unknownCard,
      solLamports: 0n,
      splRaw: {},
      gasLamports: 10_000,
      network: 'devnet',
    });
    expect(result.ok).toBe(true);
  });
});
