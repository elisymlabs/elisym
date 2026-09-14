import { USDC_SOLANA_DEVNET, USDC_SOLANA_MAINNET } from '@elisym/sdk';
import type { PaymentRequirements } from '@x402/fetch';
import { describe, expect, it } from 'vitest';
import {
  X402_SOLANA_DEVNET_CAIP2,
  X402_SOLANA_DEVNET_V1,
  X402_SOLANA_MAINNET_CAIP2,
  X402_SOLANA_MAINNET_V1,
} from '../src/x402/constants.js';
import {
  buildRequirementsPolicy,
  isAcceptableRequirement,
  maxAcceptableQuote,
  requirementAmount,
  selectAcceptableRequirement,
} from '../src/x402/matcher.js';

const USDC_MINT = USDC_SOLANA_DEVNET.mint ?? '';
const USDC_MAINNET_MINT = USDC_SOLANA_MAINNET.mint ?? '';

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: X402_SOLANA_DEVNET_CAIP2 as PaymentRequirements['network'],
    asset: USDC_MINT,
    payTo: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
    amount: '5000',
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

function mainnetRequirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return requirement({
    network: X402_SOLANA_MAINNET_CAIP2 as PaymentRequirements['network'],
    asset: USDC_MAINNET_MINT,
    ...overrides,
  });
}

const RULE = { maxUpstreamSubunits: 10_000n, network: 'devnet' as const };
const MAINNET_RULE = { maxUpstreamSubunits: 10_000n, network: 'mainnet' as const };

describe('x402 network id constants', () => {
  it('pins the wire-format literals (the matcher tests exercise them via the constants)', () => {
    expect(X402_SOLANA_MAINNET_V1).toBe('solana');
    expect(X402_SOLANA_MAINNET_CAIP2).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  });
});

describe('x402 requirement matcher', () => {
  it('accepts a devnet USDC exact requirement within the ceiling', () => {
    expect(isAcceptableRequirement(requirement(), RULE)).toBe(true);
  });

  it('accepts the v1 network alias', () => {
    const v1 = requirement({ network: X402_SOLANA_DEVNET_V1 as PaymentRequirements['network'] });
    expect(isAcceptableRequirement(v1, RULE)).toBe(true);
  });

  it('reads the v1 maxAmountRequired amount field', () => {
    const v1 = requirement({ amount: undefined as never });
    (v1 as { maxAmountRequired?: string }).maxAmountRequired = '7000';
    expect(requirementAmount(v1)).toBe(7000n);
    expect(isAcceptableRequirement(v1, RULE)).toBe(true);
  });

  it('rejects other schemes, networks and assets', () => {
    expect(isAcceptableRequirement(requirement({ scheme: 'upto' }), RULE)).toBe(false);
    expect(
      isAcceptableRequirement(
        requirement({ network: X402_SOLANA_MAINNET_CAIP2 as PaymentRequirements['network'] }),
        RULE,
      ),
    ).toBe(false);
    expect(isAcceptableRequirement(requirement({ network: 'eip155:8453' }), RULE)).toBe(false);
    expect(isAcceptableRequirement(requirement({ asset: USDC_MAINNET_MINT }), RULE)).toBe(false);
  });

  it('rejects a quote above the ceiling and malformed amounts (fail closed)', () => {
    expect(isAcceptableRequirement(requirement({ amount: '10001' }), RULE)).toBe(false);
    expect(isAcceptableRequirement(requirement({ amount: '12.5' }), RULE)).toBe(false);
    expect(isAcceptableRequirement(requirement({ amount: '-5' }), RULE)).toBe(false);
    expect(isAcceptableRequirement(requirement({ amount: '' }), RULE)).toBe(false);
    expect(isAcceptableRequirement(requirement({ amount: undefined as never }), RULE)).toBe(false);
  });

  it('accepts a quote exactly at the ceiling', () => {
    expect(isAcceptableRequirement(requirement({ amount: '10000' }), RULE)).toBe(true);
  });

  it('selects the first acceptable requirement from a mixed accepts list', () => {
    const evm = requirement({ network: 'eip155:8453' });
    const good = requirement({ amount: '9000' });
    expect(selectAcceptableRequirement([evm, good], RULE)).toBe(good);
    expect(selectAcceptableRequirement([evm], RULE)).toBeUndefined();
  });

  it('reports the worst (max) acceptable quote for the margin/balance gate', () => {
    const cheap = requirement({ amount: '3000' });
    const dear = requirement({ amount: '9000' }); // still <= 10000 ceiling
    const evm = requirement({ network: 'eip155:8453' });
    const over = requirement({ amount: '999999' });
    // Signing may pick either acceptable one, so preflight must use the max.
    expect(maxAcceptableQuote([cheap, dear, evm, over], RULE)).toBe(9000n);
    expect(maxAcceptableQuote([evm, over], RULE)).toBeNull();
    expect(maxAcceptableQuote([], RULE)).toBeNull();
  });

  it('policy filters to the same acceptance set', () => {
    const policy = buildRequirementsPolicy(RULE);
    const evm = requirement({ network: 'eip155:8453' });
    const over = requirement({ amount: '999999' });
    const good = requirement();
    expect(policy(2, [evm, over, good])).toEqual([good]);
    expect(policy(2, [evm, over])).toEqual([]);
  });
});

describe('x402 requirement matcher (mainnet agent)', () => {
  it('accepts a mainnet USDC exact requirement (CAIP-2 id + mainnet mint)', () => {
    expect(isAcceptableRequirement(mainnetRequirement(), MAINNET_RULE)).toBe(true);
  });

  it('accepts the v1 mainnet network alias ("solana")', () => {
    const v1 = mainnetRequirement({
      network: X402_SOLANA_MAINNET_V1 as PaymentRequirements['network'],
    });
    expect(isAcceptableRequirement(v1, MAINNET_RULE)).toBe(true);
  });

  it('still rejects cross-network requirements (devnet ids / devnet mint)', () => {
    // Devnet network id under a mainnet rule.
    expect(
      isAcceptableRequirement(
        mainnetRequirement({ network: X402_SOLANA_DEVNET_CAIP2 as PaymentRequirements['network'] }),
        MAINNET_RULE,
      ),
    ).toBe(false);
    expect(
      isAcceptableRequirement(
        mainnetRequirement({ network: X402_SOLANA_DEVNET_V1 as PaymentRequirements['network'] }),
        MAINNET_RULE,
      ),
    ).toBe(false);
    // Mainnet network id but the devnet mint.
    expect(isAcceptableRequirement(mainnetRequirement({ asset: USDC_MINT }), MAINNET_RULE)).toBe(
      false,
    );
  });

  it('policy under a mainnet rule signs only mainnet requirements', () => {
    const policy = buildRequirementsPolicy(MAINNET_RULE);
    const devnet = requirement();
    const mainnet = mainnetRequirement();
    expect(policy(2, [devnet, mainnet])).toEqual([mainnet]);
    expect(policy(2, [devnet])).toEqual([]);
  });
});
