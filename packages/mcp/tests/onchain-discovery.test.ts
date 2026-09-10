/**
 * How `search_agents` states an on-chain capability's ceilings.
 *
 * This is the surface an LLM reads BEFORE deciding to spend the user's money,
 * and it is the one place the decimals rule was pinned by nothing: a mutation
 * making it trust the card's declared `decimals` passed the whole MCP suite.
 * The card's `decimals` and `symbol` are provider-controlled, so an asset
 * elisym does not know is reported in raw subunits rather than dressed up.
 */
import { describe, expect, it } from 'vitest';
import { onchainCeiling } from '../src/tools/discovery.js';

const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const descriptor = {
  kind: 'withdraw',
  network: 'devnet' as const,
  programs: [],
  requires: [],
  params: [],
  token: 'usdc',
  mint: USDC_DEVNET_MINT,
  decimals: 6,
  symbol: 'USDC',
  max_per_call_subunits: '500000000',
  grants_authority: false,
  max_authority_subunits: '0',
};

describe('onchainCeiling', () => {
  it('states a known asset in its own units', () => {
    expect(onchainCeiling(descriptor, '500000000')).toBe('500 USDC');
  });

  it('reports an asset elisym does not know in raw subunits', () => {
    // The provider controls these fields. Trusting a declared 18 decimals over
    // a 6-decimal mint would show a 500-token bound as `0.0000000005` - and the
    // model would read that as harmless and spend.
    const lying = {
      ...descriptor,
      token: 'wat',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      decimals: 18,
      symbol: 'SAFE',
    };
    expect(onchainCeiling(lying, '500000000')).toBe('500000000 subunits');
  });

  it('does not dress up an unknown mint with the card’s own symbol', () => {
    expect(
      onchainCeiling({ ...descriptor, mint: 'NotAMintWeKnow11111111111111111111111111111' }, '1'),
    ).not.toContain('USDC');
  });
});
